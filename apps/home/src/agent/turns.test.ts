import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { z } from "zod";
import { type TestHome, testHome, textOf } from "../test/fakes.ts";
import { defineTool } from "./tool.ts";

/** A tool that runs until `release` is called, and says when it started. */
function slowTool(t: TestHome) {
  let started: () => void = () => {};
  let release: () => void = () => {};
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.home.addTools(() => [
    defineTool({
      name: "look_up",
      description: "Takes a moment.",
      input: z.object({}),
      run: async () => {
        started();
        await done;
        return "The 7:10 is on time.";
      },
    }),
  ]);
  return { running, release };
}

/** Every tool call in the newest request is followed by its result. */
function answeredCalls(t: TestHome): void {
  const messages = (t.model.requests.at(-1)?.messages ?? []) as {
    role: string;
    tool_calls?: unknown[];
  }[];
  for (const [at, message] of messages.entries()) {
    if (message.tool_calls?.length) assert.equal(messages[at + 1]?.role, "tool");
  }
}

const said = (t: TestHome) =>
  (t.model.requests.at(-1)?.messages ?? []).map((message) => `${message.role}:${message.content}`);

// What is said to an agent stays in its thread whatever becomes of the turn that read it: Mastra
// stores a turn's input as it accepts the signal.
describe("what is said to an agent", () => {
  test("is kept when the person stops the turn, and the next turn reads it", async () => {
    const t = await testHome("Ada");
    try {
      const slow = slowTool(t);
      const conversationId = t.home.store.mainAgent().conversationId;
      t.model.script.push({ calls: [{ name: "look_up", arguments: {} }] });
      const first = t.home.turns.enqueue({
        conversationId,
        text: "Is the 7:10 on time?",
        channel: "app",
      });
      await slow.running;
      t.home.turns.stop(conversationId);
      slow.release();
      await first;

      t.model.script.push({ text: "Yes, it is." });
      await t.say("And?");
      const read = said(t);
      assert.ok(read.includes("user:Is the 7:10 on time?"), read.join("\n"));
      assert.equal(read.at(-1), "user:And?");
      answeredCalls(t);
    } finally {
      t.stop();
    }
  });

  test("is kept when the person stops the turn while the model writes", async () => {
    const t = await testHome("Ada");
    try {
      const conversationId = t.home.store.mainAgent().conversationId;
      let release: () => void = () => {};
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      t.model.script.push({ text: "Let me think about it at length.", hold });
      const first = t.home.turns.enqueue({ conversationId, text: "Plan my week", channel: "app" });
      while (t.model.requests.length === 0) await new Promise((r) => setTimeout(r, 10));
      await new Promise((resolve) => setTimeout(resolve, 50));
      t.home.turns.stop(conversationId);
      // The model's request ends with the turn, not when the model is done.
      while (t.model.aborted === 0) await new Promise((r) => setTimeout(r, 10));
      release();
      await first;

      t.model.script.push({ text: "Here it is." });
      await t.say("Go on");
      const read = said(t);
      assert.ok(read.includes("user:Plan my week"), read.join("\n"));
    } finally {
      t.stop();
    }
  });

  test("is kept when the model fails, and the next turn reads it", async () => {
    const t = await testHome("Ada");
    try {
      t.model.script.push({ fail: 500 }, { fail: 500 }, { fail: 500 });
      await t.say("Plan my week");
      assert.equal(t.last().state, "failed");
      t.model.script.length = 0;
      t.model.script.push({ text: "Here it is." });
      await t.say("Try again");
      const read = said(t);
      assert.ok(read.includes("user:Plan my week"), read.join("\n"));
    } finally {
      t.stop();
    }
  });

  test("a message into a running turn is kept when the person stops that turn", async () => {
    const t = await testHome("Ada");
    try {
      const slow = slowTool(t);
      const conversationId = t.home.store.mainAgent().conversationId;
      t.model.script.push({ calls: [{ name: "look_up", arguments: {} }] });
      const first = t.home.turns.enqueue({
        conversationId,
        text: "Is the 7:10 on time?",
        channel: "app",
      });
      await slow.running;
      const second = t.home.turns.enqueue({
        conversationId,
        text: "Also book a seat.",
        channel: "app",
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      t.home.turns.stop(conversationId);
      slow.release();
      await Promise.all([first, second]);

      t.model.script.push({ text: "Which train?" });
      await t.say("Well?");
      const read = said(t);
      assert.ok(
        read.some((line) => line.startsWith("user:Also book a seat.")),
        read.join("\n"),
      );
      answeredCalls(t);
    } finally {
      t.stop();
    }
  });

  test("a message into a running turn is in the thread once", async () => {
    const t = await testHome("Ada");
    try {
      const slow = slowTool(t);
      const conversationId = t.home.store.mainAgent().conversationId;
      t.model.script.push(
        { calls: [{ name: "look_up", arguments: {} }] },
        { text: "On time, and I booked a seat." },
      );
      const first = t.home.turns.enqueue({
        conversationId,
        text: "Is the 7:10 on time?",
        channel: "app",
      });
      await slow.running;
      const second = t.home.turns.enqueue({
        conversationId,
        text: "Also book a seat.",
        channel: "app",
      });
      // The message is stored before the running turn reads it.
      await new Promise((resolve) => setTimeout(resolve, 100));
      slow.release();
      await Promise.all([first, second]);
      assert.equal(textOf(t.last()), "On time, and I booked a seat.");

      t.model.script.push({ text: "Done." });
      await t.say("Thanks");
      const read = said(t);
      assert.equal(read.filter((line) => line.startsWith("user:Also book a seat.")).length, 1);
      assert.equal(read.filter((line) => line === "user:Is the 7:10 on time?").length, 1);
    } finally {
      t.stop();
    }
  });
});

/** Sends a message as the person, as a device does. */
async function send(t: TestHome, text: string, later?: boolean) {
  const conversationId = t.home.store.mainAgent().conversationId;
  const response = await t.request(`/v1/conversations/${conversationId}/messages`, {
    body: { text, ...(later ? { later: true } : {}) },
  });
  return ((await response.json()) as { message: { id: string } }).message.id;
}

const replies = (t: TestHome) =>
  t.home.store
    .messages(t.home.store.mainAgent().conversationId, { limit: 20 })
    .messages.filter((message) => message.role === "agent")
    .map((message) => textOf(message));

describe("a message for after the answer", () => {
  test("waits for the running turn, then gets a turn of its own", async () => {
    const t = await testHome("Ada");
    try {
      const slow = slowTool(t);
      t.model.script.push(
        { calls: [{ name: "look_up", arguments: {} }] },
        { text: "The 7:10 is on time." },
        { text: "Seat 12 is booked." },
      );
      await send(t, "Is the 7:10 on time?");
      await slow.running;
      const id = await send(t, "Book me a seat.", true);
      assert.equal(t.home.store.message(id)?.queued, true);
      slow.release();
      await t.home.turns.idle();
      assert.deepEqual(replies(t), ["The 7:10 is on time.", "Seat 12 is booked."]);
      assert.equal(t.home.store.message(id)?.queued, undefined);
      // The first turn did not read it; the second did, as stored.
      const [first, , second] = t.model.requests.map((request) =>
        request.messages.map((message) => `${message.role}:${message.content}`),
      );
      assert.ok(!first?.includes("user:Book me a seat."));
      assert.equal(second?.at(-1), "user:Book me a seat.");
      assert.equal(t.model.requests.at(-1)?.asked, true);
    } finally {
      t.stop();
    }
  });

  test("is read at once when no reply is written", async () => {
    const t = await testHome("Ada");
    try {
      t.model.script.push({ text: "Done." });
      const id = await send(t, "Book me a seat.", true);
      await t.home.turns.idle();
      assert.deepEqual(replies(t), ["Done."]);
      assert.equal(t.home.store.message(id)?.queued, undefined);
    } finally {
      t.stop();
    }
  });

  test("does not run when the person stops the reply, and the next turn reads it", async () => {
    const t = await testHome("Ada");
    try {
      const slow = slowTool(t);
      t.model.script.push({ calls: [{ name: "look_up", arguments: {} }] });
      await send(t, "Is the 7:10 on time?");
      await slow.running;
      const id = await send(t, "Book me a seat.", true);
      const conversationId = t.home.store.mainAgent().conversationId;
      t.home.turns.stop(conversationId);
      slow.release();
      await t.home.turns.idle();
      assert.equal(t.home.store.message(id)?.queued, undefined);
      const asked = t.model.requests.length;
      assert.equal(asked, 1);

      t.model.script.push({ text: "Which seat?" });
      await t.say("And a window seat.");
      const read = said(t);
      assert.ok(read.includes("user:Book me a seat."), read.join("\n"));
      assert.equal(read.at(-1), "user:And a window seat.");
      answeredCalls(t);
    } finally {
      t.stop();
    }
  });

  test("goes before the next turn of longer work", async () => {
    const t = await testHome("Ada");
    try {
      const slow = slowTool(t);
      t.model.script.push(
        { calls: [{ name: "look_up", arguments: {} }] },
        { calls: [{ name: "go_on", arguments: { done: "Looked it up.", next: "Book it" } }] },
        { text: "Looked it up." },
        { text: "Yes, the 7:10." },
        { text: "Booked." },
      );
      await send(t, "Find a train and book it.");
      await slow.running;
      await send(t, "Is it the 7:10?", true);
      slow.release();
      await t.home.turns.idle();
      assert.deepEqual(replies(t), ["Looked it up.", "Yes, the 7:10.", "Booked."]);
      const last = said(t);
      assert.match(last.at(-1) ?? "", /Go on with your work/);
    } finally {
      t.stop();
    }
  });
});

describe("a model that reads ahead", () => {
  test("reads what the next turn starts with, and leaves nothing in the conversation", async () => {
    const t = await testHome("Ada");
    try {
      const { models, store, turns } = t.home;
      const { conversationId } = store.mainAgent();
      t.model.script.push({ text: "Hello." });
      await t.say("Hi.");

      const before = store.messages(conversationId, { limit: 50 }).messages.length;
      await turns.readAhead(conversationId);
      assert.equal(t.model.requests.length, 1, "a model that cannot read ahead is not asked");

      const engine = models.engine.bind(models);
      models.engine = (ref) => {
        const found = engine(ref);
        return found && { ...found, ahead: () => found.model({ mcpToken: "", conversationId }) };
      };
      t.model.script.push({ text: "" });
      await turns.readAhead(conversationId);
      const ahead = t.model.requests.at(-1);
      assert.equal(said(t).at(-1), "user:.");
      assert.equal(store.messages(conversationId, { limit: 50 }).messages.length, before);

      t.model.script.push({ text: "Yes." });
      await t.say("And?");
      const turn = t.model.requests.at(-1);
      assert.deepEqual(ahead?.tools, turn?.tools);
      assert.deepEqual(ahead?.messages?.slice(0, -1), turn?.messages?.slice(0, -1));
      assert.ok(!said(t).includes("user:."));
    } finally {
      t.stop();
    }
  });
});

// A view never holds a tool: its answer is the person's next message, with what they filled in.
describe("a view's answer", () => {
  const form = [
    "root = Column([form])",
    'form = Form([people, day], "Send", "Table for Friday")',
    'people = Field("people", "number", "How many people", true)',
    'day = Field("day", "select", "Which day", true, ["Friday", "Saturday"], "Friday")',
  ].join("\n");
  const shows = (view: string) => ({
    calls: [{ name: "show_view", arguments: { title: "Table for Friday", text: "A form.", view } }],
  });
  const settled = async (t: TestHome) => {
    do {
      await t.home.idle();
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (t.home.store.agents().some((agent) => agent.state === "working"));
  };

  test("reaches the agent as the person's message, with the form's values", async () => {
    const t = await testHome("Ada");
    try {
      t.model.script.push(shows(form), { text: "Fill it in." });
      await t.say("Book a table");
      const card = t.item();
      t.model.script.push({ text: "Booked for four on Friday." });
      const answered = await t.request(`/v1/cards/${card.id}/answer`, {
        body: { action: "view", message: "Send", state: { people: 4, day: "Friday" } },
      });
      assert.equal(answered.status, 200);
      const { card: after } = (await answered.json()) as {
        card: { state: string; answer?: { message?: string; state?: unknown } };
      };
      assert.equal(after.state, "answered");
      assert.equal(after.answer?.message, "Send");
      assert.deepEqual(after.answer?.state, { people: 4, day: "Friday" });
      await settled(t);
      assert.equal(
        said(t).at(-1),
        'user:Send\n\n[home] Sent from the view "Table for Friday". What they filled in:\n- people: 4\n- day: "Friday"',
      );
      assert.equal(textOf(t.last()), "Booked for four on Friday.");
      answeredCalls(t);
    } finally {
      t.stop();
    }
  });

  test("the first one counts, and only a view that asks takes one", async () => {
    const t = await testHome("Ada");
    try {
      t.model.script.push(shows(form), { text: "Fill it in." });
      await t.say("Book a table");
      const card = t.item();
      const answer = (body: unknown) => t.request(`/v1/cards/${card.id}/answer`, { body });
      // A view's card has no actions of its own.
      assert.equal((await answer({ action: "send" })).status, 400);
      t.model.script.push({ text: "Booked." });
      assert.equal(
        (await answer({ action: "view", message: "Send", state: { people: 2 } })).status,
        200,
      );
      const late = await answer({ action: "view", message: "Send", state: { people: 9 } });
      assert.equal(late.status, 409);
      await settled(t);
      const read = said(t).join("\n");
      assert.match(read, /- people: 2/);
      assert.doesNotMatch(read, /- people: 9/);

      const table = 'root = Column([rows])\nrows = Table([{"task": "Offer"}])';
      t.model.script.push(shows(table), { text: "Your tasks." });
      await t.say("Show my tasks");
      const shown = t.home.store
        .openCards(card.conversationId)
        .find((open) => open.view?.program === table);
      const pressed = await t.request(`/v1/cards/${shown?.id}/answer`, {
        body: { action: "view", message: "Go on" },
      });
      assert.equal(pressed.status, 400);
    } finally {
      t.stop();
    }
  });
});
