import type { Agent, Card } from "@wizards-bot/protocol";
import { describe, expect, it } from "vitest";
import { chatOf, onlyCard, waitedFor } from "./needs";

const agent = (id: string, over: Partial<Agent> = {}): Agent => ({
  id,
  name: id,
  kind: "round",
  about: "",
  origin: "own",
  state: "idle",
  open: 0,
  conversationId: `cnv_${id}`,
  preview: "",
  unread: 0,
  updatedAt: "2026-11-25T09:12:00.000Z",
  main: false,
  ...over,
});

const card = (id: string, over: Partial<Card> = {}): Card => ({
  id,
  kind: "question",
  level: "needs_you",
  state: "open",
  title: "Which zone?",
  actions: [],
  agentId: "law",
  conversationId: "cnv_law",
  messageId: "msg_1",
  createdAt: "2026-11-25T09:12:00.000Z",
  ...over,
});

const law = agent("law");
const taxi = agent("taxi");

describe("onlyCard", () => {
  it("is the one card that waits, with the agent whose chat shows it", () => {
    const only = card("a");
    expect(onlyCard([only], [taxi, law])).toEqual({ card: only, agent: law });
  });
  it("is none with several cards, or with none", () => {
    expect(onlyCard([card("a"), card("b")], [law])).toBeUndefined();
    expect(onlyCard([], [law])).toBeUndefined();
  });
  it("is none for a card of a conversation without a chat here", () => {
    const guest = card("a", { conversationId: "cnv_guest" });
    expect(chatOf(guest, [law])).toBeUndefined();
    expect(onlyCard([guest], [law])).toBeUndefined();
  });
});

describe("waitedFor", () => {
  it("names the agents one waits for, those that need the person first", () => {
    const goose = agent("goose", {
      waitsFor: [{ agentId: "taxi" }, { agentId: "law", cardId: "crd_1" }, { agentId: "gone" }],
    });
    expect(waitedFor(goose, [goose, taxi, law])).toEqual([
      { agent: law, cardId: "crd_1" },
      { agent: taxi },
    ]);
  });
  it("is empty for an agent that waits for none", () => {
    expect(waitedFor(law, [law])).toEqual([]);
  });
});
