import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Folder, FolderPreview } from "@wizards-bot/protocol";
import { type TestHome, testHome, textOf } from "../test/fakes.ts";

describe("a connected folder", () => {
  let t: TestHome;
  let root: string;
  let outside: string;

  before(async () => {
    t = await testHome("Ada");
    root = realpathSync(mkdtempSync(join(tmpdir(), "wizards-bot-trips-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "wizards-bot-outside-")));
    mkdirSync(join(root, "krakow"));
    mkdirSync(join(root, "node_modules"));
    writeFileSync(join(root, "krakow", "plan.md"), "# Plan\nTrain 7:10 from Vienna\n");
    writeFileSync(join(root, "budget.csv"), "item,eur\nhotel,180\n");
    writeFileSync(join(root, "photo.bin"), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(root, ".secret"), "token");
    writeFileSync(join(root, "node_modules", "x.js"), "x");
    writeFileSync(join(outside, "private.txt"), "not yours");
    symlinkSync(outside, join(root, "link"));
  });
  after(() => t.stop());

  /** Lets the agent call one tool and returns what the tool told it. */
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    t.model.script.push({ calls: [{ name, arguments: args }] }, { text: "ok" });
    await t.say(`use ${name}`);
    const messages = (t.model.requests.at(-1)?.messages ?? []) as {
      role: string;
      content: string;
    }[];
    return messages.findLast((message) => message.role === "tool")?.content ?? "";
  };

  test("is counted before it is connected, without what is hidden", async () => {
    const preview = (await (
      await t.request("/v1/folders/preview", { body: { path: root } })
    ).json()) as FolderPreview;
    assert.deepEqual([preview.files, preview.folders, preview.more], [3, 1, false]);
    assert.equal(preview.path, root);
  });

  test("cannot be the whole disk, the whole home folder, the home's data or a folder that is not there", async () => {
    const status = async (path: string) =>
      (await t.request("/v1/folders/preview", { body: { path } })).status;
    assert.equal(await status("/"), 400);
    assert.equal(await status(homedir()), 400);
    assert.equal(await status(t.home.config.dataDir), 400);
    assert.equal(await status(join(root, "nope")), 404);
    assert.equal(
      (await t.request("/v1/folders", { body: { path: "/", access: "read" } })).status,
      400,
    );
  });

  test("is listed for a path field", async () => {
    const listing = (await (
      await t.request(`/v1/folders/browse?path=${encodeURIComponent(join(root, "kra"))}`)
    ).json()) as {
      path: string;
      folders: { name: string }[];
    };
    assert.equal(listing.path, root);
    assert.deepEqual(
      listing.folders.map((folder) => folder.name),
      ["krakow"],
    );
  });

  test("is connected by the person and told to every device", async () => {
    const events: string[] = [];
    const stop = t.home.events.subscribe((stored) => events.push(stored.event.type));
    const folder = (await (
      await t.request("/v1/folders", { body: { path: root, access: "read" } })
    ).json()) as Folder;
    stop();
    assert.equal(folder.access, "read");
    assert.equal(folder.path, root);
    assert.ok(events.includes("folders.updated"));
    const again = (await (
      await t.request("/v1/folders", { body: { path: root, access: "read" } })
    ).json()) as Folder;
    assert.equal(again.id, folder.id);
    const { folders } = (await (await t.request("/v1/folders")).json()) as { folders: Folder[] };
    assert.equal(folders.length, 1);
  });

  test("an agent lists, reads and searches it, and is told that it exists", async () => {
    const name = t.home.folders.list()[0]?.name as string;
    const listed = await call("folder_list", { folder: name });
    assert.equal(listed, "krakow/\nbudget.csv (1 KB)\nphoto.bin (1 KB)");
    assert.equal(
      await call("folder_read", { folder: name, path: "krakow/plan.md" }),
      "# Plan\nTrain 7:10 from Vienna\n",
    );
    assert.match(await call("folder_read", { folder: name, path: "photo.bin" }), /not a text file/);
    assert.equal(
      await call("folder_search", { query: "7:10" }),
      `${name}: krakow/plan.md:2: Train 7:10 from Vienna`,
    );
    const system =
      (t.model.requests.at(-1)?.messages[0] as { content: string } | undefined)?.content ?? "";
    assert.match(system, new RegExp(`Connected folders[^\\n]*\\n- ${name}: read only`));
  });

  test("an agent looks at a picture in it and the model sees it after the tool's answer", async () => {
    const name = t.home.folders.list()[0]?.name as string;
    const dot =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    writeFileSync(join(root, "board.png"), Buffer.from(dot, "base64"));
    assert.match(await call("folder_read", { folder: name, path: "board.png" }), /folder_look/);
    const told = await call("folder_look", { folder: name, paths: ["board.png", "budget.csv"] });
    assert.equal(told, "Picture 1: board.png\nbudget.csv is not a picture.");
    const messages = (t.model.requests.at(-1)?.messages ?? []) as {
      role: string;
      images?: string[];
    }[];
    const shown = messages.at(-1);
    assert.equal(shown?.role, "user");
    assert.deepEqual(shown?.images, [dot]);
  });

  test("an agent reaches nothing outside it and nothing hidden", async () => {
    const name = t.home.folders.list()[0]?.name as string;
    assert.match(
      await call("folder_read", { folder: name, path: "../outside/private.txt" }),
      /not a path inside/,
    );
    assert.match(await call("folder_read", { folder: name, path: ".secret" }), /not a path inside/);
    assert.match(
      await call("folder_read", { folder: name, path: "link/private.txt" }),
      /leads out of/,
    );
    assert.match(await call("folder_list", { folder: name, path: "link" }), /leads out of/);
    assert.equal(
      await call("folder_search", { query: "not yours" }),
      "Nothing found for “not yours”.",
    );
  });

  test("an agent changes a file only where the person allowed it, and only after a yes", async () => {
    const folder = t.home.folders.list()[0] as Folder;
    const write = {
      folder: folder.name,
      path: "krakow/packing.md",
      content: "- socks\n",
      why: "Add a packing list.",
    };
    assert.match(await call("folder_write", write), /reading only/);
    assert.equal(t.home.store.items().length, 0);

    await t.request(`/v1/folders/${folder.id}`, { method: "PATCH", body: { access: "write" } });
    await call("folder_write", write);
    const first = t.item();
    assert.equal(first.title, "Add a packing list.");
    t.model.script.push({ text: "Left as it is." });
    await t.answer(first.id, "keep");
    assert.equal(existsSync(join(root, "krakow", "packing.md")), false);

    await call("folder_write", write);
    t.model.script.push({ text: "Written." });
    await t.answer(t.item().id, "write");
    assert.equal(readFileSync(join(root, "krakow", "packing.md"), "utf8"), "- socks\n");
    assert.equal(textOf(t.last()), "Written.");

    await call("folder_write", { ...write, path: "link/escape.md" });
    assert.equal(existsSync(join(outside, "escape.md")), false);
  });

  test("an agent connects a folder only with the person's yes, and is gone when disconnected", async () => {
    const second = realpathSync(mkdtempSync(join(tmpdir(), "wizards-bot-notes-")));
    await call("folder_connect", { path: second, access: "read" });
    const card = t.item();
    assert.match(card.title, /^Connect the folder “wizards-bot-notes-/);
    assert.equal(t.home.folders.list().length, 1);
    t.model.script.push({ text: "Connected." });
    await t.answer(card.id, "connect");
    assert.equal(t.home.folders.list().length, 2);
    const added = t.home.folders.list().find((folder) => folder.path === second) as Folder;
    assert.equal((await t.request(`/v1/folders/${added.id}`, { method: "DELETE" })).status, 204);
    assert.equal(t.home.folders.list().length, 1);
    assert.equal(existsSync(second), true);
  });
});
