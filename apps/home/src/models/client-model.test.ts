import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { type ClientSessions, type ClientTurn, clientModel } from "./client-model.ts";
import type { CallOptions } from "./ollama.ts";

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
  return { turns, ask, session: () => stored };
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
