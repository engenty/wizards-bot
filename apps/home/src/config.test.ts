import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { claimData, DataTooNew, extendPath, olderVersion } from "./config.ts";

const dir = mkdtempSync(join(tmpdir(), "wizards-config-"));
after(() => rmSync(dir, { recursive: true, force: true }));

describe("versions", () => {
  test("compare by their numbers", () => {
    assert.equal(olderVersion("0.1.1", "0.2.0"), true);
    assert.equal(olderVersion("0.10.0", "0.9.9"), false);
    assert.equal(olderVersion("0.2.0", "0.2.0"), false);
    assert.equal(olderVersion("0.2", "0.2.1"), true);
    assert.equal(olderVersion("1.0.0-beta.1", "1.0.0"), false);
  });
});

describe("the data folder's version", () => {
  test("is noted by the home that starts on it", () => {
    const data = mkdtempSync(join(dir, "data-"));
    claimData(data, "0.2.0");
    assert.equal(readFileSync(join(data, "version"), "utf8"), "0.2.0\n");
    claimData(data, "0.3.0");
    assert.equal(readFileSync(join(data, "version"), "utf8"), "0.3.0\n");
  });

  test("keeps an older home away from data a newer one wrote", () => {
    const data = mkdtempSync(join(dir, "data-"));
    claimData(data, "0.3.0");
    assert.throws(() => claimData(data, "0.2.0"), DataTooNew);
    assert.equal(readFileSync(join(data, "version"), "utf8"), "0.3.0\n");
  });
});

describe("PATH", () => {
  test("gets the person's folders in front, from the setting and the data folder", () => {
    const data = mkdtempSync(join(dir, "data-"));
    writeFileSync(join(data, "path"), "/Users/ada/.local/bin:/opt/homebrew/bin:relative\n");
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin:/opt/homebrew/bin",
      WIZARDS_BOT_PATH: "/Users/ada/.nvm/bin",
    };
    assert.equal(
      extendPath(data, env),
      "/Users/ada/.nvm/bin:/Users/ada/.local/bin:/opt/homebrew/bin:/usr/bin:/bin",
    );
  });

  test("stays as it is without either", () => {
    const data = mkdtempSync(join(dir, "data-"));
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin:/bin" };
    assert.equal(extendPath(data, env), "/usr/bin:/bin");
  });
});
