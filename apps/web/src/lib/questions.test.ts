import type { Card, CardField, Message } from "@wizards-bot/protocol";
import { describe, expect, it } from "vitest";
import {
  answersOf,
  answerText,
  formOf,
  isFree,
  missingIn,
  questionsIn,
  targetOf,
} from "./questions";

const card = (id: string, over: Partial<Card> = {}): Card => ({
  id,
  kind: "question",
  level: "needs_you",
  state: "open",
  title: "Wie hoch?",
  reply: { placeholder: "Höhe" },
  actions: [],
  agentId: "agt_1",
  conversationId: "cnv_1",
  messageId: `msg_${id}`,
  createdAt: "2026-11-25T09:12:00.000Z",
  ...over,
});

const FORM: CardField[] = [
  { id: "p1", label: "Höhe", type: "number", unit: "m", required: true },
  {
    id: "p2",
    label: "Abstand",
    type: "number",
    unit: "m",
    required: true,
    unsure: "Weiß ich nicht",
  },
  {
    id: "p3",
    label: "Material",
    type: "multi",
    options: [
      { id: "o1", label: "Holz" },
      { id: "o2", label: "Stein" },
    ],
  },
  { id: "p4", label: "Beginn", type: "date" },
  { id: "p5", label: "Plan", type: "file" },
];

const idle = { working: false };
const a = card("a");
const b = card("b");

describe("what kind of question", () => {
  it("is free, a form, or a choice", () => {
    const form = card("f", { fields: FORM });
    const choice = card("c", { actions: [{ id: "choice_0", label: "Ja", style: "primary" }] });
    expect([isFree(a), isFree(form), isFree(choice)]).toEqual([true, false, false]);
    expect([formOf(a), formOf(form), formOf(choice)]).toEqual([undefined, FORM, undefined]);
    expect(formOf(card("x", { reply: undefined, fields: FORM }))).toBeUndefined();
  });
  it("only an open question of the chat counts", () => {
    const other = card("o", { conversationId: "cnv_2" });
    const approval = card("y", { reply: undefined });
    expect(questionsIn([a, other, approval], "cnv_1")).toEqual([a]);
  });
});

describe("targetOf", () => {
  it("is the newest, or the one the person picked", () => {
    expect(targetOf([a, b], undefined, idle)).toBe(b);
    expect(targetOf([a, b], { cardId: "a", newest: "b" }, idle)).toBe(a);
    expect(targetOf([], undefined, idle)).toBeUndefined();
  });
  it("is none once the person writes about something else, until a newer question comes", () => {
    const none = { cardId: null, newest: "a" };
    expect(targetOf([a], none, idle)).toBeUndefined();
    expect(targetOf([a, b], none, idle)).toBe(b);
  });
  it("is the newest again when the picked one is answered", () => {
    expect(targetOf([b], { cardId: "a", newest: "b" }, idle)).toBe(b);
  });
  it("is not an earlier question while the agent works on something else", () => {
    const last = { id: "msg_x" } as Message;
    expect(targetOf([a], undefined, { working: true, last })).toBeUndefined();
    expect(targetOf([a], { cardId: "a", newest: "a" }, { working: true, last })).toBe(a);
    const own = { id: "msg_a" } as Message;
    expect(targetOf([a], undefined, { working: true, last: own })).toBe(a);
  });
});

describe("answersOf", () => {
  it("names the question, says none, or nothing where none waits", () => {
    expect(answersOf([a], a)).toEqual({ answers: "a" });
    expect(answersOf([a], undefined)).toEqual({ answers: null });
    expect(answersOf([], undefined)).toEqual({});
  });
});

describe("a form", () => {
  it("misses what is required and what may be unknown but was not said", () => {
    expect(missingIn(FORM, {})).toEqual(["p1", "p2"]);
    expect(missingIn(FORM, { p1: "2,4", p2: "unsure" })).toEqual([]);
  });
  it("shows each answer as words", () => {
    const values = { p1: "2,4", p2: "unsure", p3: ["o1", "o2"], p4: "2026-12-31", p5: ["f1"] };
    const said = FORM.map((field) => answerText(field, values, "de", (n) => `${n} Datei`));
    expect(said).toEqual([
      "2,4 m",
      "Weiß ich nicht",
      "Holz, Stein",
      "31. Dezember 2026",
      "1 Datei",
    ]);
    expect(answerText(FORM[0] as CardField, {}, "de", String)).toBeUndefined();
  });
});
