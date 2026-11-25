import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type TestHome, testHome } from "../test/fakes.ts";
import { KNOWN_TOOLS, traitOf } from "./harness.ts";

const offered = (t: TestHome) =>
  ((t.model.requests.at(-1)?.tools ?? []) as { function: { name: string } }[]).map(
    (tool) => tool.function.name,
  );
const heard = (t: TestHome) =>
  ((t.model.requests.at(-1)?.messages ?? []) as { role: string; content: string }[]).findLast(
    (message) => message.role === "tool",
  )?.content ?? "";
const friday = { title: "Bills", prompt: "Remind Ada of the bills", every: "week", time: "09:00" };
const rules = (t: TestHome) => t.home.tasks.lines(t.home.store.mainAgent().id);
const card = (t: TestHome) => t.home.store.items().at(-1);

describe("the harness around an agent's tools", () => {
  test("keeps the few in the prompt, by name, and finds the others", async () => {
    const t = await testHome("Ada");
    try {
      t.model.script.push(
        { calls: [{ name: "tool_search", arguments: { query: "set a repeating task" } }] },
        { text: "Found it." },
      );
      await t.say("Can you remind me of things?");
      const names = offered(t);
      assert.ok(names.length < 20, names.join(" "));
      assert.deepEqual(names, [...names].sort());
      for (const name of ["ask", "remember", "tool_search", "tool_call"])
        assert.ok(names.includes(name), name);
      assert.ok(!names.includes("schedule_set"));
      assert.match(heard(t), /Nothing has been done yet[\s\S]*schedule_set[\s\S]*weekday/);
    } finally {
      t.stop();
    }
  });

  test("runs what is called through it as its own tool, with its line in the chat", async () => {
    const t = await testHome("Ada");
    try {
      t.model.script.push(
        {
          calls: [
            {
              name: "tool_call",
              arguments: { name: "schedule_set", input: { ...friday, weekday: 5 } },
            },
          ],
        },
        { text: "Every Friday at 9." },
      );
      const reply = await t.say("Remind me of the bills every Friday");
      assert.match(rules(t).join("\n"), /every Friday at 09:00/);
      assert.ok(reply.parts.some((p) => p.type === "activity" && p.label === "Scheduling a task"));
      assert.equal(reply.unsourced, undefined);
      assert.match(heard(t), /every Friday at 09:00/);
    } finally {
      t.stop();
    }
  });

  test("never runs a tool that does not exist, nor one that lacks an input", async () => {
    const t = await testHome("Ada");
    try {
      t.model.script.push(
        { calls: [{ name: "tool_call", arguments: { name: "reminder_create", input: {} } }] },
        { calls: [{ name: "tool_call", arguments: { name: "schedule_set", input: {} } }] },
        { text: "I could not." },
      );
      await t.say("Remind me");
      const tools = t.model.requests.flatMap((request) =>
        ((request.messages ?? []) as { role: string; content: string }[])
          .filter((message) => message.role === "tool")
          .map((message) => message.content),
      );
      assert.ok(tools.some((text) => /no tool “reminder_create”, and nothing was done/.test(text)));
      assert.ok(tools.some((text) => /schedule_set needs title, prompt/.test(text)));
      assert.deepEqual(rules(t), []);
    } finally {
      t.stop();
    }
  });
});

describe("a small model", () => {
  test("changes something only after the person read what it will do", async () => {
    const t = await testHome("Ada", undefined, { level: "basic" });
    try {
      const call = {
        name: "tool_call",
        arguments: { name: "schedule_set", input: { ...friday, every: "weekday" } },
      };
      t.model.script.push({ calls: [call] });
      await t.say("Remind me of the bills every Friday");
      assert.deepEqual(rules(t), []);
      const asked = card(t);
      // The days themselves: three in a row are not every Friday.
      assert.equal((asked?.body ?? "").match(/^- /gm)?.length, 3);

      t.model.script.push({ text: "Then not." });
      await t.answer(asked?.id ?? "", "leave");
      await t.home.turns.idle();
      assert.deepEqual(rules(t), []);
      assert.match(heard(t), /person said no/);

      t.model.script.push({ calls: [call] });
      await t.say("Do it");
      t.model.script.push({ text: "Done." });
      await t.answer(card(t)?.id ?? "", "do");
      await t.home.turns.idle();
      assert.equal(rules(t).length, 1);
    } finally {
      t.stop();
    }
  });

  test("is not given what it cannot be trusted with, whatever way it calls it", async () => {
    const t = await testHome("Ada", undefined, { level: "basic" });
    try {
      t.model.script.push(
        {
          calls: [
            {
              name: "tool_call",
              arguments: { name: "agent_create", input: { name: "Tax", instructions: "x" } },
            },
          ],
        },
        { text: "I cannot." },
      );
      await t.say("Make a bot for my taxes");
      assert.ok(!offered(t).includes("artifact_write"));
      assert.match(heard(t), /more capable/);
      assert.equal(t.home.store.agents().length, 1);
    } finally {
      t.stop();
    }
  });

  test("an answer without a source says so, one that read something does not", async () => {
    const t = await testHome("Ada", undefined, { level: "basic" });
    try {
      t.model.script.push({ text: "§ 12 says three metres." });
      assert.equal((await t.say("How high may a sauna be?")).unsourced, true);
      t.model.script.push(
        { calls: [{ name: "tool_call", arguments: { name: "task_list", input: {} } }] },
        { text: "You have no tasks." },
      );
      assert.equal((await t.say("Which tasks run?")).unsourced, undefined);
    } finally {
      t.stop();
    }
  });
});

describe("the traits of the tools", () => {
  test("name every tool of a home that changes something or needs more", async () => {
    const t = await testHome("Ada");
    try {
      let names: string[] = [];
      const tools = t.home.tools.bind(t.home);
      t.home.tools = (context) => {
        const made = tools(context);
        names = made.map((tool) => tool.name);
        return made;
      };
      t.model.script.push({ text: "Hello." });
      await t.say("Hi");
      const unnamed = names.filter(
        (name) =>
          !(KNOWN_TOOLS.includes(name) || t.home.skills.owned(name)) && traitOf(name).changes,
      );
      assert.deepEqual(unnamed, []);
    } finally {
      t.stop();
    }
  });
});
