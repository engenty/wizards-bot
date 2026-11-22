import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { Card } from "@wizards-bot/protocol";
import type { ChannelContext, Incoming } from "./channels.ts";
import { signal, signalAdapter } from "./signal.ts";

const NUMBER = "+491701234567";

/** A local server in place of the signal-cli daemon: its check, its event stream and its JSON-RPC. */
async function fakeDaemon() {
  let sequence = 0;
  const state = {
    url: "",
    /** The open event streams, oldest first. */
    streams: [] as ServerResponse[],
    /** The `account` and `Last-Event-ID` each stream asked with. */
    asked: [] as { account: string | null; last: string | undefined }[],
    rpc: [] as { jsonrpc: string; id: string; method: string; params: Record<string, unknown> }[],
    /** The numbers the daemon holds. */
    accounts: new Set([NUMBER]),
    /** The error the next sends answer with. */
    error: undefined as string | undefined,
    /** Writes one event, as signal-cli does, to the newest stream. */
    push(envelope: Record<string, unknown>): void {
      const data = JSON.stringify({ account: NUMBER, envelope });
      state.streams
        .at(-1)
        ?.write(`id:1794650000000-${++sequence}\nevent:receive\ndata:${data}\n\n`);
    },
    write(raw: string): void {
      state.streams.at(-1)?.write(raw);
    },
    /** Ends the newest stream, as a restart of signal-cli does. */
    drop(): void {
      state.streams.at(-1)?.destroy();
    },
    async close(): Promise<void> {
      for (const stream of state.streams) stream.destroy();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "", "http://localhost");
    if (url.pathname === "/api/v1/check") return void response.writeHead(200).end();
    if (url.pathname === "/api/v1/events") {
      const account = url.searchParams.get("account");
      state.asked.push({ account, last: request.headers["last-event-id"] as string | undefined });
      if (!account || !state.accounts.has(account)) return void response.writeHead(400).end();
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(":\n");
      state.streams.push(response);
      return;
    }
    if (url.pathname === "/api/v1/rpc" && request.method === "POST") {
      const call = JSON.parse(await read(request));
      state.rpc.push(call);
      const answer = state.error
        ? { jsonrpc: "2.0", id: call.id, error: { code: -32603, message: state.error } }
        : {
            jsonrpc: "2.0",
            id: call.id,
            result: { timestamp: 1794650000000, results: [{ type: "SUCCESS" }] },
          };
      return void response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify(answer));
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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

/** An envelope as signal-cli writes it for a text from a person. */
const from = (
  sourceNumber: string | null,
  message: string | null,
  more: Record<string, unknown> = {},
) => ({
  source: sourceNumber,
  sourceNumber,
  sourceUuid: "0a4c7f1e-6f3b-4c55-9d5e-3f1c2a7b8d90",
  sourceName: "Mara",
  sourceDevice: 1,
  timestamp: 1794650000000,
  dataMessage: { timestamp: 1794650000000, message, expiresInSeconds: 0, viewOnce: false, ...more },
});

test("a text from a person reaches the home", async () => {
  const fake = await fakeDaemon();
  const { context, received } = listener();
  const stop = await signalAdapter().start(
    { url: `${fake.url}/`, number: "+49 170 1234567" },
    context,
  );
  try {
    assert.deepEqual(fake.asked, [{ account: NUMBER, last: undefined }]);

    fake.push(from("+33123456789", "claim 4821"));
    await until(() => received.length === 1);
    assert.deepEqual(received[0], { from: "+33123456789", text: "claim 4821" });

    // An event may arrive in pieces, and a line with only a colon keeps the stream alive.
    const data = JSON.stringify({ account: NUMBER, envelope: from("+33123456789", "two\nlines") });
    fake.write(`:\nid:1794650000000-90\r\nevent:receive\r\ndata: ${data.slice(0, 40)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(received.length, 1);
    fake.write(`${data.slice(40)}\r\n\r\n`);
    await until(() => received.length === 2);
    assert.equal(received[1]?.text, "two\nlines");
  } finally {
    stop();
    await fake.close();
  }
});

test("what is not a text of a person to the agent is dropped", async () => {
  const fake = await fakeDaemon();
  const { context, received } = listener();
  const stop = await signalAdapter().start({ url: fake.url, number: NUMBER }, context);
  try {
    const base = from("+33123456789", null);
    fake.push({
      ...base,
      dataMessage: undefined,
      receiptMessage: { when: 1, isDelivery: true, timestamps: [1] },
    });
    fake.push({
      ...base,
      dataMessage: undefined,
      typingMessage: { action: "STARTED", timestamp: 1 },
    });
    // What the agent's own devices sent.
    fake.push({
      ...from(NUMBER, null),
      dataMessage: undefined,
      syncMessage: {
        sentMessage: { destinationNumber: "+33123456789", message: "from the agent" },
      },
    });
    fake.push(from(NUMBER, "a note to itself"));
    // A picture without words, and a text in a group.
    fake.push(from("+33123456789", null, { attachments: [{ contentType: "image/jpeg" }] }));
    fake.push(
      from("+33123456789", "to everyone", {
        groupInfo: { groupId: "Pmpi+EfPWms=", type: "DELIVER" },
      }),
    );
    fake.write("data:not json\n\n");
    fake.push(from("+33123456789", "the last one"));
    await until(() => received.length > 0);
    assert.deepEqual(received, [{ from: "+33123456789", text: "the last one" }]);

    // Someone who does not show their number is known by their account id.
    fake.push(from(null, "hello"));
    await until(() => received.length === 2);
    assert.deepEqual(received[1], { from: "0a4c7f1e-6f3b-4c55-9d5e-3f1c2a7b8d90", text: "hello" });
  } finally {
    stop();
    await fake.close();
  }
});

test("a lost stream comes back and asks for what it missed", async () => {
  const fake = await fakeDaemon();
  const { context, received } = listener();
  const stop = await signalAdapter({ retry: 10 }).start({ url: fake.url, number: NUMBER }, context);
  try {
    fake.push(from("+33123456789", "one"));
    await until(() => received.length === 1);

    fake.drop();
    await until(() => fake.streams.length === 2);
    assert.deepEqual(fake.asked[1], { account: NUMBER, last: "1794650000000-1" });
    fake.push(from("+33123456789", "two"));
    await until(() => received.length === 2);
    assert.equal(received[1]?.text, "two");
  } finally {
    stop();
  }

  // After the stop the home leaves the stream and does not come back.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fake.streams.length, 2);
  assert.ok(fake.streams[1]?.destroyed);
  await fake.close();
});

test("the home keeps trying while signal-cli is away", async () => {
  const fake = await fakeDaemon();
  const { context, received, logs } = listener();
  const stop = await signalAdapter({ retry: 10 }).start({ url: fake.url, number: NUMBER }, context);
  try {
    // The daemon forgets the number for a while, so every new stream is refused.
    fake.accounts.clear();
    fake.drop();
    await until(
      () => logs.filter((line) => line === "signal-cli is out of reach: HTTP 400").length >= 2,
    );
    assert.equal(fake.streams.length, 1);

    fake.accounts.add(NUMBER);
    await until(() => fake.streams.length === 2);
    fake.push(from("+33123456789", "back"));
    await until(() => received.length === 1);
  } finally {
    stop();
    await fake.close();
  }
});

const card: Card = {
  id: "crd_1",
  kind: "approval",
  level: "needs_you",
  state: "open",
  title: "Book Tuesday at nine?",
  actions: [
    { id: "book", label: "Book it", style: "primary" },
    { id: "cancel", label: "Not now", style: "plain" },
  ],
  agentId: "agt_1",
  conversationId: "cnv_1",
  messageId: "msg_1",
  createdAt: "2026-11-21T10:00:00.000Z",
};

test("a message goes out as a JSON-RPC send, cards as text", async () => {
  const fake = await fakeDaemon();
  try {
    const settings = { url: fake.url, number: NUMBER };
    await signal.send(settings, "+33123456789", { text: "The dentist has time.", cards: [card] });
    assert.equal(fake.rpc.length, 1);
    const call = fake.rpc[0];
    assert.equal(call?.jsonrpc, "2.0");
    assert.equal(call?.method, "send");
    assert.ok(call?.id);
    assert.deepEqual(call?.params, {
      account: NUMBER,
      recipient: ["+33123456789"],
      message:
        "The dentist has time.\n\nBook Tuesday at nine?\n1: Book it   2: Not now\nReply with the number.",
    });

    fake.error = "Failed to send message: Unregistered user";
    await assert.rejects(signal.send(settings, "+33123456789", { text: "Hello.", cards: [] }), {
      message: "Failed to send message: Unregistered user",
    });
  } finally {
    await fake.close();
  }
});

test("start says in plain words when signal-cli does not answer", async () => {
  const { context } = listener();
  // A port on this computer where nothing listens.
  const fake = await fakeDaemon();
  const url = fake.url;
  await fake.close();
  await assert.rejects(signal.start({ url, number: NUMBER }, context), {
    message: `signal-cli does not answer at ${url}. Start it with “signal-cli -a ${NUMBER} daemon --http ${new URL(url).host}”, then connect again`,
  });

  await assert.rejects(signal.start({ url, number: "0170 1234567" }, context), {
    message: "The agent's number starts with + and the country code, as in +491701234567",
  });
  await assert.rejects(signal.start({ url: "the computer", number: NUMBER }, context), {
    message: "The address of signal-cli is not a web address, as in http://127.0.0.1:8080",
  });

  const other = await fakeDaemon();
  try {
    await assert.rejects(signal.start({ url: other.url, number: "+4915112345678" }, context), {
      message:
        "signal-cli does not know the number +4915112345678. Register it with signal-cli first",
    });
  } finally {
    await other.close();
  }
});

test("the setup asks for the number and offers the usual address", () => {
  assert.match(signal.setup.body, /signal-cli -a \+\d+ daemon --http 127\.0\.0\.1:8080/);
  assert.deepEqual(
    signal.setup.fields.map((field) => [field.id, field.type, field.required ?? false]),
    [
      ["number", "text", true],
      ["url", "text", false],
    ],
  );
});
