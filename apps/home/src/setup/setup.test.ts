import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CLIENTS, type Client, forgetEnv } from "@engenty/local-models/clients";
import type { Event, Message, Setup } from "@wizards-bot/protocol";
import { FakeOllama, type TestHome, testHome, textOf } from "../test/fakes.ts";
import { explainClaude, explainCodex, explainGateway, explainOllama } from "./explain.ts";
import { codexSetting, probeClient, probeGateway, probeOllama } from "./probes.ts";
import { summary } from "./setup.ts";

// The lines below are what the clients and services printed when they failed, in the week the
// setup was built.
const CLAUDE_LIMIT =
  "API Error: 400 You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.";
const CLAUDE_SIGNED_OUT = "Invalid API key · Please run /login";
const CODEX_OLLAMA = "This model requires an Ollama account. Run `ollama signin` to continue.";
const OLLAMA_MEMORY = "model requires more system memory (24.0 GiB) than is available (7.9 GiB)";

const bin = mkdtempSync(join(tmpdir(), "wizards-bot-clients-"));
after(() => rmSync(bin, { recursive: true, force: true }));

/** An installed, signed-in client whose turn runs `body` once it has read the message. */
function fakeClient(base: Client, name: string, body: string): Client {
  const file = join(bin, name);
  writeFileSync(
    file,
    `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  const say = (line) => process.stdout.write(JSON.stringify(line) + "\\n");
  ${body}
});
`,
  );
  chmodSync(file, 0o755);
  // The sign-in is decided once per client id; the home's own start decided it for the real client.
  forgetEnv(base.id);
  return {
    ...base,
    bin: file,
    version: async () => "1.0.0",
    auth: async () => "subscription",
  };
}

const claudeSays = (text: string, error: boolean) => `
  ${error ? `say({ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: ${JSON.stringify(text)} }] } });` : `say({ type: "assistant", message: { model: "claude", content: [{ type: "text", text: ${JSON.stringify(text)} }] } });`}
  say({ type: "result", session_id: "s1", is_error: ${error}, result: ${JSON.stringify(text)} });
  process.exit(${error ? 1 : 0});`;

test("Claude Code: an API key at its usage limit, signed out, and answering", async () => {
  const limit = await probeClient(
    fakeClient(CLIENTS.claude, "claude-limit", claudeSays(CLAUDE_LIMIT, true)),
  );
  assert.equal(limit.state, "problem");
  assert.match(limit.said.en, /API key whose usage limit is reached/);
  assert.match(limit.todo?.en ?? "", /\/login/);

  const out = await probeClient(
    fakeClient(CLIENTS.claude, "claude-out", claudeSays(CLAUDE_SIGNED_OUT, true)),
  );
  assert.equal(out.said.en, "Claude is not signed in on this computer.");
  assert.equal(out.command, "claude");

  const ok = await probeClient(fakeClient(CLIENTS.claude, "claude-ok", claudeSays("ok", false)));
  assert.equal(ok.state, "ok");
});

test("a client runs its test call without the API key the home was started with", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-limited";
  forgetEnv("claude");
  try {
    const keyed = fakeClient(
      CLIENTS.claude,
      "claude-keyed",
      `const text = process.env.ANTHROPIC_API_KEY ? ${JSON.stringify(CLAUDE_LIMIT)} : "ok";
  say({ type: "result", is_error: Boolean(process.env.ANTHROPIC_API_KEY), result: text });`,
    );
    assert.equal((await probeClient(keyed)).state, "ok");
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    forgetEnv("claude");
  }
});

test("Codex: an Ollama cloud model without an Ollama sign-in, signed out, and answering", async () => {
  const ollama = await probeClient(
    fakeClient(
      CLIENTS.codex,
      "codex-ollama",
      `say({ type: "thread.started", thread_id: "t1" });
  say({ type: "error", message: ${JSON.stringify(CODEX_OLLAMA)} });
  say({ type: "turn.failed", error: { message: ${JSON.stringify(CODEX_OLLAMA)} } });
  process.exit(1);`,
    ),
  );
  assert.equal(ollama.state, "problem");
  assert.match(ollama.said.en, /Ollama cloud model/);
  assert.match(ollama.todo?.en ?? "", /config\.toml/);
  assert.equal(ollama.command, "ollama signin");

  const out = await probeClient(
    fakeClient(
      CLIENTS.codex,
      "codex-out",
      `process.stderr.write("Error: Not logged in. Run codex login.\\n"); process.exit(1);`,
    ),
  );
  assert.equal(out.said.en, "Codex is not signed in on this computer.");
  assert.equal(out.command, "codex login");

  const ok = await probeClient(
    fakeClient(
      CLIENTS.codex,
      "codex-ok",
      `say({ type: "item.completed", item: { type: "agent_message", text: "ok" } });`,
    ),
  );
  assert.equal(ok.state, "ok");
});

test("a client that is not installed, and one that does not answer in time", async () => {
  const missing = await probeClient({
    ...CLIENTS.claude,
    bin: join(bin, "not-there"),
    version: async () => null,
  });
  assert.equal(missing.state, "absent");
  assert.match(missing.said.en, /not installed/);

  const slow = fakeClient(CLIENTS.codex, "codex-slow", "setTimeout(() => {}, 60_000);");
  const late = await probeClient(slow, 400);
  assert.equal(late.state, "problem");
  assert.match(late.said.en, /did not answer within/);
});

test("the Ollama model Codex is set to, read from its config", () => {
  const home = mkdtempSync(join(tmpdir(), "wizards-bot-codex-"));
  writeFileSync(
    join(home, "config.toml"),
    'model = "glm-5.3:cloud"\nmodel_provider = "ollama"\n\n[profiles.other]\nmodel = "gpt-6"\n',
  );
  assert.deepEqual(codexSetting(home), { model: "glm-5.3:cloud", ollama: true });
  rmSync(home, { recursive: true, force: true });
  assert.deepEqual(codexSetting(join(tmpdir(), "no-codex-here")), { ollama: false });
});

/** An Ollama that lists one model of `size` bytes and answers a chat with `chat`. */
async function ollamaThat(size: number, chat: { status: number; body: unknown }): Promise<Server> {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/version") {
        return response.end(JSON.stringify({ version: "0.0.0" }));
      }
      if (request.url === "/api/tags") {
        const digest = `sha256:big-${size}`;
        return response.end(JSON.stringify({ models: [{ name: "big:70b", size, digest }] }));
      }
      if (request.url === "/api/ps") {
        return response.end(JSON.stringify({ models: [] }));
      }
      if (request.url === "/api/show") {
        return response.end(JSON.stringify({ capabilities: ["completion", "tools"] }));
      }
      response.statusCode = chat.status;
      response.end(JSON.stringify(chat.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}
const urlOf = (server: Server) => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test("Ollama: not running, a model too large for the memory, and one that answers", async () => {
  const off = await probeOllama("http://127.0.0.1:9", 16e9);
  assert.equal(off.state, "absent");
  assert.match(off.said.en, /does not answer/);

  // Larger than a little over half the memory: no test call, the computer would swap.
  const large = await ollamaThat(40e9, { status: 200, body: {} });
  const tooLarge = await probeOllama(urlOf(large), 16e9);
  assert.equal(tooLarge.state, "problem");
  assert.equal(
    tooLarge.said.en,
    "big:70b needs 40 GB. On this computer the Bot Server takes a model of up to 9 GB, a little over half of its 16 GB of memory, so the computer stays quick.",
  );
  large.close();

  // Ollama itself says so.
  const refusing = await ollamaThat(1e9, { status: 500, body: { error: OLLAMA_MEMORY } });
  const memory = await probeOllama(urlOf(refusing), 16e9);
  assert.equal(memory.said.en, "big:70b is too large for this computer's memory.");
  refusing.close();

  const fake = new FakeOllama();
  await fake.start();
  const ok = await probeOllama(fake.url, 16e9);
  assert.equal(ok.state, "ok");
  assert.equal(ok.model, "fake:1");
  fake.stop();
});

test("a gateway: no key, and a key it refuses", async () => {
  const gateway = {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://gateway.test/v1",
    models: ["openrouter/auto"],
  };
  assert.match((await probeGateway(gateway, undefined)).said.en, /has no key/);
  const refused = await probeGateway(gateway, "sk-or-wrong", 5000, async () =>
    Response.json({ error: { message: "No auth credentials found", code: 401 } }, { status: 401 }),
  );
  assert.equal(refused.state, "problem");
  assert.equal(refused.said.en, "OpenRouter refused the key.");
  assert.match(refused.todo?.en ?? "", /add OpenRouter/);
});

test("the sentences for what the services said", () => {
  assert.match(explainClaude("Credit balance is too low").said.en, /no credit left/);
  assert.match(explainClaude("Claude AI usage limit reached|1764000000").said.en, /plan's limit/);
  assert.match(explainCodex("You've hit your usage limit.").said.en, /Codex limit/);
  assert.match(
    explainOllama("pull model manifest: file does not exist", "x:1").said.en,
    /does not have/,
  );
  assert.match(explainGateway("OpenAI", "insufficient_quota", 429, "gpt").said.en, /no credit/);
  assert.match(explainGateway("OpenAI", "model_not_found", 404, "gpt-9").said.en, /does not know/);
});

let t: TestHome;
const events: Event[] = [];
before(async () => {
  t = await testHome("Ada");
  t.home.events.subscribe(({ event }) => events.push(event));
});
after(() => t.stop());

test("a new home: the first start is not done, nothing tested, the data folder is temporary", async () => {
  const setup = (await (await t.request("/v1/setup")).json()) as Setup;
  assert.equal(setup.done, false);
  assert.equal(setup.name.confirmed, false);
  assert.equal(setup.hasModel, true);
  assert.equal(setup.working, false);
  const ollama = setup.models.find((check) => check.id === "ollama");
  assert.equal(ollama?.state, "untested");
  assert.equal(setup.home.find((check) => check.id === "data")?.state, "warning");
  assert.equal(setup.home.find((check) => check.id === "address")?.state, "ok");
  assert.equal(setup.home.find((check) => check.id === "push")?.state, "absent");
  assert.equal(setup.capabilities.find((check) => check.id === "text")?.state, "untested");
  assert.equal(summary(setup).startsWith("not tested yet"), true);
});

test("test calls: kept with their time, told as events, a failing client beside a working Ollama", async () => {
  t.home.setup.clients = [
    fakeClient(CLIENTS.claude, "claude-home", claudeSays(CLAUDE_SIGNED_OUT, true)),
  ];
  events.length = 0;
  const response = await t.request("/v1/setup/test", { body: {} });
  const setup = (await response.json()) as Setup;
  const claude = setup.models.find((check) => check.id === "claude");
  assert.equal(claude?.state, "problem");
  assert.equal(claude?.said, "Claude is not signed in on this computer.");
  assert.ok(claude?.at);
  assert.equal(setup.models.find((check) => check.id === "ollama")?.state, "ok");
  assert.equal(setup.working, true);
  assert.equal(setup.capabilities.find((check) => check.id === "text")?.state, "ok");
  assert.equal(setup.capabilities.find((check) => check.id === "pictures")?.state, "ok");
  const told = events.filter((event) => event.type === "setup.updated");
  assert.ok(told.length >= 2);
  const first = told[0];
  assert.equal(
    first?.type === "setup.updated" &&
      first.setup.models.some((check) => check.state === "testing"),
    true,
  );
  assert.match(summary(setup), /Ollama answers · 1 problem \(Claude Code\)/);

  // Read again, the outcome is the kept one: no new call.
  const asked = t.model.requests.length;
  const again = (await (await t.request("/v1/setup")).json()) as Setup;
  assert.equal(again.models.find((check) => check.id === "claude")?.at, claude?.at);
  assert.equal(t.model.requests.length, asked);

  // One source alone.
  t.home.setup.clients = [fakeClient(CLIENTS.claude, "claude-home-ok", claudeSays("ok", false))];
  const one = (await (
    await t.request("/v1/setup/test", { body: { source: "claude" } })
  ).json()) as Setup;
  assert.equal(one.models.find((check) => check.id === "claude")?.state, "ok");
  assert.equal(t.model.requests.length, asked);
});

test("an Ollama nobody picked: found, never asked, until the person picks it", async () => {
  const fresh = await testHome("Ada", undefined, { unpicked: true });
  try {
    const row = (setup: Setup) => setup.models.find((check) => check.id === "ollama");
    const post = async (path: string, body: unknown) =>
      (await (await fresh.request(path, { body })).json()) as Setup;

    const all = await post("/v1/setup/test", {});
    assert.equal(row(all)?.state, "untested");
    assert.equal(row(all)?.on, false);
    assert.equal(row(all)?.start?.model, "fake:1");
    assert.equal(all.hasModel, false);
    assert.equal(all.working, false);
    await post("/v1/setup/test", { source: "ollama" });
    assert.equal(fresh.model.requests.length, 0);

    const on = await post("/v1/setup/ollama", { on: true });
    assert.equal(row(on)?.state, "ok");
    assert.equal(row(on)?.on, true);
    assert.equal(row(on)?.start, undefined);
    assert.equal(on.hasModel, true);
    const asked = fresh.model.requests.length;
    assert.ok(asked > 0);

    const off = await post("/v1/setup/ollama", { on: false });
    assert.equal(row(off)?.state, "untested");
    assert.equal(row(off)?.start?.model, "fake:1");
    assert.deepEqual(fresh.home.models.candidates(), []);
    assert.equal(fresh.model.requests.length, asked);
  } finally {
    fresh.stop();
  }
});

test("a home that answers with Ollama alone keeps it; one with another model does not", async () => {
  const kept = (ids: string[]) =>
    JSON.stringify(
      Object.fromEntries(
        ids.map((id) => [id, { state: "ok", said: "", at: "2026-11-20T10:00:00.000Z" }]),
      ),
    );
  for (const [ids, picked] of [
    [["ollama"], true],
    [["ollama", "claude"], false],
  ] as const) {
    const before = await testHome("Ada", undefined, { unpicked: true });
    before.home.db.setMeta("setup.tests", kept([...ids]));
    const { dataDir } = before.home.config;
    before.stop();
    const now = await testHome("Ada", undefined, { unpicked: true, dataDir });
    assert.equal(now.home.models.ollamaPicked(), picked);
    now.stop();
  }
});

test("the name, and the end of the first start", async () => {
  const named = (await (
    await t.request("/v1/setup", { method: "PATCH", body: { name: "Ada Lovelace" } })
  ).json()) as Setup;
  assert.deepEqual(named.name, { value: "Ada Lovelace", confirmed: true });
  assert.equal(t.home.person(), "Ada Lovelace");
  const finished = (await (
    await t.request("/v1/setup", { method: "PATCH", body: { done: true } })
  ).json()) as Setup;
  assert.equal(finished.done, true);
  // The chat starts with the main agent's greeting, once.
  const main = t.home.store.mainAgent().conversationId;
  const greeted = t.home.store.messages(main, { limit: 5 }).messages;
  assert.equal(greeted.length, 1);
  assert.match(textOf(greeted[0] as Message), /^Hello Ada Lovelace\. I am .+, your first wizard\./);
  await t.request("/v1/setup", { method: "PATCH", body: { done: true } });
  assert.equal(t.home.store.messages(main, { limit: 5 }).messages.length, 1);
});

test("a connected folder that is gone", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "wizards-bot-folder-")), "Notes");
  mkdirSync(dir);
  assert.equal((await t.request("/v1/folders", { body: { path: dir, access: "read" } })).ok, true);
  let setup = await t.home.setup.view();
  assert.equal(setup.home.find((check) => check.id === "folders")?.state, "ok");
  rmSync(dir, { recursive: true });
  setup = await t.home.setup.view();
  const folders = setup.home.find((check) => check.id === "folders");
  assert.equal(folders?.state, "problem");
  assert.match(folders?.said ?? "", /Notes .* is no longer there/);
});

test("a gateway's key card from the setup, with the model the person named", async () => {
  t.home.setup.gatewayFetch = async () =>
    Response.json({ error: { message: "Invalid key" } }, { status: 401 });
  const { card } = (await (
    await t.request("/v1/setup/gateway", { body: { provider: "openrouter" } })
  ).json()) as { card: { id: string; fields: { id: string; value?: string }[] } };
  assert.equal(card.fields.find((field) => field.id === "model")?.value, "openrouter/auto");
  assert.equal(t.item().id, card.id);
  t.model.script.push({ text: "OpenRouter is set up." });
  await t.home.answer(card.id, {
    action: "save",
    values: { key: "sk-or-x", model: "anthropic/claude-haiku" },
    by: "Test phone",
  });
  await t.home.idle();
  const gateway = t.home.models.gateways().find((g) => g.id === "openrouter");
  assert.deepEqual(gateway?.models, ["anthropic/claude-haiku", "openrouter/auto"]);
  // The card's answer tests the gateway at once.
  for (let tries = 0; tries < 50; tries++) {
    if ((await t.home.setup.view()).models.find((c) => c.id === "openrouter")?.at) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const check = (await t.home.setup.view()).models.find((c) => c.id === "openrouter");
  assert.equal(check?.said, "OpenRouter refused the key.");
});

test("a pairing code for the setup's own page, not a card in the chat", async () => {
  const before = t.home.store.items().length;
  const pairing = (await (await t.request("/v1/setup/pairing", { body: {} })).json()) as {
    address: string;
    code: string;
    link: string;
  };
  assert.match(pairing.code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(pairing.address, t.home.address());
  assert.match(pairing.link, /^wizardsbot:\/\/pair\?home=/);
  assert.equal(t.home.store.items().length, before);
});

test("the checks in the language the person reads", async () => {
  await t.request("/v1/setup", { method: "PATCH", body: { lang: "de" } });
  assert.equal(
    t.home.store.mainAgent().about,
    "Dein eigener Wizard. Er kennt deine anderen Wizards, deine Konten und was dich braucht.",
  );
  const setup = await t.home.setup.view();
  const gateway = setup.models.find((check) => check.id === "openrouter");
  assert.equal(gateway?.said, "OpenRouter hat den Schlüssel abgelehnt.");
  assert.equal(
    setup.home.find((check) => check.id === "push")?.todo,
    "Gib dem Bot Server deinen Apple-Schlüssel.",
  );
  await t.request("/v1/setup", { method: "PATCH", body: { lang: "en" } });
  assert.equal(
    (await t.home.setup.view()).models.find((check) => check.id === "openrouter")?.said,
    "OpenRouter refused the key.",
  );
});
