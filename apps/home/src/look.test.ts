import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { ChatLook, Event } from "@wizards-bot/protocol";
import { type TestHome, testHome } from "./test/fakes.ts";

describe("how the chat looks", () => {
  let t: TestHome;
  before(async () => {
    t = await testHome("Ada");
  });
  after(() => t.stop());

  const look = async () => (await (await t.request("/v1/look")).json()) as ChatLook;

  test("is the plain one until the person picks, then is told to every device", async () => {
    assert.deepEqual(await look(), { view: "canvas", tools: "summary" });
    const events: Event[] = [];
    const stop = t.home.events.subscribe(({ event }) => events.push(event));
    const picked = { view: "bubbles", tools: "all" };
    const response = await t.request("/v1/look", { method: "PUT", body: picked });
    stop();
    assert.equal(response.status, 200);
    assert.deepEqual(await look(), picked);
    assert.deepEqual(events, [{ type: "look.updated", look: picked }]);
  });

  test("takes the plain value for one it does not know", async () => {
    await t.request("/v1/look", { method: "PUT", body: { view: "cinema", tools: "none" } });
    assert.deepEqual(await look(), { view: "canvas", tools: "none" });
  });
});
