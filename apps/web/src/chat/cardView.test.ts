import { CHAT_LIBRARY } from "@engenty/chatviews/chat";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Card } from "@wizards-bot/protocol";
import { createElement } from "react";
import { prerender } from "react-dom/static";
import { describe, expect, it, vi } from "vitest";
import { VIEW_LIBRARY } from "../lib/views";
import { CardView } from "./CardView";
import { formOf, stateOf, valuesOf } from "./viewForm";

// The chat's Markdown cleans its HTML with the browser's own parser, which is not here: a card's
// body stands as its text.
vi.mock("../ui/Markdown", () => ({
  Markdown: ({ text }: { text: string }) => createElement("div", null, text),
}));

const TABLE = [
  "root = Column([title, tasks])",
  'title = Text("Open tasks", "h3")',
  'tasks = Table([{"task": "Offer", "due": "Friday"}, {"task": "Invoice", "due": "Monday"}])',
].join("\n");

const FORM = [
  "root = Column([booking, ask])",
  'booking = Form([people, day, note], "Send it", "Table for Friday")',
  'people = Field("people", "number", "How many people", true)',
  'day = Field("day", "select", "Which day", true, ["Friday", "Saturday"], "Friday")',
  'note = Field("note", "textarea", "Anything else")',
  'ask = Button("Another day", @ToAssistant("Offer me another day"))',
].join("\n");

const card = (over: Partial<Card> = {}): Card => ({
  id: "crd_1",
  kind: "info",
  level: "update",
  state: "open",
  title: "Open tasks",
  body: "Offer on Friday, invoice on Monday.",
  actions: [],
  agentId: "main",
  conversationId: "cnv_main",
  messageId: "msg_1",
  createdAt: "2026-11-25T09:12:00.000Z",
  ...over,
});

/** The card as the page draws it, once everything it waits for is there. */
async function drawn(shown: Card): Promise<string> {
  const page = createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    createElement(CardView, { card: shown }),
  );
  const { prelude } = await prerender(page);
  return new Response(prelude).text();
}

describe("a card with a view", () => {
  it("draws a table from the program, not the card's text", async () => {
    const html = await drawn(card({ view: { program: TABLE, library: VIEW_LIBRARY } }));
    expect(html).toContain("<table");
    expect(html).toContain("Invoice");
    expect(html).toContain("Monday");
    expect(html).toContain("Open tasks");
    expect(html).not.toContain("Offer on Friday, invoice on Monday.");
  });

  it("draws a form from the program, with its fields and its buttons", async () => {
    const html = await drawn(
      card({
        kind: "question",
        level: "needs_you",
        title: "Table for Friday",
        view: { program: FORM, library: VIEW_LIBRARY },
      }),
    );
    expect(html).toContain("How many people");
    expect(html).toContain("Which day");
    expect(html).toContain("<textarea");
    expect(html).toContain("Send it");
    expect(html).toContain("Another day");
  });

  it("shows what an answered form was sent with, and who sent it", async () => {
    const html = await drawn(
      card({
        kind: "question",
        level: "needs_you",
        state: "answered",
        view: { program: FORM, library: VIEW_LIBRARY },
        answer: {
          action: "view",
          message: "Send it",
          state: { people: 4, day: "Saturday", note: null },
          by: "Ben’s iPhone",
          person: { id: "usr_ben", name: "Ben" },
          at: "2026-11-25T09:13:00.000Z",
        },
      }),
    );
    expect(html).toContain("Sent by Ben");
    expect(html).toContain("“Send it”");
    // Its send button is gone: the first answer counts.
    expect(html).not.toMatch(/<button[^>]*>Send it<\/button>/);
  });

  it("shows title and body where the library is not one this app draws", async () => {
    const html = await drawn(card({ view: { program: TABLE, library: "engenty:core/9" } }));
    expect(html).toContain("Offer on Friday, invoice on Monday.");
    expect(html).not.toContain("<table");
  });

  it("names the library the home stores", () => {
    expect(VIEW_LIBRARY).toBe(CHAT_LIBRARY);
  });
});

describe("a card without a view", () => {
  it("is drawn as before: title, body and one button for each action", async () => {
    const html = await drawn(
      card({
        kind: "approval",
        level: "needs_you",
        title: "Remove “Tax”?",
        body: "Its conversation goes with it.",
        actions: [
          { id: "remove", label: "Remove agent", style: "danger" },
          { id: "keep", label: "Keep it", style: "plain" },
        ],
      }),
    );
    expect(html).toContain("Remove “Tax”?");
    expect(html).toContain("Its conversation goes with it.");
    expect(html).toMatch(/<button[^>]*>Remove agent<\/button>/);
    expect(html).toMatch(/<button[^>]*>Keep it<\/button>/);
    expect(html).not.toContain("<table");
  });
});

describe("a view's form", () => {
  const form = formOf(FORM);

  it("is read from the program: its name and its fields with what they start with", () => {
    expect(form).toEqual({
      name: "booking",
      fields: [
        { name: "people", value: undefined },
        { name: "day", value: "Friday" },
        { name: "note", value: undefined },
      ],
    });
    expect(formOf(TABLE)).toBeUndefined();
  });

  it("gives every field's value as the person left it", () => {
    if (!form) throw new Error("no form");
    // OpenUI keeps only what was touched: `day` keeps what the program gave it.
    const state = { booking: { people: { value: 4, componentType: "Field" } } };
    expect(valuesOf(form, state)).toEqual({ people: 4, day: "Friday", note: null });
    expect(valuesOf(form, undefined)).toEqual({ people: null, day: "Friday", note: null });
  });

  it("turns sent values back into the state the renderer starts with", () => {
    if (!form) throw new Error("no form");
    expect(stateOf(form, { people: 4, day: "Saturday", note: null })).toEqual({
      booking: { people: { value: 4 }, day: { value: "Saturday" } },
    });
  });
});
