import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type TestHome, testHome } from "../test/fakes.ts";
import { cacheMarks, type PromptMessage } from "./cache.ts";

const MARK = { cacheControl: { type: "ephemeral" } };
const text = (value: string) => [{ type: "text", text: value }];
const isMarked = (message: PromptMessage | undefined): boolean =>
  JSON.stringify(message?.providerOptions?.anthropic) === JSON.stringify(MARK);

describe("the prompt cache", () => {
  test("marks the end of what was said before, never the newest message", () => {
    const prompt: PromptMessage[] = [
      { role: "system", content: "You are Goose." },
      { role: "user", content: text("Hello") },
      { role: "assistant", content: text("Hi.") },
      { role: "user", content: text("How are you?") },
    ];
    const marked = cacheMarks(prompt, "[home] It is Monday.");
    assert.deepEqual(marked.map(isMarked), [false, false, true, false]);
    assert.deepEqual(marked[3]?.content, [
      { type: "text", text: "How are you?" },
      { type: "text", text: "\n\n[home] It is Monday." },
    ]);
    // Only the newest message carries the context.
    assert.deepEqual(marked[1]?.content, text("Hello"));
  });

  test("marks the last step once tool steps follow the newest message", () => {
    const prompt: PromptMessage[] = [
      { role: "system", content: "You are Goose." },
      { role: "user", content: text("Is the train on time?") },
      { role: "assistant", content: [{ type: "tool-call", toolName: "look_up" }] },
      { role: "tool", content: [{ type: "tool-result", toolName: "look_up" }] },
    ];
    assert.deepEqual(cacheMarks(prompt).map(isMarked), [false, false, false, true]);
  });

  test("keeps what the provider options say besides the mark", () => {
    const prompt: PromptMessage[] = [
      { role: "user", content: text("One"), providerOptions: { anthropic: { other: 1 } } },
      { role: "user", content: text("Two") },
    ];
    assert.deepEqual(cacheMarks(prompt)[0]?.providerOptions, {
      anthropic: { other: 1, ...MARK },
    });
  });
});

describe("what an agent reads", () => {
  let t: TestHome;
  before(async () => {
    t = await testHome("Ada");
  });
  after(() => t.stop());

  test("the system prompt stays the same from turn to turn; the time goes with the newest message", async () => {
    t.model.script.push({ text: "Good morning." }, { text: "Noted." });
    await t.say("Good morning");
    const conversationId = t.home.store.mainAgent().conversationId;
    t.home.store.createDocument({
      conversationId,
      title: "Packing",
      content: "- socks",
    });
    await t.say("I wrote a list");
    const [first, second] = t.model.requests.slice(-2);
    assert.ok(first && second);
    assert.equal(second.messages[0]?.content, first.messages[0]?.content);
    assert.doesNotMatch(second.messages[0]?.content ?? "", /\[home\] It is |"Packing"/);
    assert.match(second.context, /^\[home\] It is /);
    assert.match(second.context, /"Packing"/);
    // The second request starts with everything the first one sent.
    assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
  });
});
