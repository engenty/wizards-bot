import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import type { Setup } from "@wizards-bot/protocol";
import { loadConfig } from "./config.ts";
import { accountName } from "./home.ts";
import { type TestHome, testHome, textOf } from "./test/fakes.ts";

const TOKEN = "home-token-once";
const KEY = "gw_home_ada";
const SETUP_CODE = "K7QM-2RXD";

/**
 * The Manage-App as a hosted home meets it: the claim, which works once, and the gateway, which
 * speaks the AI SDK's gateway protocol and answers from a script.
 */
class FakeManage {
  url = "";
  claims = 0;
  /** What the claim answers: the contract's answer, or a status. */
  claimStatus = 200;
  /** The person's name in their account, when the claim gives one. */
  name: string | undefined;
  /** The headers of each call to the gateway's language model. */
  readonly calls: IncomingHttpHeaders[] = [];
  readonly script: string[] = [];
  private server: Server | undefined;

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        if (request.method === "POST" && request.url === "/v1/homes/claim") {
          if (request.headers.authorization !== `Bearer ${TOKEN}`) {
            response.statusCode = 401;
            return response.end("{}");
          }
          this.claims++;
          if (this.claims > 1 || this.claimStatus !== 200) {
            response.statusCode = this.claims > 1 ? 409 : this.claimStatus;
            return response.end(JSON.stringify({ error: "claimed" }));
          }
          return response.end(
            JSON.stringify({
              gatewayUrl: `${this.url}/`,
              gatewayKey: KEY,
              handle: "ada@wizards.bot",
              ...(this.name ? { name: this.name } : {}),
            }),
          );
        }
        if (request.method === "POST" && request.url === "/v4/ai/language-model") {
          this.calls.push(request.headers);
          if (request.headers.authorization !== `Bearer ${KEY}`) {
            response.statusCode = 401;
            return response.end(JSON.stringify({ error: { message: "Invalid key" } }));
          }
          const text = this.script.shift() ?? "ok";
          const finish = {
            finishReason: { unified: "stop", raw: "stop" },
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          };
          if (request.headers["ai-language-model-streaming"] === "true") {
            response.setHeader("content-type", "text/event-stream");
            const parts = [
              { type: "stream-start", warnings: [] },
              { type: "text-start", id: "t" },
              { type: "text-delta", id: "t", delta: text },
              { type: "text-end", id: "t" },
              { type: "finish", ...finish },
            ];
            return response.end(parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join(""));
          }
          JSON.parse(body);
          return response.end(
            JSON.stringify({ content: [{ type: "text", text }], warnings: [], ...finish }),
          );
        }
        response.statusCode = 404;
        response.end("{}");
      });
    });
    const server = this.server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  stop(): void {
    this.server?.close();
  }
}

describe("a hosted home", () => {
  let manage: FakeManage;
  let t: TestHome;

  const hosted = () => ({
    manageUrl: manage.url,
    homeToken: TOKEN,
    setupCode: "K7QM2RXD",
    // A server has no Ollama.
    ollamaUrl: "http://127.0.0.1:9",
  });

  before(async () => {
    manage = new FakeManage();
    await manage.start();
    t = await testHome("Ada", undefined, { config: hosted() });
  });
  after(() => {
    t.stop();
    manage.stop();
  });

  test("reads its settings from the environment", () => {
    const config = loadConfig({
      WIZARDS_BOT_DATA: t.home.config.dataDir,
      WIZARDS_BOT_SETUP_CODE: "k7qm-2rxd",
      WIZARDS_BOT_MANAGE_URL: "https://manage.wizards.bot/",
      WIZARDS_BOT_HOME_TOKEN: TOKEN,
    });
    assert.equal(config.setupCode, "K7QM2RXD");
    assert.equal(config.manageUrl, "https://manage.wizards.bot");
    assert.equal(config.homeToken, TOKEN);
    const plain = loadConfig({ WIZARDS_BOT_DATA: t.home.config.dataDir });
    assert.equal(plain.setupCode, undefined);
    assert.equal(plain.manageUrl, undefined);
  });

  test("answers on /health without signing in", async () => {
    const response = await fetch(`${t.url}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });

  test("claims the gateway's key and its handle once, and keeps them", async () => {
    assert.equal(t.home.models.account(), undefined);
    assert.equal(await t.home.hosted.claim(), "claimed");
    assert.equal(manage.claims, 1);
    assert.deepEqual(t.home.models.account(), { gatewayUrl: manage.url });
    assert.equal(t.home.models.accountKey(), KEY);
    assert.equal(t.home.handle(), "ada@wizards.bot");
    // The key is a secret: not in the meta the home keeps in the clear.
    const meta = t.home.db.all<{ value: string }>("select value from meta");
    assert.ok(!meta.some((row) => row.value.includes(KEY)));
    assert.equal(await t.home.hosted.claim(), "kept");
    assert.equal(manage.claims, 1);
  });

  test("lists the wizards account as a model source, and the home asks it", async () => {
    await t.home.idle();
    const models = await (await t.request("/v1/models")).json();
    const account = (
      models as { sources: { id: string; online: boolean; kind: string }[] }
    ).sources.find((source) => source.id === "wizards");
    assert.equal(account?.online, true);
    assert.equal(account?.kind, "gateway");
    assert.equal(t.home.models.candidates()[0], "wizards:wizards/standard");
  });

  test("its setup tests the account and offers a key of one's own and the computer", async () => {
    await t.home.setup.test("wizards");
    const setup = (await (await t.request("/v1/setup")).json()) as Setup;
    const ids = setup.models.map((check) => check.id);
    assert.deepEqual(ids, ["wizards", "own-key", "link"]);
    const account = setup.models[0];
    assert.equal(account?.state, "ok");
    assert.equal(account?.said, "Your wizards account answers with wizards/standard.");
    assert.equal(setup.working, true);
    assert.match(setup.models[2]?.command ?? "", /^wizards bot setup --link http/);
    // The gateway call is the runtime's: the home's key as bearer, no tenant.
    const call = manage.calls.at(-1);
    assert.equal(call?.authorization, `Bearer ${KEY}`);
    assert.equal(call?.["ai-language-model-id"], "wizards/standard");
    assert.equal(call?.["x-wizards-tenant"], undefined);
  });

  test("an agent answers through the account", async () => {
    await t.request("/v1/consent", { body: { services: ["wizards"] } });
    manage.script.push("Hello from the account.");
    const reply = await t.say("Hello");
    assert.equal(textOf(reply), "Hello from the account.");
    assert.equal(reply.model, "wizards:wizards/standard");
  });

  test("its setup code pairs the first device and then ends", async () => {
    t.home.db.run("delete from device");
    const pair = (code: string) =>
      fetch(`${t.url}/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, name: "Ada's iPhone", kind: "phone" }),
      });
    assert.equal((await pair("K7QM-2RXE")).status, 401);
    assert.equal((await pair(SETUP_CODE)).status, 200);
    assert.equal((await pair(SETUP_CODE)).status, 401);
    // Ended for good, also once no device is left.
    t.home.db.run("delete from device");
    assert.equal(t.home.hosted.setupCodeOpen(), false);
  });

  test("a second start does not claim again", async () => {
    const dataDir = t.home.config.dataDir;
    t.stop();
    t = await testHome("Ada", undefined, { dataDir, config: hosted() });
    assert.equal(await t.home.hosted.claim(), "kept");
    assert.equal(manage.claims, 1);
    assert.equal(t.home.handle(), "ada@wizards.bot");
  });
});

describe("the person's name on a hosted Bot Server", () => {
  test("is not taken from the account root", () => {
    assert.equal(accountName("root"), "");
    assert.equal(accountName("ada"), "Ada");
  });

  test("is empty until the person says it, so the setup asks", async () => {
    const manage = new FakeManage();
    await manage.start();
    const t = await testHome("Ada", undefined, {
      config: { manageUrl: manage.url, homeToken: TOKEN, ollamaUrl: "http://127.0.0.1:9" },
    });
    try {
      // What testHome named it, gone: as a new hosted home in a container starts.
      t.home.db.run("delete from meta where key = 'person.name'");
      assert.equal(t.home.person(), "");
      const setup = await t.home.setup.view();
      assert.deepEqual(setup.name, { value: "", confirmed: false });
      assert.equal(t.home.handle(), `me@127.0.0.1:${new URL(t.url).port}`);
      await t.home.setup.change({ name: "Ada Lovelace" });
      assert.equal(t.home.person(), "Ada Lovelace");
    } finally {
      t.stop();
      manage.stop();
    }
  });

  test("is the account's when the claim gives one, for the person to confirm", async () => {
    const manage = new FakeManage();
    await manage.start();
    manage.name = "Ada Lovelace";
    const t = await testHome("Ada", undefined, {
      config: { manageUrl: manage.url, homeToken: TOKEN, ollamaUrl: "http://127.0.0.1:9" },
    });
    try {
      t.home.db.run("delete from meta where key = 'person.name'");
      assert.equal(await t.home.hosted.claim(), "claimed");
      await t.home.idle();
      const setup = await t.home.setup.view();
      assert.deepEqual(setup.name, { value: "Ada Lovelace", confirmed: false });
      assert.equal(t.home.handle(), "ada@wizards.bot");
    } finally {
      t.stop();
      manage.stop();
    }
  });
});

describe("a hosted home whose token was claimed already", () => {
  test("keeps running without the account and does not try again", async () => {
    const manage = new FakeManage();
    await manage.start();
    manage.claimStatus = 409;
    const t = await testHome("Ben", undefined, {
      config: { manageUrl: manage.url, homeToken: TOKEN },
    });
    try {
      assert.equal(await t.home.hosted.claim(), "refused");
      assert.equal(t.home.models.account(), undefined);
      const setup = await t.home.setup.view();
      assert.ok(!setup.models.some((check) => check.id === "wizards"));
    } finally {
      t.stop();
      manage.stop();
    }
  });
});

describe("a home that is not hosted", () => {
  test("claims nothing and has no setup code", async () => {
    const t = await testHome("Cleo");
    try {
      assert.equal(await t.home.hosted.claim(), "none");
      assert.equal(t.home.hosted.setupCodeOpen(), false);
      const setup = await t.home.setup.view();
      assert.ok(setup.models.some((check) => check.id === "ollama"));
      assert.ok(!setup.models.some((check) => check.id === "link"));
    } finally {
      t.stop();
    }
  });
});
