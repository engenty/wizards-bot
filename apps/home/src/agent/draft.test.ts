import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Event } from "@wizards-bot/protocol";
import { type TestHome, testHome } from "../test/fakes.ts";
import { Draft } from "./draft.ts";

describe("an agent's message while it is written", () => {
  let t: TestHome;
  before(async () => {
    t = await testHome("Ada");
  });
  after(() => t.stop());

  test("keeps what the model thought apart from its answer, and each source once", () => {
    const events: Event[] = [];
    const stop = t.home.events.subscribe((stored) => events.push(stored.event));
    const { conversationId } = t.home.store.mainAgent();
    const draft = new Draft(
      t.home.store,
      t.home.store.addMessage({
        conversationId,
        role: "agent",
        channel: "app",
        parts: [],
        state: "streaming",
      }),
    );
    draft.reason("Trains ");
    draft.reason("first.");
    assert.equal(draft.empty, true);
    draft.write("The 7:10.");
    draft.source("https://example.com/trains", "Timetable");
    draft.source("https://example.com/trains", "Timetable");
    const message = draft.finish("done");
    stop();
    assert.deepEqual(message.parts, [
      { type: "reasoning", text: "Trains first." },
      { type: "text", text: "The 7:10." },
      { type: "source", url: "https://example.com/trains", title: "Timetable" },
    ]);
    assert.equal(draft.text, "The 7:10.");
    // The thought grows by deltas on its own part, as text does.
    const deltas = events.filter((event) => event.type === "message.delta");
    assert.deepEqual(
      deltas.map((event) => event.type === "message.delta" && [event.part, event.text]),
      [
        [0, "Trains "],
        [0, "first."],
        [1, "The 7:10."],
      ],
    );
  });
});
