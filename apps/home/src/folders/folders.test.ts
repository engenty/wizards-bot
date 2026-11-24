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
import type { Folder, FolderListing, FolderPreview, Setup } from "@wizards-bot/protocol";
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

  /** Lets the agent call a tool that asks: its run waits for the card's answer. */
  const asks = async (args: Record<string, unknown>): Promise<void> => {
    t.model.script.push({ calls: [{ name: "folder_connect", arguments: args }] });
    await t.say("connect a folder");
  };

  test("an agent asks with one card where the person picks the folder and says yes", async () => {
    const second = realpathSync(mkdtempSync(join(tmpdir(), "wizards-bot-notes-")));
    await asks({ purpose: "A folder for the legal texts", access: "write" });
    const card = t.item();
    assert.equal(card.title, "A folder for the legal texts");
    const [folder, access] = card.fields ?? [];
    assert.equal(folder?.type, "folder");
    assert.equal(folder?.value, undefined);
    assert.deepEqual([access?.type, access?.value], ["choice", "write"]);
    assert.equal(t.home.folders.list().length, 1);

    // A folder the home does not connect keeps the card open.
    const refused = await t.request(`/v1/cards/${card.id}/answer`, {
      body: { action: "connect", values: { folder: "/", access: "read" } },
    });
    assert.equal(refused.status, 400);
    assert.equal(t.item().id, card.id);

    t.model.script.push({ text: "Connected." });
    await t.answer(card.id, "connect", { folder: second, access: "read" });
    assert.equal(t.home.store.items().length, 0);
    const added = t.home.folders.list().find((each) => each.path === second) as Folder;
    assert.equal(added.access, "read");
    assert.match(textOf(t.last()), /Connected\./);
    const told = (t.model.requests.at(-1)?.messages ?? []) as { role: string; content: string }[];
    assert.match(
      told.findLast((message) => message.role === "tool")?.content ?? "",
      /is connected \(read only\)/,
    );

    assert.equal((await t.request(`/v1/folders/${added.id}`, { method: "DELETE" })).status, 204);
    assert.equal(t.home.folders.list().length, 1);
    assert.equal(existsSync(second), true);
  });

  test("a path the person wrote starts the card with that folder; a no connects nothing", async () => {
    const third = realpathSync(mkdtempSync(join(tmpdir(), "wizards-bot-laws-")));
    await asks({ purpose: "Laws", access: "read", path: third });
    const card = t.item();
    assert.equal(card.fields?.[0]?.value, third);
    t.model.script.push({ text: "Fine." });
    await t.answer(card.id, "keep", { folder: third, access: "read" });
    assert.equal(
      t.home.folders.list().some((each) => each.path === third),
      false,
    );
    assert.match(
      await call("folder_connect", { purpose: "Laws", access: "read", path: join(third, "nope") }),
      /without `path`/,
    );
  });
});

describe("the folder picker", () => {
  let t: TestHome;
  let home: string;
  let was: string | undefined;

  before(async () => {
    t = await testHome("Ada");
    home = realpathSync(mkdtempSync(join(tmpdir(), "wizards-bot-home-")));
    mkdirSync(join(home, "Documents", "Trips"), { recursive: true });
    mkdirSync(join(home, ".ssh"));
    writeFileSync(join(home, "Documents", "notes.md"), "# Notes\n");
    was = process.env.HOME;
    process.env.HOME = home;
  });
  after(() => {
    process.env.HOME = was;
    return t.stop();
  });

  const browse = (path?: string) =>
    t.request(`/v1/folders/browse${path === undefined ? "" : `?path=${encodeURIComponent(path)}`}`);

  test("starts at the home folder and lists folders only, nothing hidden", async () => {
    const listing = (await (await browse()).json()) as FolderListing;
    assert.deepEqual([listing.path, listing.parent, listing.home], [home, null, home]);
    assert.deepEqual(
      listing.folders.map((folder) => folder.name),
      ["Documents"],
    );
    const inside = (await (await browse("~/Documents")).json()) as FolderListing;
    assert.equal(inside.parent, home);
    assert.deepEqual(
      inside.folders.map((folder) => folder.name),
      ["Trips"],
    );
  });

  test("completes a half-typed name from its parent", async () => {
    const listing = (await (await browse(join(home, "Documents", "Tr"))).json()) as FolderListing;
    assert.equal(listing.path, join(home, "Documents"));
  });

  test("stays inside the home folder and out of hidden folders", async () => {
    assert.equal((await browse(tmpdir())).status, 400);
    assert.equal((await browse(join(home, ".."))).status, 400);
    assert.equal((await browse("/")).status, 400);
    assert.equal((await browse("~/.ssh")).status, 400);
    symlinkSync(tmpdir(), join(home, "Documents", "out"));
    assert.equal((await browse(join(home, "Documents", "out"))).status, 400);
  });

  test("makes a new folder there and lists it", async () => {
    const made = await t.request("/v1/folders/new", {
      body: { parent: join(home, "Documents"), name: "Gesetze" },
    });
    const listing = (await made.json()) as FolderListing;
    assert.equal(listing.path, join(home, "Documents", "Gesetze"));
    assert.deepEqual(listing.folders, []);
    assert.equal(existsSync(join(home, "Documents", "Gesetze")), true);
    const status = async (parent: string, name: string) =>
      (await t.request("/v1/folders/new", { body: { parent, name } })).status;
    assert.equal(await status(join(home, "Documents"), "Gesetze"), 400);
    assert.equal(await status(join(home, "Documents"), ".hidden"), 400);
    assert.equal(await status(join(home, "Documents"), "a/b"), 400);
    assert.equal(await status(tmpdir(), "escape"), 400);
    assert.equal(existsSync(join(tmpdir(), "escape")), false);
  });
});

describe("the agents' own folder", () => {
  let t: TestHome;
  let home: string;
  let was: string | undefined;

  before(async () => {
    t = await testHome("Ada");
    home = realpathSync(mkdtempSync(join(tmpdir(), "wizards-bot-own-")));
    mkdirSync(join(home, "Documents", "Laws"), { recursive: true });
    mkdirSync(join(home, "Documents", "Trips"), { recursive: true });
    was = process.env.HOME;
    process.env.HOME = home;
  });
  after(() => {
    process.env.HOME = was;
    return t.stop();
  });

  const setup = async () => (await (await t.request("/v1/setup")).json()) as Setup;
  const connect = async (body: Record<string, unknown>) =>
    (await t.request("/v1/folders", { body })) as Response;

  test("the setup suggests ~/wizards until one is chosen", async () => {
    assert.deepEqual((await setup()).ownFolder, {
      path: join(home, "wizards"),
      connected: false,
      exists: false,
    });
  });

  test("is made when it is not there, and connected for changes", async () => {
    const made = (await (
      await connect({ path: "~/wizards", access: "read", own: true })
    ).json()) as Folder;
    assert.deepEqual([made.path, made.access, made.own], [join(home, "wizards"), "write", true]);
    assert.equal(existsSync(join(home, "wizards")), true);
    assert.deepEqual((await setup()).ownFolder, {
      path: join(home, "wizards"),
      connected: true,
      exists: true,
    });
  });

  test("other folders the setup connects join the same list", async () => {
    await connect({ path: join(home, "Documents", "Laws"), access: "read" });
    await connect({ path: join(home, "Documents", "Trips"), access: "write" });
    const { folders } = (await (await t.request("/v1/folders")).json()) as { folders: Folder[] };
    assert.deepEqual(
      folders.map((folder) => [folder.name, folder.access, folder.own ?? false]),
      [
        ["Laws", "read", false],
        ["Trips", "write", false],
        ["wizards", "write", true],
      ],
    );
  });

  test("is where an agent writes when it names no folder, after a yes", async () => {
    t.model.script.push(
      {
        calls: [
          {
            name: "folder_write",
            arguments: { path: "notes.md", content: "# Notes\n", why: "Keep the notes." },
          },
        ],
      },
      { text: "Asked." },
    );
    await t.say("keep my notes");
    const card = t.item();
    assert.match(card.body ?? "", /\*\*wizards\*\*/);
    t.model.script.push({ text: "Written." });
    await t.answer(card.id, "write");
    assert.equal(readFileSync(join(home, "wizards", "notes.md"), "utf8"), "# Notes\n");
    const system =
      (t.model.requests.at(-1)?.messages[0] as { content: string } | undefined)?.content ?? "";
    assert.match(system, /- wizards: your own folder/);
  });

  test("is one folder: choosing another moves the mark, and the first stays connected", async () => {
    await connect({ path: join(home, "Documents", "Laws"), access: "read", own: true });
    const folders = t.home.folders.list();
    assert.deepEqual(
      folders.filter((folder) => folder.own).map((folder) => [folder.name, folder.access]),
      [["Laws", "write"]],
    );
    assert.ok(folders.some((folder) => folder.name === "wizards" && !folder.own));
  });

  test("is made nowhere outside the home folder, and nothing is its own once disconnected", async () => {
    assert.equal(
      (await connect({ path: join(tmpdir(), "wizards-bot-not-here"), access: "write", own: true }))
        .status,
      400,
    );
    assert.equal(existsSync(join(tmpdir(), "wizards-bot-not-here")), false);
    assert.equal((await connect({ path: "~/.hidden", access: "write", own: true })).status, 400);
    const own = t.home.folders.own() as Folder;
    await t.request(`/v1/folders/${own.id}`, { method: "DELETE" });
    assert.equal(t.home.folders.own(), undefined);
    assert.equal((await setup()).ownFolder?.connected, false);
  });

  test("a hosted home's setup has none", async () => {
    const hosted = await testHome("Ben", undefined, {
      config: { manageUrl: "http://127.0.0.1:9" },
    });
    try {
      const view = (await (await hosted.request("/v1/setup")).json()) as Setup;
      assert.equal(view.hosted, true);
      assert.equal(view.ownFolder, undefined);
    } finally {
      hosted.stop();
    }
  });
});

describe("a new folder an agent proposes", () => {
  let t: TestHome;
  let home: string;
  let was: string | undefined;

  before(async () => {
    t = await testHome("Ada");
    home = realpathSync(mkdtempSync(join(tmpdir(), "wizards-bot-home-")));
    mkdirSync(join(home, "code"));
    was = process.env.HOME;
    process.env.HOME = home;
  });
  after(() => {
    process.env.HOME = was;
    return t.stop();
  });

  const propose = async (args: Record<string, unknown>): Promise<string> => {
    t.model.script.push({ calls: [{ name: "folder_connect", arguments: args }] }, { text: "ok" });
    await t.say("keep the laws somewhere");
    const messages = (t.model.requests.at(-1)?.messages ?? []) as {
      role: string;
      content: string;
    }[];
    return messages.findLast((message) => message.role === "tool")?.content ?? "";
  };

  test("is made and connected after one yes on the card", async () => {
    t.model.script.push({
      calls: [
        {
          name: "folder_connect",
          arguments: {
            purpose: "A folder for the legal texts",
            access: "write",
            path: "~/code/wizards/data",
            create: true,
          },
        },
      ],
    });
    await t.say("keep the laws somewhere");
    const card = t.item();
    const field = card.fields?.[0];
    assert.equal(field?.value, join(home, "code", "wizards", "data"));
    assert.match(field?.placeholder ?? "", /makes this folder/);
    assert.equal(existsSync(join(home, "code", "wizards")), false);

    t.model.script.push({ text: "Connected." });
    await t.answer(card.id, "connect", {
      folder: join(home, "code", "wizards", "data"),
      access: "write",
    });
    assert.equal(existsSync(join(home, "code", "wizards", "data")), true);
    const folder = t.home.folders.byName("data") as Folder;
    assert.deepEqual(
      [folder.path, folder.access],
      [join(home, "code", "wizards", "data"), "write"],
    );
  });

  test("is not made hidden, outside the person's places or in the system", async () => {
    for (const path of ["~/.config/x", "/etc/wizards", join(tmpdir(), "wizards-bot-elsewhere")]) {
      const told = await propose({ purpose: "x", access: "read", path, create: true });
      assert.match(told, /without `path`/, path);
      assert.equal(existsSync(path.replace("~", home)), false, path);
    }
  });

  test("a path that is not there without `create` is not made", async () => {
    const told = await propose({ purpose: "x", access: "read", path: "~/code/missing" });
    assert.match(told, /no such folder/);
    assert.equal(existsSync(join(home, "code", "missing")), false);
  });

  test("every agent of the person may ask to connect a folder", async () => {
    const guide = t.home.store.createAgent({ name: "Guide", kind: "drop", about: "Knows laws." });
    const tools = (
      t.home.folders as unknown as {
        tools(context: unknown): { name: string }[];
      }
    ).tools({
      home: t.home,
      agent: guide,
      conversationId: guide.conversationId,
      draft: { id: "d" },
    });
    assert.ok(tools.some((tool) => tool.name === "folder_connect"));
  });

  test("the picker names its place and the disks besides the home folder", async () => {
    const listing = (await (
      await t.request(`/v1/folders/browse?path=${encodeURIComponent(join(home, "code"))}`)
    ).json()) as FolderListing;
    assert.equal(listing.root, home);
    assert.ok(Array.isArray(listing.disks));
  });
});

describe("a Bot Server on a server", () => {
  let t: TestHome;
  let files: string;

  before(async () => {
    files = join(realpathSync(mkdtempSync(join(tmpdir(), "wizards-bot-vps-"))), "files");
    t = await testHome("Ada", undefined, { config: { filesDir: files } });
  });
  after(() => t.stop());

  test("has one folder of files, the agents' own, connected for changes from the start", () => {
    const own = t.home.folders.own() as Folder;
    assert.deepEqual([own.path, own.access], [realpathSync(files), "write"]);
  });

  test("picks, makes and connects folders only inside it", async () => {
    const listing = (await (await t.request("/v1/folders/browse")).json()) as FolderListing;
    assert.deepEqual([listing.home, listing.disks], [realpathSync(files), []]);
    const made = await t.request("/v1/folders/new", { body: { parent: files, name: "Laws" } });
    assert.equal(made.status, 200);
    const status = async (path: string) =>
      (await t.request("/v1/folders/preview", { body: { path } })).status;
    assert.equal(await status(join(files, "Laws")), 200);
    assert.equal(await status(tmpdir()), 400);
    assert.equal(await status(homedir()), 400);
  });
});
