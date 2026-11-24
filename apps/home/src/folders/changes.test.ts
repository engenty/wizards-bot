import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Folder } from "@wizards-bot/protocol";
import { type TestHome, testHome } from "../test/fakes.ts";
import { trashFolder } from "./trash.ts";

describe("changing files in a connected folder", () => {
  let t: TestHome;
  let home: string;
  let office: string;
  let archive: string;
  let was: string | undefined;
  let folder: Folder;

  before(async () => {
    t = await testHome("Ada");
    home = realpathSync(mkdtempSync(join(tmpdir(), "wizards-bot-home-")));
    was = process.env.HOME;
    process.env.HOME = home;
    office = join(home, "Office");
    archive = join(home, "Archive");
    mkdirSync(join(office, "letters"), { recursive: true });
    mkdirSync(archive);
    writeFileSync(join(office, "letters", "kraus.md"), "Dear Mr Kraus,\nthe price is 180 EUR.\n");
    folder = t.home.folders.connect({ path: office, access: "write" });
    t.home.folders.connect({ path: archive, access: "read" });
  });
  after(() => {
    process.env.HOME = was;
    return t.stop();
  });

  /** The agent calls a tool; returns what it told the agent when it did not ask. */
  const use = async (name: string, args: Record<string, unknown>): Promise<string> => {
    t.model.script.push({ calls: [{ name, arguments: args }] }, { text: "ok" });
    await t.say(`use ${name}`);
    const messages = (t.model.requests.at(-1)?.messages ?? []) as {
      role: string;
      content: string;
    }[];
    return messages.findLast((message) => message.role === "tool")?.content ?? "";
  };
  /** The agent calls a tool that shows a card; the run waits for the answer. */
  const asking = async (name: string, args: Record<string, unknown>) => {
    t.model.script.push({ calls: [{ name, arguments: args }] });
    await t.say(`use ${name}`);
    return t.item();
  };

  test("a new folder asks first, with three answers", async () => {
    const card = await asking("folder_make", {
      folder: "Office",
      path: "2026/invoices",
      why: "A place for the invoices.",
    });
    assert.deepEqual(
      card.actions.map((action) => action.id),
      ["once", "always", "deny"],
    );
    assert.match(card.actions[1]?.label ?? "", /Always allow in Office/);
    t.model.script.push({ text: "Made." });
    await t.answer(card.id, "once");
    assert.equal(existsSync(join(office, "2026", "invoices")), true);
  });

  test("an edit shows the change and keeps the old version in the Trash", async () => {
    const card = await asking("folder_edit", {
      folder: "Office",
      path: "letters/kraus.md",
      old: "180 EUR",
      new: "190 EUR",
      why: "Correct the price.",
    });
    assert.match(card.body ?? "", /- 180 EUR\n\+ 190 EUR/);
    t.model.script.push({ text: "Changed." });
    await t.answer(card.id, "once");
    assert.match(readFileSync(join(office, "letters", "kraus.md"), "utf8"), /190 EUR/);
    const trash = trashFolder(t.home.config.dataDir, false).files;
    assert.ok(readdirSync(trash).some((name) => name.startsWith("kraus")));
  });

  test("an edit needs the passage once, as the file is now", async () => {
    assert.match(
      await use("folder_edit", {
        folder: "Office",
        path: "letters/kraus.md",
        old: "180 EUR",
        new: "200 EUR",
        why: "x",
      }),
      /not in letters\/kraus.md as it is now/,
    );
  });

  test("“Always allow” lets the next changes in that folder go without a card", async () => {
    const card = await asking("folder_write", {
      folder: "Office",
      path: "notes.md",
      content: "# Notes\n",
      why: "Keep notes.",
    });
    t.model.script.push({ text: "Written." });
    await t.answer(card.id, "always");
    assert.equal(t.home.folders.byName("Office")?.allow, "always");
    assert.equal(readFileSync(join(office, "notes.md"), "utf8"), "# Notes\n");

    const items = t.home.store.items().length;
    assert.match(
      await use("folder_write", {
        folder: "Office",
        path: "notes.md",
        content: "# Notes\n- more\n",
        why: "More notes.",
      }),
      /is written/,
    );
    assert.equal(t.home.store.items().length, items);
    assert.equal(readFileSync(join(office, "notes.md"), "utf8"), "# Notes\n- more\n");
  });

  test("a file of the conversation is saved into the folder", async () => {
    const file = t.home.files.add({
      name: "receipt.txt",
      mime: "text/plain",
      bytes: new TextEncoder().encode("Hotel 180 EUR"),
    });
    assert.match(
      await use("folder_write", {
        folder: "Office",
        path: "receipts/hotel.txt",
        file: file.id,
        why: "Keep the receipt.",
      }),
      /is written/,
    );
    assert.equal(readFileSync(join(office, "receipts", "hotel.txt"), "utf8"), "Hotel 180 EUR");
  });

  test("a copy goes from a folder read only into one for changes, never the other way", async () => {
    writeFileSync(join(archive, "2025.csv"), "item,eur\n");
    assert.match(
      await use("folder_copy", {
        folder: "Archive",
        from: "2025.csv",
        to: "old/2025.csv",
        toFolder: "Office",
        why: "Last year's numbers beside this year's.",
      }),
      /is copied/,
    );
    assert.equal(readFileSync(join(office, "old", "2025.csv"), "utf8"), "item,eur\n");
    assert.match(
      await use("folder_copy", {
        folder: "Office",
        from: "notes.md",
        to: "notes.md",
        toFolder: "Archive",
        why: "x",
      }),
      /reading only/,
    );
  });

  test("a turn that read data from outside asks, also where the person said always", async () => {
    const conversationId = t.home.store.mainAgent().conversationId;
    t.model.script.push({
      calls: [
        {
          name: "folder_write",
          arguments: { folder: "Office", path: "mail.md", content: "x", why: "Keep the mail." },
        },
      ],
    });
    const before = t.home.store.items().length;
    await t.home.turns.enqueue({
      conversationId,
      text: "A mail arrived.",
      channel: "home",
      outside: true,
    });
    assert.equal(t.home.store.items().length, before + 1);
    assert.equal(existsSync(join(office, "mail.md")), false);
    t.model.script.push({ text: "Left." });
    await t.answer(t.item().id, "deny");
  });

  test("a task an event started changes no files", async () => {
    const conversationId = t.home.store.mainAgent().conversationId;
    t.model.script.push(
      {
        calls: [
          {
            name: "folder_write",
            arguments: { folder: "Office", path: "event.md", content: "x", why: "x" },
          },
        ],
      },
      { text: "I would keep it." },
    );
    await t.home.turns.enqueue({
      conversationId,
      text: "A file arrived.",
      channel: "home",
      task: { id: "tsk_x", title: "Sort", quiet: false, event: true },
      outside: true,
    });
    assert.equal(existsSync(join(office, "event.md")), false);
    assert.equal(folder.access, "write");
  });
});

describe("moving and deleting in a connected folder", () => {
  let t: TestHome;
  let home: string;
  let scans: string;
  let was: string | undefined;

  before(async () => {
    t = await testHome("Ada");
    home = realpathSync(mkdtempSync(join(tmpdir(), "wizards-bot-home-")));
    was = process.env.HOME;
    process.env.HOME = home;
    scans = join(home, "Scans");
    mkdirSync(scans);
    for (const name of ["a.pdf", "b.pdf", "old.txt"]) writeFileSync(join(scans, name), name);
    const folder = t.home.folders.connect({ path: scans, access: "write" });
    t.home.folders.setAllow(folder.id, "always");
  });
  after(() => {
    process.env.HOME = was;
    return t.stop();
  });

  test("many files move in one call, here without a card", async () => {
    t.model.script.push(
      {
        calls: [
          {
            name: "folder_move",
            arguments: {
              folder: "Scans",
              moves: [
                { from: "a.pdf", to: "2026/Q1/a.pdf" },
                { from: "b.pdf", to: "2026/Q1/b.pdf" },
              ],
              why: "Sort the scans.",
            },
          },
        ],
      },
      { text: "Sorted." },
    );
    await t.say("sort my scans");
    assert.deepEqual(readdirSync(join(scans, "2026", "Q1")).sort(), ["a.pdf", "b.pdf"]);
    assert.equal(existsSync(join(scans, "a.pdf")), false);
  });

  test("deleting asks every time, also where the person said always, and goes to the Trash", async () => {
    t.model.script.push({
      calls: [
        {
          name: "folder_delete",
          arguments: { folder: "Scans", paths: ["old.txt"], why: "It is not needed." },
        },
      ],
    });
    await t.say("clean up");
    const card = t.item();
    assert.deepEqual(
      card.actions.map((action) => [action.id, action.style]),
      [
        ["once", "danger"],
        ["deny", "plain"],
      ],
    );
    assert.equal(existsSync(join(scans, "old.txt")), true);
    t.model.script.push({ text: "Gone." });
    await t.answer(card.id, "once");
    assert.equal(existsSync(join(scans, "old.txt")), false);
    const trash = trashFolder(t.home.config.dataDir, false).files;
    assert.ok(readdirSync(trash).includes("old.txt"));
  });
});
