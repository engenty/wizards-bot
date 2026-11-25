import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import type {
  Agent,
  AgentDetail,
  Card,
  Document,
  DocumentMark,
  Message,
  SearchHit,
  Space,
} from "@wizards-bot/protocol";
import type { TurnContext } from "./agent/turns.ts";
import { openSource } from "./skills/office/documents.ts";
import { FakeMcp } from "./test/fake-mcp.ts";
import { type TestHome, testHome, textOf } from "./test/fakes.ts";

const KEY = "wbk_group_home";
const SALES: Space = { id: "spc_sales", name: "Sales" };

/** The Manage-App as a group home with members meets it: who is in the team, and a person's token. */
class FakeManage {
  url = "";
  people = [
    { id: "usr_ada", name: "Ada", role: "owner" },
    { id: "usr_ben", name: "Ben", role: "admin" },
    { id: "usr_cleo", name: "Cleo", role: "member" },
    { id: "usr_eve", name: "Eve", role: "member" },
    { id: "usr_dora", name: "Dora", role: "client" },
  ];
  studio: { mcp: string } | null = null;
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
            JSON.stringify({ group: { name: "Club" }, people: this.people, studio: this.studio }),
          );
        if (request.url === "/v1/homes/studio-token" && request.method === "POST") {
          const person = (JSON.parse(body || "{}") as { person?: string }).person ?? "";
          if (!this.people.some((one) => one.id === person)) {
            response.statusCode = 404;
            return response.end("{}");
          }
          return response.end(
            JSON.stringify({
              token: `token-${person}`,
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

/** The studio's MCP endpoint: a tool that reads in a space and one that runs. */
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
  });

/** The bearers the studio's tool calls came with, oldest first. */
const bearers = (studio: FakeMcp): (string | undefined)[] =>
  studio.requests.filter((one) => one.method === "tools/call").map((one) => one.authorization);

const studioCall = (tool: string, args: Record<string, unknown> = {}, name = "studio") => ({
  name: "connection_call",
  arguments: { name, tool, arguments: args, why: "Use the studio" },
});

/** The names of the tools a request of the model carried. */
const toolsOf = (request: { tools?: unknown[] } | undefined): string[] =>
  ((request?.tools ?? []) as { function: { name: string } }[]).map((tool) => tool.function.name);

describe("a member of a group home", () => {
  let manage: FakeManage;
  let studio: FakeMcp;
  let t: TestHome;
  let ada = "";
  let cleo = "";
  let eve = "";
  let dora = "";
  let team = "";
  let cleos = "";
  let eves = "";

  const settle = async () => {
    do {
      await t.home.idle();
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (t.home.store.isWorking(cleos) || t.home.store.isWorking(eves));
    await t.home.idle();
  };
  const agents = async (token: string) =>
    ((await (await t.request("/v1/agents", { token })).json()) as { agents: Agent[] }).agents;
  const items = async (token: string) =>
    ((await (await t.request("/v1/items", { token })).json()) as { items: Card[] }).items;
  const messages = async (token: string, conversationId: string) =>
    (
      (await (
        await t.request(`/v1/conversations/${conversationId}/messages`, { token })
      ).json()) as {
        messages: Message[];
      }
    ).messages;
  /** Sends a message as one person's device and waits until the agent is done. */
  const say = async (token: string, conversationId: string, text: string, space?: Space) => {
    const sent = await t.request(`/v1/conversations/${conversationId}/messages`, {
      token,
      body: { text, ...(space ? { space } : {}) },
    });
    assert.equal(sent.status, 202);
    await settle();
  };
  const device = (personId: string, name: string) =>
    t.home.store.addDevice({ name, kind: "browser", personId }).token;
  /** Everything a device hears until `until` stands in it. */
  const listen = async (token: string, until: string, lastEventId?: number) => {
    const response = await fetch(`${t.url}/v1/events`, {
      headers: {
        authorization: `Bearer ${token}`,
        ...(lastEventId === undefined ? {} : { "last-event-id": String(lastEventId) }),
      },
    });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    let said = "";
    while (!said.includes(until)) said += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    return said;
  };
  const lastEvent = () => (t.home.events as unknown as { seq: number }).seq;

  before(async () => {
    manage = new FakeManage();
    studio = fakeStudio();
    await Promise.all([manage.start(), studio.start()]);
    manage.studio = { mcp: studio.url };
    t = await testHome("Ada", undefined, { config: { manageUrl: manage.url } });
    t.home.models.accountKey = () => KEY;
    // Every device of a group home is someone's: the test's own device goes.
    t.home.db.run("delete from device");
    assert.equal(await t.home.group.pull(), true);
    ada = device("usr_ada", "Ada's browser");
    cleo = device("usr_cleo", "Cleo's browser");
    eve = device("usr_eve", "Eve's browser");
    dora = device("usr_dora", "Dora's browser");
    team = t.home.store.mainAgent().conversationId;
    t.home.store.updateAgent(t.home.store.mainAgent().id, { memory: "The hall has a blue door." });
  });
  after(() => {
    studio.stop();
    manage.stop();
    t.stop();
  });

  test("lists the group's own agents, each with a conversation of their own", async () => {
    const main = t.home.store.mainAgent();
    const shared = t.home.store.createAgent({
      name: "Lux",
      kind: "round",
      origin: "shared",
      from: "lux@other.example",
      remote: "https://other.example",
    });
    const mine = await agents(cleo);
    assert.deepEqual(
      mine.map((agent) => agent.name),
      ["Goose"],
    );
    cleos = mine[0]?.conversationId ?? "";
    assert.ok(cleos && cleos !== team);
    assert.equal(t.home.store.memberOf(cleos), "usr_cleo");
    assert.deepEqual(
      { state: mine[0]?.state, open: mine[0]?.open, unread: mine[0]?.unread, at: mine[0]?.preview },
      { state: "idle", open: 0, unread: 0, at: "" },
    );
    // It is made once, and each member has their own.
    assert.equal((await agents(cleo))[0]?.conversationId, cleos);
    eves = (await agents(eve))[0]?.conversationId ?? "";
    assert.ok(eves && eves !== cleos && eves !== team);
    // Who runs the home still reads the team's conversation, and all agents.
    const adas = await agents(ada);
    assert.equal(adas[0]?.conversationId, team);
    assert.ok(adas.some((agent) => agent.id === shared.id));

    const detail = (await (
      await t.request(`/v1/agents/${main.id}`, { token: cleo })
    ).json()) as AgentDetail;
    assert.equal(detail.agent.conversationId, cleos);
    assert.equal(detail.memory, "");
    assert.deepEqual(detail.tasks, []);
    const admins = (await (
      await t.request(`/v1/agents/${main.id}`, { token: ada })
    ).json()) as AgentDetail;
    assert.match(admins.memory, /blue door/);
    assert.equal((await t.request(`/v1/agents/${shared.id}`, { token: cleo })).status, 404);
    t.home.removeAgent(shared.id);
  });

  test("writes in their own conversation, to an agent that reads its memory and does not write it", async () => {
    t.model.script.push(
      {
        calls: [{ name: "document_write", arguments: { title: "Plan", content: "# Plan\nOne." } }],
      },
      { text: "Here is the plan." },
    );
    await say(cleo, cleos, "Write a plan");
    const mine = await messages(cleo, cleos);
    assert.deepEqual(mine.find((message) => message.role === "you")?.from, {
      name: "Cleo",
      person: "usr_cleo",
    });
    assert.equal(textOf(mine.at(-1) as Message), "Here is the plan.");
    const asked = t.model.requests.at(-1);
    const system = asked?.messages[0]?.content ?? "";
    assert.match(system, /You talk with Cleo, a member of the group/);
    assert.match(system, /Only Cleo reads it/);
    assert.match(system, /blue door/);
    assert.match(system, /studio, the studio the team works in/);
    assert.doesNotMatch(system, /`remember`/);
    assert.equal(
      asked?.messages.find((message) => message.role === "user")?.content,
      "Write a plan",
    );
    const tools = toolsOf(asked);
    for (const name of ["ask", "document_write", "artifact_write", "connection_call"])
      assert.ok(tools.includes(name), name);
    for (const name of ["remember", "connection_add", "folder_list", "schedule_set", "shell_run"])
      assert.ok(!tools.includes(name), name);

    // The admins' conversation with the same agent shows nothing of it.
    assert.deepEqual(await messages(ada, team), []);
    const line = (await agents(ada))[0];
    assert.deepEqual(
      { unread: line?.unread, preview: line?.preview, state: line?.state },
      { unread: 0, preview: "", state: "idle" },
    );
    // Their own line shows it: the document the answer begins with.
    assert.equal((await agents(cleo))[0]?.preview, "Plan");
  });

  test("nobody else reads, writes in or stops a member's conversation, and a member no other", async () => {
    const closed: [string, string][] = [
      [ada, cleos],
      [eve, cleos],
      [cleo, eves],
      [cleo, team],
    ];
    for (const [token, conversationId] of closed) {
      const at = `/v1/conversations/${conversationId}`;
      for (const path of ["messages", "documents", "files", "artifacts"])
        assert.equal((await t.request(`${at}/${path}`, { token })).status, 404, path);
      for (const path of ["read", "warm", "stop"])
        assert.equal((await t.request(`${at}/${path}`, { token, body: {} })).status, 404, path);
      const written = await t.request(`${at}/messages`, { token, body: { text: "Hello" } });
      assert.equal(written.status, 404);
    }
    await t.home.idle();
    assert.equal((await messages(cleo, cleos)).length, 2);
    for (const path of ["documents", "files", "artifacts"])
      assert.equal(
        (await t.request(`/v1/conversations/${cleos}/${path}`, { token: cleo })).status,
        200,
      );
  });

  test("a document, an artifact and a card are their conversation's", async () => {
    const id = t.home.store.documents(cleos)[0]?.id ?? "";
    const at = `/v1/documents/${id}`;
    const read = (await (await t.request(at, { token: cleo })).json()) as Document;
    assert.equal(read.title, "Plan");
    const saved = await t.request(at, {
      method: "PUT",
      token: cleo,
      body: { content: "# Plan\nTwo.", baseVersion: read.version },
    });
    assert.equal(saved.status, 200);
    const marked = await t.request(`${at}/marks`, {
      token: cleo,
      body: { quote: "Two.", before: "", after: "" },
    });
    assert.equal(marked.status, 201);
    const mark = (await marked.json()) as DocumentMark;
    const artifact = t.home.artifacts.write({
      title: "Chart",
      content: "<p>One</p>",
      conversationId: cleos,
    });
    assert.equal((await t.request(`/v1/artifacts/${artifact.id}`, { token: cleo })).status, 200);
    for (const token of [ada, eve]) {
      assert.equal((await t.request(at, { token })).status, 404);
      const put = { content: "Mine now.", baseVersion: read.version + 1 };
      assert.equal((await t.request(at, { method: "PUT", token, body: put })).status, 404);
      assert.equal((await t.request(`${at}/marks`, { token })).status, 404);
      const add = { quote: "Two.", before: "", after: "" };
      assert.equal((await t.request(`${at}/marks`, { token, body: add })).status, 404);
      const gone = await t.request(`${at}/marks/${mark.id}`, { method: "DELETE", token });
      assert.equal(gone.status, 404);
      assert.equal((await t.request(`/v1/artifacts/${artifact.id}`, { token })).status, 404);
    }
    assert.equal(t.home.store.document(id)?.content, "# Plan\nTwo.");
    assert.equal(
      (await t.request(`${at}/marks/${mark.id}`, { method: "DELETE", token: cleo })).status,
      204,
    );
    // The admins' search finds nothing of it.
    const { hits } = (await (await t.request("/v1/search?q=plan", { token: ada })).json()) as {
      hits: SearchHit[];
    };
    assert.deepEqual(
      hits.filter((hit) => hit.kind !== "agent"),
      [],
    );

    t.model.script.push(
      {
        calls: [
          { name: "ask", arguments: { title: "Which day?", choices: ["Monday", "Tuesday"] } },
        ],
      },
      { text: "Monday it is." },
    );
    await say(cleo, cleos, "Pick a day");
    const card = (await items(cleo)).at(-1) as Card;
    assert.equal(card.title, "Which day?");
    assert.deepEqual(await items(ada), []);
    assert.deepEqual(await items(eve), []);
    assert.deepEqual(
      [(await agents(cleo))[0]?.state, (await agents(cleo))[0]?.open],
      ["needs_you", 1],
    );
    assert.deepEqual([(await agents(ada))[0]?.state, (await agents(ada))[0]?.open], ["idle", 0]);
    const answer = { action: card.actions[0]?.id };
    for (const token of [ada, eve])
      assert.equal(
        (await t.request(`/v1/cards/${card.id}/answer`, { token, body: answer })).status,
        404,
      );
    assert.equal(t.home.store.card(card.id)?.state, "open");
    const answered = await t.request(`/v1/cards/${card.id}/answer`, { token: cleo, body: answer });
    assert.equal(answered.status, 200);
    assert.deepEqual(((await answered.json()) as { card: Card }).card.answer?.person, {
      id: "usr_cleo",
      name: "Cleo",
    });
    await settle();
    assert.equal(textOf((await messages(cleo, cleos)).at(-1) as Message), "Monday it is.");
    // The turn the answer started is still the member's.
    assert.ok(!toolsOf(t.model.requests.at(-1)).includes("remember"));
  });

  test("a turn the home starts in a member's conversation is the member's too", async () => {
    t.model.script.push({ text: "Noted." });
    t.home.tell(cleos, "Something ended.");
    await settle();
    const asked = t.model.requests.at(-1);
    assert.match(asked?.messages[0]?.content ?? "", /You talk with Cleo, a member/);
    assert.ok(!toolsOf(asked).includes("remember"));
    assert.ok(!toolsOf(asked).includes("shell_run"));
  });

  test("reads only the documents of their own conversation, and no connected folder", async () => {
    const theirs = t.home.store.createDocument({
      title: "Budget",
      content: "Secret",
      conversationId: team,
    });
    t.model.script.push(
      { calls: [{ name: "document_read", arguments: { id: theirs.id } }] },
      {
        calls: [
          {
            name: "document_write",
            arguments: { id: theirs.id, title: "Budget", content: "Changed" },
          },
        ],
      },
      { text: "I cannot read that." },
    );
    await say(cleo, cleos, "Read the budget");
    const told = JSON.stringify(t.model.requests.at(-1)?.messages ?? []);
    assert.match(told, new RegExp(`There is no document ${theirs.id}`));
    assert.doesNotMatch(told, /Secret/);
    assert.equal(t.home.store.document(theirs.id)?.content, "Secret");
    // An admin's turn reads the team's documents by id, and none of a member's.
    const members = t.home.store.documents(cleos)[0]?.id ?? "";
    t.model.script.push(
      { calls: [{ name: "document_read", arguments: { id: members } }] },
      { text: "There is none." },
    );
    await say(ada, team, "Read that document");
    assert.match(
      JSON.stringify(t.model.requests.at(-1)?.messages ?? []),
      new RegExp(`There is no document ${members}`),
    );

    const turn = (id: string) =>
      ({ home: t.home, trigger: { writer: t.home.group.person(id) } }) as unknown as TurnContext;
    const from = { folder: "Reports", path: "q3.docx" };
    assert.throws(() => openSource(turn("usr_cleo"), from), /for the team's admins/);
    assert.throws(() => openSource(turn("usr_ada"), from), /no connected folder Reports/);
  });

  test("reaches nothing of what the admins run", async () => {
    for (const path of [
      "/v1/search?q=plan",
      "/v1/devices",
      "/v1/handoffs",
      "/v1/plugins",
      "/v1/secrets",
      "/v1/vault",
      "/v1/folders",
      "/v1/models",
      "/v1/setup",
      "/v1/avatar",
      "/v1/contacts",
      "/v1/links",
      "/v1/person",
    ]) {
      const answer = await t.request(path, { token: cleo });
      assert.equal(answer.status, 403, path);
      assert.equal(((await answer.json()) as { error: string }).error, "admins_only");
    }
    const posts: [string, unknown][] = [
      [`/v1/conversations/${cleos}/import`, { messages: [] }],
      ["/v1/consent", { services: [] }],
      ["/v1/devices", { name: "Watch", kind: "watch" }],
      ["/v1/setup/test", {}],
    ];
    for (const [path, body] of posts)
      assert.equal((await t.request(path, { token: cleo, body })).status, 403, path);
    // A client of the team has no chat.
    for (const path of ["/v1/agents", "/v1/items", `/v1/conversations/${cleos}/messages`])
      assert.equal((await t.request(path, { token: dora })).status, 403, path);
  });

  test("a model service that waits for a yes waits for an admin's", async () => {
    const waiting = t.home.models.waitingForYes.bind(t.home.models);
    t.home.models.waitingForYes = () => [{ id: "big", label: "Big" }] as never;
    try {
      const refused = await t.request(`/v1/conversations/${cleos}/messages`, {
        token: cleo,
        body: { text: "Hello" },
      });
      assert.equal(refused.status, 409);
      const body = (await refused.json()) as { error: string; message: string };
      assert.equal(body.error, "admins_consent");
      assert.match(body.message, /An admin of the team says yes/);
      const admins = await t.request(`/v1/conversations/${team}/messages`, {
        token: ada,
        body: { text: "Hello" },
      });
      assert.equal(((await admins.json()) as { error: string }).error, "needs_consent");
    } finally {
      t.home.models.waitingForYes = waiting;
    }
  });

  test("hears what happens in their own conversation, and nobody else hears of it", async () => {
    const main = t.home.store.mainAgent();
    const from = lastEvent();
    const listening = t.home.events.listenerCount;
    const heard = Promise.all([cleo, eve, ada].map((token) => listen(token, "A new about")));
    while (t.home.events.listenerCount < listening + 3) await new Promise((r) => setTimeout(r, 5));
    t.model.script.push(
      {
        calls: [
          { name: "document_write", arguments: { title: "Notes", content: "Streamed notes" } },
        ],
      },
      { text: "Streamed answer." },
    );
    await say(cleo, cleos, "Stream this");
    // What every device that lists the agent hears ends the three streams.
    t.home.store.updateAgent(main.id, { about: "A new about" });
    const [hers, eveHeard, adaHeard] = (await heard) as [string, string, string];
    for (const kind of ["message.created", "message.updated", "document.updated", "agent.updated"])
      assert.ok(hers.includes(kind), kind);
    assert.ok(hers.includes("Stream this") && hers.includes("Streamed answer."));
    for (const others of [eveHeard, adaHeard]) {
      assert.ok(!others.includes(cleos));
      assert.ok(!others.includes("Stream"));
      // The one thing they heard is the agent's own change, each with the line of their own.
      assert.equal(others.match(/"type":"agent\.updated"/g)?.length, 1);
    }
    assert.ok(eveHeard.includes(eves) && !eveHeard.includes(team));
    assert.ok(adaHeard.includes(team));
    assert.ok(!hers.includes(team) && !hers.includes(eves));

    // What the admins' conversation does is not told to a member.
    const quiet = Promise.all([cleo, ada].map((token) => listen(token, "A newer about")));
    while (t.home.events.listenerCount < listening + 2) await new Promise((r) => setTimeout(r, 5));
    t.model.script.push({ text: "For the admins." });
    await say(ada, team, "Admins only");
    t.home.store.updateAgent(main.id, { about: "A newer about" });
    const [cleoHeard, adaLater] = (await quiet) as [string, string];
    assert.ok(adaLater.includes("For the admins."));
    assert.ok(!cleoHeard.includes(team) && !cleoHeard.includes("admins"));
    assert.equal(cleoHeard.match(/"type":"agent\.updated"/g)?.length, 1);

    // The same holds for what a device missed and is told again.
    const again = await listen(ada, "A newer about", from);
    assert.ok(again.includes("A new about"));
    assert.ok(!again.includes(cleos) && !again.includes("Streamed"));
    const hersAgain = await listen(cleo, "A newer about", from);
    assert.ok(hersAgain.includes("Streamed answer."));
    assert.ok(!hersAgain.includes("For the admins."));
  });

  test("uses the studio as themselves, and no other connection", async () => {
    t.home.db.run(
      "insert into connection (id, name, url, state, created_at) values ('con_mail', 'mail', 'http://127.0.0.1:9/mcp', 'connected', ?)",
      new Date().toISOString(),
    );
    t.model.script.push(
      { calls: [studioCall("space_search", { query: "prices" })] },
      { calls: [studioCall("send", { to: "all" }, "mail")] },
      { calls: [{ name: "connection_tools", arguments: { name: "mail" } }] },
      { text: "Found it." },
    );
    await say(cleo, cleos, "What do we know about prices", SALES);
    assert.deepEqual(studio.calls.at(-1)?.arguments, { query: "prices", spaceId: "spc_sales" });
    assert.equal(bearers(studio).at(-1), "Bearer token-usr_cleo");
    const asked = t.model.requests.at(-1);
    assert.match(asked?.context ?? "", /the space "Sales" is open/);
    assert.doesNotMatch(asked?.messages[0]?.content ?? "", /mail/);
    const told = (asked?.messages ?? []).filter((message) => message.role === "tool").slice(-3);
    assert.match(JSON.stringify(told[0]), /found/);
    for (const refused of told.slice(1)) {
      assert.match(JSON.stringify(refused), /That is for the team's admins/);
      assert.doesNotMatch(JSON.stringify(refused), /mail/);
    }
    t.home.db.run("delete from connection where id = 'con_mail'");
  });

  test("a studio tool that changes something asks the member alone, once", async () => {
    const calls = studio.calls.length;
    t.model.script.push({ calls: [studioCall("wizard_run", { wizardId: "wiz_1" })] });
    await say(cleo, cleos, "Run the wizard", SALES);
    const card = (await items(cleo)).at(-1) as Card;
    assert.equal(card.kind, "approval");
    assert.deepEqual(
      card.actions.map((action) => action.id),
      ["once", "deny"],
    );
    assert.deepEqual(await items(ada), []);
    assert.equal(studio.calls.length, calls);
    const answer = (token: string, action: string) =>
      t.request(`/v1/cards/${card.id}/answer`, { token, body: { action } });
    assert.equal((await answer(ada, "once")).status, 404);
    assert.equal((await answer(cleo, "always")).status, 400);
    assert.equal(studio.calls.length, calls);
    t.model.script.push({ text: "It ran." });
    assert.equal((await answer(cleo, "once")).status, 200);
    await settle();
    assert.deepEqual(studio.calls.at(-1)?.arguments, { wizardId: "wiz_1", spaceId: "spc_sales" });
    assert.equal(bearers(studio).at(-1), "Bearer token-usr_cleo");
    assert.equal(textOf((await messages(cleo, cleos)).at(-1) as Message), "It ran.");
    assert.deepEqual(t.home.connections.byName("studio")?.policies, {});

    // Who runs the home is offered "Always allow".
    t.model.script.push({ calls: [studioCall("wizard_run", { wizardId: "wiz_2" })] });
    await say(ada, team, "Run the other wizard", SALES);
    const admins = (await items(ada)).at(-1) as Card;
    assert.deepEqual(
      admins.actions.map((action) => action.id),
      ["once", "always", "deny"],
    );
    t.model.script.push({ text: "Left it." });
    await t.request(`/v1/cards/${admins.id}/answer`, { token: ada, body: { action: "deny" } });
    await settle();
  });

  test("has no view to show, and reads nothing about views", async () => {
    t.model.script.push({ text: "In words, then." });
    await say(cleo, cleos, "Show me the numbers");
    const members = t.model.requests.at(-1);
    assert.ok(!toolsOf(members).includes("show_view"));
    assert.doesNotMatch(members?.messages[0]?.content ?? "", /Views:|show_view|openui-lang/);
    // Who runs the home has both.
    t.model.script.push({ text: "Here they are." });
    await say(ada, team, "Show me the numbers");
    const admins = t.model.requests.at(-1);
    assert.ok(toolsOf(admins).includes("show_view"));
    assert.match(admins?.messages[0]?.content ?? "", /Views:/);
  });

  test("a view's answer is given by who reads its conversation, like any card's", async () => {
    const view = [
      "root = Column([form])",
      'form = Form([people], "Send", "Hall")',
      'people = Field("people", "number", "How many people", true)',
    ].join("\n");
    t.model.script.push(
      { calls: [{ name: "show_view", arguments: { title: "Hall", text: "A form.", view } }] },
      { text: "Fill it in." },
    );
    await say(ada, team, "Ask how many come");
    const teams = t.home.store.openCards(team).find((card) => card.view) as Card;
    assert.equal(teams.view?.program, view);
    const answer = (token: string, card: Card, people: number) =>
      t.request(`/v1/cards/${card.id}/answer`, {
        token,
        body: { action: "view", message: "Send", state: { people } },
      });
    // The team's view is not a member's to answer.
    assert.equal((await answer(cleo, teams, 7)).status, 404);
    assert.equal(t.home.store.card(teams.id)?.state, "open");

    // A view that stands in a member's own conversation is that member's alone.
    const agent = t.home.store.mainAgent();
    const message = t.home.store.addMessage({
      conversationId: cleos,
      role: "agent",
      agentId: agent.id,
      channel: "home",
      parts: [],
    });
    const mine = t.home.store.createCard(
      {
        kind: "question",
        level: "needs_you",
        title: "Seats",
        body: "A form.",
        view: teams.view,
        actions: [],
        payload: { type: "view", writer: "usr_cleo" },
      },
      { agentId: agent.id, conversationId: cleos, messageId: message.id },
    );
    assert.ok((await items(cleo)).some((card) => card.id === mine.id));
    assert.ok(!(await items(ada)).some((card) => card.id === mine.id));
    for (const token of [ada, eve]) assert.equal((await answer(token, mine, 12)).status, 404);
    assert.equal(t.home.store.card(mine.id)?.state, "open");
    t.model.script.push({ text: "Forty seats." });
    const answered = await answer(cleo, mine, 40);
    assert.equal(answered.status, 200);
    const { card: after } = (await answered.json()) as { card: Card };
    assert.deepEqual(after.answer?.person, { id: "usr_cleo", name: "Cleo" });
    assert.deepEqual(after.answer?.state, { people: 40 });
    await settle();
    // The turn the answer starts is the member's: it reads what they filled in, with their tools.
    const asked = t.model.requests.at(-1);
    const told = (asked?.messages ?? []).findLast((each) => each.role === "user")?.content ?? "";
    assert.match(told, /Sent from the view "Seats"[\s\S]*- people: 40/);
    assert.match(asked?.messages[0]?.content ?? "", /You talk with Cleo, a member/);
    assert.ok(!toolsOf(asked).includes("show_view"));
    assert.ok(!toolsOf(asked).includes("remember"));
    assert.equal(textOf((await messages(cleo, cleos)).at(-1) as Message), "Forty seats.");

    t.model.script.push({ text: "Twelve it is." });
    assert.equal((await answer(ada, teams, 12)).status, 200);
    await settle();
  });

  test("someone who becomes an admin reads the team's conversation, and their own stays put away", async () => {
    manage.people = manage.people.map((one) =>
      one.id === "usr_cleo" ? { ...one, role: "admin" } : one,
    );
    await t.home.group.pull();
    assert.equal((await t.request("/v1/agents", { token: cleo })).status, 401);
    const admin = device("usr_cleo", "Cleo's browser");
    assert.equal((await agents(admin))[0]?.conversationId, team);
    assert.equal(
      (await t.request(`/v1/conversations/${cleos}/messages`, { token: admin })).status,
      404,
    );
    assert.deepEqual(t.home.store.memberConversations({ person: "usr_cleo" }), [cleos]);
  });

  test("someone who leaves the team loses their conversations with their devices", async () => {
    t.model.script.push(
      { calls: [{ name: "document_write", arguments: { title: "Mine", content: "Eve's" } }] },
      { text: "Written." },
    );
    await say(eve, eves, "Write it down");
    const document = t.home.store.documents(eves)[0]?.id ?? "";
    assert.ok(t.home.store.document(document));
    manage.people = manage.people.filter((one) => one.id !== "usr_eve");
    await t.home.group.pull();
    assert.equal((await t.request("/v1/agents", { token: eve })).status, 401);
    assert.deepEqual(t.home.store.memberConversations({ person: "usr_eve" }), []);
    assert.equal(t.home.store.conversation(eves), undefined);
    assert.equal(t.home.store.document(document), undefined);
    assert.deepEqual(t.home.store.messages(eves).messages, []);
    // The others keep theirs.
    assert.ok(t.home.store.conversation(cleos));
    assert.ok(t.home.store.conversation(team));
  });
});

describe("a member of a group home with a small model", () => {
  test("is not asked whether a more capable model takes over", async () => {
    const manage = new FakeManage();
    await manage.start();
    const t = await testHome("Ada", undefined, {
      level: "basic",
      config: { manageUrl: manage.url },
    });
    try {
      t.home.models.accountKey = () => KEY;
      t.home.db.run("delete from device");
      await t.home.group.pull();
      const { models } = t.home;
      const engine = models.engine.bind(models);
      const own = models.candidates()[0] ?? "";
      models.candidates = () => [own, "big:one"];
      models.engine = (ref) => {
        const found = engine(own);
        return found && (ref === own ? found : { ...found, ref, level: "high" });
      };
      models.waitingForYes = () => [];
      const page = { name: "artifact_write", arguments: { title: "Chart", html: "<p>One</p>" } };
      const token = (personId: string) =>
        t.home.store.addDevice({ name: personId, kind: "browser", personId }).token;
      const cleo = token("usr_cleo");
      const cleos =
        ((await (await t.request("/v1/agents", { token: cleo })).json()) as { agents: Agent[] })
          .agents[0]?.conversationId ?? "";
      const say = async (as: string, conversationId: string) => {
        t.model.script.push(
          { calls: [{ name: "tool_call", arguments: { name: page.name, input: page.arguments } }] },
          { text: "I cannot do that myself." },
        );
        await t.request(`/v1/conversations/${conversationId}/messages`, {
          token: as,
          body: { text: "Draw a chart" },
        });
        await t.home.idle();
      };
      await say(cleo, cleos);
      assert.deepEqual(t.home.store.items(), []);
      assert.match(
        JSON.stringify(t.model.requests.at(-1)?.messages ?? []),
        /Nothing was done\. Not for the model that answers now/,
      );
      // An admin is asked.
      await say(token("usr_ada"), t.home.store.mainAgent().conversationId);
      assert.match(t.home.store.items()[0]?.title ?? "", /take over\?$/);
    } finally {
      t.stop();
      manage.stop();
    }
  });
});
