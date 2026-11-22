import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Event, Setup } from "@wizards-bot/protocol";
import { pullModel, suggestedModel } from "../models/ollama.ts";
import { type TestHome, testHome } from "../test/fakes.ts";
import { probeOllama } from "./probes.ts";
import { PullRefused } from "./setup.ts";

/** An Ollama `/api/pull` that streams `lines`, one JSON object per line, `gap` ms apart. */
const pulling = (lines: object[], gap = 0): typeof fetch =>
  (async () => {
    const rest = [...lines];
    return new Response(
      new ReadableStream({
        async pull(controller) {
          const line = rest.shift();
          if (!line) return controller.close();
          if (gap) await new Promise((done) => setTimeout(done, gap));
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify(line)}\n`));
        },
      }),
    );
  }) as unknown as typeof fetch;

describe("a model for Ollama", () => {
  test("is the largest that leaves the computer room", () => {
    assert.equal(suggestedModel(8e9).model, "qwen3:4b");
    assert.equal(suggestedModel(16e9).model, "qwen3:8b");
    assert.equal(suggestedModel(32e9).model, "qwen3:14b");
    assert.equal(suggestedModel(2e9).model, "qwen3:1.7b");
  });

  test("is offered when Ollama on this computer has none", async () => {
    const empty = (async (url: string | URL) =>
      String(url).endsWith("/api/tags")
        ? Response.json({ models: [] })
        : new Response(null, { status: 404 })) as unknown as typeof fetch;
    const probe = await probeOllama("http://127.0.0.1:11434", 8e9, empty);
    assert.equal(probe.state, "problem");
    assert.equal(probe.command, "ollama pull qwen3:4b");
    assert.deepEqual(probe.pull, { model: "qwen3:4b", size: 2.5e9 });
    // An Ollama on another computer: the home says what to do there, and pulls nothing.
    const elsewhere = await probeOllama("http://192.168.1.20:11434", 8e9, empty);
    assert.equal(elsewhere.pull, undefined);
  });

  test("loads with its progress, and fails with what Ollama said", async () => {
    const heard: number[] = [];
    await pullModel(
      "http://127.0.0.1:11434",
      "qwen3:4b",
      (done) => heard.push(done),
      pulling([
        { status: "pulling manifest" },
        { status: "pulling abc", total: 100, completed: 40 },
        { status: "pulling abc", total: 100, completed: 100 },
        { status: "success" },
      ]),
    );
    assert.deepEqual(heard, [40, 100]);
    await assert.rejects(
      pullModel(
        "http://127.0.0.1:11434",
        "qwen3:4b",
        () => {},
        pulling([{ error: "pull model manifest: file does not exist" }]),
      ),
      /file does not exist/,
    );
    await assert.rejects(
      pullModel(
        "http://127.0.0.1:11434",
        "qwen3:4b",
        () => {},
        pulling([{ status: "pulling abc", total: 9, completed: 1 }]),
      ),
      /stopped before/,
    );
  });
});

describe("the setup's pull", () => {
  let t: TestHome;
  before(async () => {
    t = await testHome("Ada");
  });
  after(() => t.stop());

  test("pulls only what it offers", async () => {
    await assert.rejects(t.home.setup.pull("something:70b"), PullRefused);
    const response = await t.request("/v1/setup/pull", { body: { model: "something:70b" } });
    assert.equal(response.status, 400);
  });

  test("pulls a model it offers and tells the devices how far it is", async () => {
    const told: Setup[] = [];
    const off = t.home.events.subscribe(({ event }: { event: Event }) => {
      if (event.type === "setup.updated") told.push(event.setup);
    });
    t.home.setup.ollamaFetch = pulling(
      [{ status: "pulling abc", total: 2.5e9, completed: 1e9 }, { status: "success" }],
      150,
    );
    const first = await t.home.setup.pull("qwen3:4b");
    assert.equal(first.pulling?.model, "qwen3:4b");
    await t.home.setup.pulled();
    const last = await t.home.setup.view();
    assert.equal(last.pulling?.state, "done");
    assert.equal(last.pulling?.model, "qwen3:4b");
    assert.ok(told.some((setup) => setup.pulling?.state === "pulling"));
    assert.ok(told.some((setup) => setup.pulling?.state === "done"));
    off();
  });
});
