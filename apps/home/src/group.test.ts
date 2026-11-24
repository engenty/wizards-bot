import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import type { Card, HomeInfo, Message, PairResponse } from "@wizards-bot/protocol";
import { PassRefused } from "./group.ts";
import { type TestHome, testHome, textOf } from "./test/fakes.ts";

const KEY = "wbk_group_home";

/** The Manage-App as a group home meets it: who its admins are, and the key that signs passes. */
class FakeManage {
  url = "";
  group: { name: string } | null = { name: "Club" };
  admins = [
    { id: "usr_ada", name: "Ada", role: "owner" },
    { id: "usr_ben", name: "Ben", role: "admin" },
  ];
  pulls = 0;
  readonly keys = generateKeyPairSync("ed25519");
  readonly kid = "key-1";
  private server: Server | undefined;

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/homes/admins") {
        if (request.headers.authorization !== `Bearer ${KEY}`) {
          response.statusCode = 401;
          return response.end("{}");
        }
        this.pulls++;
        return response.end(JSON.stringify({ group: this.group, admins: this.admins }));
      }
      if (request.url === "/api/auth/jwks") {
        const jwk = this.keys.publicKey.export({ format: "jwk" });
        return response.end(JSON.stringify({ keys: [{ ...jwk, kid: this.kid, alg: "EdDSA" }] }));
      }
      response.statusCode = 404;
      response.end("{}");
    });
    const server = this.server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  stop(): void {
    this.server?.close();
  }

  /** A pass as the Manage-App signs it: EdDSA, for one admin and one home's origin. */
  pass(
    sub: string,
    aud: string,
    more: { exp?: number; jti?: string; key?: FakeManage["keys"]["privateKey"] } = {},
  ): string {
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const head = part({ alg: "EdDSA", kid: this.kid, typ: "JWT" });
    const body = part({
      iss: this.url,
      aud,
      sub,
      name: sub,
      exp: more.exp ?? Math.floor(Date.now() / 1000) + 300,
      jti: more.jti ?? randomUUID(),
    });
    const signature = sign(null, Buffer.from(`${head}.${body}`), more.key ?? this.keys.privateKey);
    return `${head}.${body}.${signature.toString("base64url")}`;
  }
}

describe("a group home", () => {
  let manage: FakeManage;
  let t: TestHome;
  let ada = "";
  let ben = "";

  const pair = (pass: string, name: string) =>
    fetch(`${t.url}/v1/pair/admin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pass, name, kind: "browser" }),
    });

  before(async () => {
    manage = new FakeManage();
    await manage.start();
    t = await testHome("Ada", undefined, { config: { manageUrl: manage.url } });
    // The key the claim would have given; the gateway itself is not part of these tests.
    t.home.models.accountKey = () => KEY;
    // Every device of a group home is an admin's: the test's own device goes.
    t.home.db.run("delete from device");
  });
  after(() => {
    t.stop();
    manage.stop();
  });

  test("asks the Manage-App who runs it, and speaks for the group", async () => {
    assert.equal(await t.home.group.pull(), true);
    assert.equal(t.home.group.isGroup(), true);
    assert.deepEqual(
      t.home.group.admins().map((admin) => admin.name),
      ["Ada", "Ben"],
    );
    const info = (await (await fetch(`${t.url}/v1/home`)).json()) as HomeInfo;
    assert.equal(info.name, "Club");
    assert.deepEqual(info.group, { name: "Club" });
  });

  test("pairs each admin's first device with a pass, as theirs", async () => {
    const response = await pair(manage.pass("usr_ada", t.url), "Ada's browser");
    assert.equal(response.status, 200);
    const paired = (await response.json()) as PairResponse;
    assert.deepEqual(paired.device.admin, { id: "usr_ada", name: "Ada" });
    assert.deepEqual(paired.home.group, { name: "Club" });
    ada = paired.token;
    ben = (
      (await (await pair(manage.pass("usr_ben", t.url), "Ben's browser")).json()) as PairResponse
    ).token;
    assert.ok(ben);
  });

  test("takes no setup code and no code without an admin", async () => {
    assert.equal(t.home.hosted.setupCodeOpen(), false);
    const code = t.home.store.newPairingCode();
    const response = await fetch(`${t.url}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name: "Someone's phone", kind: "phone" }),
    });
    assert.equal(response.status, 401);
  });

  test("refuses a pass that is used, old, for another home, badly signed or not an admin's", async () => {
    const used = manage.pass("usr_ada", t.url);
    assert.equal((await pair(used, "Ada's iPad")).status, 200);
    assert.equal((await pair(used, "Ada's iPad")).status, 401);
    const refused = (pass: string, why: RegExp) =>
      assert.rejects(t.home.group.admit(pass), (error: Error) => {
        assert.ok(error instanceof PassRefused);
        assert.match(error.message, why);
        return true;
      });
    await refused(used, /used already/);
    await refused(
      manage.pass("usr_ada", t.url, { exp: Math.floor(Date.now() / 1000) - 600 }),
      /too old/,
    );
    await refused(manage.pass("usr_ada", "https://other.wizards.bot"), /another Bot Server/);
    const stranger = generateKeyPairSync("ed25519").privateKey;
    await refused(manage.pass("usr_ada", t.url, { key: stranger }), /not signed/);
    await refused(manage.pass("usr_eve", t.url), /not an admin/);
    await refused("not.a-pass", /not one the Bot Server takes|not complete/);
  });

  test("a message names its admin, to the other admins and to the agent", async () => {
    const conversationId = t.home.store.mainAgent().conversationId;
    t.model.script.push({ text: "Hello Ben." });
    await t.request(`/v1/conversations/${conversationId}/messages`, {
      token: ben,
      body: { text: "Hello" },
    });
    await t.home.idle();
    const { messages } = (await (
      await t.request(`/v1/conversations/${conversationId}/messages`, { token: ada })
    ).json()) as { messages: Message[] };
    const mine = messages.find((message) => message.role === "you");
    assert.deepEqual(mine?.from, { name: "Ben", admin: "usr_ben" });
    const asked = t.model.requests.at(-1);
    const system = asked?.messages[0]?.content ?? "";
    assert.match(system, /an agent of the group Club/);
    assert.match(system, /Ada, Ben/);
    assert.match(asked?.messages.at(-1)?.content ?? "", /^Ben writes:\nHello/);
    assert.equal(textOf(t.last()), "Hello Ben.");
  });

  test("a card waits for every admin; the first answer counts and names who gave it", async () => {
    t.model.script.push(
      {
        calls: [{ name: "ask", arguments: { title: "Book the hall?", choices: ["Book", "Not"] } }],
      },
      { text: "Booked." },
    );
    const conversationId = t.home.store.mainAgent().conversationId;
    await t.request(`/v1/conversations/${conversationId}/messages`, {
      token: ada,
      body: { text: "Book the hall" },
    });
    await t.home.idle();
    const items = async (token: string) =>
      ((await (await t.request("/v1/items", { token })).json()) as { items: Card[] }).items;
    const card = (await items(ada)).at(-1) as Card;
    assert.equal((await items(ben)).at(-1)?.id, card.id);
    const answered = await t.request(`/v1/cards/${card.id}/answer`, {
      token: ben,
      body: { action: card.actions[0]?.id },
    });
    assert.equal(answered.status, 200);
    const { card: after } = (await answered.json()) as { card: Card };
    assert.deepEqual(after.answer?.admin, { id: "usr_ben", name: "Ben" });
    const late = await t.request(`/v1/cards/${card.id}/answer`, {
      token: ada,
      body: { action: card.actions[1]?.id },
    });
    assert.equal(late.status, 409);
    await t.home.idle();
    const told = JSON.stringify(t.model.requests.at(-1)?.messages ?? []);
    assert.match(told, /Ben answered the card/);
  });

  test("a pairing code an admin asks for pairs the device as theirs", async () => {
    t.model.script.push({ calls: [{ name: "device_pair", arguments: {} }] }, { text: "Scan it." });
    const conversationId = t.home.store.mainAgent().conversationId;
    await t.request(`/v1/conversations/${conversationId}/messages`, {
      token: ada,
      body: { text: "Add my phone" },
    });
    await t.home.idle();
    const card = t.home.store
      .messages(conversationId, { limit: 5 })
      .messages.flatMap((message) => message.parts)
      .find((part) => part.type === "card" && part.card.kind === "pairing");
    assert.ok(card?.type === "card");
    assert.match(card.card.title, /: Ada$/);
    const code = /\*\*([A-Z0-9-]+)\*\*/.exec(card.card.body ?? "")?.[1] ?? "";
    const response = await fetch(`${t.url}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name: "Ada's iPhone", kind: "phone" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(((await response.json()) as PairResponse).device.admin, {
      id: "usr_ada",
      name: "Ada",
    });
  });

  test("a device offers nothing to the agents of a group", async () => {
    const response = await t.request("/v1/device/resources", {
      method: "PUT",
      token: ada,
      body: { resources: [{ id: "cal", kind: "calendar", name: "Ada's", can: ["read"] }] },
    });
    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as { error: string }).error, "group_home");
  });

  test("an admin who is gone loses their devices with the next look", async () => {
    manage.admins = manage.admins.filter((admin) => admin.id !== "usr_ben");
    await t.home.group.pull();
    assert.equal((await t.request("/v1/agents", { token: ben })).status, 401);
    assert.equal((await t.request("/v1/agents", { token: ada })).status, 200);
    assert.deepEqual(
      t.home.group.admins().map((admin) => admin.name),
      ["Ada"],
    );
  });
});

describe("a personal hosted home", () => {
  test("stays one person's when the Manage-App names no group", async () => {
    const manage = new FakeManage();
    manage.group = null;
    await manage.start();
    const t = await testHome("Ada", undefined, { config: { manageUrl: manage.url } });
    try {
      t.home.models.accountKey = () => KEY;
      assert.equal(await t.home.group.pull(), true);
      assert.equal(t.home.group.isGroup(), false);
      assert.equal(t.home.info().group, undefined);
      assert.equal(t.home.person(), "Ada");
      const code = t.home.store.newPairingCode();
      const response = await fetch(`${t.url}/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, name: "Ada's iPad", kind: "phone" }),
      });
      assert.equal(response.status, 200);
    } finally {
      t.stop();
      manage.stop();
    }
  });
});
