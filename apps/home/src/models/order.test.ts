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
