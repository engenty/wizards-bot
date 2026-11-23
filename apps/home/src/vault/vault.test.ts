import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { installedChrome } from "@engenty/browser";
import type { VaultImported, VaultItem, VaultSecret, VaultView } from "@wizards-bot/protocol";
import { type TestHome, testHome } from "../test/fakes.ts";

const PASSWORD = "Correct-Horse-Battery-9";

describe("the Vault", () => {
  let t: TestHome;
  before(async () => {
    t = await testHome("Ada");
  });
  after(() => t.stop());

  const json = async <T>(path: string, init?: { method?: string; body?: unknown }) =>
    (await (await t.request(path, init)).json()) as T;

  test("keeps a login sealed, shows its user name and reveals it to the device, logged", async () => {
    const item = await json<VaultItem>("/v1/vault", {
      body: {
        kind: "login",
        label: "Reports",
        origin: "https://reports.example.com/login?x=1",
        username: "ada@example.com",
        password: PASSWORD,
      },
    });
    assert.equal(item.origin, "https://reports.example.com");
    assert.equal(item.detail, "ada@example.com");
    const stored = t.home.db.get<{ sealed: string; hint: string }>(
      "select sealed, hint from vault_item where id = ?",
      item.id,
    );
    assert.ok(stored && !stored.sealed.includes(PASSWORD) && !stored.sealed.includes("ada@"));
    assert.equal(stored?.hint, "ad•••");
    const secret = await json<VaultSecret>(`/v1/vault/${item.id}/reveal`, { method: "POST" });
    assert.equal(secret.password, PASSWORD);
    const view = await json<VaultView>("/v1/vault");
    assert.deepEqual(
      view.activity.map((a) => a.action),
      ["reveal", "create"],
    );
  });

  test("refuses a card number that is not one and an address with a password in it", async () => {
    const card = await t.request("/v1/vault", {
      body: {
        kind: "card",
        label: "Card",
        holder: "Ada",
        number: "4111 1111 1111 1112",
        expiry: "12/29",
      },
    });
    assert.equal(card.status, 400);
    const login = await t.request("/v1/vault", {
      body: {
        kind: "login",
        label: "X",
        origin: "https://a:b@example.com",
        username: "a",
        password: "b",
      },
    });
    assert.equal(login.status, 400);
  });

  test("imports a password manager's CSV and replaces a login of the same site and user", async () => {
    const csv = [
      "name,url,username,password",
      `Reports,https://reports.example.com,ada@example.com,new-${PASSWORD}`,
      "Shop,shop.example.com,ada,shop-pass",
    ].join("\n");
    const imported = await json<VaultImported>("/v1/vault/import", { body: { csv } });
    assert.deepEqual(imported, { added: 1, updated: 1, unreadable: 0, badKeys: 0 });
    const view = await json<VaultView>("/v1/vault");
    assert.deepEqual(
      view.items.map((i) => [i.label, i.origin]),
      [
        ["Reports", "https://reports.example.com"],
        ["Shop", "https://shop.example.com"],
      ],
    );
  });
});

// A real Chrome signs in on a page served here: where Chrome is installed, skipped elsewhere.
describe("signing in with a saved login", { skip: !installedChrome() }, () => {
  let t: TestHome;
  let site: Server;
  let siteUrl = "";
  const posted: string[] = [];

  before(async () => {
    t = await testHome("Ada");
    site = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      if (req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
        });
        req.on("end", () => {
          posted.push(body);
          res.end("<h1>Welcome back</h1>");
        });
        return;
      }
      res.end(
        '<form method="post"><label>Email <input name="u"></label><label>Password <input type="password" name="p"></label><button>Sign in</button></form>',
      );
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    await t.request("/v1/vault", {
      body: { kind: "login", label: "Local", origin: siteUrl, username: "ada", password: PASSWORD },
    });
  });
  after(async () => {
    await t.home.browser.stop();
    t.stop();
    site.close();
  });

  test("asks first, enters the password on the page, and the model never reads it", async () => {
    t.model.script.push(
      { calls: [{ name: "browser_open", arguments: { url: siteUrl } }] },
      { calls: [{ name: "browser_snapshot", arguments: {} }] },
      {
        calls: [
          {
            name: "vault_sign_in",
            arguments: {
              usernameRef: "@e1",
              passwordRef: "@e2",
              submitRef: "@e3",
              why: "To read the weekly numbers.",
            },
          },
        ],
      },
      { text: "Asked." },
    );
    await t.say("Get this week's numbers from my local site");
    const card = t.item();
    assert.equal(card.kind, "approval");
    assert.match(card.title, /^Sign in to 127\.0\.0\.1:\d+ as ad•••\?$/);
    assert.equal(posted.length, 0, "nothing is entered before the person says yes");

    t.model.script.push({ text: "Done." });
    await t.answer(card.id, "once");

    assert.deepEqual(posted, [`u=ada&p=${PASSWORD}`]);
    const read = JSON.stringify(t.model.requests);
    assert.ok(!read.includes(PASSWORD), "no request to the model holds the password");
    assert.match(read, /entered privately/);
    const view = (await (await t.request("/v1/vault")).json()) as VaultView;
    assert.equal(view.activity[0]?.action, "sign_in");
  });
});
