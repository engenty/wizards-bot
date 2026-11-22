import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Card, Message } from "@wizards-bot/protocol";
import type { AgentRecord } from "../store/store.ts";
import { FakeOutsideAgent, type TestHome, testHome, textOf } from "../test/fakes.ts";
import { A2AAgent, outsideUrl, readCard, signInOf } from "./a2a.ts";

/** Has the main agent read an outside agent's card. Returns the card that asks the person. */
async function offer(t: TestHome, fake: FakeOutsideAgent): Promise<Card> {
  t.model.script.push(
    { calls: [{ name: "outside_agent_add", arguments: { url: fake.url } }] },
    { text: "I asked you first." },
  );
  await t.say(`Add the agent at ${fake.url}`);
  return t.item();
}

/** Adds an outside agent as the person: reads its card and says yes. */
async function add(
  t: TestHome,
  fake: FakeOutsideAgent,
  values?: Record<string, string>,
): Promise<AgentRecord> {
  const card = await offer(t, fake);
  t.model.script.push({ text: `${fake.name} is in your list.` });
  await t.answer(card.id, "add", values);
  return t.home.store.agents().find((agent) => agent.from === fake.host) as AgentRecord;
}

/** Writes to an agent in its own chat, as the person, and returns the answer. */
async function write(t: TestHome, agent: AgentRecord, text: string): Promise<Message> {
  await t.request(`/v1/conversations/${agent.conversationId}/messages`, { body: { text } });
  await t.home.turns.idle();
  return t.home.store.messages(agent.conversationId, { limit: 1 }).messages[0] as Message;
}

async function outsideAgent(change?: (fake: FakeOutsideAgent) => void): Promise<FakeOutsideAgent> {
  const fake = new FakeOutsideAgent();
  change?.(fake);
  await fake.start();
  return fake;
}

describe("an agent card", () => {
  const fakes: FakeOutsideAgent[] = [];
  after(() => {
    for (const fake of fakes) fake.stop();
  });
  const outside = async (fake: FakeOutsideAgent) => {
    fakes.push(fake);
    await fake.start();
    return fake;
  };

  test("is read in A2A 1.0 and in 0.3, from the agent's site or the card's own address", async () => {
    const one = await outside(new FakeOutsideAgent());
    const card = await readCard(one.url, true);
    assert.deepEqual(card, {
      cardUrl: `${one.url}/.well-known/agent-card.json`,
      version: "1.0",
      name: "Booking",
      description: "Books tables and rooms.",
      organization: "Hotel Lux",
      skills: ["Book a table"],
      url: `${one.url}/rpc`,
      tenant: undefined,
      streams: false,
      signIn: { kind: "none" },
    });
    assert.deepEqual(await readCard(card.cardUrl, true), card);

    const old = new FakeOutsideAgent();
    old.version = "0.3";
    old.signIn = "apiKey";
    old.streams = true;
    await outside(old);
    const read = await readCard(`${old.url}/`, true);
    assert.equal(read.version, "0.3");
    assert.equal(read.url, `${old.url}/rpc`);
    assert.equal(read.streams, true);
    assert.deepEqual(read.signIn, { kind: "apiKey", location: "header", name: "X-API-Key" });
  });

  test("says why when the home cannot talk to the agent", async () => {
    class Other extends FakeOutsideAgent {
      interfaces: unknown[] = [];
      override card() {
        return { ...super.card(), supportedInterfaces: this.interfaces };
      }
    }
    const grpc = new Other();
    grpc.interfaces = [
      { url: "https://a.example", protocolBinding: "GRPC", protocolVersion: "1.0" },
    ];
    await outside(grpc);
    await assert.rejects(readCard(grpc.url, true), /GRPC only\. The Bot Server speaks JSON-RPC/);

    const later = new Other();
    later.interfaces = [
      { url: "https://a.example/rpc", protocolBinding: "JSONRPC", protocolVersion: "2.0" },
    ];
    await outside(later);
    await assert.rejects(
      readCard(later.url, true),
      /speaks A2A 2\.0\. The Bot Server speaks A2A 1\.0 and 0\.3/,
    );

    // Nothing answers at this address.
    await assert.rejects(readCard("http://127.0.0.1:9/agents/x", true), /no agent card at/);
  });

  test("asks for nothing, a token or a key, and the first way the home can do is taken", () => {
    assert.deepEqual(signInOf({}, "1.0"), { kind: "none" });
    assert.deepEqual(signInOf({}, "0.3"), { kind: "none" });
    const schemes = {
      oauth: { oauth2SecurityScheme: { flows: {} } },
      token: { httpAuthSecurityScheme: { scheme: "bearer" } },
      key: { apiKeySecurityScheme: { location: "query", name: "api_key" } },
    };
    assert.deepEqual(
      signInOf(
        {
          securitySchemes: schemes,
          securityRequirements: [
            { schemes: { oauth: { list: ["read"] } } },
            { schemes: { key: { list: [] } } },
          ],
        },
        "1.0",
      ),
      { kind: "apiKey", location: "query", name: "api_key" },
    );
    const oauth = signInOf(
      {
        securitySchemes: schemes,
        securityRequirements: [
          { schemes: { oauth: { list: [] } } },
          { schemes: { token: { list: [] }, key: { list: [] } } },
        ],
      },
      "1.0",
    );
    assert.match("why" in oauth ? oauth.why : "", /OAuth, or a token together with a key/);

    // A2A 0.3 describes the same the way OpenAPI does.
    const old = {
      securitySchemes: {
        oidc: { type: "openIdConnect", openIdConnectUrl: "https://a.example" },
        token: { type: "http", scheme: "Bearer" },
        basic: { type: "http", scheme: "Basic" },
      },
    };
    assert.deepEqual(signInOf({ ...old, security: [{ oidc: [] }, { token: [] }] }, "0.3"), {
      kind: "bearer",
    });
    const basic = signInOf({ ...old, security: [{ oidc: ["openid"] }, { basic: [] }] }, "0.3");
    assert.match("why" in basic ? basic.why : "", /OpenID Connect, or HTTP Basic/);
  });

  test("is read from a public address only by a home on the internet", () => {
    assert.equal(outsideUrl("https://agents.example/card.json", false).host, "agents.example");
    assert.equal(outsideUrl("http://127.0.0.1:9000", true).host, "127.0.0.1:9000");
    assert.throws(() => outsideUrl("http://127.0.0.1:9000", false), /private address/);
    assert.throws(() => outsideUrl("https://printer.local/card.json", false), /private address/);
    assert.throws(() => outsideUrl("http://agents.example", true), /https/);
    assert.throws(() => outsideUrl("https://me:pw@agents.example", true), /password/);
    assert.throws(() => outsideUrl("file:///etc/passwd", true), /https/);
  });
});

describe("an agent that is not a wizards.bot home", () => {
  let t: TestHome;
  const fakes: FakeOutsideAgent[] = [];
  const outside = async (change?: (fake: FakeOutsideAgent) => void) => {
    const fake = await outsideAgent(change);
    fakes.push(fake);
    return fake;
  };
  before(async () => {
    t = await testHome("Ada");
  });
  after(() => {
    t.stop();
    for (const fake of fakes) fake.stop();
  });

  test("is added from its card after the person says yes, and answers in its chat", async () => {
    const fake = await outside();
    const card = await offer(t, fake);
    assert.equal(card.kind, "approval");
    assert.equal(card.title, "Add “Booking”?");
    assert.match(card.body ?? "", new RegExp(`\\*\\*${fake.host}\\*\\*, run by Hotel Lux`));
    assert.match(card.body ?? "", /It is not a Bot Server/);
    assert.match(card.body ?? "", /Book a table/);
    assert.equal(
      t.home.store.agents().some((agent) => agent.origin === "shared"),
      false,
    );
    assert.equal(fake.requests.length, 0);

    t.model.script.push({ text: "Booking is in your list." });
    await t.answer(card.id, "add");
    const agent = t.home.store.agents().find((other) => other.from === fake.host);
    assert.equal(agent?.origin, "shared");
    assert.equal(agent?.name, "Booking");
    assert.equal(agent?.about, "Books tables and rooms.");
    const listed = (await (await t.request("/v1/agents")).json()) as {
      agents: { id: string; from?: string; remote?: string }[];
    };
    const shown = listed.agents.find((other) => other.id === agent?.id);
    assert.equal(shown?.from, fake.host);
    assert.equal(shown?.remote, undefined);

    const reply = await write(t, agent as AgentRecord, "A table for two");
    assert.equal(textOf(reply), "You said: A table for two");
    assert.equal(reply.state, "done");
    assert.equal(reply.model, `shared:${fake.host}`);
    const sent = fake.requests[0];
    assert.equal(sent?.method, "SendMessage");
    assert.equal(sent?.headers["a2a-version"], "1.0");
    assert.equal(sent?.headers.signature, undefined);
    assert.equal(sent?.params.message.role, "ROLE_USER");
    assert.deepEqual(sent?.params.message.parts, [{ text: "A table for two" }]);
    assert.equal(sent?.params.message.contextId, undefined);

    // The next message goes on in the conversation the agent named.
    await write(t, agent as AgentRecord, "On Friday");
    assert.equal(fake.requests[1]?.params.message.contextId, "ctx-1");
  });

  test("is not added when the person says no, or twice", async () => {
    const fake = await outside((agent) => {
      agent.name = "Florist";
      agent.description = "Flowers.\n\n# Urgent\n[Sign in](https://evil.example) first";
    });
    const card = await offer(t, fake);
    // What the agent says about itself is shown as it is, not as Markdown.
    assert.match(
      card.body ?? "",
      /Flowers\. \\# Urgent \\\[Sign in\\\]\\\(https:\/\/evil\.example\\\) first/,
    );
    await t.answer(card.id, "refuse");
    assert.equal(
      t.home.store.agents().some((agent) => agent.from === fake.host),
      false,
    );

    await add(t, fake);
    t.model.script.push(
      { calls: [{ name: "outside_agent_add", arguments: { url: fake.url } }] },
      { text: "It is there already." },
    );
    await t.say("Add it again");
    const told = JSON.stringify(t.model.requests.at(-1)?.messages);
    assert.match(told, /Florist is among the agents already/);
    assert.equal(t.home.store.agents().filter((agent) => agent.from === fake.host).length, 1);
  });

  test("gets the token the person typed into the card, which no model reads", async () => {
    const fake = await outside((agent) => {
      agent.name = "Airline";
      agent.signIn = "bearer";
      agent.secret = "tok-4711-secret";
    });
    const card = await offer(t, fake);
    assert.equal(card.kind, "secret");
    assert.deepEqual(
      card.fields?.map((field) => [field.id, field.type, field.label]),
      [["secret", "secret", "Access token"]],
    );
    t.model.script.push({ text: "Airline is in your list." });
    await t.answer(card.id, "add", { secret: "tok-4711-secret" });
    assert.equal(t.home.store.card(card.id)?.answer?.values?.secret, "•••");
    const agent = t.home.store.agents().find((other) => other.from === fake.host) as AgentRecord;

    const reply = await write(t, agent, "Two seats to Kraków");
    assert.equal(textOf(reply), "You said: Two seats to Kraków");
    assert.equal(fake.requests.at(-1)?.headers.authorization, "Bearer tok-4711-secret");
    assert.doesNotMatch(JSON.stringify(t.model.requests), /tok-4711-secret/);
    assert.doesNotMatch(
      JSON.stringify(t.home.db.all("select * from outside_agent")),
      /tok-4711-secret/,
    );

    // The agent stops taking the token: the person reads why.
    fake.secret = "another";
    const refused = await write(t, agent, "And back");
    assert.equal(refused.state, "failed");
    assert.match(textOf(refused), /Airline did not accept the token/);

    // Its secret goes with it.
    assert.equal(t.home.secrets.has(`outside.${agent.id}`), true);
    t.home.removeAgent(agent.id);
    assert.equal(t.home.secrets.has(`outside.${agent.id}`), false);
    assert.equal(
      t.home.db.all("select * from outside_agent where agent_id = ?", agent.id).length,
      0,
    );
  });

  test("gets a key in the header its card names, and is not added without one", async () => {
    const fake = await outside((agent) => {
      agent.name = "Weather";
      agent.signIn = "apiKey";
      agent.secret = "key-123";
    });
    const empty = await offer(t, fake);
    t.model.script.push({ text: "It was not added." });
    await t.answer(empty.id, "add", { secret: " " });
    assert.equal(
      t.home.store.agents().some((agent) => agent.from === fake.host),
      false,
    );

    const agent = await add(t, fake, { secret: "key-123" });
    const reply = await write(t, agent, "Rain tomorrow?");
    assert.equal(textOf(reply), "You said: Rain tomorrow?");
    assert.equal(fake.requests.at(-1)?.headers["x-api-key"], "key-123");
    assert.equal(fake.requests.at(-1)?.headers.authorization, undefined);
  });

  test("is not added when it asks for OAuth, and the agent reads why", async () => {
    const fake = await outside((agent) => {
      agent.name = "Bank";
      agent.signIn = "oauth";
    });
    const before = t.home.store.items().length;
    t.model.script.push(
      { calls: [{ name: "outside_agent_add", arguments: { url: fake.url } }] },
      { text: "That agent asks for OAuth, which I cannot do yet." },
    );
    await t.say("Add the bank's agent");
    assert.equal(t.home.store.items().length, before);
    const told = JSON.stringify(t.model.requests.at(-1)?.messages);
    assert.match(told, /Bank cannot be added yet\. It asks for OAuth\./);
    assert.match(told, /OAuth is not built yet/);
  });

  test("may answer with a task: finished, still worked on, or waiting for more", async () => {
    const fake = await outside((agent) => {
      agent.name = "Planner";
      agent.answers = "task";
    });
    const agent = await add(t, fake);
    assert.equal(textOf(await write(t, agent, "Plan a day")), "You said: Plan a day");

    fake.answers = "working";
    assert.equal(textOf(await write(t, agent, "Plan a week")), "You said: Plan a week");
    assert.deepEqual(
      fake.requests.slice(-2).map((request) => request.method),
      ["SendMessage", "GetTask"],
    );

    fake.answers = "input";
    assert.equal(textOf(await write(t, agent, "Book it")), "Which day?");
    const waiting = fake.requests.at(-1)?.params.message.contextId;
    fake.answers = "message";
    assert.equal(textOf(await write(t, agent, "Friday")), "You said: Friday");
    const next = fake.requests.at(-1)?.params.message;
    assert.match(next.taskId, /^task-/);
    assert.equal(next.contextId, waiting);
    // The task ended with that answer: the message after it starts fresh.
    await write(t, agent, "Thanks");
    assert.equal(fake.requests.at(-1)?.params.message.taskId, undefined);
  });

  test("streams its answer into the chat when its card offers that", async () => {
    const fake = await outside((agent) => {
      agent.name = "Concierge";
      agent.streams = true;
    });
    const agent = await add(t, fake);
    const pieces: string[] = [];
    const stop = t.home.events.subscribe(({ event }) => {
      if (event.type === "message.delta") pieces.push(event.text);
    });
    const reply = await write(t, agent, "A late checkout");
    stop();
    assert.equal(fake.requests.at(-1)?.method, "SendStreamingMessage");
    assert.deepEqual(pieces, ["You said: ", "A late checkout"]);
    assert.equal(textOf(reply), "You said: A late checkout");
    assert.equal(reply.state, "done");
    await write(t, agent, "Until two");
    assert.match(fake.requests.at(-1)?.params.message.contextId, /^ctx-/);
  });

  test("is talked to in A2A 0.3 when its card is that", async () => {
    const fake = await outside((agent) => {
      agent.name = "Museum";
      agent.version = "0.3";
      agent.signIn = "bearer";
      agent.secret = "old-token";
    });
    const agent = await add(t, fake, { secret: "old-token" });
    const reply = await write(t, agent, "Open on Monday?");
    assert.equal(textOf(reply), "You said: Open on Monday?");
    const sent = fake.requests[0];
    assert.equal(sent?.method, "message/send");
    assert.equal(sent?.headers["a2a-version"], undefined);
    assert.equal(sent?.headers.authorization, "Bearer old-token");
    assert.equal(sent?.params.message.role, "user");
    assert.deepEqual(sent?.params.message.parts, [{ kind: "text", text: "Open on Monday?" }]);
    await write(t, agent, "And on Tuesday?");
    assert.equal(fake.requests[1]?.params.message.contextId, "ctx-1");
  });

  test("gets a task from another agent only after the person says yes", async () => {
    const fake = await outside((agent) => {
      agent.name = "Taxi";
    });
    const agent = await add(t, fake);
    const hand = {
      name: "agent_message",
      arguments: { id: agent.id, text: "A taxi at 8, to the station" },
    };

    t.model.script.push({ calls: [hand] }, { text: "I asked you first." });
    await t.say("Ask the taxi agent for a car at 8");
    const ask = t.item();
    assert.equal(ask.title, "Send this to “Taxi”?");
    assert.match(ask.body ?? "", /A taxi at 8, to the station/);
    assert.match(ask.body ?? "", new RegExp(`This goes to ${fake.host}`));
    assert.equal(fake.requests.length, 0);

    t.model.script.push({ text: "The taxi is booked." });
    await t.answer(ask.id, "send");
    assert.deepEqual(fake.requests[0]?.params.message.parts, [
      { text: "A taxi at 8, to the station" },
    ]);
    const back = t.model.requests.at(-1)?.messages.at(-1)?.content ?? "";
    assert.match(back, /Taxi, which is not on this Bot Server, answered/);
    assert.match(back, /You said: A taxi at 8, to the station/);
    assert.equal(textOf(t.last()), "The taxi is booked.");

    t.model.script.push({ calls: [hand] }, { text: "I asked you first." });
    await t.say("And once more");
    t.model.script.push({ text: "Not sent." });
    await t.answer(t.item().id, "keep");
    assert.equal(fake.requests.length, 1);
  });
});

describe("a caller from outside", () => {
  let t: TestHome;
  let travel: AgentRecord;
  let notes: AgentRecord;
  let token = "";
  const NAME = "the booking agent of Hotel Lux";

  const rpc = (
    agentId: string,
    init: {
      token?: string;
      method?: string;
      params?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) =>
    fetch(`${t.url}/a2a/agents/${agentId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "a2a-version": "1.0",
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...init.headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: init.method ?? "SendMessage",
        params: init.params ?? {
          message: { messageId: "m1", role: "ROLE_USER", parts: [{ text: "Is Friday free?" }] },
        },
      }),
    });
  // biome-ignore lint/suspicious/noExplicitAny: a JSON-RPC answer as it came
  const answerOf = async (response: Response): Promise<any> => response.json();

  before(async () => {
    t = await testHome("Ada");
    travel = t.home.store.createAgent({
      name: "Travel",
      kind: "drop",
      about: "Plans Ada's trips.",
      instructions: "Answer questions about Ada's trip to Kraków.",
    });
    notes = t.home.store.createAgent({ name: "Notes", kind: "oval", about: "Keeps notes." });
  });
  after(() => t.stop());

  test("is let in by the person and gets an access token that is shown once", async () => {
    assert.equal((await fetch(`${t.url}/a2a/agents/${travel.id}/agent-card.json`)).status, 404);

    t.model.script.push(
      { calls: [{ name: "outside_agent_let_in", arguments: { agentId: travel.id, name: NAME } }] },
      { text: "I asked you first." },
    );
    await t.say("Let the booking agent of Hotel Lux talk to Travel");
    const ask = t.item();
    assert.equal(ask.title, `Let ${NAME} write to “Travel”?`);
    assert.equal(t.home.peers.outside.callers().length, 0);

    t.model.script.push({ text: "It may write to Travel now." });
    await t.answer(ask.id, "let_in");
    const shown = t.item();
    assert.equal(shown.title, `Access token for ${NAME}`);
    token = /Access token: `([^`]+)`/.exec(shown.body ?? "")?.[1] ?? "";
    assert.ok(token.length >= 40);
    const cardUrl = /Agent card: `([^`]+)`/.exec(shown.body ?? "")?.[1] ?? "";
    assert.equal(cardUrl, `${t.url}/a2a/agents/${travel.id}/agent-card.json`);
    // Neither a model nor the database got the token itself.
    assert.doesNotMatch(JSON.stringify(t.model.requests), new RegExp(token));
    assert.doesNotMatch(JSON.stringify(t.home.db.all("select * from caller")), new RegExp(token));

    // The card reads the way an outside agent's card does, by Mastra's client.
    const read = await readCard(cardUrl, true);
    assert.equal(read.name, "Travel");
    assert.equal(read.description, "Plans Ada's trips.");
    assert.equal(read.version, "1.0");
    assert.equal(read.url, `${t.url}/a2a/agents/${travel.id}`);
    assert.equal(read.streams, true);
    assert.deepEqual(read.signIn, { kind: "bearer" });
    // Without a version it is the card A2A 0.3 knows. Neither says the agent's instructions.
    const plain = await fetch(cardUrl);
    assert.equal(plain.headers.get("vary"), "A2A-Version");
    const old = await answerOf(plain);
    assert.equal(old.protocolVersion, "0.3.0");
    assert.equal(old.url, read.url);
    assert.deepEqual(old.security, [{ token: [] }]);
    assert.deepEqual(old.capabilities, {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
    });
    assert.doesNotMatch(JSON.stringify(old), /Answer questions about/);

    await t.answer(shown.id, "hide");
    const hidden = t.home.store.card(shown.id);
    assert.doesNotMatch(hidden?.body ?? "", new RegExp(token));
    assert.match(hidden?.body ?? "", /shown once/);
    assert.equal(t.home.store.items().length, 0);
  });

  test("reaches its agent in a conversation of its own, and nothing else", async () => {
    t.model.script.push({ text: "Friday is free." });
    const first = await answerOf(await rpc(travel.id, { token }));
    assert.equal(first.id, 7);
    assert.equal(first.result.task.status.state, "TASK_STATE_COMPLETED");
    assert.deepEqual(first.result.task.artifacts[0].parts, [{ text: "Friday is free." }]);
    const asked = t.model.requests.at(-1);
    assert.match(asked?.messages[0]?.content ?? "", new RegExp(`Ada lets ${NAME} write to you`));
    assert.match(asked?.messages[0]?.content ?? "", /Answer questions about Ada's trip/);
    assert.equal(asked?.tools, undefined);

    // Whatever conversation the caller names, it stays in its own.
    t.model.script.push({ text: "Saturday too." });
    const second = await answerOf(
      await rpc(travel.id, {
        token,
        params: {
          message: {
            messageId: "m2",
            role: "ROLE_USER",
            contextId: travel.conversationId,
            parts: [{ text: "And Saturday?" }],
          },
        },
      }),
    );
    const contextId = second.result.task.contextId;
    assert.equal(contextId, first.result.task.contextId);
    assert.notEqual(contextId, travel.conversationId);
    // The agent remembers what was said before, in that conversation.
    assert.match(JSON.stringify(t.model.requests.at(-1)?.messages), /Friday is free\./);
    await t.home.idle();
    assert.deepEqual(
      t.home.store.messages(contextId).messages.map((message) => [message.role, textOf(message)]),
      [
        ["you", "Is Friday free?"],
        ["agent", "Friday is free."],
        ["you", "And Saturday?"],
        ["agent", "Saturday too."],
      ],
    );
    assert.equal(t.home.store.messages(travel.conversationId).messages.length, 0);
    assert.match(t.home.peers.outside.callers()[0]?.heardAt ?? "", /^20/);

    // Mastra's own A2A client, with the token, is answered too, and streamed to.
    t.model.script.push({ text: "Sunday is taken." });
    const client = new A2AAgent({
      url: `${t.url}/a2a/agents/${travel.id}/agent-card.json`,
      protocolVersion: "1.0",
      headers: { authorization: `Bearer ${token}` },
    });
    const viaMastra = await client.generate("And Sunday?");
    assert.equal(viaMastra.text, "Sunday is taken.");
    assert.equal(viaMastra.task?.contextId, contextId);
    t.model.script.push({ text: "Monday is free again." });
    const streamed = await client.stream("And Monday?");
    let pieces = 0;
    for await (const chunk of streamed.fullStream as AsyncIterable<{ type: string }>) {
      if (chunk.type === "text-delta") pieces++;
    }
    assert.ok(pieces >= 2);
    assert.equal(await streamed.text, "Monday is free again.");

    // Another agent, the main agent, the devices' routes and the tools are closed to it.
    const requests = t.model.requests.length;
    for (const other of [notes.id, t.home.store.mainAgent().id, "agt_nothere"]) {
      const response = await rpc(other, { token });
      assert.equal(response.status, 403);
      assert.equal(
        (await answerOf(response)).message,
        "This agent does not take messages from the sender.",
      );
    }
    assert.equal((await t.request("/v1/agents", { token })).status, 401);
    assert.equal((await t.request(`/v1/agents/${travel.id}`, { token })).status, 401);
    const tools = await answerOf(
      await t.request("/mcp", { token, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } }),
    );
    assert.equal(tools.result, undefined);
    assert.equal(tools.error.message, "This turn is over.");
    assert.equal(t.model.requests.length, requests);
  });

  test("is answered in A2A 0.3 as well, and asks for its tasks", async () => {
    t.model.script.push({ text: "Tuesday is free." });
    const old = await answerOf(
      await rpc(travel.id, {
        token,
        method: "message/send",
        headers: { "a2a-version": "0.3" },
        params: {
          message: {
            kind: "message",
            messageId: "m-old",
            role: "user",
            parts: [{ kind: "text", text: "And Tuesday?" }],
          },
        },
      }),
    );
    assert.equal(old.result.kind, "task");
    assert.equal(old.result.status.state, "completed");
    assert.deepEqual(old.result.artifacts[0].parts, [{ kind: "text", text: "Tuesday is free." }]);

    const one = await answerOf(
      await rpc(travel.id, { token, method: "GetTask", params: { id: old.result.id } }),
    );
    assert.equal(one.result.id, old.result.id);
    assert.equal(one.result.status.state, "TASK_STATE_COMPLETED");
    const all = await answerOf(await rpc(travel.id, { token, method: "ListTasks", params: {} }));
    assert.ok(all.result.tasks.length >= 3);
    assert.ok(
      all.result.tasks.every(
        (task: { contextId: string }) => task.contextId === old.result.contextId,
      ),
    );
    // A task belongs to the caller that made it: the person's device token opens none.
    assert.equal(
      (await rpc(travel.id, { token: t.token, method: "GetTask", params: { id: old.result.id } }))
        .status,
      401,
    );
  });

  test("is told what the home does not do in A2A", async () => {
    const code = async (init: Parameters<typeof rpc>[1]) =>
      (await answerOf(await rpc(travel.id, { token, ...init }))).error?.code;
    assert.equal(await code({ method: "GetTask", params: { id: "task-1" } }), -32001);
    assert.equal(await code({ method: "CancelTask", params: { id: "task-1" } }), -32001);
    assert.equal(await code({ method: "CreateTaskPushNotificationConfig" }), -32003);
    assert.equal(
      await code({
        params: {
          message: { messageId: "m", role: "ROLE_USER", parts: [{ text: "Hello" }] },
          configuration: { taskPushNotificationConfig: { url: "https://x.example/hook" } },
        },
      }),
      -32003,
    );
    assert.equal(await code({ method: "GetExtendedAgentCard" }), -32007);
    assert.equal(await code({ method: "tasks/nothing" }), -32601);
    // A method of A2A 1.0 needs the version named: without it a request is A2A 0.3.
    assert.equal(await code({ headers: { "a2a-version": "0.3" } }), -32601);
    assert.equal(await code({ headers: { "a2a-version": "2.0" } }), -32009);
    assert.equal(
      await code({
        params: {
          message: {
            messageId: "m",
            role: "ROLE_USER",
            parts: [{ url: "https://x.example/a.pdf" }],
          },
        },
      }),
      -32005,
    );
    assert.equal(
      await code({ params: { message: { messageId: "m", role: "ROLE_USER", parts: [] } } }),
      -32602,
    );
  });

  test("is refused without a token and with a wrong one", async () => {
    const requests = t.model.requests.length;
    const none = await rpc(travel.id);
    assert.equal(none.status, 401);
    assert.match(none.headers.get("www-authenticate") ?? "", /^Bearer/);
    assert.equal((await answerOf(none)).message, "This Bot Server does not know the sender.");
    assert.equal((await rpc(travel.id, { token: `${token}x` })).status, 401);
    assert.equal((await rpc(travel.id, { token: t.token })).status, 401);
    assert.equal(
      (await rpc(travel.id, { headers: { authorization: `Basic ${token}` } })).status,
      401,
    );
    assert.equal(t.model.requests.length, requests);
  });

  test("is refused once it is shut out", async () => {
    const caller = t.home.peers.outside.callers()[0];
    t.model.script.push(
      { calls: [{ name: "outside_list", arguments: {} }] },
      { calls: [{ name: "outside_shut_out", arguments: { id: caller?.id } }] },
      { text: "It is shut out." },
    );
    await t.say("Shut the booking agent out");
    const told = JSON.stringify(t.model.requests.at(-1)?.messages);
    assert.match(told, new RegExp(`${NAME} \\(${caller?.id}\\) writes to Travel`));
    assert.match(told, /Its access token no longer works/);

    const requests = t.model.requests.length;
    assert.equal((await rpc(travel.id, { token })).status, 401);
    assert.equal(t.model.requests.length, requests);
    assert.equal((await fetch(`${t.url}/a2a/agents/${travel.id}/agent-card.json`)).status, 404);
  });

  test("is never let in to the main agent", async () => {
    const main = t.home.store.mainAgent();
    t.model.script.push(
      { calls: [{ name: "outside_agent_let_in", arguments: { agentId: main.id, name: NAME } }] },
      { text: "That one stays yours." },
    );
    await t.say("Let it talk to you");
    assert.match(JSON.stringify(t.model.requests.at(-1)?.messages), /yours alone/);
    assert.equal(t.home.store.items().length, 0);
  });
});
