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
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Folder, FolderActivity, FolderEntries } from "@wizards-bot/protocol";
import { type TestHome, testHome } from "../test/fakes.ts";

describe("the file browser's routes", () => {
  let t: TestHome;
  let home: string;
  let office: string;
  let laws: string;
  let was: string | undefined;
  let folder: Folder;
  let readOnly: Folder;

  before(async () => {
    t = await testHome("Ada");
    home = realpathSync(mkdtempSync(join(tmpdir(), "wizards-bot-home-")));
    was = process.env.HOME;
    process.env.HOME = home;
    office = join(home, "Office");
    laws = join(home, "Laws");
    mkdirSync(join(office, "letters"), { recursive: true });
    mkdirSync(laws);
    writeFileSync(join(office, "letters", "kraus.md"), "Dear Mr Kraus\n");
    writeFileSync(join(office, "plan.txt"), "plan");
    writeFileSync(join(office, ".env"), "TOKEN=x");
    writeFileSync(join(office, "server.pem"), "key");
    symlinkSync(tmpdir(), join(office, "out"));
    writeFileSync(join(laws, "bgb.txt"), "§ 1");
    folder = t.home.folders.connect({ path: office, access: "write" });
    readOnly = t.home.folders.connect({ path: laws, access: "read" });
  });
  after(() => {
    process.env.HOME = was;
    return t.stop();
  });

  const json = async <T>(path: string, init?: Parameters<TestHome["request"]>[1]) =>
    (await (await t.request(path, init)).json()) as T;
  const put = (id: string, path: string, text: string) =>
    fetch(`${t.url}/v1/folders/${id}/file?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${t.token}`, "content-type": "application/octet-stream" },
      body: text,
    });
  const activity = (id = folder.id) =>
    json<{ activity: FolderActivity[] }>(`/v1/folders/${id}/activity`).then((a) => a.activity);

  test("list what the agents reach: nothing hidden, no secret, no link", async () => {
    const top = await json<FolderEntries>(`/v1/folders/${folder.id}/entries`);
    assert.deepEqual(
      top.entries.map((entry) => [entry.name, entry.kind]),
      [
        ["letters", "folder"],
        ["plan.txt", "file"],
      ],
    );
    assert.equal(top.parent, null);
    const inner = await json<FolderEntries>(`/v1/folders/${folder.id}/entries?path=letters`);
    assert.deepEqual([inner.path, inner.parent], ["letters", ""]);
    assert.equal(inner.entries[0]?.path, "letters/kraus.md");
    const out = await t.request(`/v1/folders/${folder.id}/entries?path=out`);
    assert.equal(out.status, 400);
  });

  test("serve a file for showing or saving, never as a page, and no secret", async () => {
    const shown = await t.request(`/v1/folders/${folder.id}/file?path=letters/kraus.md`);
    assert.equal(shown.status, 200);
    assert.match(shown.headers.get("content-type") ?? "", /^text\/plain/);
    assert.match(shown.headers.get("content-disposition") ?? "", /^inline/);
    assert.match(shown.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.equal(await shown.text(), "Dear Mr Kraus\n");
    const saved = await t.request(`/v1/folders/${folder.id}/file?path=plan.txt&download`);
    assert.match(saved.headers.get("content-disposition") ?? "", /^attachment/);
    await saved.arrayBuffer();
    assert.equal((await t.request(`/v1/folders/${folder.id}/file?path=server.pem`)).status, 400);
    assert.equal((await t.request(`/v1/folders/${folder.id}/file?path=.env`)).status, 400);
  });

  test("what an agent did shows per turn with its name, and a change is taken back", async () => {
    t.home.folders.setAllow(folder.id, "always");
    t.model.script.push(
      {
        calls: [
          {
            name: "folder_write",
            arguments: { folder: "Office", path: "todo.md", content: "- call", why: "A list." },
          },
          { name: "folder_read", arguments: { folder: "Office", path: "plan.txt" } },
        ],
      },
      { text: "Done." },
    );
    await t.say("make a list");
    const [row] = await activity();
    assert.equal(row?.agentName, t.home.store.mainAgent().name);
    assert.equal(row?.read, 1);
    assert.deepEqual(
      row?.changes.map((change) => [change.action, change.path]),
      [["write", "todo.md"]],
    );
    const undone = await json<{ activity: FolderActivity[] }>(`/v1/folders/${folder.id}/undo`, {
      body: { activityId: row?.id, index: 0 },
    });
    assert.equal(undone.activity[0]?.changes[0]?.undone, true);
    assert.equal(existsSync(join(office, "todo.md")), false);
    const again = await t.request(`/v1/folders/${folder.id}/undo`, {
      body: { activityId: row?.id, index: 0 },
    });
    assert.equal(again.status, 400);
  });

  test("the person drops a file in, makes, renames and deletes, and takes it back", async () => {
    assert.equal((await put(folder.id, "inbox/scan.txt", "scan")).status, 200);
    assert.equal(readFileSync(join(office, "inbox", "scan.txt"), "utf8"), "scan");
    const edit = (body: unknown) =>
      t.request(`/v1/folders/${folder.id}/edit`, { body }).then((r) => r.status);
    assert.equal(await edit({ action: "make", path: "2026" }), 204);
    assert.equal(await edit({ action: "move", from: "inbox/scan.txt", to: "2026/scan.txt" }), 204);
    assert.equal(existsSync(join(office, "2026", "scan.txt")), true);
    assert.equal(await edit({ action: "trash", paths: ["2026/scan.txt"] }), 204);
    assert.equal(existsSync(join(office, "2026", "scan.txt")), false);
    const [deleted] = await activity();
    assert.equal(deleted?.agentId, undefined);
    assert.deepEqual([deleted?.changes[0]?.action, deleted?.changes[0]?.kept], ["delete", true]);
    await t.request(`/v1/folders/${folder.id}/undo`, {
      body: { activityId: deleted?.id, index: 0 },
    });
    assert.equal(readFileSync(join(office, "2026", "scan.txt"), "utf8"), "scan");
  });

  test("nothing changes in a folder connected for reading", async () => {
    assert.equal((await put(readOnly.id, "x.txt", "x")).status, 400);
    const status = (
      await t.request(`/v1/folders/${readOnly.id}/edit`, {
        body: { action: "trash", paths: ["bgb.txt"] },
      })
    ).status;
    assert.equal(status, 400);
    assert.equal(existsSync(join(laws, "bgb.txt")), true);
  });
});
