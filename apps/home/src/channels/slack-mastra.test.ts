import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Card } from "@wizards-bot/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { testHome, textOf } from "../test/fakes.ts";
import type { ChannelContext, Incoming } from "./channels.ts";
import { slackMastraAdapter } from "./slack-mastra.ts";

const SETTINGS = { appToken: "xapp-1-test", botToken: "xoxb-test" };

interface FakeSlack {
  api: string;
  sockets: WebSocket[];
  calls: { method: string; body: Record<string, string> }[];
  refuse: boolean;
  push(envelope: Record<string, unknown>): void;
  close(): Promise<void>;
}

async function read(request: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of request) parts.push(part as Buffer);
  return Buffer.concat(parts).toString("utf8");
}

/** A local server that speaks enough of Slack for the Chat SDK's adapter: its Web API and a socket. */
async function fakeSlack(): Promise<FakeSlack> {
  const state: FakeSlack = {
    api: "",
    sockets: [],
    calls: [],
    refuse: false,
    push: (envelope) => state.sockets.at(-1)?.send(JSON.stringify(envelope)),
    async close() {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
  const server = createServer(async (request, response) => {
    const raw = await read(request);
    const method = (request.url ?? "").replace(/^\/api\//, "").replace(/\?.*$/, "");
    let body: Record<string, string>;
    try {
      body = JSON.parse(raw);
    } catch {
      body = Object.fromEntries(new URLSearchParams(raw));
    }
    state.calls.push({ method, body });
    const json = (value: unknown) =>
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (state.refuse) return json({ ok: false, error: "invalid_auth" });
    const port = (server.address() as AddressInfo).port;
    if (method === "auth.test")
      return json({ ok: true, user_id: "UBOT", bot_id: "BBOT", team_id: "T1" });
    if (method === "apps.connections.open")
      return json({ ok: true, url: `ws://127.0.0.1:${port}/link` });
    if (method === "users.info")
      return json({ ok: true, user: { id: "U1", name: "ada", real_name: "Ada" } });
    if (method === "chat.postMessage" || method === "chat.update") {
      return json({ ok: true, ts: `170000000${state.calls.length}.000100`, channel: body.channel });
    }
    return json({ ok: true });
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => {
    state.sockets.push(socket);
    socket.send(
      JSON.stringify({ type: "hello", num_connections: 1, connection_info: { app_id: "A1" } }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/`;
  return state;
}

async function until<T>(look: () => T | undefined | false | null, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const found = look();
    if (found) return found;
    if (Date.now() > end) throw new Error("Waited too long.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function listener(): { heard: Incoming[]; context: ChannelContext } {
  const heard: Incoming[] = [];
  return {
    heard,
    context: { receive: (incoming) => heard.push(incoming), publicUrl: undefined, log: () => {} },
  };
}

const message = (event: Record<string, unknown>, id: string) => ({
  envelope_id: id,
  type: "events_api",
  accepts_response_payload: false,
  payload: {
    type: "event_callback",
    team_id: "T1",
    api_app_id: "A1",
    event_id: `Ev${id}`,
    event_time: 1_700_000_001,
    event: { type: "message", event_ts: event.ts, ...event },
  },
});

const card = (patch: Partial<Card> = {}): Card => ({
  id: "crd_1",
  kind: "approval",
  level: "needs_you",
  state: "open",
  title: "Send the invitation?",
  body: "Thursday 15:00",
  actions: [
    { id: "yes", label: "Send", style: "primary" },
    { id: "no", label: "Don't send", style: "plain" },
  ],
  agentId: "agt_1",
  conversationId: "cnv_1",
  messageId: "msg_1",
  createdAt: "2026-11-21T09:00:00.000Z",
  ...patch,
});

test("connects in Socket Mode and hears a direct message, not a channel or itself", async () => {
  const fake = await fakeSlack();
  const { heard, context } = listener();
  const stop = await slackMastraAdapter({ api: fake.api }).start(SETTINGS, context);
  try {
    await until(() => fake.sockets.length);
    assert.ok(fake.calls.some((call) => call.method === "auth.test"));
    assert.ok(fake.calls.some((call) => call.method === "apps.connections.open"));
    fake.push(
      message(
        {
          channel_type: "channel",
          channel: "C1",
          user: "U1",
          text: "in a channel",
          ts: "1700000001.000100",
        },
        "1",
      ),
    );
    fake.push(
      message(
        {
          channel_type: "im",
          channel: "D1",
          user: "UBOT",
          bot_id: "BBOT",
          text: "my own",
          ts: "1700000001.000200",
        },
        "2",
      ),
    );
    fake.push(
      message(
        {
          channel_type: "im",
          channel: "D1",
          user: "U1",
          text: "hello <https://x.example|there>",
          ts: "1700000001.000300",
        },
        "3",
      ),
    );
    await until(() => heard.length);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(heard, [{ from: "U1", peer: "slack:D1:", text: "hello there" }]);
  } finally {
    stop();
    await fake.close();
  }
});

test("sends text, a card with buttons, and a card with fields as text", async () => {
  const fake = await fakeSlack();
  const adapter = slackMastraAdapter({ api: fake.api });
  const stop = await adapter.start(SETTINGS, listener().context);
  try {
    await adapter.send(SETTINGS, "slack:D1:", {
      text: "You are **free** after 14:00.",
      cards: [
        card(),
        card({
          id: "crd_2",
          title: "Key for Notion",
          fields: [{ id: "key", label: "Key", type: "secret" }],
        }),
      ],
    });
    const posts = fake.calls
      .filter((call) => call.method === "chat.postMessage")
      .map((call) => call.body);
    assert.equal(posts.length, 2);
    assert.equal(posts[0]?.channel, "D1");
    const first = JSON.stringify(posts[0]);
    assert.match(first, /free/);
    assert.match(first, /Key for Notion/);
    assert.match(first, /Answer this one in the wizards.bot app\./);
    const blocks = JSON.parse(posts[1]?.blocks ?? "[]") as {
      type: string;
      elements?: { action_id: string; style?: string; text: { text: string } }[];
    }[];
    const buttons = blocks.find((block) => block.type === "actions")?.elements ?? [];
    assert.deepEqual(
      buttons.map((button) => [button.action_id, button.text.text, button.style]),
      [
        ["card:crd_1:yes", "Send", "primary"],
        ["card:crd_1:no", "Don't send", undefined],
      ],
    );
    assert.match(posts[1]?.blocks ?? "", /Send the invitation\?/);
  } finally {
    stop();
    await fake.close();
  }
});

test("a pressed button answers the card and takes the buttons away", async () => {
  const fake = await fakeSlack();
  const { heard, context } = listener();
  const stop = await slackMastraAdapter({ api: fake.api }).start(SETTINGS, context);
  try {
    await until(() => fake.sockets.length);
    fake.push({
      envelope_id: "a1",
      type: "interactive",
      accepts_response_payload: false,
      payload: {
        type: "block_actions",
        team: { id: "T1" },
        user: { id: "U1", username: "ada", name: "ada" },
        api_app_id: "A1",
        trigger_id: "t1",
        container: {
          type: "message",
          message_ts: "1700000002.000100",
          channel_id: "D1",
          is_ephemeral: false,
        },
        channel: { id: "D1", name: "directmessage" },
        message: { ts: "1700000002.000100", type: "message", text: "x" },
        response_url: `${fake.api}respond`,
        actions: [
          {
            action_id: "card:crd_1:yes",
            block_id: "b1",
            value: "Send",
            type: "button",
            action_ts: "1700000003.0",
          },
        ],
      },
    });
    await until(() => heard.length);
    assert.deepEqual(heard, [
      { from: "U1", peer: "slack:D1:", text: "", answer: { cardId: "crd_1", action: "yes" } },
    ]);
    const update = await until(() => fake.calls.find((call) => call.method === "chat.update"));
    assert.equal(update.body.ts, "1700000002.000100");
    assert.match(JSON.stringify(update.body), /You chose “Send”\./);
  } finally {
    stop();
    await fake.close();
  }
});

test("says so plainly when Slack refuses the tokens, and stops listening when stopped", async () => {
  const fake = await fakeSlack();
  fake.refuse = true;
  await assert.rejects(
    slackMastraAdapter({ api: fake.api }).start(SETTINGS, listener().context),
    /Slack did not accept the tokens/,
  );
  fake.refuse = false;
  const adapter = slackMastraAdapter({ api: fake.api });
  const stop = await adapter.start(SETTINGS, listener().context);
  const socket = await until(() => fake.sockets.at(-1));
  stop();
  await until(() => socket.readyState === socket.CLOSED);
  await assert.rejects(
    adapter.send(SETTINGS, "slack:D1:", { text: "x", cards: [] }),
    /Slack is not connected/,
  );
  await fake.close();
});

test("a whole home: set up by a card, claimed by the person, then one conversation with the app", async () => {
  const fake = await fakeSlack();
  const t = await testHome("Ada", [slackMastraAdapter({ api: fake.api })]);
  const dm = (user: string, text: string, n: number) =>
    fake.push(
      message(
        {
          channel_type: "im",
          channel: user === "U1" ? "D1" : "D9",
          user,
          text,
          ts: `170000001${n}.000100`,
        },
        `m${n}`,
      ),
    );
  const posted = () =>
    fake.calls
      .filter((call) => call.method === "chat.postMessage")
      .map((call) => JSON.stringify(call.body));
  try {
    t.model.script.push(
      { calls: [{ name: "channel_connect", arguments: { channel: "slack" } }] },
      { text: "The card is there." },
    );
    await t.say("Connect Slack");
    const setup = t.item();
    assert.equal(setup.kind, "secret");
    assert.deepEqual(
      setup.fields?.map((field) => [field.id, field.type]),
      [
        ["appToken", "secret"],
        ["botToken", "secret"],
      ],
    );

    t.model.script.push({ text: "Send me the claim words on Slack." });
    await t.answer(setup.id, "save", SETTINGS);
    await until(() => fake.sockets.length);
    const code = t.home.db.meta("channel.slack.claim") as string;
    assert.match(code, /^\d{4}$/);
    assert.ok(!JSON.stringify(t.model.requests).includes(SETTINGS.botToken));

    dm("U2", `claim 0000`, 1);
    dm("U1", `claim ${code}`, 2);
    await until(() => posted().some((post) => post.includes("From now on I hear only you here.")));
    assert.equal(t.home.channels.owner("slack"), "U1");

    t.model.script.push({ text: "Hello Ada, from Slack." });
    dm("U2", "let me in", 3);
    dm("U1", "Hello from Slack", 4);
    await until(() => posted().some((post) => post.includes("Hello Ada, from Slack.")));
    const conversationId = t.home.store.mainAgent().conversationId;
    const last = t.home.store.messages(conversationId, { limit: 2 }).messages;
    assert.deepEqual(
      last.map((entry) => [entry.role, entry.channel, textOf(entry)]),
      [
        ["you", "slack", "Hello from Slack"],
        ["agent", "slack", "Hello Ada, from Slack."],
      ],
    );
    assert.ok(!JSON.stringify(t.model.requests).includes("let me in"));
  } finally {
    t.stop();
    await fake.close();
  }
});
