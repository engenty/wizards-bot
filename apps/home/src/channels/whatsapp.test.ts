import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Card } from "@wizards-bot/protocol";
import { Hono } from "hono";
import type { ChannelContext, ChannelId, Channels, Incoming } from "./channels.ts";
import { whatsapp, whatsappAdapter } from "./whatsapp.ts";

const SETTINGS = {
  phoneNumberId: "106540352242922",
  accessToken: "token-for-tests",
  appSecret: "secret-for-tests",
  verifyToken: "heron",
};
const WEBHOOK = "/channels/whatsapp/webhook";

/** A home with the webhook routes and a stand-in for its channels. `null`: WhatsApp is not set up. */
function home(settings: Record<string, string> | null = SETTINGS) {
  const received: Incoming[] = [];
  const channels = {
    settings: (id: ChannelId) => (id === "whatsapp" ? (settings ?? undefined) : undefined),
    receive: (id: ChannelId, incoming: Incoming) => {
      assert.equal(id, "whatsapp");
      received.push(incoming);
    },
  } as unknown as Channels;
  const app = new Hono();
  whatsappAdapter().routes?.(app, channels);
  const deliver = (body: string, signature = sign(body)) =>
    app.request(WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature },
      body,
    });
  return { app, received, deliver };
}

const sign = (body: string, secret = SETTINGS.appSecret): string =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

/** A notification as Meta posts it, with these messages for the agent's number. */
const notification = (
  messages: Record<string, unknown>[],
  phoneNumberId = SETTINGS.phoneNumberId,
): string =>
  JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "102290129340398",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550783881", phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: "Mara" }, wa_id: "491701234567" }],
              messages,
            },
          },
        ],
      },
    ],
  });

const text = (id: string, body: string) => ({
  from: "491701234567",
  id,
  timestamp: "1794650000",
  type: "text",
  text: { body },
});

/** A message as the adapter posts it to the Graph API. */
interface Sent {
  to?: string;
  recipient?: string;
  type?: string;
  text?: { body: string };
  interactive?: {
    body: { text: string };
    action: { buttons: { reply: { id: string; title: string } }[] };
  };
}

/** A local server in place of the Graph API. */
async function fakeGraph() {
  const state = {
    graph: "",
    calls: [] as {
      method: string;
      url: string;
      token: string;
      body: Sent | undefined;
    }[],
    /** The error Meta answers with, when set. */
    error: undefined as string | undefined,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
  const server = createServer(async (request, response) => {
    const body = await read(request);
    state.calls.push({
      method: request.method ?? "",
      url: request.url ?? "",
      token: request.headers.authorization ?? "",
      body: body ? JSON.parse(body) : undefined,
    });
    if (state.error) {
      response.writeHead(400, { "content-type": "application/json" });
      return void response.end(
        JSON.stringify({ error: { message: state.error, type: "OAuthException", code: 190 } }),
      );
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: "wamid.out" }] }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.graph = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}

async function read(request: IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of request) parts.push(part as Buffer);
  return Buffer.concat(parts).toString("utf8");
}

const card = (over: Partial<Card> = {}): Card => ({
  id: "crd_1",
  kind: "approval",
  level: "needs_you",
  state: "open",
  title: "Send the mail to Anna?",
  body: "It has two attachments.",
  actions: [
    { id: "send", label: "Send", style: "primary" },
    { id: "cancel", label: "Not now, I read it first", style: "plain" },
  ],
  agentId: "agt_1",
  conversationId: "cnv_1",
  messageId: "msg_1",
  createdAt: "2026-11-21T10:00:00.000Z",
  ...over,
});

const context = (publicUrl: string | undefined): ChannelContext => ({
  receive: () => {},
  publicUrl,
  log: () => {},
});

test("Meta's check of the address gets the challenge back", async () => {
  const { app } = home();
  const good = await app.request(
    `${WEBHOOK}?hub.mode=subscribe&hub.verify_token=heron&hub.challenge=1158201444`,
  );
  assert.equal(good.status, 200);
  assert.equal(await good.text(), "1158201444");

  const wrong = await app.request(
    `${WEBHOOK}?hub.mode=subscribe&hub.verify_token=stork&hub.challenge=1158201444`,
  );
  assert.equal(wrong.status, 403);
  assert.notEqual(await wrong.text(), "1158201444");

  const missing = await app.request(`${WEBHOOK}?hub.mode=subscribe&hub.challenge=1158201444`);
  assert.equal(missing.status, 403);

  // Before the channel is set up there is no token to match.
  const empty = home(null);
  for (const token of ["", "heron", "undefined"]) {
    const early = await empty.app.request(
      `${WEBHOOK}?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=1`,
    );
    assert.equal(early.status, 403);
  }
});

test("a signed text message reaches the home", async () => {
  const { received, deliver } = home();
  const response = await deliver(notification([text("wamid.1", "claim 4821 – grüße")]));
  assert.equal(response.status, 200);
  assert.deepEqual(received, [{ from: "491701234567", text: "claim 4821 – grüße" }]);
});

test("a message with a wrong or missing signature is refused", async () => {
  const { app, received, deliver } = home();
  const body = notification([text("wamid.1", "hello")]);

  assert.equal((await deliver(body, sign(body, "another-secret"))).status, 401);
  assert.equal((await deliver(body, sign(`${body} `))).status, 401);
  assert.equal((await deliver(body, "sha256=")).status, 401);
  assert.equal((await deliver(body, sign(body).replace("sha256=", "sha1="))).status, 401);
  const unsigned = await app.request(WEBHOOK, { method: "POST", body });
  assert.equal(unsigned.status, 401);
  assert.deepEqual(received, []);

  // Without settings nobody can sign, so nothing is let in.
  const empty = home(null);
  assert.equal((await empty.deliver(body)).status, 401);
  assert.deepEqual(empty.received, []);
});

test("a pressed reply button answers its card", async () => {
  const { received, deliver } = home();
  const pressed = {
    from: "491701234567",
    id: "wamid.2",
    timestamp: "1794650001",
    type: "interactive",
    interactive: { type: "button_reply", button_reply: { id: "card:crd_1:send", title: "Send" } },
  };
  assert.equal((await deliver(notification([pressed]))).status, 200);
  assert.deepEqual(received, [
    { from: "491701234567", text: "", answer: { cardId: "crd_1", action: "send" } },
  ]);
});

test("what is not a text or a button for this number is dropped", async () => {
  const { received, deliver } = home();
  const picture = { from: "491701234567", id: "wamid.3", type: "image", image: { id: "1" } };
  const list = {
    from: "491701234567",
    id: "wamid.4",
    type: "interactive",
    interactive: { type: "list_reply", list_reply: { id: "card:crd_1:send", title: "Send" } },
  };
  const foreign = {
    from: "491701234567",
    id: "wamid.5",
    type: "interactive",
    interactive: { type: "button_reply", button_reply: { id: "something-else", title: "Yes" } },
  };
  assert.equal((await deliver(notification([picture, list, foreign]))).status, 200);
  // A message for another number of the same Meta app.
  assert.equal((await deliver(notification([text("wamid.6", "hello")], "999"))).status, 200);
  // A delivery report has no messages.
  const statuses = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          { field: "messages", value: { statuses: [{ id: "wamid.out", status: "read" }] } },
        ],
      },
    ],
  });
  assert.equal((await deliver(statuses)).status, 200);
  assert.equal((await deliver("not json")).status, 400);
  assert.deepEqual(received, []);
});

test("a message Meta delivers twice is heard once", async () => {
  const { received, deliver } = home();
  const body = notification([text("wamid.7", "book the table")]);
  assert.equal((await deliver(body)).status, 200);
  assert.equal((await deliver(body)).status, 200);
  assert.equal(received.length, 1);
});

test("a person without a visible number is heard by their user id", async () => {
  const { received, deliver } = home();
  const message = {
    from_user_id: "DE.13491208655302741918",
    id: "wamid.8",
    type: "text",
    text: { body: "hello" },
  };
  await deliver(notification([message]));
  assert.deepEqual(received, [{ from: "DE.13491208655302741918", text: "hello" }]);
});

test("a text goes out through the Graph API", async () => {
  const fake = await fakeGraph();
  try {
    const adapter = whatsappAdapter({ graph: fake.graph });
    await adapter.send(SETTINGS, "491701234567", { text: "The table is booked.", cards: [] });
    assert.deepEqual(
      [...fake.calls],
      [
        {
          method: "POST",
          url: "/v27.0/106540352242922/messages",
          token: "Bearer token-for-tests",
          body: {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: "+491701234567",
            type: "text",
            text: { body: "The table is booked." },
          },
        },
      ],
    );

    await adapter.send(SETTINGS, "DE.13491208655302741918", { text: "Hello.", cards: [] });
    assert.equal(fake.calls[1]?.body?.recipient, "DE.13491208655302741918");
    assert.equal("to" in (fake.calls[1]?.body ?? {}), false);

    // A text longer than WhatsApp takes goes out in pieces.
    fake.calls.length = 0;
    await adapter.send(SETTINGS, "491701234567", {
      text: `${"a".repeat(4000)}\n${"b".repeat(4000)}`,
      cards: [],
    });
    assert.deepEqual(
      fake.calls.map((call) => call.body?.text?.body.length),
      [4000, 4000],
    );
  } finally {
    await fake.close();
  }
});

test("one card with up to three actions goes out with reply buttons", async () => {
  const fake = await fakeGraph();
  try {
    const adapter = whatsappAdapter({ graph: fake.graph });
    await adapter.send(SETTINGS, "491701234567", { text: "I wrote the draft.", cards: [card()] });
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(fake.calls[0]?.body, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "+491701234567",
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: "I wrote the draft.\n\nSend the mail to Anna?\n\nIt has two attachments." },
        action: {
          buttons: [
            { type: "reply", reply: { id: "card:crd_1:send", title: "Send" } },
            { type: "reply", reply: { id: "card:crd_1:cancel", title: "Not now, I read it…" } },
          ],
        },
      },
    });
    const buttons = fake.calls[0]?.body?.interactive?.action.buttons ?? [];
    assert.ok(buttons.every((button) => button.reply.title.length <= 20));

    // A text too long to stand above buttons goes ahead of the card.
    fake.calls.length = 0;
    await adapter.send(SETTINGS, "491701234567", { text: "x".repeat(1500), cards: [card()] });
    assert.deepEqual(
      fake.calls.map((call) => call.body?.type),
      ["text", "interactive"],
    );
    assert.equal(
      fake.calls[1]?.body?.interactive?.body.text,
      "Send the mail to Anna?\n\nIt has two attachments.",
    );
  } finally {
    await fake.close();
  }
});

test("other cards go out as text", async () => {
  const fake = await fakeGraph();
  try {
    const adapter = whatsappAdapter({ graph: fake.graph });
    const four = card({
      actions: ["One", "Two", "Three", "Four"].map((label) => ({
        id: label.toLowerCase(),
        label,
        style: "plain",
      })),
    });
    const fields = card({ fields: [{ id: "key", label: "API key", type: "secret" }] });
    const alike = card({
      actions: [
        { id: "a", label: "Send it to Anna and Ben now", style: "plain" },
        { id: "b", label: "Send it to Anna and Ben later", style: "plain" },
      ],
    });
    await adapter.send(SETTINGS, "491701234567", { text: "", cards: [four] });
    await adapter.send(SETTINGS, "491701234567", { text: "", cards: [fields] });
    await adapter.send(SETTINGS, "491701234567", { text: "", cards: [alike] });
    await adapter.send(SETTINGS, "491701234567", {
      text: "Two things.",
      cards: [card(), card({ id: "crd_2" })],
    });

    const bodies = fake.calls.map((call) => call.body?.text?.body);
    assert.equal(
      bodies[0],
      "Send the mail to Anna?\nIt has two attachments.\n1: One   2: Two   3: Three   4: Four\nReply with the number.",
    );
    assert.equal(
      bodies[1],
      "Send the mail to Anna?\nIt has two attachments.\nAnswer this one in the wizards.bot app.",
    );
    assert.match(bodies[2] ?? "", /Reply with the number\.$/);
    assert.match(bodies[3] ?? "", /^Two things\.\n\nSend the mail to Anna\?/);
    assert.ok(fake.calls.every((call) => call.body?.type === "text"));
  } finally {
    await fake.close();
  }
});

test("start checks the values with Meta and says what is wrong", async () => {
  const fake = await fakeGraph();
  try {
    const adapter = whatsappAdapter({ graph: fake.graph });
    const stop = await adapter.start(SETTINGS, context("https://home.example.com"));
    stop();
    assert.deepEqual(fake.calls[0], {
      method: "GET",
      url: "/v27.0/106540352242922?fields=display_phone_number",
      token: "Bearer token-for-tests",
      body: undefined,
    });

    await assert.rejects(adapter.start(SETTINGS, context(undefined)), {
      message: "Meta has to reach your Bot Server, and your Bot Server has no public address yet",
    });
    await assert.rejects(
      adapter.start({ ...SETTINGS, appSecret: "" }, context("https://home.example.com")),
      {
        message: "The app secret is missing",
      },
    );

    fake.error = "Error validating access token: Session has expired.";
    await assert.rejects(adapter.start(SETTINGS, context("https://home.example.com")), {
      message:
        "Meta did not accept the phone number ID and the access token: Error validating access token: Session has expired.",
    });
    await assert.rejects(adapter.send(SETTINGS, "491701234567", { text: "Hello.", cards: [] }), {
      message: "Error validating access token: Session has expired.",
    });
  } finally {
    await fake.close();
  }
});

test("the setup names the webhook address and asks for the four values", () => {
  assert.match(whatsapp.setup.body, /`\{home\}\/channels\/whatsapp\/webhook`/);
  assert.deepEqual(
    whatsapp.setup.fields.map((field) => [field.id, field.type]),
    [
      ["phoneNumberId", "text"],
      ["accessToken", "secret"],
      ["appSecret", "secret"],
      ["verifyToken", "text"],
    ],
  );
});
