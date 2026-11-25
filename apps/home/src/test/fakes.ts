import { mkdtempSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { Card, Message } from "@wizards-bot/protocol";
import type { ChannelAdapter } from "../channels/channels.ts";
import type { Config } from "../config.ts";
import { Home } from "../home.ts";
import { createServer } from "../server.ts";

/** What the fake model says in one step: text, tool calls, or both. */
export interface Scripted {
  text?: string;
  calls?: { name: string; arguments: Record<string, unknown> }[];
  /** The model writes its first word, then waits for this before it goes on. */
  hold?: Promise<void>;
  /** The model fails with this status instead of answering. */
  fail?: number;
}

/** Where the context the home adds to the newest user message begins (`agent/cache.ts`). */
const CONTEXT = /\s*\[home\] It is [^\n]*\.(?:\n|$)[\s\S]*$/;

/** The signal that starts a turn on what was stored before it (`agent/turns.ts`). */
const ASKED = "<asked>Answer the message above.</asked>";

function withoutContext(body: {
  messages: { role: string; content: string }[];
  tools?: unknown[];
}): FakeOllama["requests"][number] {
  const newest = body.messages.findLastIndex((message) => message.role === "user");
  const content = body.messages[newest]?.content ?? "";
  const found = CONTEXT.exec(content);
  const said = found ? content.slice(0, found.index) : content;
  const asked = said === ASKED;
  const messages = body.messages
    .map((message, at) => (at === newest ? { ...message, content: said } : message))
    .filter((_, at) => !(asked && at === newest));
  return { ...body, messages, context: found ? found[0].trim() : "", asked };
}

/** An Ollama that answers from a script, so a test runs the real loop without a model. */
export class FakeOllama {
  readonly script: Scripted[] = [];
  /**
   * The request bodies of `/api/chat`, newest last, with the messages as they were said: the
   * signal that starts a turn on a stored message is taken out (`asked`), and the turn's
   * changing context (the time, the documents, the cards that wait), which the home adds to the
   * newest user message, is taken off it into `context`.
   */
  readonly requests: {
    messages: { role: string; content: string }[];
    tools?: unknown[];
    context: string;
    asked: boolean;
  }[] = [];
  /** Answers the caller stopped reading before they were finished. */
  aborted = 0;
  /** Whether the model says it takes pictures. */
  vision = true;
  private server: Server | undefined;
  url = "";

  async start(): Promise<void> {
    this.server = createHttpServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        if (request.url === "/api/version") {
          return response.end(JSON.stringify({ version: "0.0.0" }));
        }
        if (request.url === "/api/tags") {
          // Another digest is another model: what Ollama says of a model is kept by its digest.
          const digest = `sha256:fake-${this.vision ? "vision" : "text"}`;
          return response.end(JSON.stringify({ models: [{ name: "fake:1", size: 1, digest }] }));
        }
        if (request.url === "/api/ps") {
          return response.end(JSON.stringify({ models: [] }));
        }
        if (request.url === "/api/show") {
          return response.end(
            JSON.stringify({
              capabilities: ["completion", "tools", ...(this.vision ? ["vision"] : [])],
            }),
          );
        }
        this.requests.push(withoutContext(JSON.parse(body)));
        const next = this.script.shift() ?? { text: "(nothing scripted)" };
        const lines: unknown[] = [];
        for (const word of (next.text ?? "").split(/(?<= )/)) {
          if (word) lines.push({ message: { content: word } });
        }
        if (next.calls) {
          lines.push({
            message: { content: "", tool_calls: next.calls.map((call) => ({ function: call })) },
          });
        }
        lines.push({ done: true, done_reason: "stop", prompt_eval_count: 1, eval_count: 1 });
        if (next.fail) {
          response.statusCode = next.fail;
          return response.end(JSON.stringify({ error: "the model failed" }));
        }
        const hold = next.hold;
        if (!hold) return response.end(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
        response.on("close", () => {
          if (!response.writableEnded) this.aborted++;
        });
        response.write(`${JSON.stringify(lines.shift())}\n`);
        void hold.then(() =>
          response.end(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`),
        );
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

export interface TestHome {
  home: Home;
  model: FakeOllama;
  /** The home's own address, also its public one. */
  url: string;
  /** A paired device's token. */
  token: string;
  request(
    path: string,
    init?: { method?: string; body?: unknown; token?: string },
  ): Promise<Response>;
  /** Sends a message as the person and waits until the agent and every follow-up is done. */
  say(text: string): Promise<Message>;
  /** The newest open card that waits for the person. */
  item(): Card;
  /** Answers a card as the person and waits for what follows. */
  answer(cardId: string, action: string, values?: Record<string, string | string[]>): Promise<void>;
  last(): Message;
  stop(): void;
}

async function freePort(): Promise<number> {
  const probe = createHttpServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** A whole home on a free port with a scripted model and one paired device. */
export async function testHome(
  person: string,
  adapters?: ChannelAdapter[],
  /**
   * `port`: where to answer, for a home that takes the place of another at its address.
   * `dataDir`: what an earlier home kept, for the same home at another address.
   * `config`: settings of its start, e.g. those of a hosted home.
   * `unpicked`: nobody has picked Ollama, the scripted model, so the home does not ask it.
   */
  at: {
    port?: number;
    dataDir?: string;
    unreachable?: boolean;
    unpicked?: boolean;
    config?: Partial<Config>;
  } = {},
): Promise<TestHome> {
  const model = new FakeOllama();
  await model.start();
  const port = at.port ?? (await freePort());
  const url = `http://127.0.0.1:${port}`;
  const home = new Home(
    {
      dataDir: at.dataDir ?? mkdtempSync(join(tmpdir(), "wizards-bot-test-")),
      port,
      // `unreachable`: a home on a laptop, which no other home can call.
      publicUrl: at.unreachable ? undefined : url,
      ollamaUrl: model.url,
      subscriptions: [],
      ...at.config,
    },
    adapters,
  );
  home.db.setMeta("person.name", person);
  // A new home offers the morning look after the first answers. Only its own test wants that.
  home.db.setMeta("morning.offer", "not_new");
  if (!at.unpicked) home.models.pickOllama(true);
  await home.models.refresh(true);
  const app = createServer(home);
  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
  const { token } = home.store.addDevice({ name: "Test phone", kind: "phone" });
  const conversationId = home.store.mainAgent().conversationId;

  const request: TestHome["request"] = (path, init = {}) =>
    fetch(`${url}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        authorization: `Bearer ${init.token ?? token}`,
        "content-type": "application/json",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  const last = () => home.store.messages(conversationId, { limit: 1 }).messages[0] as Message;
  const settle = async () => {
    // A turn may tell another agent, whose answer starts a turn here again.
    do {
      await home.idle();
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (home.store.agents().some((agent) => agent.state === "working"));
    await home.idle();
  };
  return {
    home,
    model,
    url,
    token,
    request,
    last,
    async say(text) {
      await request(`/v1/conversations/${conversationId}/messages`, { body: { text } });
      await settle();
      return last();
    },
    item: () => home.store.items().at(-1) as Card,
    async answer(cardId, action, values) {
      const response = await request(`/v1/cards/${cardId}/answer`, { body: { action, values } });
      if (!response.ok) throw new Error(`answer failed: ${response.status}`);
      await settle();
    },
    stop() {
      server.close();
      model.stop();
      home.close();
    },
  };
}

/**
 * An A2A agent that is not a wizards.bot home: a card at the well-known address and JSON-RPC at
 * `/rpc`, in A2A 1.0 or 0.3. It answers "You said: …".
 */
export class FakeOutsideAgent {
  name = "Booking";
  description = "Books tables and rooms.";
  /** The A2A it speaks: its card, its method names and its messages follow that. */
  version: "1.0" | "0.3" = "1.0";
  /** Whether its card offers streaming. It then answers a streamed message in pieces. */
  streams = false;
  /** What its card asks a sender for. */
  signIn: "none" | "bearer" | "apiKey" | "oauth" = "none";
  /** The token or key it takes. */
  secret = "";
  /**
   * How it answers a message: with a message, a finished task, a task it still works on
   * (finished when asked for again), or a task that waits for one more message.
   */
  answers: "message" | "task" | "working" | "input" = "message";
  /** The JSON-RPC requests it took, newest last. */
  readonly requests: {
    method: string;
    headers: Record<string, string | string[] | undefined>;
    // biome-ignore lint/suspicious/noExplicitAny: whatever a sender put into the request
    params: any;
  }[] = [];
  url = "";
  private server: Server | undefined;
  private working: { id: string; contextId: string; text: string } | undefined;

  get host(): string {
    return new URL(this.url).host;
  }

  card(): Record<string, unknown> {
    const one = this.version === "1.0";
    const schemes: Record<string, unknown> = {
      none: {},
      bearer: {
        token: one
          ? { httpAuthSecurityScheme: { scheme: "Bearer" } }
          : { type: "http", scheme: "bearer" },
      },
      apiKey: {
        key: one
          ? { apiKeySecurityScheme: { location: "header", name: "X-API-Key" } }
          : { type: "apiKey", in: "header", name: "X-API-Key" },
      },
      oauth: {
        sign: one
          ? {
              oauth2SecurityScheme: {
                flows: { authorizationCode: { authorizationUrl: "", tokenUrl: "", scopes: {} } },
              },
            }
          : { type: "oauth2", flows: {} },
      },
    };
    const securitySchemes = schemes[this.signIn] as Record<string, unknown>;
    const shared = {
      name: this.name,
      description: this.description,
      version: "1.0.0",
      provider: { organization: "Hotel Lux", url: this.url },
      capabilities: { streaming: this.streams, pushNotifications: false },
      securitySchemes,
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [{ id: "book", name: "Book a table", description: "Books a table.", tags: [] }],
    };
    if (!one) {
      return {
        ...shared,
        url: `${this.url}/rpc`,
        preferredTransport: "JSONRPC",
        protocolVersion: "0.3.0",
        security: Object.keys(securitySchemes).map((name) => ({ [name]: [] })),
      };
    }
    return {
      ...shared,
      supportedInterfaces: [
        { url: `${this.url}/grpc`, protocolBinding: "GRPC", protocolVersion: "1.0" },
        { url: `${this.url}/rpc`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
      ],
      securityRequirements: Object.keys(securitySchemes).map((name) => ({
        schemes: { [name]: { list: [] } },
      })),
    };
  }

  async start(): Promise<void> {
    this.server = createHttpServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        if (request.method === "GET" && request.url === "/.well-known/agent-card.json") {
          return response.end(JSON.stringify(this.card()));
        }
        if (request.method !== "POST" || request.url !== "/rpc") {
          response.statusCode = 404;
          return response.end("{}");
        }
        const signedIn =
          this.signIn === "bearer"
            ? request.headers.authorization === `Bearer ${this.secret}`
            : this.signIn === "apiKey"
              ? request.headers["x-api-key"] === this.secret
              : true;
        if (!signedIn) {
          response.statusCode = 401;
          return response.end(JSON.stringify({ error: "unauthorized" }));
        }
        const rpc = JSON.parse(body);
        this.requests.push({ method: rpc.method, headers: request.headers, params: rpc.params });
        const events = this.streamed(rpc);
        if (events) {
          response.setHeader("content-type", "text/event-stream");
          for (const result of events) {
            response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result })}\n\n`);
          }
          return response.end();
        }
        response.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, ...this.answer(rpc) }));
      });
    });
    const server = this.server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  /** A text as the parts of a message, in the agent's version. */
  private parts(text: string): unknown[] {
    return [this.version === "1.0" ? { text } : { kind: "text", text }];
  }

  /** "You said: …" for the message of a request. */
  // biome-ignore lint/suspicious/noExplicitAny: a JSON-RPC request as it came
  private reply(rpc: any): string {
    const parts: { text?: string }[] = rpc.params?.message?.parts ?? [];
    return `You said: ${parts.map((part) => part.text ?? "").join("")}`;
  }

  /** The events of a streamed answer in A2A 1.0: the task, its text in two pieces, its end. */
  // biome-ignore lint/suspicious/noExplicitAny: a JSON-RPC request as it came
  private streamed(rpc: any): unknown[] | undefined {
    if (rpc.method !== "SendStreamingMessage") return undefined;
    const text = this.reply(rpc);
    const taskId = `task-${this.requests.length}`;
    const contextId = rpc.params?.message?.contextId ?? `ctx-${this.requests.length}`;
    const piece = (words: string, append: boolean, lastChunk: boolean) => ({
      artifactUpdate: {
        taskId,
        contextId,
        artifact: { artifactId: "a1", parts: [{ text: words }] },
        append,
        lastChunk,
      },
    });
    return [
      { task: { id: taskId, contextId, status: { state: "TASK_STATE_WORKING" } } },
      piece(text.slice(0, 10), false, false),
      piece(text.slice(10), true, true),
      { statusUpdate: { taskId, contextId, status: { state: "TASK_STATE_COMPLETED" } } },
    ];
  }

  // biome-ignore lint/suspicious/noExplicitAny: a JSON-RPC request as it came
  private answer(rpc: any): { result: unknown } | { error: { code: number; message: string } } {
    const one = this.version === "1.0";
    const state = (name: string) =>
      one ? `TASK_STATE_${name.toUpperCase().replace("-", "_")}` : name;
    const said = (text: string, contextId: string) => ({
      messageId: "m",
      contextId,
      role: one ? "ROLE_AGENT" : "agent",
      parts: this.parts(text),
      ...(one ? {} : { kind: "message" }),
    });
    const task = (id: string, contextId: string, name: string, text: string, say?: string) => ({
      id,
      contextId,
      ...(one ? {} : { kind: "task" }),
      status: { state: state(name), ...(say ? { message: said(say, contextId) } : {}) },
      artifacts: name === "completed" ? [{ artifactId: "a1", parts: this.parts(text) }] : undefined,
    });
    // A2A 1.0 names what a message is answered with; 0.3 tells it by `kind`.
    const sent = (what: "task" | "message", value: unknown) => ({
      result: one ? { [what]: value } : value,
    });

    if (rpc.method === (one ? "GetTask" : "tasks/get")) {
      const { working } = this;
      if (!working || working.id !== rpc.params?.id)
        return { error: { code: -32001, message: "No such task." } };
      this.working = undefined;
      return { result: task(working.id, working.contextId, "completed", working.text) };
    }
    if (rpc.method !== (one ? "SendMessage" : "message/send"))
      return { error: { code: -32601, message: `Unknown method ${rpc.method}.` } };
    const message = rpc.params?.message ?? {};
    const text = this.reply(rpc);
    const contextId = message.contextId ?? `ctx-${this.requests.length}`;
    const id = `task-${this.requests.length}`;
    if (message.taskId) return sent("task", task(message.taskId, contextId, "completed", text));
    if (this.answers === "task") return sent("task", task(id, contextId, "completed", text));
    if (this.answers === "working") {
      this.working = { id, contextId, text };
      return sent("task", task(id, contextId, "working", text));
    }
    if (this.answers === "input")
      return sent("task", task(id, contextId, "input-required", text, "Which day?"));
    return sent("message", said(text, contextId));
  }

  stop(): void {
    this.server?.close();
  }
}

export const textOf = (message: Message): string =>
  message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
