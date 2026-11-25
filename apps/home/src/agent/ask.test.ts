import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Card, Message } from "@wizards-bot/protocol";
import { z } from "zod";
import { cardsAsText } from "../channels/channels.ts";
import { type TestHome, testHome } from "../test/fakes.ts";
import { formFields, isDate, numberOf, questionCard, readForm } from "./ask.ts";

const asking = (args: Record<string, unknown>) => ({ calls: [{ name: "ask", arguments: args }] });

describe("a question of an agent", () => {
  let t: TestHome;
  beforeEach(async () => {
    t = await testHome("Ada");
    t.home.db.setMeta("person.lang", "de");
  });
  afterEach(() => t.stop());

  const conversation = () => t.home.store.mainAgent().conversationId;
  const write = async (body: Record<string, unknown>) => {
    const response = await t.request(`/v1/conversations/${conversation()}/messages`, { body });
    await t.home.idle();
    return response;
  };
  const newest = () => t.model.requests.at(-1)?.messages.at(-1);
  const told = () => newest()?.content ?? "";
  const said = () =>
    t.home.store
      .messages(conversation())
      .messages.map((message) => [
        message.role,
        message.parts.map((part) =>
          part.type === "text"
            ? part.text
            : part.type === "card"
              ? part.card.title
              : part.type === "file"
                ? part.file.name
                : part.type,
        ),
      ]);

  describe("with one free answer", () => {
    it("is answered in the chat, in the same run", async () => {
      t.model.script.push({
        text: "Let me see. ",
        ...asking({ title: "Wie hoch?", hint: "Höhe" }),
      });
      await t.say("Darf ich eine Sauna bauen?");
      const card = t.item();
      assert.deepEqual(card.reply, { placeholder: "Höhe" });
      assert.equal(t.home.store.mainAgent().state, "needs_you");

      t.model.script.push({ text: "Dann ja." });
      await write({ text: "2,4 m", answers: card.id });
      assert.equal(newest()?.role, "tool");
      assert.match(told(), /^The person answered "Wie hoch\?": 2,4 m\n/);
      assert.equal(t.home.store.card(card.id)?.answer?.message, "2,4 m");
      assert.equal(t.home.store.items().length, 0);
      // The question stands once, and nothing of it again in the answer.
      assert.deepEqual(said(), [
        ["you", ["Darf ich eine Sauna bauen?"]],
        ["agent", ["Let me see. ", "Wie hoch?"]],
        ["you", ["2,4 m"]],
        ["agent", ["Dann ja."]],
      ]);
    });

    it("repeats nothing when the thread is read anew", async () => {
      t.model.script.push({ text: "Let me see. ", ...asking({ title: "Wie hoch?" }) });
      await t.say("Darf ich?");
      // biome-ignore lint/suspicious/noExplicitAny: what the home does a minute after the turn
      const turns = t.home.turns as any;
      const entry = await turns.threads.get(conversation());
      clearTimeout(entry.idle);
      entry.subscription.unsubscribe();
      turns.threads.delete(conversation());
      t.model.script.push({ text: "Dann ja." });
      await write({ text: "2,4 m" });
      assert.deepEqual(said().at(-1), ["agent", ["Dann ja."]]);
    });

    it("is answered by a message that names no question, and by no card", async () => {
      t.model.script.push(asking({ title: "Wie hoch?" }));
      await t.say("Darf ich?");
      const card = t.item();
      assert.deepEqual([card.fields, card.actions], [undefined, []]);
      const pressed = await t.request(`/v1/cards/${card.id}/answer`, { body: { action: "reply" } });
      assert.equal(pressed.status, 400);
      t.model.script.push({ text: "Dann ja." });
      await write({ text: "2,4 m" });
      assert.match(told(), /"Wie hoch\?": 2,4 m/);
    });

    it("the agent is reminded of it in a turn about something else", async () => {
      t.model.script.push(asking({ title: "Wie hoch?" }));
      await t.say("Darf ich?");
      t.model.script.push({ text: "Es ist zwölf." });
      await write({ text: "Wie spät ist es?", answers: null });
      assert.match(t.model.requests.at(-1)?.context ?? "", /still wait.*"Wie hoch\?"/);
    });

    it("stays open for a message about something else", async () => {
      t.model.script.push(asking({ title: "Wie hoch?" }));
      await t.say("Darf ich?");
      const card = t.item();
      t.model.script.push({ text: "Es ist zwölf." });
      await write({ text: "Wie spät ist es?", answers: null });
      assert.equal(t.item().id, card.id);

      t.model.script.push({ text: "Dann ja." });
      await write({ text: "2,4 m", answers: card.id });
      assert.match(told(), /\[home\] The person answered "Wie hoch\?": 2,4 m/);
      assert.equal(t.home.store.items().length, 0);
    });

    it("takes files with the answer", async () => {
      const { home } = t;
      const file = home.files.add({
        name: "plan.txt",
        mime: "text/plain",
        bytes: Buffer.from("Sauna 2 x 3 m"),
      });
      t.model.script.push(asking({ title: "Hast du einen Plan?" }));
      await t.say("Darf ich?");
      t.model.script.push({ text: "Dann ja." });
      await write({ text: "", files: [file.id] });
      assert.match(told(), /\(only the files\)[\s\S]*Sauna 2 x 3 m/);
    });

    it("one of several is answered by name, else the newest", async () => {
      t.model.script.push(asking({ title: "Wie hoch?" }));
      await t.say("Darf ich?");
      const first = t.item();
      t.model.script.push(asking({ title: "Bar oder Karte?" }));
      await write({ text: "Was anderes", answers: null });
      const second = t.item();
      assert.equal(t.home.store.items().length, 2);
      t.model.script.push({ text: "Gut." });
      await write({ text: "2,4 m", answers: first.id });
      assert.match(told(), /"Wie hoch\?": 2,4 m/);
      assert.deepEqual(
        t.home.store.items().map((card) => card.id),
        [second.id],
      );
      t.model.script.push({ text: "Gut." });
      await write({ text: "Karte" });
      assert.match(told(), /"Bar oder Karte\?": Karte/);
    });

    it("is a message like any other when another device was first", async () => {
      t.model.script.push(asking({ title: "Wie hoch?" }));
      await t.say("Darf ich?");
      const card = t.item();
      t.model.script.push({ text: "Dann ja." });
      await write({ text: "2,4 m", answers: card.id });
      t.model.script.push({ text: "Verstanden." });
      await write({ text: "3 m", answers: card.id });
      assert.equal(told(), "3 m");
    });

    it("is sent back once when it asks for several things", async () => {
      const body = "- Wie hoch?\n- Wie weit zum Nachbarn?\n- Freistehend?";
      t.model.script.push(asking({ title: "Was planst du?", body }), {
        ...asking({ title: "Was planst du?", form: [{ label: "Höhe", kind: "number" }] }),
      });
      await t.say("Darf ich?");
      assert.match(told(), /with `form`/);
      assert.equal(t.item().fields?.[0]?.label, "Höhe");
    });
  });

  describe("with several parts", () => {
    const form = [
      { label: "Höhe", kind: "number", unit: "m" },
      { label: "Abstand zum Nachbarn", kind: "number", unit: "m", unsure: true },
      { label: "Bauweise", options: ["Freistehend", "Angebaut"] },
      { label: "Bist du Eigentümer?", kind: "yes_no", unsure: true },
      { label: "Baubeginn", kind: "date", optional: true },
      { label: "Material", kind: "choices", options: ["Holz", "Stein", "Metall"] },
    ];

    it("is a form, and the agent reads typed values", async () => {
      t.model.script.push(asking({ title: "Erzähl mir von der Sauna", form }));
      await t.say("Darf ich?");
      const card = t.item();
      assert.deepEqual(
        card.fields?.map((field) => field.type),
        ["number", "number", "choice", "choice", "date", "multi"],
      );
      const wrong = await t.request(`/v1/cards/${card.id}/answer`, {
        body: { action: "send", values: { p1: "hoch" } },
      });
      assert.equal(wrong.status, 400);
      assert.match(JSON.stringify(await wrong.json()), /Höhe: das ist keine Zahl/);
      assert.equal(t.item().id, card.id);

      t.model.script.push({ text: "Dann ja." });
      await t.answer(card.id, "send", {
        p1: "2,4",
        p2: "unsure",
        p3: "o1",
        p4: "yes",
        p6: ["o1", "o3"],
      });
      assert.equal(newest()?.role, "tool");
      assert.equal(
        told(),
        [
          'The person filled in "Erzähl mir von der Sauna":',
          "- Höhe: 2.4 m",
          '- Abstand zum Nachbarn: "unknown"',
          '- Bauweise: "Freistehend"',
          "- Bist du Eigentümer?: true",
          "- Baubeginn: (left empty)",
          '- Material: ["Holz","Metall"]',
        ].join("\n"),
      );
    });

    it("may be answered in words instead", async () => {
      t.model.script.push(asking({ title: "Erzähl mir von der Sauna", form }));
      await t.say("Darf ich?");
      t.model.script.push({ text: "Gut." });
      await write({ text: "Ganz normal, hinten im Garten" });
      assert.match(told(), /wrote instead of filling in the form .*: Ganz normal/);
    });

    it("of one text is one free answer", async () => {
      t.model.script.push(asking({ title: "Wo?", form: [{ label: "Standort" }] }));
      await t.say("Darf ich?");
      assert.deepEqual(t.item().reply, { placeholder: "Standort" });
      assert.equal(t.item().fields, undefined);
    });
  });

  it("with choices is answered by one of them or in words; an approval by its card only", async () => {
    t.model.script.push(asking({ title: "Zug oder Auto?", choices: ["Zug", "Auto"] }));
    await t.say("Plan");
    assert.equal(t.item().kind, "question");
    t.model.script.push(asking({ title: "Buchen?", choices: ["Buchen", "Nicht"], approval: true }));
    await write({ text: "Zug, aber erst Freitag" });
    assert.match(told(), /wrote instead of choosing "Zug oder Auto\?": Zug, aber erst Freitag/);

    const approval = t.item();
    assert.equal(approval.kind, "approval");
    assert.equal(approval.reply, undefined);
    t.model.script.push({ text: "Was?" });
    await write({ text: "Moment" });
    assert.equal(t.item().id, approval.id);
    assert.equal(told(), "Moment");
  });

  it("is the message's last word, also of a client that goes on after it", async () => {
    // A client that steps by itself is not suspended: it reads the tool's answer and writes on.
    t.home.addTools((context) => [
      {
        name: "ask_on",
        description: "",
        input: z.object({}),
        silent: true,
        run: async () => {
          const card = t.home.store.createCard(questionCard({ title: "Wie hoch?" }, "de"), {
            agentId: context.agent.id,
            conversationId: context.conversationId,
            messageId: context.draft.id,
          });
          context.draft.add({ type: "card", card });
          return "The question is in the chat.";
        },
      },
    ]);
    t.model.script.push(
      { text: "Moment. ", calls: [{ name: "ask_on", arguments: {} }] },
      { text: "Ich brauche noch die Höhe." },
    );
    await t.say("Darf ich?");
    assert.deepEqual(said().at(-1), ["agent", ["Moment. ", "Wie hoch?"]]);
  });

  it("leaves no line of what the tool does", async () => {
    t.model.script.push(asking({ title: "Wie hoch?" }));
    const reply: Message = await t.say("Darf ich?");
    assert.deepEqual(
      reply.parts.map((part) => part.type),
      ["card"],
    );
  });
});

describe("a form's values", () => {
  it("numbers as people write them", () => {
    assert.equal(numberOf("2,4"), 2.4);
    assert.equal(numberOf("2.4 m", "m"), 2.4);
    assert.equal(numberOf("1.200,50"), 1200.5);
    assert.equal(numberOf("1,200.50"), 1200.5);
    assert.equal(numberOf("-3"), -3);
    assert.equal(numberOf("zwei"), undefined);
    assert.equal(numberOf(""), undefined);
  });
  it("days that exist", () => {
    assert.equal(isDate("2026-12-31"), true);
    assert.equal(isDate("2026-02-31"), false);
    assert.equal(isDate("31.12.2026"), false);
    assert.equal(isDate("morgen"), false);
  });
  it("names the part that is wrong, in the person's language", () => {
    const fields = formFields([{ label: "Höhe", kind: "number" }], "de");
    assert.deepEqual(
      readForm(fields, {}, () => undefined, "de"),
      { problem: "Höhe: das ist noch nicht ausgefüllt." },
    );
    const choice = formFields([{ label: "Art", options: ["A", "B"] }], "en");
    assert.deepEqual(
      readForm(choice, { p1: "o9" }, () => undefined, "en"),
      { problem: "Art: choose one of the options." },
    );
  });
  it("only files it knows", () => {
    const fields = formFields([{ label: "Plan", kind: "file" }], "de");
    const file = { id: "fil_1", name: "plan.pdf", mime: "application/pdf", size: 1 };
    const of = (id: string) => (id === file.id ? file : undefined);
    assert.deepEqual(readForm(fields, { p1: ["fil_1"] }, of, "de"), {
      values: { p1: [{ file: "plan.pdf", id: "fil_1" }] },
      files: [file],
    });
    assert.match(JSON.stringify(readForm(fields, { p1: ["fil_2"] }, of, "de")), /noch einmal/);
  });
  it("what the person does not know, where they may say so", () => {
    const part = { label: "Höhe", kind: "number" as const };
    const read = (fields: ReturnType<typeof formFields>) =>
      readForm(fields, { p1: "unsure" }, () => undefined, "de");
    assert.deepEqual(read(formFields([{ ...part, unsure: true }], "de")), {
      values: { p1: "unknown" },
      files: [],
    });
    assert.ok("problem" in read(formFields([part], "de")));
  });
});

describe("a question in a channel", () => {
  const card = (input: Parameters<typeof questionCard>[0]) =>
    ({ ...questionCard(input, "de"), id: "crd_1" }) as unknown as Card;

  it("is the question alone, or with what may be answered", () => {
    assert.equal(cardsAsText([card({ title: "Wie hoch?" })], "de"), "Wie hoch?");
    assert.equal(
      cardsAsText([card({ title: "Zug oder Auto?", choices: ["Zug", "Auto"] })], "de"),
      "Zug oder Auto?\n1: Zug   2: Auto\nAntworte mit der Zahl oder in deinen Worten.",
    );
    assert.match(
      cardsAsText(
        [
          card({
            title: "Die Sauna",
            form: [
              { label: "Höhe", kind: "number", unit: "m" },
              { label: "Bauweise", options: ["Frei", "Angebaut"] },
            ],
          }),
        ],
        "de",
      ),
      /- Höhe \(m\)\n- Bauweise: Frei \/ Angebaut\nAntworte hier/,
    );
  });
});
