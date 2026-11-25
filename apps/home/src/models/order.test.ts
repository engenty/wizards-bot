import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Models } from "@wizards-bot/protocol";
import { type TestHome, testHome } from "../test/fakes.ts";

let t: TestHome;
before(async () => {
  t = await testHome("Ada");
});
after(() => t.stop());

test("the person chooses which model answers first, and every device hears of it", async () => {
  const events: string[] = [];
  const stop = t.home.events.subscribe((stored) => events.push(stored.event.type));
  const response = await t.request("/v1/models/order", {
    method: "PUT",
    body: { order: ["ollama:fake:1"] },
  });
  stop();
  assert.equal(response.status, 200);
  const view = (await response.json()) as Models;
  assert.deepEqual(view.order, ["ollama:fake:1"]);
  assert.ok(events.includes("models.updated"));
});

/** Two models that answer, named as the person's own gateways. */
function twoGateways(home: TestHome["home"]) {
  const gateway = { baseUrl: "http://127.0.0.1:9", models: ["first", "second"] };
  home.models.setGateway({ id: "one", label: "One", ...gateway }, "key");
  home.models.setGateway({ id: "two", label: "Two", ...gateway }, "key");
}

const choose = (source: string, model: string) =>
  t.request("/v1/models/source", { method: "PUT", body: { source, model } });

test("a model chosen for a source is the one that answers, and every source keeps its place", async () => {
  const { models } = t.home;
  twoGateways(t.home);
  models.setOrder([]);
  assert.deepEqual(models.candidates(), ["ollama:fake:1", "one:first", "two:first"]);

  const view = (await (await choose("one", "second")).json()) as Models;
  assert.deepEqual(view.answers, ["ollama:fake:1", "one:second", "two:first"]);
  assert.deepEqual(models.candidates(), view.answers);
  // Named once, the source keeps its place in the order.
  models.setOrder(["two:first", "one:second", "ollama:fake:1"]);
  await choose("one", "first");
  assert.deepEqual(models.candidates(), ["two:first", "one:first", "ollama:fake:1"]);
});

test("a source of the order that is out of reach keeps its place too", async () => {
  t.home.models.setOrder(["mini/ollama:qwen3:8b", "one:first"]);
  await choose("two", "second");
  assert.deepEqual(t.home.models.order(), [
    "mini/ollama:qwen3:8b",
    "one:first",
    "ollama:fake:1",
    "two:second",
  ]);
});

test("a source that did not answer joins after the others; nothing is loaded for it", async () => {
  const { models } = t.home;
  const asked = t.model.requests.length;
  models.setOrder([]);
  models.pickSource("one");
  assert.deepEqual(models.candidates(), ["one:first"]);
  await choose("ollama", "fake:1");
  assert.deepEqual(models.candidates(), ["one:first", "ollama:fake:1"]);
  assert.deepEqual(models.picked(), ["one", "ollama"]);
  assert.equal(t.model.requests.length, asked);
});

test("the test call asks the chosen model, and another choice makes the last test void", async () => {
  const asked: string[] = [];
  t.home.setup.gatewayFetch = async (_url, init) => {
    asked.push((JSON.parse(String(init?.body)) as { model: string }).model);
    const message = { role: "assistant", content: "ok" };
    return Response.json({
      id: "1",
      model: "m",
      choices: [{ index: 0, message, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  };
  await choose("one", "second");
  const setup = await t.home.setup.test("one");
  assert.deepEqual(asked, ["second"]);
  assert.equal(setup.models.find((check) => check.id === "one")?.model, "second");
  await choose("one", "first");
  const after = await t.home.setup.view();
  assert.equal(after.models.find((check) => check.id === "one")?.state, "untested");
});

test("a gateway takes another model once it answers, and no source one it does not have", async () => {
  await choose("one", "third");
  assert.deepEqual(t.home.models.gateways().find((g) => g.id === "one")?.models, [
    "first",
    "second",
    "third",
  ]);
  assert.equal(t.home.models.candidates()[0], "one:third");
  t.home.setup.gatewayFetch = async () => new Response("no", { status: 404 });
  assert.equal((await choose("one", "fourth")).status, 400);
  assert.equal((await choose("ollama", "other:1")).status, 400);
  assert.equal((await choose("nobody", "x")).status, 400);
  assert.equal(t.home.models.candidates()[0], "one:third");
});
