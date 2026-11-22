import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { exportData, importData } from "./backup.ts";
import { type TestHome, testHome, textOf } from "./test/fakes.ts";

const PASSPHRASE = "correct horse battery staple";

describe("the export of a home", () => {
  let t: TestHome;
  const work = mkdtempSync(join(tmpdir(), "wizards-bot-backup-test-"));
  const file = join(work, "home.export");

  before(async () => {
    t = await testHome("Ada");
    t.home.secrets.set("gateway.openrouter", "sk-or-secret-key");
    t.model.script.push({ text: "Noted." });
    await t.say("Remember the blue door.");
  });
  after(() => t.stop());

  test("is made while the home runs and shows nothing of it", async () => {
    await exportData(t.home.config.dataDir, file, PASSPHRASE);
    const bytes = readFileSync(file);
    assert.equal(bytes.subarray(0, 4).toString(), "WBX1");
    for (const plain of ["blue door", "sk-or-secret-key", "SQLite format"])
      assert.ok(!bytes.includes(plain), `the export shows "${plain}"`);
  });

  test("brings the same home back in another folder", async () => {
    const dataDir = join(work, "back");
    await importData(file, dataDir, PASSPHRASE);
    const back = await testHome("Ada", undefined, { dataDir });
    try {
      assert.equal(back.home.identity.publicKey, t.home.identity.publicKey);
      assert.equal(back.home.secrets.get("gateway.openrouter"), "sk-or-secret-key");
      const said = back.home.store
        .messages(back.home.store.mainAgent().conversationId, { limit: 10 })
        .messages.map(textOf);
      assert.ok(said.includes("Remember the blue door."));
      assert.ok(said.includes("Noted."));
    } finally {
      back.stop();
    }
  });

  test("is not unpacked with a wrong passphrase or a changed byte", async () => {
    const dataDir = join(work, "wrong");
    await assert.rejects(importData(file, dataDir, "a wrong passphrase"), /passphrase is wrong/);
    assert.ok(!existsSync(join(dataDir, "home.db")));
    const changed = readFileSync(file);
    changed[changed.length - 40] = (changed[changed.length - 40] as number) ^ 1;
    const changedFile = join(work, "changed.export");
    writeFileSync(changedFile, changed);
    await assert.rejects(importData(changedFile, dataDir, PASSPHRASE), /file was changed/);
    assert.ok(!existsSync(join(dataDir, "home.db")));
  });

  test("does not go over a home that is there", async () => {
    await assert.rejects(
      importData(file, t.home.config.dataDir, PASSPHRASE),
      /holds a Bot Server already/,
    );
  });

  test("asks for a passphrase long enough", async () => {
    await assert.rejects(exportData(t.home.config.dataDir, file, "short"), /at least 12/);
  });
});
