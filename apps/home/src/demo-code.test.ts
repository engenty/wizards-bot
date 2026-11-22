import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { loadConfig } from "./config.ts";
import { type TestHome, testHome } from "./test/fakes.ts";

describe("the demo code of a home App Review pairs with", () => {
  let t: TestHome;

  before(async () => {
    t = await testHome("Demo");
  });
  after(() => t.stop());

  const pair = (code: string) =>
    fetch(`${t.url}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name: "Reviewer's iPhone", kind: "phone" }),
    });

  test("is read from the environment only when it is long enough", () => {
    const env = { WIZARDS_BOT_DATA: t.home.config.dataDir };
    assert.equal(
      loadConfig({ ...env, WIZARDS_BOT_DEMO_CODE: "rev-2026-ok" }).demoCode,
      "REV2026OK",
    );
    assert.equal(loadConfig({ ...env, WIZARDS_BOT_DEMO_CODE: "short" }).demoCode, undefined);
    assert.equal(loadConfig(env).demoCode, undefined);
  });

  test("a home without one takes no made-up code", async () => {
    assert.equal((await pair("REVI-EW26")).status, 401);
  });

  test("pairs again and again, written either way", async () => {
    t.home.config.demoCode = "REVIEW26";
    assert.equal((await pair("REVI-EW26")).status, 200);
    assert.equal((await pair("review26")).status, 200);
    assert.equal((await pair("REVIEW27")).status, 401);
  });
});
