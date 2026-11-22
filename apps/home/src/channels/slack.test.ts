import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Card } from "@wizards-bot/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import type { ChannelContext, Incoming } from "./channels.ts";
import { mrkdwn, plainText, slack, slackAdapter } from "./slack.ts";

const SETTINGS = { appToken: "xapp-1-test", botToken: "xoxb-test" };

interface Call {
  method: string;
  token: string;
  body: string;
}

interface FakeSlack {
  api: string;
  /** The sockets the adapter opened, oldest first. */
  sockets: WebSocket[];
  acks: string[];
  calls: Call[];
  posts: Record<string, unknown>[];
  responses: Record<string, unknown>[];
  /** Methods that answer `invalid_auth`. */
  refused: Set<string>;
  /** The whole API answers 503. */
  down: boolean;
  /** Sends an envelope through the newest socket. */
  push(envelope: Record<string, unknown>): void;
  close(): Promise<void>;
}

/** A local server that speaks enough of Slack: the Web API methods the adapter calls and a socket. */
async function fakeSlack(): Promise<FakeSlack> {
  const state: FakeSlack = {
    api: "",
    sockets: [],
    acks: [],
    calls: [],
    posts: [],
    responses: [],
    refused: new Set(),
    down: false,
    push(envelope) {
      state.sockets.at(-1)?.send(JSON.stringify(envelope));
    },
    async close() {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
  const server = createServer(async (request, response) => {
    const body = await read(request);
    const method = (request.url ?? "").replace("/api/", "");
    const json = (value: unknown): void => {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
    };
    // Where the adapter answers a pressed button. Slack hands this address out per press.
    if (request.url === "/respond") {
      state.responses.push(JSON.parse(body));
      return json({ ok: true });
    }
    state.calls.push({ method, token: request.headers.authorization ?? "", body });
    if (state.down) return void response.writeHead(503).end();
    if (state.refused.has(method)) return json({ ok: false, error: "invalid_auth" });
    if (method === "auth.test") return json({ ok: true, user_id: "UBOT", bot_id: "BBOT" });
    if (method === "apps.connections.open") {
      const ticket = state.calls.filter((call) => call.method === method).length;
      return json({
        ok: true,
        url: `${state.api.replace("http", "ws").replace("/api", "")}/link?ticket=${ticket}`,
      });
    }
    if (method === "chat.postMessage") {
      state.posts.push(JSON.parse(body));
      return json({ ok: true, ts: "1700000000.000100" });
    }
    response.writeHead(404).end();
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => {
    state.sockets.push(socket);
    socket.on("message", (data) => state.acks.push(JSON.parse(data.toString()).envelope_id));
    socket.send(
      JSON.stringify({ type: "hello", num_connections: 1, connection_info: { app_id: "A1" } }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.api = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  return state;
}

async function read(request: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of request) parts.push(part as Buffer);
  return Buffer.concat(parts).toString("utf8");
}

/** Waits until `look` finds something. */
async function until<T>(look: () => T | undefined | false | null, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const found = look();
    if (found) return found;
    if (Date.now() > end) throw new Error("Waited too long.");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function listener(): { context: ChannelContext; received: Incoming[]; logs: string[] } {
  const received: Incoming[] = [];
  const logs: string[] = [];
  const context = {
    receive: (incoming: Incoming) => received.push(incoming),
    publicUrl: undefined,
    log: (line: string) => logs.push(line),
  };
  return { context, received, logs };
}

const message = (id: string, event: Record<string, unknown>) => ({
  type: "events_api",
  envelope_id: id,
  accepts_response_payload: false,
  payload: { type: "event_callback", event: { type: "message", ts: "1.1", ...event } },
});

const card = (over: Partial<Card> = {}): Card => ({
  id: "crd_1",
  kind: "approval",
  level: "needs_you",
  state: "open",
  title: "Send the mail to Anna?",
  body: "It has **two** attachments.",
  actions: [
    { id: "send", label: "Send", style: "primary" },
    { id: "cancel", label: "Not now", style: "plain" },
  ],
  agentId: "agt_1",
  conversationId: "cnv_1",
  messageId: "msg_1",
  createdAt: "2026-11-21T10:00:00.000Z",
  ...over,
});

test("a direct message reaches the home and Slack gets its acknowledgement", async () => {
  const fake = await fakeSlack();
  const { context, received } = listener();
  const stop = await slackAdapter({ api: fake.api }).start(SETTINGS, context);
  try {
    assert.equal(fake.sockets.length, 1);
    assert.deepEqual(
      fake.calls.map((call) => [call.method, call.token]),
      [
        ["auth.test", "Bearer xoxb-test"],
        ["apps.connections.open", "Bearer xapp-1-test"],
      ],
    );

    fake.push(
      message("e1", {
        channel_type: "im",
        channel: "D1",
        user: "U1",
        text: "claim 4821 &amp; see <https://example.com/a?b=1|example.com> &lt;now&gt;",
      }),
    );
    await until(() => received.length === 1);
    assert.deepEqual(received[0], {
      from: "U1",
      peer: "D1",
      text: "claim 4821 & see https://example.com/a?b=1 <now>",
    });

    // What is not a person's direct message is acknowledged and dropped.
    fake.push(
      message("e2", { channel_type: "im", channel: "D1", bot_id: "BBOT", text: "from an app" }),
    );
    fake.push(
      message("e3", { channel_type: "im", channel: "D1", user: "UBOT", text: "from the agent" }),
    );
    fake.push(
      message("e4", { channel_type: "im", channel: "D1", user: "U1", subtype: "message_changed" }),
    );
    fake.push(
      message("e5", { channel_type: "channel", channel: "C1", user: "U1", text: "in a channel" }),
    );
    await until(() => fake.acks.length === 5);
    assert.deepEqual(fake.acks, ["e1", "e2", "e3", "e4", "e5"]);
    assert.equal(received.length, 1);
  } finally {
    stop();
  }

  // After the stop the socket is closed and stays closed.
  const socket = fake.sockets[0] as WebSocket;
  await until(() => socket.readyState === socket.CLOSED);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fake.sockets.length, 1);
  await fake.close();
});

test("a card goes out with buttons, and a pressed button answers it", async () => {
  const fake = await fakeSlack();
  const { context, received } = listener();
  const adapter = slackAdapter({ api: fake.api });
  const stop = await adapter.start(SETTINGS, context);
  try {
    await adapter.send(SETTINGS, "D1", { text: "I wrote the **draft**.", cards: [card()] });
    const post = fake.posts[0] as {
      channel: string;
      text: string;
      blocks: Record<string, unknown>[];
    };
    assert.equal(post.channel, "D1");
    assert.match(post.text, /^I wrote the \*draft\*\./);
    assert.deepEqual(post.blocks, [
      { type: "section", text: { type: "mrkdwn", text: "I wrote the *draft*." } },
      {
        type: "section",
        text: { type: "mrkdwn", text: "*Send the mail to Anna?*\nIt has *two* attachments." },
      },
      {
        type: "actions",
        block_id: "card:crd_1",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Send" },
            action_id: "card:crd_1:send",
            value: "send",
            style: "primary",
          },
          {
            type: "button",
            text: { type: "plain_text", text: "Not now" },
            action_id: "card:crd_1:cancel",
            value: "cancel",
          },
        ],
      },
    ]);

    fake.push({
      type: "interactive",
      envelope_id: "i1",
      accepts_response_payload: true,
      payload: {
        type: "block_actions",
        user: { id: "U1" },
        channel: { id: "D1" },
        response_url: fake.api.replace("/api", "/respond"),
        message: { text: post.text, blocks: post.blocks },
        actions: [
          {
            type: "button",
            action_id: "card:crd_1:send",
            block_id: "card:crd_1",
            value: "send",
            text: { type: "plain_text", text: "Send" },
          },
        ],
      },
    });
    await until(() => received.length === 1);
    assert.deepEqual(received[0], {
      from: "U1",
      peer: "D1",
      text: "",
      answer: { cardId: "crd_1", action: "send" },
    });
    await until(() => fake.acks.length === 1);
    assert.deepEqual(fake.acks, ["i1"]);

    // The message keeps its text and shows the choice where the buttons were.
    const response = (await until(() => fake.responses[0])) as {
      replace_original: string;
      blocks: unknown[];
    };
    assert.equal(response.replace_original, "true");
    assert.deepEqual(response.blocks, [
      post.blocks[0],
      post.blocks[1],
      { type: "context", elements: [{ type: "mrkdwn", text: "You chose “Send”." }] },
    ]);
  } finally {
    stop();
    await fake.close();
  }
});

test("a message without button cards is plain text", async () => {
  const fake = await fakeSlack();
  try {
    const adapter = slackAdapter({ api: fake.api });
    await adapter.send(SETTINGS, "D1", { text: "Done.", cards: [] });
    assert.deepEqual(fake.posts[0], { channel: "D1", text: "Done." });
    assert.equal(fake.calls[0]?.token, "Bearer xoxb-test");

    // A card with fields has no buttons in Slack. The text sends the person to the app.
    const fields = card({ fields: [{ id: "key", label: "API key", type: "secret" }] });
    await adapter.send(SETTINGS, "D1", { text: "", cards: [fields] });
    assert.deepEqual(fake.posts[1], {
      channel: "D1",
      text: "Send the mail to Anna?\nIt has *two* attachments.\nAnswer this one in the wizards.bot app.",
    });

    // Beside a card with buttons it becomes a section of its own.
    await adapter.send(SETTINGS, "D1", { text: "", cards: [fields, card({ id: "crd_2" })] });
    const post = fake.posts[2] as { blocks: { type: string; block_id?: string }[] };
    assert.deepEqual(
      post.blocks.map((block) => block.type),
      ["section", "section", "actions"],
    );
    assert.equal(post.blocks[2]?.block_id, "card:crd_2");
  } finally {
    await fake.close();
  }
});

test("the home follows Slack to a new socket", async () => {
  const fake = await fakeSlack();
  const { context, received } = listener();
  const stop = await slackAdapter({ api: fake.api, retry: 10 }).start(SETTINGS, context);
  try {
    const first = fake.sockets[0] as WebSocket;
    fake.push({
      type: "disconnect",
      reason: "refresh_requested",
      debug_info: { host: "wss-111.slack.com" },
    });
    await until(() => fake.sockets.length === 2);
    // The old socket is closed by the home once the new one is ready.
    await until(() => first.readyState === first.CLOSED);

    fake.push(
      message("e1", { channel_type: "im", channel: "D1", user: "U1", text: "still there?" }),
    );
    await until(() => received.length === 1);
    assert.equal(received[0]?.text, "still there?");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fake.sockets.length, 2);
  } finally {
    stop();
    await fake.close();
  }
});

test("a lost connection comes back, also when Slack is out of reach for a while", async () => {
  const fake = await fakeSlack();
  const { context, received, logs } = listener();
  const stop = await slackAdapter({ api: fake.api, retry: 10 }).start(SETTINGS, context);
  try {
    fake.down = true;
    fake.sockets[0]?.terminate();
    await until(() => logs.filter((line) => line.startsWith("Slack is out of reach")).length >= 2);
    assert.equal(fake.sockets.length, 1);

    fake.down = false;
    await until(() => fake.sockets.length === 2);
    fake.push(message("e1", { channel_type: "im", channel: "D1", user: "U1", text: "back" }));
    await until(() => received.length === 1);
    await until(() => fake.acks.length === 1);
    assert.deepEqual(fake.acks, ["e1"]);
  } finally {
    stop();
    await fake.close();
  }
});

test("start says in plain words which token does not work", async () => {
  const fake = await fakeSlack();
  const { context } = listener();
  const adapter = slackAdapter({ api: fake.api });
  try {
    await assert.rejects(
      adapter.start({ appToken: "xoxb-mixed-up", botToken: "xoxb-test" }, context),
      {
        message: "The app-level token starts with xapp-. Copy it again from “Basic Information”",
      },
    );
    await assert.rejects(adapter.start({ appToken: "xapp-1-test", botToken: "" }, context), {
      message: "The bot token starts with xoxb-. Copy it again from “Install App”",
    });
    assert.equal(fake.calls.length, 0);

    fake.refused.add("auth.test");
    await assert.rejects(adapter.start(SETTINGS, context), {
      message: "Slack did not accept the bot token: invalid_auth",
    });

    fake.refused.clear();
    fake.refused.add("apps.connections.open");
    await assert.rejects(adapter.start(SETTINGS, context), {
      message: "Slack did not open a connection for the app-level token: invalid_auth",
    });
    assert.equal(fake.sockets.length, 0);
  } finally {
    await fake.close();
  }
});

test("the setup carries a manifest with everything the adapter uses", () => {
  const manifest = /```json\n([\s\S]+?)\n```/.exec(slack.setup.body)?.[1];
  assert.ok(manifest);
  const parsed = JSON.parse(manifest);
  assert.equal(parsed.settings.socket_mode_enabled, true);
  assert.equal(parsed.settings.interactivity.is_enabled, true);
  assert.deepEqual(parsed.settings.event_subscriptions.bot_events, ["message.im"]);
  assert.deepEqual(parsed.oauth_config.scopes.bot, [
    "chat:write",
    "im:history",
    "im:read",
    "im:write",
  ]);
  assert.equal(parsed.features.app_home.messages_tab_enabled, true);
  assert.deepEqual(
    slack.setup.fields.map((field) => [field.id, field.type]),
    [
      ["appToken", "secret"],
      ["botToken", "secret"],
    ],
  );
});

test("Markdown becomes Slack's markup", () => {
  assert.equal(mrkdwn("**bold** and *italic* and ~~gone~~"), "*bold* and _italic_ and ~gone~");
  assert.equal(mrkdwn("# Plan for **today**\n\n- one\n* two"), "*Plan for today*\n\n• one\n• two");
  assert.equal(
    mrkdwn("See [the page](https://example.com/?a=1&b=2)."),
    "See <https://example.com/?a=1&amp;b=2|the page>.",
  );
  assert.equal(mrkdwn("a < b & b > c\n> quoted"), "a &lt; b &amp; b &gt; c\n> quoted");
  assert.equal(
    mrkdwn("run `ls **/*.ts` or\n```\nif (a < b) **c**\n```"),
    "run `ls **/*.ts` or\n```\nif (a &lt; b) **c**\n```",
  );
});

test("a message from Slack reads as the person typed it", () => {
  assert.equal(
    plainText("mail <mailto:anna@example.com|anna@example.com>"),
    "mail anna@example.com",
  );
  assert.equal(plainText("open <https://example.com>"), "open https://example.com");
  assert.equal(plainText("1 &lt; 2 &amp;&amp; 3 &gt; 2"), "1 < 2 && 3 > 2");
  assert.equal(plainText("ask <@U123>"), "ask <@U123>");
});
