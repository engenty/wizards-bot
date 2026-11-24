import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CallOptions } from "@engenty/local-models/ollama";
import {
  type ClientSessions,
  type ClientTurn,
  clientModel,
  SUBSCRIPTIONS,
  turnEvents,
} from "./client-model.ts";

type Said = ["user" | "assistant", string];

const prompt = (said: Said[]): CallOptions["prompt"] => [
  { role: "system", content: "Be brief." },
  ...said.map(([role, text]) => ({ role, content: [{ type: "text" as const, text }] })),
];

/** A client that answers from a script and remembers what it was asked. */
function fakeClient(replies: (string | Error)[]) {
  const turns: ClientTurn[] = [];
  let stored: { id: string; last: string } | null = null;
  const sessions: ClientSessions = {
    load: () => stored,
    save: (session) => {
      stored = session;
    },
  };
  const model = clientModel({
    provider: "claude",
    model: "default",
    mcpToken: "token",
    sessions,
    run: async (turn, onEvent) => {
      turns.push(turn);
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      onEvent({ kind: "delta", text: reply ?? "" });
      onEvent({ kind: "session", id: `session-${turns.length}` });
    },
  });
  const ask = async (said: Said[]): Promise<string> => {
    const { stream } = await model.doStream({ prompt: prompt(said) } as CallOptions);
    let text = "";
    for await (const part of stream) {
      if (part.type === "text-delta") text += part.delta;
      if (part.type === "error") throw part.error;
    }
    return text;
  };
  /** One message of the person made of several text parts. */
  const askParts = async (parts: { type: "text"; text: string }[]): Promise<void> => {
    const { stream } = await model.doStream({
      prompt: [
        { role: "system", content: "Be brief." },
        { role: "user", content: parts },
      ],
    } as CallOptions);
    for await (const _ of stream);
  };
  return { turns, ask, askParts, session: () => stored };
}

describe("a subscription client as a model", () => {
  test("starts its own conversation with everything said so far", async () => {
    const client = fakeClient(["Noted."]);
    assert.equal(await client.ask([["user", "I like trains"]]), "Noted.");
    assert.equal(client.turns[0]?.session, null);
    assert.equal(client.turns[0]?.system, "Be brief.");
    assert.equal(client.turns[0]?.message, "I like trains");
    assert.equal(client.session()?.id, "session-1");
  });

  test("resumes that conversation and is told only what it has not read", async () => {
    const client = fakeClient(["Noted.", "Trains."]);
    await client.ask([["user", "I like trains"]]);
    await client.ask([
      ["user", "I like trains"],
      ["assistant", "Noted."],
      ["user", "[home] The person answered a card"],
      ["user", "What do I like?"],
    ]);
    assert.equal(client.turns[1]?.session, "session-1");
    assert.equal(
      client.turns[1]?.message,
      "The conversation since your last turn:\nPerson: [home] The person answered a card\n\nNow:\nWhat do I like?",
    );
  });

  test("reads the turn's context with the newest message, set apart from it", async () => {
    const client = fakeClient(["Noted."]);
    await client.askParts([
      { type: "text", text: "What is on today?" },
      { type: "text", text: "\n\n[home] It is Monday." },
    ]);
    assert.equal(client.turns[0]?.message, "What is on today?\n\n[home] It is Monday.");
  });

  test("reads everything again when its last answer is not in what it is shown", async () => {
    const client = fakeClient(["Noted.", "Hello."]);
    await client.ask([["user", "I like trains"]]);
    await client.ask([
      ["assistant", "Something another model wrote."],
      ["user", "Hello?"],
    ]);
    assert.equal(client.turns[1]?.session, null);
    assert.match(
      client.turns[1]?.message ?? "",
      /^The conversation so far:\nYou: Something another model wrote\./,
    );
  });

  test("starts over when the client no longer knows the conversation", async () => {
    const client = fakeClient(["Noted.", new Error("No conversation found"), "Fresh."]);
    await client.ask([["user", "I like trains"]]);
    const reply = await client.ask([
      ["user", "I like trains"],
      ["assistant", "Noted."],
      ["user", "Again?"],
    ]);
    assert.equal(reply, "Fresh.");
    assert.deepEqual(
      client.turns.map((turn) => turn.session),
      [null, "session-1", null],
    );
    assert.match(client.turns[2]?.message ?? "", /^The conversation so far:/);
  });
});

describe("Claude's output in a turn", () => {
  const line = (read: (line: string) => unknown, event: unknown) => read(JSON.stringify(event));

  test("a failed API call is a failure, not an answer", () => {
    const read = turnEvents(SUBSCRIPTIONS.claude.client);
    assert.deepEqual(
      line(read, {
        type: "assistant",
        message: {
          model: "<synthetic>",
          content: [
            {
              type: "text",
              text: "API Error: 400 You have reached your specified API usage limits.",
            },
          ],
        },
      }),
      [
        {
          kind: "failure",
          detail: "API Error: 400 You have reached your specified API usage limits.",
        },
      ],
    );
    assert.deepEqual(
      line(read, {
        type: "assistant",
        message: { model: "claude", content: [{ type: "text", text: "Hi" }] },
      }),
      [{ kind: "text", text: "Hi" }],
    );
  });

  test("streamed text is not told again when the whole message follows", () => {
    const read = turnEvents(SUBSCRIPTIONS.claude.client);
    const delta = (text: string) => ({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text } },
    });
    assert.deepEqual(line(read, delta("Hel")), [{ kind: "delta", text: "Hel" }]);
    assert.deepEqual(line(read, delta("lo")), [{ kind: "delta", text: "lo" }]);
    assert.deepEqual(
      line(read, {
        type: "assistant",
        message: {
          model: "claude",
          content: [
            { type: "text", text: "Hello" },
            { type: "tool_use", name: "mcp__home__remember", input: {} },
          ],
        },
      }),
      [{ kind: "tool", name: "mcp__home__remember", started: true }],
    );
    assert.deepEqual(
      line(read, {
        type: "assistant",
        message: { model: "claude", content: [{ type: "text", text: "Done." }] },
      }),
      [{ kind: "text", text: "Done." }],
    );
  });
});
