import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type {
  Agent,
  Card,
  ChatLook,
  HomeInfo,
  Message,
  PairResponse,
  Setup,
} from "@wizards-bot/protocol";
import { PassRefused } from "./group.ts";
import { createServer as createApp } from "./server.ts";
import { type TestHome, testHome, textOf } from "./test/fakes.ts";

const KEY = "wbk_group_home";

/** The Manage-App as a group home meets it: who is in the team, and the key that signs passes. */
class FakeManage {
  url = "";
  group: { name: string } | null = { name: "Club" };
  people = [
    { id: "usr_ada", name: "Ada", role: "owner" },
    { id: "usr_ben", name: "Ben", role: "admin" },
    { id: "usr_cleo", name: "Cleo", role: "member" },
    { id: "usr_dora", name: "Dora", role: "client" },
  ];
  studio: { mcp: string } | null = null;
  pulls = 0;
  readonly keys = generateKeyPairSync("ed25519");
  readonly kid = "key-1";
  private server: Server | undefined;

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/v1/homes/people") {
        if (request.headers.authorization !== `Bearer ${KEY}`) {
          response.statusCode = 401;
          return response.end("{}");
        }
        this.pulls++;
        return response.end(
          JSON.stringify({ group: this.group, people: this.people, studio: this.studio }),
        );
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

  /** A pass as the Manage-App signs it: EdDSA, for one person and one home's origin. */
  pass(
    sub: string,
    aud: string,
    more: {
      exp?: number;
      jti?: string;
      origin?: string;
      key?: FakeManage["keys"]["privateKey"];
    } = {},
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
      ...(more.origin ? { origin: more.origin } : {}),
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
  let cleo = "";
  let dora = "";

  const pair = (pass: string, name: string, origin?: string) =>
    fetch(`${t.url}/v1/pair/pass`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
      body: JSON.stringify({ pass, name, kind: "browser" }),
    });

  before(async () => {
    manage = new FakeManage();
    await manage.start();
    t = await testHome("Ada", undefined, { config: { manageUrl: manage.url } });
    // The key the claim would have given; the gateway itself is not part of these tests.
    t.home.models.accountKey = () => KEY;
    // Every device of a group home is someone's: the test's own device goes.
    t.home.db.run("delete from device");
  });
  after(() => {
    t.stop();
    manage.stop();
  });

  test("asks the Manage-App who is in the team, and speaks for the group", async () => {
    assert.equal(await t.home.group.pull(), true);
    assert.equal(t.home.group.isGroup(), true);
    assert.deepEqual(
      t.home.group.admins().map((admin) => admin.name),
      ["Ada", "Ben"],
    );
    assert.deepEqual(
      t.home.group.people().map((person) => person.role),
      ["owner", "admin", "member", "client"],
    );
    const info = (await (await fetch(`${t.url}/v1/home`)).json()) as HomeInfo;
    assert.equal(info.name, "Club");
    assert.deepEqual(info.group, { name: "Club" });
  });

  test("pairs each admin's first device with a pass, as theirs", async () => {
    const response = await pair(manage.pass("usr_ada", t.url), "Ada's browser");
    assert.equal(response.status, 200);
    const paired = (await response.json()) as PairResponse;
    assert.deepEqual(paired.device.person, { id: "usr_ada", name: "Ada", role: "owner" });
    assert.deepEqual(paired.home.group, { name: "Club" });
    ada = paired.token;
    ben = (
      (await (await pair(manage.pass("usr_ben", t.url), "Ben's browser")).json()) as PairResponse
    ).token;
    assert.ok(ben);
  });

  test("takes no setup code and no code that is nobody's", async () => {
    assert.equal(t.home.hosted.setupCodeOpen(), false);
    const code = t.home.store.newPairingCode();
    const response = await fetch(`${t.url}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name: "Someone's phone", kind: "phone" }),
    });
    assert.equal(response.status, 401);
  });

  test("refuses a pass that is used, old, for another home, badly signed or not of the team", async () => {
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
    await refused(manage.pass("usr_eve", t.url), /not in the team/);
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
    assert.deepEqual(mine?.from, { name: "Ben", person: "usr_ben" });
    const asked = t.model.requests.at(-1);
    const system = asked?.messages[0]?.content ?? "";
    assert.match(system, /an agent of the group Club/);
    assert.match(system, /Ada, Ben/);
    assert.match(asked?.messages.at(-1)?.content ?? "", /^Ben writes:\nHello/);
    assert.equal(textOf(t.last()), "Hello Ben.");
  });

  test("each admin reads for themselves", async () => {
    const conversationId = t.home.store.mainAgent().conversationId;
    const unread = async (token: string) =>
      ((await (await t.request("/v1/agents", { token })).json()) as { agents: Agent[] }).agents[0]
        ?.unread;
    assert.equal(await unread(ben), 1);
    assert.equal(await unread(ada), 1);
    await t.request(`/v1/conversations/${conversationId}/read`, { token: ben, body: {} });
    assert.equal(await unread(ben), 0);
    assert.equal(await unread(ada), 1);
  });

  test("each admin has their own look of the chat, told to their devices only", async () => {
    const look = async (token: string) =>
      (await (await t.request("/v1/look", { token })).json()) as ChatLook;
    const stream = async (token: string) => {
      const response = await fetch(`${t.url}/v1/events`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      let said = "";
      const done = (async () => {
        while (!said.includes("setup.updated")) {
          const { value } = await reader.read();
          said += new TextDecoder().decode(value);
        }
        await reader.cancel();
        return said;
      })();
      return done;
    };
    const heard = Promise.all([stream(ada), stream(ben)]);
    while (t.home.events.listenerCount < 2) await new Promise((r) => setTimeout(r, 5));
    const picked = { view: "bubbles", tools: "none" } as const;
    await t.request("/v1/look", { method: "PUT", token: ben, body: picked });
    // What every device hears of ends the two streams.
    t.home.events.emit({ type: "setup.updated", setup: {} as Setup });
    const [adas, bens] = await heard;
    assert.ok(bens.includes("look.updated"));
    assert.ok(!adas.includes("look.updated"));
    assert.deepEqual(await look(ben), picked);
    assert.deepEqual(await look(ada), { view: "canvas", tools: "summary" });
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
    assert.deepEqual(after.answer?.person, { id: "usr_ben", name: "Ben" });
    const late = await t.request(`/v1/cards/${card.id}/answer`, {
      token: ada,
      body: { action: card.actions[1]?.id },
    });
    assert.equal(late.status, 409);
    await t.home.idle();
    const told = JSON.stringify(t.model.requests.at(-1)?.messages ?? []);
    assert.match(told, /Ben answered\./);
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
    assert.deepEqual(((await response.json()) as PairResponse).device.person, {
      id: "usr_ada",
      name: "Ada",
      role: "owner",
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

  // ── Members and clients ───────────────────────────────────────────────────

  const STUDIO = "https://studio.example";

  test("a pass from another site's page pairs only from that page", async () => {
    const pass = () => manage.pass("usr_cleo", t.url, { origin: STUDIO });
    const refused = (token: string, from?: string) =>
      assert.rejects(t.home.group.admit(token, from), /for another page/);
    await refused(pass());
    await refused(pass(), "https://other.example");
    await refused(pass(), t.url);
    // A pass for the home's own page is no other page's.
    await refused(manage.pass("usr_cleo", t.url), STUDIO);
    assert.equal(t.home.store.pairedFrom(STUDIO), false);
    const paired = await pair(pass(), "Studio · Chrome", STUDIO);
    assert.equal(paired.status, 200);
    assert.equal(paired.headers.get("access-control-allow-origin"), STUDIO);
    const { token, device } = (await paired.json()) as PairResponse;
    assert.equal(device.person?.role, "member");
    cleo = token;
    dora = (
      (await (
        await pair(manage.pass("usr_dora", t.url, { origin: STUDIO }), "Portal", STUDIO)
      ).json()) as PairResponse
    ).token;
  });

  test("only the studio the team works in shows the home's page inside its own", async () => {
    const webDir = mkdtempSync(join(tmpdir(), "wizards-web-"));
    writeFileSync(join(webDir, "index.html"), "<!doctype html>");
    const app = createApp(t.home, { webDir });
    const frames = async () =>
      /frame-ancestors ([^;]+)/.exec(
        (await app.request("/")).headers.get("content-security-policy") ?? "",
      )?.[1];
    assert.equal(await frames(), "'none'");
    manage.studio = { mcp: `${STUDIO}/api/mcp` };
    await t.home.group.pull();
    assert.equal(await frames(), STUDIO);
    manage.studio = null;
    await t.home.group.pull();
    assert.equal(await frames(), "'none'");
  });

  test("answers another site's page only when a device was paired from it", async () => {
    const preflight = (path: string, origin: string) =>
      fetch(`${t.url}${path}`, {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "GET" },
      });
    const allowed = async (path: string, origin: string) =>
      (await preflight(path, origin)).headers.get("access-control-allow-origin");
    assert.equal(await allowed("/v1/device", STUDIO), STUDIO);
    assert.equal(await allowed("/v1/device", "https://other.example"), null);
    assert.equal(await allowed("/v1/pair/pass", "https://other.example"), "https://other.example");
    const answer = await fetch(`${t.url}/v1/device`, {
      headers: { origin: STUDIO, authorization: `Bearer ${cleo}` },
    });
    assert.equal(answer.headers.get("access-control-allow-origin"), STUDIO);
    assert.equal(answer.headers.get("access-control-allow-credentials"), null);
    // Also a refused one: the page reads that it has to pair again.
    const refused = await fetch(`${t.url}/v1/device`, {
      headers: { origin: STUDIO, authorization: "Bearer gone" },
    });
    assert.equal(refused.status, 401);
    assert.equal(refused.headers.get("access-control-allow-origin"), STUDIO);
  });

  test("a member's and a client's device reach nothing of the admins'", async () => {
    const { conversationId, id } = t.home.store.mainAgent();
    for (const token of [cleo, dora]) {
      assert.equal((await t.request("/v1/device", { token })).status, 200);
      assert.equal((await t.request("/v1/look", { token })).status, 200);
      for (const path of [
        "/v1/agents",
        `/v1/agents/${id}`,
        `/v1/conversations/${conversationId}/messages`,
        "/v1/items",
        "/v1/search?q=hello",
        "/v1/devices",
        "/v1/vault",
        "/v1/folders",
        "/v1/models",
        "/v1/setup",
        "/v1/contacts",
      ]) {
        const answer = await t.request(path, { token });
        assert.equal(answer.status, 403, path);
        assert.equal(((await answer.json()) as { error: string }).error, "admins_only");
      }
      const written = await t.request(`/v1/conversations/${conversationId}/messages`, {
        token,
        body: { text: "Hello" },
      });
      assert.equal(written.status, 403);
      const watch = await t.request("/v1/devices", { token, body: { name: "W", kind: "watch" } });
      assert.equal(watch.status, 403);
    }
  });

  test("a member's device hears only its own look, and gets no push", async () => {
    const response = await fetch(`${t.url}/v1/events`, {
      headers: { authorization: `Bearer ${cleo}` },
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    let said = "";
    await reader.read();
    t.home.events.emit({ type: "setup.updated", setup: {} as Setup });
    const look = { view: "bubbles", tools: "none" } as const;
    await t.request("/v1/look", { method: "PUT", token: ada, body: look });
    await t.request("/v1/look", { method: "PUT", token: cleo, body: look });
    while (!said.includes("look.updated"))
      said += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    assert.ok(said.includes("usr_cleo"));
    assert.ok(!said.includes("usr_ada"));
    assert.ok(!said.includes("setup.updated"));

    const pushed: string[] = [];
    t.home.notifier.useSender({
      send: async (push) => {
        pushed.push(push.token);
        return { ok: true };
      },
      close: () => {},
    });
    const push = (token: string) => ({ token, environment: "development", topic: "bot" });
    await t.request("/v1/device", { method: "PATCH", token: cleo, body: { push: push("cleo") } });
    await t.request("/v1/device", { method: "PATCH", token: ada, body: { push: push("ada") } });
    t.model.script.push({ text: "Done." });
    const conversationId = t.home.store.mainAgent().conversationId;
    await t.request(`/v1/conversations/${conversationId}/messages`, {
      token: ben,
      body: { text: "Go" },
    });
    await t.home.idle();
    t.home.notifier.useSender(undefined);
    await t.request("/v1/device", { method: "PATCH", token: ada, body: { push: null } });
    assert.ok(pushed.includes("ada"));
    assert.ok(!pushed.includes("cleo"));
  });

  test("an agent has for a member what stays in the conversation, for a client a question", async () => {
    const agent = t.home.store.mainAgent();
    t.home.store.updateAgent(agent.id, { memory: "The hall has a blue door." });
    const asked = async (id: string) => {
      t.model.script.push({ text: "Yes." });
      const writer = t.home.group.person(id);
      await t.home.turns.enqueue({
        conversationId: agent.conversationId,
        text: "Hello",
        channel: "app",
        writer,
      });
      await t.home.idle();
      const request = t.model.requests.at(-1);
      const tools = (request?.tools ?? []) as { function: { name: string } }[];
      return {
        tools: tools.map((tool) => tool.function.name),
        system: request?.messages[0]?.content ?? "",
      };
    };
    const all = await asked("usr_ada");
    for (const name of ["remember", "agent_message", "connection_call"])
      assert.ok(all.tools.includes(name), name);
    const member = await asked("usr_cleo");
    const outside = [
      "agent_message",
      "connection_call",
      "connection_tools",
      "device_pair",
      "folder_list",
      "folder_read",
      "schedule_set",
      "shell_run",
      "vault_sign_in",
    ];
    assert.ok(member.tools.includes("document_write"));
    for (const name of outside) assert.ok(!member.tools.includes(name), name);
    assert.match(member.system, /blue door/);
    // What the turn leads to has no more: work that goes on, and the answer to a question.
    const names = (n: number) =>
      ((t.model.requests.at(n)?.tools ?? []) as { function: { name: string } }[]).map(
        (tool) => tool.function.name,
      );
    t.model.script.push(
      { calls: [{ name: "go_on", arguments: { done: "a", next: "b" } }] },
      { text: "More." },
      { calls: [{ name: "ask", arguments: { title: "Which?", choices: ["One", "Two"] } }] },
      { text: "One it is." },
    );
    await t.home.turns.enqueue({
      conversationId: agent.conversationId,
      text: "Work on it",
      channel: "app",
      writer: t.home.group.person("usr_cleo"),
    });
    await t.home.idle();
    assert.ok(!names(-1).includes("connection_call"));
    const card = t.home.store.openCards(agent.conversationId).at(-1) as Card;
    await t.request(`/v1/cards/${card.id}/answer`, {
      token: ada,
      body: { action: card.actions[0]?.id },
    });
    await t.home.idle();
    assert.equal(textOf(t.last()), "One it is.");
    assert.ok(names(-1).includes("document_write"));
    assert.ok(!names(-1).includes("connection_call"));
    const client = await asked("usr_dora");
    assert.ok(!client.tools.includes("remember"));
    assert.ok(!client.tools.includes("document_write"));
    assert.doesNotMatch(client.system, /blue door/);
  });

  test("an unknown role may do the least", async () => {
    manage.people.push({ id: "usr_eli", name: "Eli", role: "superuser" });
    await t.home.group.pull();
    assert.equal(t.home.group.person("usr_eli")?.role, "client");
    manage.people.pop();
    await t.home.group.pull();
    assert.equal(t.home.group.person("usr_eli"), undefined);
  });

  test("someone who may do less than before pairs again", async () => {
    const as = (role: string) => {
      manage.people = manage.people.map((one) => (one.id === "usr_ben" ? { ...one, role } : one));
      return t.home.group.pull();
    };
    // An owner does what an admin does.
    await as("owner");
    assert.equal((await t.request("/v1/agents", { token: ben })).status, 200);
    const open = await fetch(`${t.url}/v1/events`, { headers: { authorization: `Bearer ${ben}` } });
    const reader = (open.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    await as("member");
    assert.equal((await t.request("/v1/agents", { token: ben })).status, 401);
    // The stream ends at once, not with the next ping.
    while (!(await reader.read()).done);
    await as("admin");
    ben = (
      (await (await pair(manage.pass("usr_ben", t.url), "Ben's browser")).json()) as PairResponse
    ).token;
    assert.equal((await t.request("/v1/agents", { token: ben })).status, 200);
  });

  test("a browser paired from another site's page goes when it was not seen for 30 days", async () => {
    const days = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    t.home.db.run("update device set seen_at = ?", days(31));
    t.home.db.run("update device set seen_at = ? where person_id = 'usr_dora'", days(29));
    t.home.group.tidy();
    assert.equal((await t.request("/v1/device", { token: cleo })).status, 401);
    assert.equal((await t.request("/v1/device", { token: dora })).status, 200);
    // A device of the home's own page or app stays.
    assert.equal((await t.request("/v1/device", { token: ada })).status, 200);
  });

  test("someone who is gone loses their devices with the next look", async () => {
    manage.people = manage.people.filter((person) => person.id !== "usr_ben");
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
