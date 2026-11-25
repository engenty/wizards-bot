import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Card } from "@wizards-bot/protocol";
import { type TestHome, testHome, textOf } from "../test/fakes.ts";
import { formValues, viewAnswer, viewRules } from "./view.ts";

const TABLE = [
  "root = Column([title, tasks])",
  'title = Text("Open tasks", "h3")',
  'tasks = Table([{"task": "Offer", "due": "Friday"}, {"task": "Invoice", "due": "Monday"}])',
].join("\n");

const FORM = [
  "root = Column([form])",
  'form = Form([people, day], "Send", "Table for Friday")',
  'people = Field("people", "number", "How many people", true)',
  'day = Field("day", "select", "Which day", true, ["Friday", "Saturday"], "Friday")',
].join("\n");

const cards = (t: TestHome): Card[] =>
  t.home.store
    .messages(t.home.store.mainAgent().conversationId, { limit: 20 })
    .messages.flatMap((message) => message.parts)
    .flatMap((part) => (part.type === "card" ? [part.card] : []));

const heard = (t: TestHome) =>
  ((t.model.requests.at(-1)?.messages ?? []) as { role: string; content: string }[]).findLast(
    (message) => message.role === "tool",
  )?.content ?? "";

const show = (view: string, title = "Open tasks") => ({
  calls: [{ name: "show_view", arguments: { title, text: "Offer on Friday.", view } }],
});

describe("show_view", () => {
  test("a valid view is stored as a card with the view", async () => {
    const t = await testHome("Ada");
    try {
      t.model.script.push(show(TABLE), { text: "Your open tasks." });
      const answer = await t.say("Show my open tasks as a table");
      const [card] = cards(t);
      assert.deepEqual(card?.view, { program: TABLE, library: "engenty:core/1" });
      assert.equal(card?.kind, "info");
      assert.equal(card?.level, "update");
      assert.equal(card?.title, "Open tasks");
      // A device that cannot draw the view shows the card's text.
      assert.equal(card?.body, "Offer on Friday.");
      assert.equal(textOf(answer), "Your open tasks.");
      // The card reaches a device as it was stored.
      const read = (await (
        await t.request(`/v1/conversations/${card?.conversationId}/messages`)
      ).json()) as { messages: { parts: { type: string; card?: Card }[] }[] };
      const sent = read.messages.flatMap((message) => message.parts).find((part) => part.card);
      assert.equal(sent?.card?.view?.program, TABLE);
    } finally {
      t.stop();
    }
  });

  test("a view with a form waits for the person", async () => {
    const t = await testHome("Ada");
    try {
      t.model.script.push(show(FORM, "Table for Friday"), { text: "Fill it in." });
      await t.say("Book a table");
      const card = t.item();
      assert.equal(card.kind, "question");
      assert.equal(card.level, "needs_you");
      assert.equal(card.view?.program, FORM);
      assert.deepEqual(card.actions, []);
    } finally {
      t.stop();
    }
  });

  test("a broken view is the tool's error and stores nothing", async () => {
    const t = await testHome("Ada");
    try {
      const broken = 'root = Column([title, missing])\ntitle = Text("Open tasks", "h3")';
      t.model.script.push(show(broken), { text: "I could not show it." });
      const answer = await t.say("Show my open tasks as a table");
      assert.deepEqual(cards(t), []);
      assert.match(heard(t), /The view was not shown/);
      assert.match(heard(t), /"missing" is used but never defined/);
      assert.equal(textOf(answer), "I could not show it.");
    } finally {
      t.stop();
    }
  });

  test("a view that names a file is refused", async () => {
    const t = await testHome("Ada");
    try {
      const withPicture = 'root = Column([picture])\npicture = Image("fil_1", "A plan")';
      t.model.script.push(show(withPicture), { text: "Without the picture then." });
      await t.say("Show the plan");
      assert.deepEqual(cards(t), []);
      assert.match(heard(t), /Image: a view here shows no files/);
    } finally {
      t.stop();
    }
  });

  test("the agent's instructions say how a view is written", async () => {
    const t = await testHome("Ada");
    try {
      t.model.script.push({ text: "Hello." });
      await t.say("Hi");
      const request = t.model.requests.at(-1);
      const system = (request?.messages ?? []).find((message) => message.role === "system");
      assert.match(system?.content ?? "", /Views:/);
      assert.match(system?.content ?? "", /Table\(rows/);
      const offered = ((request?.tools ?? []) as { function: { name: string } }[]).map(
        (tool) => tool.function.name,
      );
      assert.ok(offered.includes("show_view"));
      // The library's prompt opens with the home's own words, not with its "respond in openui-lang".
      assert.doesNotMatch(viewRules("Ada"), /ENTIRE response/);
    } finally {
      t.stop();
    }
  });
});

describe("a view's answer", () => {
  test("is read as the values by field name, also as OpenUI keeps a form", () => {
    assert.deepEqual(formValues({ people: 4, day: "Friday" }), { people: 4, day: "Friday" });
    assert.deepEqual(
      formValues({
        form: { people: { value: 4, componentType: "Field" }, day: { value: "Friday" } },
      }),
      { people: 4, day: "Friday" },
    );
    assert.equal(
      viewAnswer("Table for Friday", "Send", { people: 4, note: "", vegan: false }),
      'Send\n\n[home] Sent from the view "Table for Friday". What they filled in:\n- people: 4\n- note: (left empty)\n- vegan: false',
    );
    assert.equal(
      viewAnswer("Next week", "Plan Wednesday for me", undefined),
      'Plan Wednesday for me\n\n[home] Pressed in the view "Next week".',
    );
  });
});
