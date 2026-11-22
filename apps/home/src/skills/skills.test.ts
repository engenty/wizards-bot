import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { FileRef, Message } from "@wizards-bot/protocol";
import { type TestHome, testHome, textOf } from "../test/fakes.ts";
import { makeDocx, readDocx } from "./office/docx.ts";
import { tinyPdf } from "./office/fixtures.ts";
import { readPptx } from "./office/pptx.ts";
import { makeXlsx, readXlsx } from "./office/xlsx.ts";

type Request = TestHome["model"]["requests"][number];

/** The names of the tools a request offered the model. */
const offered = (request: Request | undefined): string[] =>
  ((request?.tools ?? []) as { function: { name: string } }[]).map((tool) => tool.function.name);
const system = (request: Request | undefined): string => request?.messages[0]?.content ?? "";
const fileOf = (message: Message): FileRef | undefined =>
  message.parts.find((part) => part.type === "file")?.file;

describe("skills", () => {
  let t: TestHome;
  let conversationId: string;
  before(async () => {
    t = await testHome("Ada");
    conversationId = t.home.store.mainAgent().conversationId;
  });
  after(() => t.stop());

  const upload = async (name: string, type: string, bytes: Uint8Array): Promise<FileRef> => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(bytes)], name, { type }));
    const response = await fetch(`${t.url}/v1/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.token}` },
      body: form,
    });
    return (await response.json()) as FileRef;
  };
  const sayWith = async (text: string, files: FileRef[]): Promise<Message> => {
    await t.request(`/v1/conversations/${conversationId}/messages`, {
      body: { text, files: files.map((file) => file.id) },
    });
    await t.home.idle();
    return t.last();
  };
  /** What the last tool call told the model. */
  const told = (): string =>
    t.model.requests.at(-1)?.messages.findLast((message) => message.role === "tool")?.content ?? "";

  test("are read from their folders: a name, a description, the instructions, what calls for them", () => {
    const skills = t.home.skills.list();
    assert.deepEqual(
      skills.map((skill) => skill.name),
      ["app-links", "excel", "google-workspace", "powerpoint", "word"],
    );
    for (const skill of skills) {
      assert.ok(skill.description.length > 20 && skill.description.length < 120, skill.name);
      // A loaded skill has to fit beside a conversation in a small model's context.
      assert.ok(skill.instructions.length < 2600, `${skill.name}: ${skill.instructions.length}`);
    }
    const names = (text: string, files: string[] = []): string[] =>
      t.home.skills
        .matching({ text, files: files.map((name) => ({ id: "", name, mime: "", size: 1 })) })
        .map((skill) => skill.name);
    assert.deepEqual(names("Make a one-page Word document about bees"), ["word"]);
    assert.deepEqual(names("In other words, a word about bees"), []);
    assert.deepEqual(names("Put it into an EXCEL sheet"), ["excel"]);
    assert.deepEqual(names("What is in here?", ["Q3.XLSX"]), ["excel"]);
    assert.deepEqual(names("a slide deck for Monday"), ["powerpoint"]);
    assert.deepEqual(names("Add a row to my Google Sheet"), ["google-workspace"]);
    assert.deepEqual(names("Eine Präsentation als pptx und ein Word-Dokument"), [
      "powerpoint",
      "word",
    ]);
    assert.deepEqual(names("the crossword and the excellent docxy"), []);
  });

  test("an agent sees one line per skill and none of their tools", async () => {
    t.model.script.push({ text: "Hello." });
    await t.say("Hello");
    const request = t.model.requests.at(-1);
    assert.match(system(request), /^Skills: instructions and tools for one kind of task\./m);
    assert.match(system(request), /^- word: Make, read and change Word documents \(\.docx\)\.$/m);
    assert.doesNotMatch(system(request), /Loaded skill/);
    const tools = offered(request);
    assert.ok(tools.includes("skill_load") && tools.includes("file_read"));
    assert.ok(!tools.some((name) => /^(word|excel|powerpoint)_/.test(name)));
  });

  test("an agent loads a skill, and its tools are there from the next step on", async () => {
    t.model.script.push(
      { calls: [{ name: "skill_load", arguments: { name: "excel" } }] },
      {
        calls: [
          {
            name: "excel_make",
            arguments: {
              name: "Trip costs",
              sheets: [
                {
                  name: "Costs",
                  rows: [
                    ["Item", "EUR"],
                    ["Train", 89],
                    ["Total", "=SUM(B2:B2)"],
                  ],
                },
              ],
            },
          },
        ],
      },
      { text: "The sheet is in this message." },
    );
    const reply = await t.say("Add up what the trip costs in a table I can keep");
    const [first, second, third] = t.model.requests.slice(-3);
    assert.ok(!offered(first).includes("excel_make"));
    assert.ok(offered(second).includes("excel_make") && offered(second).includes("excel_edit"));
    assert.ok(!offered(second).includes("word_make"));
    const loaded = second?.messages.findLast((message) => message.role === "tool")?.content ?? "";
    assert.match(loaded, /The Bot Server does not calculate/);
    assert.match(
      loaded,
      /Its tools are yours from your next step on: `excel_make`, `excel_edit`\./,
    );
    assert.match(told(), /Trip costs\.xlsx \(fil_\w+\) is in your message/);
    assert.ok(offered(third).includes("excel_make"));

    const file = fileOf(reply);
    assert.equal(file?.name, "Trip costs.xlsx");
    assert.match(file?.mime ?? "", /spreadsheetml\.sheet$/);
    const saved = await t.request(`/v1/files/${file?.id}`);
    assert.equal(saved.status, 200);
    const text = readXlsx(new Uint8Array(await saved.arrayBuffer()));
    assert.match(text, /^2 \| Train \| 89$/m);
    assert.match(text, /^3 \| Total \| =SUM\(B2:B2\)$/m);
    assert.equal(textOf(reply), "The sheet is in this message.");

    t.model.script.push(
      { calls: [{ name: "skill_load", arguments: { name: "nope" } }] },
      { text: "ok" },
    );
    await t.say("load nope");
    assert.match(
      told(),
      /There is no skill nope\. Skills: app-links, excel, google-workspace, powerpoint, word\./,
    );
  });

  test("a message that names Word loads the skill before the model starts", async () => {
    t.model.script.push(
      {
        calls: [
          {
            name: "word_make",
            arguments: {
              name: "Bees",
              content: "# Bees\n\nBees make **honey**.\n\n- Queen\n- Workers",
            },
          },
        ],
      },
      { text: "Your document is here." },
    );
    const reply = await t.say("Make a one-page Word document about bees");
    const first = t.model.requests.at(-2);
    assert.ok(offered(first).includes("word_make"));
    assert.match(system(first), /^- word \(loaded, see below\):/m);
    assert.match(
      system(first),
      /^Loaded skill "word":\nYour tools: `word_make` and `word_edit`\./m,
    );
    const file = fileOf(reply);
    assert.equal(file?.name, "Bees.docx");
    const text = readDocx(t.home.files.bytes(file?.id ?? "") as Uint8Array);
    assert.match(text, /^# Bees$/m);
    assert.match(text, /Bees make honey\./);
    assert.match(text, /^- Workers$/m);
  });

  test("an attached Word document is read, and a change comes back as a new file", async () => {
    const attached = await upload(
      "offer.docx",
      "application/octet-stream",
      makeDocx({
        title: "Offer",
        content: "# Offer\n\nThe price is 1200 EUR.\n\n## Terms\n\nNet 30.",
      }),
    );
    assert.match(attached.mime, /wordprocessingml\.document$/);
    t.model.script.push(
      {
        calls: [
          {
            name: "word_edit",
            arguments: {
              changes: [{ find: "1200 EUR", replace: "1500 EUR" }],
              add: "Valid until **March**.",
              after: "Net 30",
            },
          },
        ],
      },
      { text: "Changed." },
    );
    const reply = await sayWith("Raise the price to 1500 and add how long it is valid", [attached]);
    const first = t.model.requests.at(-2);
    const read = first?.messages.at(-1)?.content ?? "";
    assert.match(read, new RegExp(`Attached file offer\\.docx \\(${attached.id}\\), its text:`));
    assert.match(read, /^# Offer$/m);
    assert.match(read, /The price is 1200 EUR\./);
    assert.ok(offered(first).includes("word_edit"));
    assert.match(
      told(),
      /"1200 EUR" replaced once\.\nText added after "Net 30"\.\noffer\.docx \(fil_/,
    );
    const file = fileOf(reply);
    assert.ok(file && file.id !== attached.id);
    const text = readDocx(t.home.files.bytes(file.id) as Uint8Array);
    assert.match(text, /The price is 1500 EUR\./);
    assert.match(text, /Net 30\.\n\nValid until March\./);
    // The attached file is as it was.
    assert.match(readDocx(t.home.files.bytes(attached.id) as Uint8Array), /1200 EUR/);

    t.model.script.push(
      { calls: [{ name: "word_edit", arguments: { changes: [{ find: "9999", replace: "1" }] } }] },
      { text: "Not found." },
    );
    const unchanged = await t.say("And replace 9999");
    assert.match(told(), /"9999" is not in the document.*\nThe document is unchanged\./s);
    assert.equal(fileOf(unchanged), undefined);
  });

  test("an attached PDF and an attached workbook reach the agent as text; a file is read again by its name", async () => {
    const pdf = await upload(
      "invoice.pdf",
      "application/pdf",
      tinyPdf(["Invoice 114", "Total: 80 EUR"]),
    );
    const book = await upload(
      "costs.xlsx",
      "application/octet-stream",
      makeXlsx({
        title: "c",
        sheets: [
          {
            name: "Costs",
            rows: [
              ["Item", "EUR"],
              ["Hotel", 180],
            ],
          },
        ],
      }),
    );
    t.model.script.push(
      { calls: [{ name: "file_read", arguments: { file: "invoice.pdf" } }] },
      { calls: [{ name: "file_read", arguments: { file: "nothing.pdf" } }] },
      { text: "80 and 180." },
    );
    await sayWith("What do they say?", [pdf, book]);
    const [first, second, third] = t.model.requests.slice(-3);
    const read = first?.messages.at(-1)?.content ?? "";
    assert.match(
      read,
      /Attached file invoice\.pdf \(fil_\w+\), its text:\n```\nInvoice 114\nTotal: 80 EUR\n```/,
    );
    assert.match(read, /^2 \| Hotel \| 180$/m);
    // A workbook is attached: the excel skill is there, a PDF needs none.
    assert.ok(offered(first).includes("excel_edit"));
    assert.equal(second?.messages.at(-1)?.content, "Invoice 114\nTotal: 80 EUR");
    assert.match(
      third?.messages.at(-1)?.content ?? "",
      /There is no file nothing\.pdf in this conversation\. Files: .*invoice\.pdf/,
    );
  });

  test("a deck is made from an outline", async () => {
    t.model.script.push(
      {
        calls: [
          {
            name: "powerpoint_make",
            arguments: {
              name: "Kickoff.pptx",
              content: "# Kickoff\nQ1 plan\n\n## Goals\n- Ship\n- Learn",
            },
          },
        ],
      },
      { text: "Done." },
    );
    const reply = await t.say("I need a PowerPoint for the kickoff");
    const file = fileOf(reply);
    assert.equal(file?.name, "Kickoff.pptx");
    const text = readPptx(t.home.files.bytes(file?.id ?? "") as Uint8Array);
    assert.match(text, /^## Slide 1: Kickoff\n- Q1 plan$/m);
    assert.match(text, /^## Slide 2: Goals\n- Ship\n- Learn$/m);
  });

  test("writing into a connected folder asks first, and reading a document there works", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wizards-bot-papers-")));
    writeFileSync(
      join(root, "old.docx"),
      makeDocx({ title: "Old", content: "# Old\n\nSigned by Ada in 2025." }),
    );
    const folder = t.home.folders.connect({ path: root, access: "read" });

    t.model.script.push(
      { calls: [{ name: "folder_read", arguments: { folder: folder.name, path: "old.docx" } }] },
      {
        calls: [
          {
            name: "word_edit",
            arguments: {
              folder: folder.name,
              path: "old.docx",
              changes: [{ find: "2025", replace: "2026" }],
            },
          },
        ],
      },
      { text: "It is read only." },
    );
    const refused = await t.say("In the docx old.docx, change the year to 2026");
    const [, second] = t.model.requests.slice(-3);
    assert.match(second?.messages.at(-1)?.content ?? "", /^# Old\n\nSigned by Ada in 2025\.$/);
    assert.match(told(), /is connected for reading only, so it was not written there/);
    assert.equal(refused.parts.filter((part) => part.type === "card").length, 0);
    assert.match(readDocx(readFileSync(join(root, "old.docx"))), /2025/);

    t.home.folders.setAccess(folder.id, "write");
    t.model.script.push(
      {
        calls: [
          {
            name: "word_edit",
            arguments: {
              folder: folder.name,
              path: "old.docx",
              changes: [{ find: "2025", replace: "2026" }],
            },
          },
        ],
      },
      { text: "I asked." },
    );
    const asked = await t.say("Now you may");
    const card = asked.parts.find((part) => part.type === "card")?.card;
    assert.equal(card?.title, `Replace old.docx in ${folder.name}?`);
    assert.ok(fileOf(asked));
    assert.match(readDocx(readFileSync(join(root, "old.docx"))), /2025/);
    t.model.script.push({ text: "Written." });
    await t.answer(card?.id as string, "write");
    assert.match(readDocx(readFileSync(join(root, "old.docx"))), /Signed by Ada in 2026\./);
    assert.match(
      t.model.requests.at(-1)?.messages.at(-1)?.content ?? "",
      /\[home\] old\.docx in .* is written\./,
    );

    t.model.script.push(
      {
        calls: [
          {
            name: "excel_make",
            arguments: {
              name: "Plan",
              sheets: [{ name: "Plan", rows: [["Step"], ["Go"]] }],
              folder: folder.name,
              path: "2027/plan.xlsx",
            },
          },
        ],
      },
      { text: "I asked." },
    );
    const made = await t.say("Put an Excel plan into the folder");
    const second2 = made.parts.find((part) => part.type === "card")?.card;
    assert.equal(second2?.title, `Write plan.xlsx into ${folder.name}?`);
    t.model.script.push({ text: "Left it." });
    await t.answer(second2?.id as string, "keep");
    assert.equal(existsSync(join(root, "2027", "plan.xlsx")), false);
    assert.match(
      t.model.requests.at(-1)?.messages.at(-1)?.content ?? "",
      /The person said no to writing 2027\/plan\.xlsx/,
    );
  });

  test("Google Docs loads the skill that works through a connection", async () => {
    t.model.script.push({ text: "No Google account is connected. Shall I connect one?" });
    await t.say("Add a paragraph to my Google Doc about bees");
    const request = t.model.requests.at(-1);
    assert.match(system(request), /^Loaded skill "google-workspace":/m);
    assert.match(system(request), /`connection_tools`/);
    assert.match(system(request), /https:\/\/docsmcp\.googleapis\.com\/mcp\/v1/);
    assert.ok(offered(request).includes("connection_add"));
  });

  test("a link, a call and a message are cards the person taps; nothing opens by itself", async () => {
    t.model.script.push(
      {
        calls: [
          {
            name: "link_open",
            arguments: {
              url: "https://maps.apple.com/?daddr=Krak%C3%B3w%20G%C5%82%C3%B3wny&dirflg=r",
              title: "Directions to Kraków Główny in Apple Maps",
            },
          },
          { name: "link_open", arguments: { url: "javascript:alert(1)", title: "x" } },
          { name: "call_start", arguments: { to: "Anna Berg" } },
          {
            name: "message_draft",
            arguments: { to: "Anna Berg", via: "messages", text: "I am 10 minutes late." },
          },
        ],
      },
      { text: "Tap the cards." },
    );
    const reply = await t.say(
      "Directions to Kraków Główny in Apple Maps, then call Anna and tell her by SMS I am late",
    );
    const cards = reply.parts.flatMap((part) => (part.type === "card" ? [part.card] : []));
    assert.deepEqual(
      cards.map((card) => [card.kind, card.title, card.url?.split("?")[0]]),
      [
        ["info", "Directions to Kraków Główny in Apple Maps", "https://maps.apple.com/"],
        ["info", "Call Anna Berg", "wizardsbot://call"],
        ["info", "Message to Anna Berg in Messages", "wizardsbot://message"],
      ],
    );
    // Spaces travel as %20, which every reader of a query takes as a space.
    assert.match(cards[1]?.url ?? "", /to=Anna%20Berg$/);
    const message = new URL(cards[2]?.url ?? "").searchParams;
    assert.deepEqual(
      [message.get("to"), message.get("via"), message.get("text")],
      ["Anna Berg", "messages", "I am 10 minutes late."],
    );
    // A card never waits: nothing is open in what needs the person.
    assert.ok(cards.every((card) => card.level === "update" && !card.actions.length));
    const results = (t.model.requests.at(-1)?.messages ?? []).filter((m) => m.role === "tool");
    assert.ok(results.some((m) => m.content.startsWith("A card does not open javascript links")));
  });

  test("a skill that is not used goes again", async () => {
    const other = t.home.store.createAgent({
      name: "Clerk",
      kind: "round",
      about: "Keeps papers.",
      instructions: "Keep papers.",
    });
    const skills = t.home.skills;
    skills.hear(other.conversationId, { text: "an Excel sheet" });
    assert.equal(skills.isLoaded(other.conversationId, "excel"), true);
    assert.equal(skills.shows(other.conversationId, "excel_make"), true);
    assert.equal(skills.shows(other.conversationId, "word_make"), false);
    assert.equal(skills.shows(other.conversationId, "ask"), true);
    for (let message = 0; message < 5; message++) skills.hear(other.conversationId, { text: "ok" });
    assert.equal(skills.isLoaded(other.conversationId, "excel"), true);
    skills.hear(other.conversationId, { text: "ok" });
    assert.equal(skills.isLoaded(other.conversationId, "excel"), false);
    assert.doesNotMatch(skills.prompt(other.conversationId), /Loaded skill/);
  });
});
