import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import type { Message, Space } from "@wizards-bot/protocol";
import { FakeMcp } from "../test/fake-mcp.ts";
import { type TestHome, testHome } from "../test/fakes.ts";
import { inSpace } from "./studio.ts";

const KEY = "wbk_group_home";
const SALES: Space = { id: "spc_sales", name: "Sales" };

/** The Manage-App as the studio's connection meets it: who is in the team, and a person's token. */
class FakeManage {
  url = "";
  group: { name: string } | null = { name: "Club" };
  people = [
    { id: "usr_ada", name: "Ada", role: "owner" },
    { id: "usr_ben", name: "Ben", role: "admin" },
  ];
  studio: { mcp: string } | null = null;
  /** Whom a token was asked for, oldest first; null where the home named nobody. */
  readonly tokens: (string | null)[] = [];
  /** Whether it gives tokens at all. */
  gives = true;
  private server: Server | undefined;

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        if (request.headers.authorization !== `Bearer ${KEY}`) {
          response.statusCode = 401;
          return response.end("{}");
        }
        if (request.url === "/v1/homes/people")
          return response.end(
            JSON.stringify({ group: this.group, people: this.people, studio: this.studio }),
          );
        if (request.url === "/v1/homes/studio-token" && request.method === "POST") {
          const person = (JSON.parse(body || "{}") as { person?: string }).person ?? null;
          if (!this.gives || (person && !this.people.some((one) => one.id === person))) {
            response.statusCode = 404;
            return response.end("{}");
          }
          this.tokens.push(person);
          return response.end(
            JSON.stringify({
              token: `token-${person ?? "owner"}-${this.tokens.length}`,
              expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
            }),
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

/** The studio's MCP endpoint: a tool that reads in a space, one that runs, one that lists. */
const fakeStudio = () =>
  new FakeMcp("modern", {
    space_search: {
      description: "Searches a space.",
      readOnly: true,
      input: { query: { type: "string" }, spaceId: { type: "string" } },
      run: () => ({ text: "found" }),
    },
    wizard_run: {
      description: "Runs a wizard.",
      input: { wizardId: { type: "string" }, spaceId: { type: "string" } },
      run: () => ({ text: "ran" }),
    },
    list_spaces: {
      description: "Lists the spaces.",
      readOnly: true,
      run: () => ({ text: "Sales" }),
    },
  });

/** The bearers the studio's tool calls came with, oldest first. */
const bearers = (studio: FakeMcp): (string | undefined)[] =>
  studio.requests.filter((one) => one.method === "tools/call").map((one) => one.authorization);

/** What the last tool answered, as the model read it. */
const result = (t: TestHome): string =>
  JSON.stringify(t.model.requests.at(-1)?.messages.at(-1)?.content ?? "");

const call = (tool: string, args: Record<string, unknown> = {}) => ({
  name: "connection_call",
  arguments: { name: "studio", tool, arguments: args, why: "Use the studio" },
});

describe("the studio of a group home", () => {
  let manage: FakeManage;
  let studio: FakeMcp;
  let t: TestHome;
  let ada = "";
  let ben = "";

  /** Sends a message as one person's device and waits until the agent is done. */
  const sayAs = async (token: string, text: string, space?: Space): Promise<Message> => {
    const conversationId = t.home.store.mainAgent().conversationId;
    const sent = await t.request(`/v1/conversations/${conversationId}/messages`, {
      body: { text, ...(space ? { space } : {}) },
      token,
    });
    assert.equal(sent.status, 202);
    do {
      await t.home.idle();
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (t.home.store.agents().some((agent) => agent.state === "working"));
    await t.home.idle();
    return t.last();
  };
  const connection = () => {
    const found = t.home.connections.byName("studio");
    assert.ok(found);
    return found;
  };

  before(async () => {
    manage = new FakeManage();
    studio = fakeStudio();
    await Promise.all([manage.start(), studio.start()]);
    manage.studio = { mcp: studio.url };
    t = await testHome("Ada", undefined, { config: { manageUrl: manage.url } });
    t.home.models.accountKey = () => KEY;
    assert.equal(await t.home.group.pull(), true);
    ada = t.home.store.addDevice({ name: "Ada's Mac", kind: "browser", personId: "usr_ada" }).token;
    ben = t.home.store.addDevice({ name: "Ben's Mac", kind: "browser", personId: "usr_ben" }).token;
  });
  after(() => {
    studio.stop();
    manage.stop();
    t.stop();
  });

  test("is a connection nobody added, with no key and no sign-in, and nothing is asked yet", () => {
    const made = connection();
    assert.equal(made.url, studio.url);
    assert.equal(made.state, "connected");
    assert.ok(t.home.connections.isStudio(made));
    assert.equal(t.home.secrets.get(`connection.${made.id}.key`), undefined);
    assert.equal(t.home.secrets.get(`connection.${made.id}.oauth`), undefined);
    assert.equal(studio.requests.length, 0);
    assert.deepEqual(manage.tokens, []);
  });

  test("without a person no call is made and no token is asked for", async () => {
    await assert.rejects(t.home.connections.use(connection(), "space_search", {}), /nobody wrote/);
    assert.equal(studio.requests.length, 0);
    assert.deepEqual(manage.tokens, []);
  });

  test("a turn nobody wrote is told that the studio needs a person", async () => {
    t.model.script.push({ calls: [call("space_search", { query: "x" })] });
    t.model.script.push({ text: "ok" });
    // The test's own device is nobody's: what it sends is written by no one of the team.
    await t.say("search the studio");
    assert.match(result(t), /nobody wrote here/);
    assert.equal(studio.requests.length, 0);
    assert.deepEqual(manage.tokens, []);
  });

  test("two writers call it with two different bearers, each token asked for once", async () => {
    const { connections } = t.home;
    for (const person of ["usr_ada", "usr_ada", "usr_ben", "usr_ada"]) {
      const step = await connections.use(connection(), "space_search", {}, person);
      assert.ok("result" in step);
    }
    assert.deepEqual(manage.tokens, ["usr_ada", "usr_ben"]);
    assert.deepEqual(bearers(studio), [
      "Bearer token-usr_ada-1",
      "Bearer token-usr_ada-1",
      "Bearer token-usr_ben-2",
      "Bearer token-usr_ada-1",
    ]);
    // Its tools were read as the first person who used it.
    assert.ok(studio.requests.every((one) => one.authorization?.startsWith("Bearer token-usr_")));
    assert.equal(studio.requests[0]?.authorization, "Bearer token-usr_ada-1");
    assert.deepEqual(
      connection().tools.map((tool) => tool.name),
      ["space_search", "wizard_run", "list_spaces"],
    );
  });

  test("a token is asked for again a minute before it ends", async (context) => {
    const asked = manage.tokens.length;
    context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    // Eight minutes on, the ten-minute token still lives.
    context.mock.timers.tick(8 * 60_000);
    await t.home.connections.use(connection(), "space_search", {}, "usr_ada");
    assert.equal(manage.tokens.length, asked);
    assert.equal(bearers(studio).at(-1), "Bearer token-usr_ada-1");
    // Less than a minute is left of it.
    context.mock.timers.tick(90_000);
    await t.home.connections.use(connection(), "space_search", {}, "usr_ada");
    assert.deepEqual(manage.tokens.slice(asked), ["usr_ada"]);
    assert.equal(bearers(studio).at(-1), `Bearer token-usr_ada-${asked + 1}`);
  });

  test("someone the Manage-App gives no token is told so, and nothing is called", async () => {
    const calls = studio.requests.length;
    await assert.rejects(
      t.home.connections.use(connection(), "space_search", {}, "usr_gone"),
      /does not answer for you right now/,
    );
    assert.equal(studio.requests.length, calls);
  });

  test("a turn reads the open space and its call works in it, as the person who wrote", async () => {
    t.model.script.push({ calls: [call("space_search", { query: "prices" })] });
    t.model.script.push({ text: "Here it is." });
    await sayAs(ben, "what do we know about prices", SALES);
    assert.match(t.model.requests.at(-1)?.context ?? "", /the space "Sales" is open/);
    assert.deepEqual(studio.calls.at(-1)?.arguments, { query: "prices", spaceId: "spc_sales" });
    assert.match(bearers(studio).at(-1) ?? "", /^Bearer token-usr_ben-/);
  });

  test("a space the agent names wins, and a tool that takes no space gets none", async () => {
    t.model.script.push({ calls: [call("space_search", { query: "x", spaceId: "spc_other" })] });
    t.model.script.push({ calls: [call("list_spaces")] });
    t.model.script.push({ text: "ok" });
    await sayAs(ada, "look in the other space", SALES);
    assert.deepEqual(studio.calls.at(-2)?.arguments, { query: "x", spaceId: "spc_other" });
    assert.deepEqual(studio.calls.at(-1)?.arguments, {});
  });

  test("with no space open the agent is sent to list_spaces and nothing is filled in", async () => {
    t.model.script.push({ calls: [call("space_search", { query: "x" })] });
    t.model.script.push({ text: "ok" });
    await sayAs(ada, "search");
    const context = t.model.requests.at(-1)?.context ?? "";
    assert.match(context, /No space of the studio is open here/);
    assert.match(context, /list_spaces/);
    assert.deepEqual(studio.calls.at(-1)?.arguments, { query: "x" });
  });

  test("the space and the person are kept across a card's answer", async () => {
    t.model.script.push({ calls: [call("wizard_run", { wizardId: "wiz_1" })] });
    await sayAs(ben, "run the wizard", SALES);
    const card = t.item();
    assert.match(card.body ?? "", /"spaceId": "spc_sales"/);
    const before = studio.calls.length;
    t.model.script.push({ text: "It ran." });
    // Another admin says yes: the call still runs for the one who asked, in their space.
    const answered = await t.request(`/v1/cards/${card.id}/answer`, {
      body: { action: "once" },
      token: ada,
    });
    assert.equal(answered.status, 200);
    await t.home.idle();
    assert.equal(studio.calls.length, before + 1);
    assert.deepEqual(studio.calls.at(-1)?.arguments, { wizardId: "wiz_1", spaceId: "spc_sales" });
    assert.match(bearers(studio).at(-1) ?? "", /^Bearer token-usr_ben-/);
  });

  test("the space and the person are kept across go_on", async () => {
    t.model.script.push({
      calls: [{ name: "go_on", arguments: { done: "Looked.", next: "Search the space" } }],
    });
    t.model.script.push({ text: "Going on." });
    t.model.script.push({ calls: [call("space_search", { query: "next" })] });
    t.model.script.push({ text: "Done." });
    await sayAs(ben, "do the longer thing", SALES);
    assert.deepEqual(studio.calls.at(-1)?.arguments, { query: "next", spaceId: "spc_sales" });
    assert.match(bearers(studio).at(-1) ?? "", /^Bearer token-usr_ben-/);
    assert.match(t.model.requests.at(-1)?.context ?? "", /the space "Sales" is open/);
  });

  test("the agent cannot disconnect it, nor take its name", async () => {
    t.model.script.push({ calls: [{ name: "connection_remove", arguments: { name: "studio" } }] });
    t.model.script.push({
      calls: [
        { name: "connection_add", arguments: { name: "Studio", url: "https://evil.example/mcp" } },
      ],
    });
    t.model.script.push({ text: "ok" });
    await sayAs(ada, "disconnect the studio");
    const said = JSON.stringify(t.model.requests.at(-1)?.messages ?? []);
    assert.match(said, /cannot be disconnected here/);
    assert.match(said, /Pick another name/);
    assert.equal(connection().url, studio.url);
  });

  test("it moves with the address the Manage-App names, and goes with it", async () => {
    const first = connection();
    t.home.connections.setPolicy(first, "wizard_run", "always");
    manage.studio = { mcp: "http://127.0.0.1:9/api/mcp" };
    await t.home.group.pull();
    const moved = connection();
    assert.equal(moved.url, "http://127.0.0.1:9/api/mcp");
    assert.ok(t.home.connections.isStudio(moved));
    // Another studio: its tools are not read yet, and no "always" of the old one holds in it.
    assert.deepEqual(moved.tools, []);
    assert.deepEqual(moved.policies, {});
    assert.equal(t.home.info().studio, "http://127.0.0.1:9");
    manage.studio = null;
    await t.home.group.pull();
    assert.equal(t.home.connections.byName("studio"), undefined);
    assert.equal(t.home.connections.hasStudio(), false);
    assert.equal(t.home.info().studio, undefined);
  });
});

describe("the studio of one person's home", () => {
  test("is called as that person: the home names nobody", async () => {
    const manage = new FakeManage();
    manage.group = null;
    const studio = fakeStudio();
    await Promise.all([manage.start(), studio.start()]);
    manage.studio = { mcp: studio.url };
    const t = await testHome("Ada", undefined, { config: { manageUrl: manage.url } });
    try {
      t.home.models.accountKey = () => KEY;
      await t.home.group.pull();
      const connection = t.home.connections.byName("studio");
      assert.ok(connection);
      const step = await t.home.connections.use(connection, "space_search", {});
      assert.ok("result" in step);
      assert.deepEqual(manage.tokens, [null]);
      assert.deepEqual(bearers(studio), ["Bearer token-owner-1"]);
    } finally {
      t.stop();
      studio.stop();
      manage.stop();
    }
  });

  test("a connection of that name made by hand gives way to it", async () => {
    const manage = new FakeManage();
    manage.group = null;
    const studio = fakeStudio();
    await Promise.all([manage.start(), studio.start()]);
    const t = await testHome("Ada", undefined, { config: { manageUrl: manage.url } });
    try {
      t.home.models.accountKey = () => KEY;
      const { connection: own } = await t.home.connections.add({
        name: "studio",
        url: studio.url,
        key: "wz_key",
      });
      assert.equal(t.home.connections.isStudio(own), false);
      manage.studio = { mcp: studio.url };
      await t.home.group.pull();
      const kept = t.home.connections.byName("studio");
      assert.ok(kept && t.home.connections.isStudio(kept));
      assert.notEqual(kept.id, own.id);
      assert.equal(t.home.secrets.get(`connection.${own.id}.key`), undefined);
    } finally {
      t.stop();
      studio.stop();
      manage.stop();
    }
  });
});

describe("the open space in a call's arguments", () => {
  const schema = { type: "object", properties: { spaceId: { type: "string" } } };
  test("is filled in only where the tool takes a space and none is named", () => {
    assert.deepEqual(inSpace({ q: 1 }, schema, SALES), { q: 1, spaceId: "spc_sales" });
    assert.deepEqual(inSpace({ spaceId: "spc_x" }, schema, SALES), { spaceId: "spc_x" });
    assert.deepEqual(inSpace({ q: 1 }, { type: "object", properties: {} }, SALES), { q: 1 });
    assert.deepEqual(inSpace({ q: 1 }, schema, undefined), { q: 1 });
  });
});
