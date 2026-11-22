import type { Card, Message } from "@wizards-bot/protocol";
import { describe, expect, it } from "vitest";
import { noticesOf } from "./notify";

const nameOf = (id: string | undefined) => (id === "agt_1" ? "Goose" : "wizards.bot");

const message = (over: Partial<Message>): Message => ({
  id: "msg_1",
  conversationId: "cnv_1",
  role: "agent",
  agentId: "agt_1",
  channel: "app",
  parts: [],
  state: "done",
  createdAt: "2026-11-21T09:12:00.000Z",
  ...over,
});

const card: Card = {
  id: "crd_1",
  kind: "approval",
  level: "needs_you",
  state: "open",
  title: "Send the invitation to Anna?",
  actions: [],
  agentId: "agt_1",
  conversationId: "cnv_1",
  messageId: "msg_1",
  createdAt: "2026-11-21T09:12:00.000Z",
};

describe("noticesOf", () => {
  it("tells a finished answer by its first text, under the agent's name", () => {
    const done = message({
      parts: [
        { type: "activity", label: "Reading your calendar", state: "done" },
        { type: "text", text: "You are free after 14:00." },
      ],
    });
    expect(noticesOf({ type: "message.updated", message: done }, nameOf)).toEqual([
      { title: "Goose", body: "You are free after 14:00.", tag: "msg_1" },
    ]);
  });

  it("says nothing while the answer is being written, or about the person's own message", () => {
    const parts = [{ type: "text" as const, text: "You are" }];
    const writing = message({ state: "streaming", parts });
    expect(noticesOf({ type: "message.updated", message: writing }, nameOf)).toEqual([]);
    const mine = message({ role: "you", parts });
    expect(noticesOf({ type: "message.updated", message: mine }, nameOf)).toEqual([]);
  });

  it("tells a card that waits by its title, and not the text around it", () => {
    const asked = message({
      parts: [
        { type: "text", text: "One thing first." },
        { type: "card", card },
      ],
    });
    expect(noticesOf({ type: "message.updated", message: asked }, nameOf)).toEqual([
      { title: "Goose", body: "Send the invitation to Anna?", tag: "crd_1" },
    ]);
  });

  it("says nothing about a card that is answered, or about any other event", () => {
    const answered = message({ parts: [{ type: "card", card: { ...card, state: "answered" } }] });
    expect(noticesOf({ type: "message.created", message: answered }, nameOf)).toEqual([]);
    expect(noticesOf({ type: "reset" }, nameOf)).toEqual([]);
  });
});
