import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import type { Client } from "@engenty/local-models/clients";
import type { LocalModelsState } from "@engenty/model-setup";
import type { Setup } from "@wizards-bot/protocol";
import { type TestHome, testHome } from "../test/fakes.ts";

/** A client that is installed and signed in, and runs nothing. */
const fake = (id: "claude" | "codex"): Client =>
  ({
    id,
    name: id === "claude" ? "Claude Code" : "Codex",
    bin: "/bin/sh",
    tools: true,
    passThrough: /^$/,
    keyVars: [],
    auth: async () => "subscription",
    version: async () => "1.0.0",
    login: { args: ["-c", "echo signed in"], interactive: false },
  }) as unknown as Client;

describe("the setup shared with engenty wizards", () => {
  let t: TestHome;
  before(async () => {
    t = await testHome("Ada", undefined, { unpicked: true });
    t.home.setup.clients = [fake("codex")];
  });
  after(() => t.stop());
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await t.request(`/v1/setup/local${path}`, {
      method,
      ...(body === undefined ? {} : { body }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  test("is for a paired device only", async () => {
    const response = await fetch(`${t.url}/v1/setup/local/clients`);
    assert.equal(response.status, 401);
  });

  test("lists the clients and loads no model", async () => {
    const { body } = await call("GET", "/clients");
    const [client] = body.clients as { id: string; auth: string }[];
    assert.equal(client?.id, "codex");
    // Apple MLX comes after these, on a Mac that has its helper.
    const servers = body.servers as { id: string; running: boolean }[];
    assert.deepEqual(
      servers.slice(0, 2).map((server) => [server.id, server.running]),
      [
        ["ollama", true],
        ["lmstudio", false],
      ],
    );
    assert.equal(t.model.requests.length, 0);
  });

  test("a test call needs a pick", async () => {
    const { body } = await call("POST", "/models/test", {});
    assert.equal(body.ok, false);
    assert.equal(t.model.requests.length, 0);
  });

  test("Ollama answers once it is picked there, and nothing else does", async () => {
    const { body } = await call("POST", "/servers/ollama/address", {
      url: "http://127.0.0.1:11434",
    });
    assert.equal(body.ok, true);
    assert.deepEqual(t.home.models.picked(), ["ollama"]);
    assert.deepEqual(t.home.models.candidates(), ["ollama:fake:1"]);
    const setup = (await (await t.request("/v1/setup")).json()) as Setup;
    assert.equal(setup.working, true);
  });

  test("the models of Ollama are listed, with those to download, and none is loaded", async () => {
    const asked = t.model.requests.length;
    const { body } = await call("GET", "/servers/ollama");
    const state = body as unknown as LocalModelsState;
    assert.deepEqual(
      state.installed.map((model) => model.name),
      ["fake:1"],
    );
    assert.ok(state.offered?.some((model) => model.name === "gemma4:e4b" && !model.installed));
    assert.equal(t.model.requests.length, asked);
    assert.equal((await call("POST", "/servers/ollama/pull", { model: "a b" })).status, 400);
  });

  test("a chosen model is the one that answers, after a test of its own", async () => {
    await call("PUT", "/models", { source: "ollama", model: "fake:1" });
    assert.deepEqual(t.home.models.picked(), ["ollama"]);
    assert.equal(t.home.models.serverModel("ollama"), "fake:1");
    assert.equal(((await (await t.request("/v1/setup")).json()) as Setup).working, false);
    const { body } = await call("POST", "/models/test", {});
    assert.equal(body.ok, true);
    assert.equal(body.ref, "fake:1");
    assert.deepEqual(t.home.models.candidates(), ["ollama:fake:1"]);
  });

  test("another pick takes its place, and a source nobody picked does not answer", async () => {
    await call("PUT", "/models", { source: "codex" });
    assert.deepEqual(t.home.models.picked(), ["codex"]);
    assert.equal(t.home.models.ollamaPicked(), false);
    assert.deepEqual(t.home.models.candidates(), []);
    // Ollama answered before; what was not picked no longer lets the setup go on.
    assert.equal(((await (await t.request("/v1/setup")).json()) as Setup).working, false);
    const { body } = await call("GET", "/models");
    assert.equal(body.source, "codex");
  });

  test("a key that is refused is not kept; one that works is the pick, the next one joins it", async () => {
    t.home.setup.gatewayFetch = async () => new Response("no", { status: 401 });
    const bad = await call("POST", "/keys/openrouter", { key: "sk-bad" });
    assert.equal(bad.body.ok, false);
    assert.equal(t.home.models.gateways().length, 0);
    t.home.setup.gatewayFetch = async () =>
      Response.json({
        id: "1",
        model: "m",
        choices: [
          { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    assert.equal((await call("POST", "/keys/openrouter", { key: "sk-good" })).body.ok, true);
    assert.deepEqual(t.home.models.picked(), ["openrouter"]);
    assert.equal((await call("POST", "/keys/openai", { key: "sk-good" })).body.ok, true);
    assert.deepEqual(t.home.models.picked(), ["openrouter", "openai"]);
    const { body } = await call("PUT", "/models", { keys: { openrouter: "" } });
    assert.equal((body.keys as Record<string, boolean>).openrouter, false);
    assert.deepEqual(t.home.models.candidates(), ["openai:gpt-5-mini"]);
  });

  test("the order and a later key add to the pick", () => {
    t.home.models.pickSource("codex");
    t.home.models.setOrder(["ollama:fake:1"]);
    assert.deepEqual(t.home.models.picked(), ["codex", "ollama"]);
    t.home.models.pickOllama(false);
    assert.deepEqual(t.home.models.picked(), ["codex"]);
  });

  test("a closed terminal is gone, an unknown client is not found", async () => {
    assert.equal((await call("POST", "/terminal/nope/input", { data: "x" })).status, 404);
    const response = await t.request("/v1/setup/local/harness/cursor/login", { body: {} });
    assert.equal(response.status, 404);
  });
});

/** An LM Studio with one model, which answers and remembers what it was asked. */
async function fakeLmStudio() {
  const asked: string[] = [];
  const server = createServer((request, response) => {
    const path = request.url ?? "";
    asked.push(path);
    response.setHeader("content-type", "application/json");
    if (path === "/api/v1/models") {
      const capabilities = { vision: true, trained_for_tool_use: true };
      const model = { type: "llm", key: "google/gemma-4-e4b", size_bytes: 1, capabilities };
      return response.end(JSON.stringify({ models: [model] }));
    }
    if (path === "/api/v1/models/load") {
      return response.end(JSON.stringify({ instance_id: "google/gemma-4-e4b" }));
    }
    if (path === "/v1/chat/completions") {
      const message = { role: "assistant", content: "ok" };
      return response.end(JSON.stringify({ choices: [{ index: 0, message }] }));
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, asked, stop: () => server.close() };
}

describe("LM Studio in the setup", () => {
  let studio: Awaited<ReturnType<typeof fakeLmStudio>>;
  let t: TestHome;
  before(async () => {
    studio = await fakeLmStudio();
    t = await testHome("Ada", undefined, {
      unpicked: true,
      config: { lmstudioUrl: studio.url },
    });
    t.home.setup.clients = [];
    await t.home.models.refresh(true);
  });
  after(() => {
    t.stop();
    studio.stop();
  });
  const put = (body: unknown) => t.request("/v1/setup/local/models", { method: "PUT", body });

  test("found alone it answers nowhere, on any home, and no model is loaded", async () => {
    assert.ok(t.home.models.localSources().some((source) => source.id === "lmstudio"));
    assert.ok(!t.home.models.candidates().some((ref) => ref.startsWith("lmstudio:")));
    assert.ok(!studio.asked.includes("/api/v1/models/load"));
  });

  test("a chosen model picks it, its test loads the model, and it alone answers", async () => {
    await put({ source: "lmstudio", model: "google/gemma-4-e4b" });
    assert.deepEqual(t.home.models.picked(), ["lmstudio"]);
    assert.deepEqual(t.home.models.candidates(), ["lmstudio:google/gemma-4-e4b"]);
    assert.ok(!studio.asked.includes("/api/v1/models/load"));
    const test = await t.request("/v1/setup/local/models/test", { body: {} });
    const body = (await test.json()) as { ok: boolean; ref: string };
    assert.deepEqual([body.ok, body.ref], [true, "google/gemma-4-e4b"]);
    assert.ok(studio.asked.includes("/api/v1/models/load"));
    assert.ok(t.home.models.engine("lmstudio:google/gemma-4-e4b"));
    assert.deepEqual(t.home.models.forPictures().here, ["lmstudio:google/gemma-4-e4b"]);
    const setup = (await (await t.request("/v1/setup")).json()) as Setup;
    assert.equal(setup.working, true);
  });

  test("another pick puts it away", async () => {
    t.home.models.pickSource("codex");
    assert.deepEqual(t.home.models.candidates(), []);
    assert.deepEqual(t.home.models.forPictures().here, []);
  });
});

test("a hosted home has none of it", async () => {
  const hosted = await testHome("Ada", undefined, {
    config: { manageUrl: "http://127.0.0.1:9", homeToken: undefined },
  });
  const response = await hosted.request("/v1/setup/local/clients");
  assert.equal(response.status, 404);
  hosted.stop();
});
