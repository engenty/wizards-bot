import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
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
import type { Folder } from "@wizards-bot/protocol";
import { type TestHome, testHome } from "../test/fakes.ts";
import { badPart, executable, refusedFolder, secret, visible } from "./rules.ts";

describe("what no agent reaches", () => {
  test("files that hold keys or passwords, by their name", () => {
    for (const name of [
      "id_rsa",
      "id_ed25519.pub",
      "server.pem",
      "cert.p12",
      "Passwords.kdbx",
      "login.keychain-db",
      "prod.env",
      "credentials.json",
      "secrets.yaml",
      "main.tfstate",
    ])
      assert.equal(secret(name), true, name);
    for (const name of ["invoice.pdf", "environment.md", "Kevin.docx", "keys.txt", "venv"])
      assert.equal(secret(name), false, name);
    assert.equal(visible(".env"), false);
    assert.equal(visible("~$Report.docx"), false);
    assert.deepEqual(
      [badPart(["a", "..", "b"]), badPart([".git"]), badPart(["keys", "id_rsa"]), badPart(["a"])],
      ["outside", "hidden", "secret", undefined],
    );
  });

  test("files that run when they are opened", () => {
    for (const name of ["start.command", "Tool.app", "run.sh", "setup.exe", "x.scpt"])
      assert.equal(executable(name), true, name);
    assert.equal(executable("notes.md"), false);
  });

  test("the system's folders with everything in them, the whole disk and the home's data", () => {
    const data = realpathSync(mkdtempSync(join(tmpdir(), "wizards-bot-data-")));
    const etc = realpathSync("/etc");
    assert.equal(refusedFolder(etc, data), "system");
    assert.equal(refusedFolder(join(etc, "ssh"), data), "system");
    assert.equal(refusedFolder("/usr/local", data), "system");
    assert.equal(refusedFolder("/", data), "whole");
    assert.equal(refusedFolder(realpathSync(homedir()), data), "whole");
    assert.equal(
      refusedFolder(join(realpathSync(homedir()), "Library", "Keychains"), data),
      "system",
    );
    assert.equal(refusedFolder(join(data, "files"), data), "data");
    const mine = realpathSync(mkdtempSync(join(tmpdir(), "wizards-bot-mine-")));
    assert.equal(refusedFolder(mine, data), undefined);
  });
});

describe("a folder connected for changes", () => {
  let t: TestHome;
  let root: string;
  let outside: string;
  let folder: Folder;

  before(async () => {
    t = await testHome("Ada");
    root = realpathSync(mkdtempSync(join(tmpdir(), "wizards-bot-office-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "wizards-bot-elsewhere-")));
    mkdirSync(join(root, "keys"));
    writeFileSync(join(root, "keys", "id_rsa"), "-----BEGIN-----");
    writeFileSync(join(root, "server.pem"), "-----BEGIN-----");
    writeFileSync(join(root, "plan.md"), "# Plan\nkey words\n");
    writeFileSync(join(outside, "original.txt"), "theirs");
    linkSync(join(outside, "original.txt"), join(root, "twin.txt"));
    // A link to a place that is not there yet.
    symlinkSync(join(outside, "made-there.txt"), join(root, "later.txt"));
    folder = t.home.folders.connect({ path: root, access: "write" });
  });
  after(() => t.stop());

  test("writes nothing through a link, also to a place that is not there yet", async () => {
    await assert.rejects(t.home.folders.write(folder, "later.txt", "x"), /leads out of/);
    assert.equal(existsSync(join(outside, "made-there.txt")), false);
  });

  test("changes no file that has a second name elsewhere", async () => {
    await assert.rejects(t.home.folders.write(folder, "twin.txt", "mine"), /second name/);
    assert.equal(readFileSync(join(outside, "original.txt"), "utf8"), "theirs");
  });

  test("writes no program", async () => {
    await assert.rejects(t.home.folders.write(folder, "start.command", "rm -rf ~"), /program/);
    assert.equal(existsSync(join(root, "start.command")), false);
  });

  test("keeps files with keys and passwords closed: not listed, not read, not found", async () => {
    assert.throws(() => t.home.folders.locate(folder, "keys/id_rsa"), /stays closed/);
    const listed = t.home.folders.files(folder);
    assert.deepEqual([...(listed?.files.keys() ?? [])].sort(), ["plan.md", "twin.txt"]);
  });

  test("writes a new file through Mastra's filesystem, with the folders on the way", async () => {
    await t.home.folders.write(folder, "2026/notes.md", "# Notes\n");
    assert.equal(readFileSync(join(root, "2026", "notes.md"), "utf8"), "# Notes\n");
  });
});
