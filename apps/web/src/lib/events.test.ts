import { QueryClient } from "@tanstack/react-query";
import type { Agent, Card, Message } from "@wizards-bot/protocol";
import { describe, expect, it } from "vitest";
import { applyEvent, itemsWith, type Thread, withDelta, withMessage } from "./events";
import { keys } from "./keys";

const card = (over: Partial<Card> = {}): Card => ({
  id: "crd_1",
  kind: "approval",
  level: "needs_you",
  state: "open",
  title: "Send the invitation to Anna?",
  actions: [{ id: "yes", label: "Send", style: "primary" }],
  agentId: "agt_1",
  conversationId: "cnv_1",
  messageId: "msg_2",
  createdAt: "2026-11-21T09:12:00.000Z",
  ...over,
});

const message = (over: Partial<Message> = {}): Message => ({
  id: "msg_1",
  conversationId: "cnv_1",
  role: "agent",
  agentId: "agt_1",
  channel: "app",
  parts: [{ type: "text", text: "You are" }],
  state: "streaming",
  createdAt: "2026-11-21T09:12:00.000Z",
  ...over,
});

const agent = (over: Partial<Agent> = {}): Agent => ({
  id: "agt_1",
  name: "Goose",
  kind: "round",
  about: "",
  origin: "own",
  state: "idle",
  open: 0,
  conversationId: "cnv_1",
  preview: "",
  unread: 0,
  updatedAt: "2026-11-21T09:12:00.000Z",
  main: true,
  ...over,
});

/** A cache with one loaded conversation, its agent and nothing that needs the person. */
function loaded(messages: Message[] = [message()]) {
  const client = new QueryClient();
  client.setQueryData<Thread>(keys.thread("cnv_1"), { messages, more: false });
  client.setQueryData<Card[]>(keys.items(), []);
  client.setQueryData<Agent[]>(keys.agents(), [agent()]);
  return client;
}

const thread = (client: QueryClient) => client.getQueryData<Thread>(keys.thread("cnv_1"));

describe("withMessage", () => {
  it("puts a new message at the end and a known one in its place", () => {
    const start: Thread = { messages: [message(), message({ id: "msg_2" })], more: true };
    const changed = withMessage(start, message({ state: "done" }));
    expect(changed.messages.map((m) => m.id)).toEqual(["msg_1", "msg_2"]);
    expect(changed.messages[0]?.state).toBe("done");
    expect(withMessage(start, message({ id: "msg_3" })).messages).toHaveLength(3);
    expect(changed.more).toBe(true);
  });
});

describe("withDelta", () => {
  const delta = { type: "message.delta", conversationId: "cnv_1", messageId: "msg_1" } as const;

  it("adds the text to the part it names and leaves the thread it was given as it was", () => {
    const start: Thread = { messages: [message()], more: false };
    const changed = withDelta(start, { ...delta, part: 0, text: " free" });
    expect(changed.messages[0]?.parts[0]).toEqual({ type: "text", text: "You are free" });
    expect(start.messages[0]?.parts[0]).toEqual({ type: "text", text: "You are" });
  });

  it("leaves out text for a part that is none, or for a message it does not have", () => {
    const start: Thread = {
      messages: [message({ parts: [{ type: "activity", label: "Reading", state: "running" }] })],
      more: false,
    };
    expect(withDelta(start, { ...delta, part: 0, text: "x" })).toBe(start);
    expect(withDelta(start, { ...delta, part: 4, text: "x" })).toBe(start);
    expect(withDelta(start, { ...delta, messageId: "msg_9", part: 0, text: "x" })).toBe(start);
  });
});

describe("itemsWith", () => {
  it("lists a card that waits once, and takes it out when it is answered", () => {
    const waiting = itemsWith(itemsWith([], card()), card({ title: "Send it?" }));
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.title).toBe("Send it?");
    expect(itemsWith(waiting, card({ state: "answered" }))).toEqual([]);
  });

  it("does not list a card that only tells", () => {
    expect(itemsWith([], card({ level: "update" }))).toEqual([]);
  });
});

describe("applyEvent", () => {
  it("writes a message, its text as it comes, and its end", () => {
    const client = loaded();
    applyEvent(client, {
      type: "message.delta",
      conversationId: "cnv_1",
      messageId: "msg_1",
      part: 0,
      text: " free after 14:00.",
    });
    expect(thread(client)?.messages[0]?.parts[0]).toEqual({
      type: "text",
      text: "You are free after 14:00.",
    });
    applyEvent(client, { type: "message.updated", message: message({ state: "done" }) });
    expect(thread(client)?.messages[0]?.state).toBe("done");
  });

  it("lists the card a new message carries, and shows its answer everywhere", () => {
    const client = loaded();
    const asked = message({ id: "msg_2", parts: [{ type: "card", card: card() }] });
    applyEvent(client, { type: "message.created", message: asked });
    expect(client.getQueryData<Card[]>(keys.items())).toHaveLength(1);

    const answered = card({
      state: "answered",
      answer: { action: "yes", by: "Watch", at: "2026-11-21T09:13:00.000Z" },
    });
    applyEvent(client, { type: "card.updated", card: answered });
    expect(client.getQueryData<Card[]>(keys.items())).toEqual([]);
    expect(thread(client)?.messages[1]?.parts[0]).toEqual({ type: "card", card: answered });
  });

  it("leaves a conversation that is not loaded alone", () => {
    const client = loaded();
    applyEvent(client, {
      type: "message.created",
      message: message({ id: "msg_9", conversationId: "cnv_2" }),
    });
    expect(client.getQueryData(keys.thread("cnv_2"))).toBeUndefined();
  });

  it("keeps the agents as the home has them", () => {
    const client = loaded();
    applyEvent(client, { type: "agent.updated", agent: agent({ state: "working" }) });
    applyEvent(client, { type: "agent.updated", agent: agent({ id: "agt_2", main: false }) });
    expect(client.getQueryData<Agent[]>(keys.agents())?.map((a) => a.state)).toEqual([
      "working",
      "idle",
    ]);
    applyEvent(client, { type: "agent.removed", agentId: "agt_2" });
    expect(client.getQueryData<Agent[]>(keys.agents())).toHaveLength(1);
  });

  it("takes the person's avatar, and that there is none", () => {
    const client = loaded();
    const avatar = {
      skin: "medium",
      hair: { style: "short", color: "brown" },
      glasses: "none",
      beard: "none",
      hat: { style: "none", color: "grey" },
      top: { style: "tee", color: "orange" },
      bottom: { style: "trousers", color: "navy" },
      shoes: { style: "sneakers", color: "white" },
      accessory: { style: "none", color: "red" },
    } as const;
    applyEvent(client, { type: "avatar.updated", avatar });
    expect(client.getQueryData(keys.avatar())).toEqual(avatar);
    applyEvent(client, { type: "avatar.updated", avatar: null });
    expect(client.getQueryData(keys.avatar())).toBeNull();
  });

  it("takes the folders and the models whole", () => {
    const client = loaded();
    const folder = {
      id: "fld_1",
      name: "Trips",
      path: "/Users/ada/Documents/Trips",
      access: "read" as const,
      createdAt: "2026-11-21T09:12:00.000Z",
    };
    applyEvent(client, { type: "folders.updated", folders: [folder] });
    expect(client.getQueryData(keys.folders())).toEqual([folder]);
    applyEvent(client, {
      type: "models.updated",
      models: { sources: [], order: [], services: [] },
    });
    expect(client.getQueryData(keys.models())).toEqual({ sources: [], order: [], services: [] });
  });

  it("marks an open document that is behind to be loaded again, and every list after a reset", () => {
    const client = loaded();
    client.setQueryData(keys.document("doc_1"), { id: "doc_1", version: 1 });
    const meta = {
      id: "doc_1",
      title: "Week plan",
      format: "markdown" as const,
      version: 1,
      updatedAt: "2026-11-21T09:12:00.000Z",
      updatedBy: "agent" as const,
      conversationId: "cnv_1",
    };
    applyEvent(client, { type: "document.updated", document: meta });
    expect(client.getQueryState(keys.document("doc_1"))?.isInvalidated).toBe(false);
    applyEvent(client, { type: "document.updated", document: { ...meta, version: 2 } });
    expect(client.getQueryState(keys.document("doc_1"))?.isInvalidated).toBe(true);

    applyEvent(client, { type: "reset" });
    expect(client.getQueryState(keys.agents())?.isInvalidated).toBe(true);
    expect(client.getQueryState(keys.thread("cnv_1"))?.isInvalidated).toBe(true);
  });

  it("marks an open artifact that is behind to be read again, and no other one", () => {
    const client = loaded();
    client.setQueryData(keys.artifact("art_1"), { id: "art_1", version: 1 });
    client.setQueryData(keys.artifact("art_2"), { id: "art_2", version: 1 });
    const meta = {
      id: "art_1",
      title: "Spending by month",
      format: "html" as const,
      version: 1,
      updatedAt: "2026-11-21T09:12:00.000Z",
      conversationId: "cnv_1",
    };
    applyEvent(client, { type: "artifact.updated", artifact: meta });
    expect(client.getQueryState(keys.artifact("art_1"))?.isInvalidated).toBe(false);
    applyEvent(client, { type: "artifact.updated", artifact: { ...meta, version: 2 } });
    expect(client.getQueryState(keys.artifact("art_1"))?.isInvalidated).toBe(true);
    expect(client.getQueryState(keys.artifact("art_2"))?.isInvalidated).toBe(false);
    // An artifact that is not open is not loaded for the event's sake.
    applyEvent(client, { type: "artifact.updated", artifact: { ...meta, id: "art_3" } });
    expect(client.getQueryState(keys.artifact("art_3"))).toBeUndefined();
  });

  it("is not broken by an event of a newer home", () => {
    const client = loaded();
    expect(() => applyEvent(client, { type: "home.renamed" } as never)).not.toThrow();
  });
});
