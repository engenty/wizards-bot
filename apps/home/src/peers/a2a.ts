import { randomUUID } from "node:crypto";
import { A2AAgent, MastraA2AError } from "@mastra/core/a2a";
import { AgentCard as Card1 } from "@mastra/core/a2a/v1";
import type { Mastra } from "@mastra/core/mastra";
import type { RequestContext } from "@mastra/core/request-context";
import { InMemoryTaskStore } from "@mastra/server/a2a/store";
import { AGENT_EXECUTION_ROUTE } from "@mastra/server/handlers/a2a";
import { z } from "zod";

// A2A, with nothing of wizards.bot in it, and as little of the home's own as there can be.
// Asking another agent is Mastra's `A2AAgent`: it reads the card, sends the message in A2A
// 1.0 or 0.3, streams the answer and follows a task. Answering is Mastra's A2A handler
// (`@mastra/server`): messages, streaming, tasks, both versions. What the home adds is what
// Mastra leaves to its user: which address may be called, how a request says who sends it,
// which conversation a message belongs to, and what an agent's card says. Who a request
// comes from is the caller's business: a home signs it (`signature.ts`), an outside agent
// gets a token or a key (`outside.ts`).

/** The A2A the home prefers, in both directions. */
export const A2A_VERSION = "1.0";
/** The A2A versions the home speaks, the one it prefers first. */
export const A2A_VERSIONS = ["1.0", "0.3"] as const;
export type A2AVersion = (typeof A2A_VERSIONS)[number];

/** The error codes of JSON-RPC and of A2A that the home answers with. */
export const A2A_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  invalidParams: -32602,
  internalError: -32603,
  taskNotFound: -32001,
  pushNotSupported: -32003,
  unsupportedOperation: -32004,
  contentTypeNotSupported: -32005,
} as const;

/** The longest text one message may carry, in either direction. */
export const A2A_TEXT_LIMIT = 40_000;
const CARD_LIMIT = 256 * 1024;

// ── Addresses ───────────────────────────────────────────────────────────────

/** Whether a host is this computer or a private network. */
export const isPrivateHost = (host: string): boolean =>
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[)/i.test(host) ||
  /\.(local|internal|localhost)(:\d+)?$/i.test(host);

/**
 * Checks an address the home is about to call. A private address is called only by a home
 * that is private itself, and only such an address goes without TLS.
 */
export function outsideUrl(address: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    throw new Error(`“${address}” is not an address.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("An agent's address starts with https://.");
  if (url.username || url.password)
    throw new Error("An address with a password in it is not taken.");
  const local = isPrivateHost(url.host);
  if (local && !allowPrivate)
    throw new Error(`${url.host} is a private address. This home does not call private addresses.`);
  if (url.protocol === "http:" && !local)
    throw new Error("An agent's address starts with https://.");
  return url;
}

export type Fetch = typeof fetch;

/** A `fetch` that calls only addresses the home may call and follows no redirect. */
export function guarded(allowPrivate: boolean): Fetch {
  return async (input, init) => {
    const url = outsideUrl(String(input instanceof Request ? input.url : input), allowPrivate);
    const response = await fetch(url, { ...init, redirect: "error" }).catch((error) => {
      if (init?.signal?.aborted) throw error;
      return undefined;
    });
    if (!response) throw new Error(`${url.host} is out of reach.`);
    return response;
  };
}

// ── The agent card ──────────────────────────────────────────────────────────

/** How a request to an outside agent says who sends it. */
export type SignIn =
  | { kind: "none" }
  | { kind: "bearer" }
  | { kind: "apiKey"; location: "header" | "query" | "cookie"; name: string };

/** What the home takes from an agent's card. */
export interface OutsideCard {
  /** Where the card was read. */
  cardUrl: string;
  version: A2AVersion;
  name: string;
  description: string;
  /** Who runs the agent, when the card says so. */
  organization?: string;
  /** What the agent says it can do. */
  skills: string[];
  /** Where it takes messages. */
  url: string;
  tenant?: string;
  streams: boolean;
  /** The sign-in it asks for, or why the home cannot do it. */
  signIn: SignIn | { why: string };
}

/** One way to sign in, as a card of either version describes it. */
function wayOf(scheme: unknown): SignIn | string {
  const given = (scheme ?? {}) as Record<string, unknown>;
  // A2A 1.0 names the kind by its key; 0.3 has a `type`, as OpenAPI does.
  const key = (given.apiKeySecurityScheme ?? (given.type === "apiKey" ? given : undefined)) as
    | { location?: string; in?: string; name?: string }
    | undefined;
  if (key) {
    const location = key.location ?? key.in;
    if ((location === "header" || location === "query" || location === "cookie") && key.name)
      return { kind: "apiKey", location, name: key.name };
    return "a key the card does not describe";
  }
  const http = (given.httpAuthSecurityScheme ?? (given.type === "http" ? given : undefined)) as
    | { scheme?: string }
    | undefined;
  if (http)
    return http.scheme?.toLowerCase() === "bearer" ? { kind: "bearer" } : `HTTP ${http.scheme}`;
  if (given.oauth2SecurityScheme || given.type === "oauth2") return "OAuth";
  if (given.openIdConnectSecurityScheme || given.type === "openIdConnect") return "OpenID Connect";
  if (given.mtlsSecurityScheme || given.type === "mutualTLS") return "a client certificate";
  return "a sign-in the card does not describe";
}

/**
 * The sign-in a card asks for. A card lists ways to sign in, any one of which is enough; the
 * first the home can do is taken. A way that needs two things at once is not one of them.
 * `card` is the card as it was sent: Mastra's reading of it leaves the sign-in out.
 */
export function signInOf(card: unknown, version: A2AVersion): SignIn | { why: string } {
  const given = (card ?? {}) as {
    securitySchemes?: Record<string, unknown>;
    securityRequirements?: { schemes?: Record<string, unknown> }[];
    security?: Record<string, unknown>[];
  };
  const requirements =
    version === "1.0"
      ? (given.securityRequirements ?? []).map((requirement) => requirement.schemes ?? {})
      : (given.security ?? []);
  if (!requirements.length) return { kind: "none" };
  const cannot: string[] = [];
  for (const requirement of requirements) {
    const names = Object.keys(requirement);
    if (!names.length) return { kind: "none" };
    const ways = names.map((name) => wayOf(given.securitySchemes?.[name]));
    const [only] = ways;
    if (ways.length === 1 && only && typeof only !== "string") return only;
    cannot.push(
      ways
        .map((way) => (typeof way === "string" ? way : way.kind === "bearer" ? "a token" : "a key"))
        .join(" together with "),
    );
  }
  return { why: `It asks for ${[...new Set(cannot)].join(", or ")}.` };
}

/** Why the home cannot talk to an agent whose card it could read. */
function whyNot(raw: Record<string, unknown>): string {
  const interfaces = (Array.isArray(raw.supportedInterfaces) ? raw.supportedInterfaces : []) as {
    protocolBinding?: string;
    protocolVersion?: string;
  }[];
  const jsonRpc = interfaces.filter((one) => one.protocolBinding?.toUpperCase() === "JSONRPC");
  if (jsonRpc.length) {
    const versions = jsonRpc.map((one) => one.protocolVersion || "an unnamed version").join(", ");
    return `It speaks A2A ${versions}. The home speaks A2A ${A2A_VERSIONS.join(" and ")}.`;
  }
  const bindings = interfaces.map((one) => one.protocolBinding).filter(Boolean);
  const other = typeof raw.preferredTransport === "string" ? [raw.preferredTransport] : bindings;
  return other.length
    ? `It takes messages over ${other.join(", ")} only. The home speaks JSON-RPC.`
    : "Its card names no address that takes messages.";
}

/**
 * Reads an agent card. The address is the card's own (`…/agent-card.json`), or the agent's
 * site or the agent's place on it, where the card is at `/.well-known/agent-card.json`. The
 * home asks for the card once; Mastra's client reads it, as A2A 1.0 and, when it is not
 * that, as 0.3.
 */
export async function readCard(address: string, allowPrivate: boolean): Promise<OutsideCard> {
  const given = outsideUrl(address, allowPrivate);
  const base = `${given.origin}${given.pathname.replace(/\/+$/, "")}`;
  const bases = base.endsWith("/agent-card.json") ? [base] : [...new Set([base, given.origin])];
  const ask = guarded(allowPrivate);
  let why = "";
  for (const url of bases) {
    const cardUrl = url.endsWith("/agent-card.json") ? url : `${url}/.well-known/agent-card.json`;
    // An agent that speaks both versions hands out the card of the one that is asked for.
    const response = await ask(cardUrl, {
      headers: { accept: "application/json", "a2a-version": A2A_VERSION },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
    const text = response?.ok ? await response.text().catch(() => "") : "";
    if (!text || text.length > CARD_LIMIT) continue;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(text);
    } catch {
      continue;
    }
    if (!raw || typeof raw !== "object" || typeof raw.name !== "string" || !raw.name) continue;

    for (const version of A2A_VERSIONS) {
      const reader = new A2AAgent({
        url,
        protocolVersion: version,
        fetch: async () => new Response(text),
      });
      const card = await reader.getAgentCard().catch(() => undefined);
      const transport = (card?.preferredTransport ?? "JSONRPC").toUpperCase();
      if (!card || typeof card.url !== "string" || !card.url || transport !== "JSONRPC") continue;
      const tenant =
        version === "1.0"
          ? Card1.fromJSON(raw).supportedInterfaces.find((one) => one.url === card.url)?.tenant
          : undefined;
      return {
        cardUrl,
        version,
        name: raw.name,
        description: typeof card.description === "string" ? card.description : "",
        organization: card.provider?.organization || undefined,
        skills: (card.skills ?? []).map((skill) => skill.name ?? "").filter(Boolean),
        url: card.url,
        tenant: tenant || undefined,
        streams: card.capabilities?.streaming === true,
        signIn: signInOf(raw, version),
      };
    }
    why = whyNot(raw);
  }
  throw new Error(why || `There is no agent card at ${given.host}${given.pathname}.`);
}

// ── Asking an agent ─────────────────────────────────────────────────────────

/** Where a conversation with an agent stands, kept between two messages. */
export interface Thread {
  /** The conversation as the agent names it; sent along with the next message. */
  contextId?: string;
  /** A task that waits for the next message. */
  taskId?: string;
}

/**
 * A `fetch` that puts a message into the conversation it belongs to. Mastra's client starts
 * each message anew; an agent in a chat is one conversation, so the home adds the `contextId`
 * the agent named, the task that waits for this message, and the card's `tenant`.
 */
export function inThread(send: Fetch, thread: () => Thread & { tenant?: string }): Fetch {
  return (input, init) => {
    if (init?.method !== "POST" || typeof init.body !== "string") return send(input, init);
    let rpc: { params?: { tenant?: string; message?: Thread } };
    try {
      rpc = JSON.parse(init.body);
    } catch {
      return send(input, init);
    }
    const message = rpc.params?.message;
    if (!rpc.params || !message) return send(input, init);
    const { contextId, taskId, tenant } = thread();
    if (contextId && !message.contextId) message.contextId = contextId;
    if (taskId && !message.taskId) message.taskId = taskId;
    if (tenant && !rpc.params.tenant) rpc.params.tenant = tenant;
    return send(input, { ...init, body: JSON.stringify(rpc) });
  };
}

interface Part {
  kind?: string;
  text?: string;
  data?: unknown;
  file?: { uri?: string; name?: string };
}

/** What parts without text say in words. A file is named, not taken. */
function wordsOf(parts: Part[] | undefined): string {
  return (parts ?? [])
    .map((part) => {
      if (typeof part.text === "string") return part.text;
      if (part.file?.uri) return part.file.uri;
      if (part.file) return `(a file${part.file.name ? `, ${part.file.name}` : ""})`;
      if (part.data !== undefined)
        return `\`\`\`json\n${JSON.stringify(part.data, null, 2)}\n\`\`\``;
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

/** The HTTP status an agent refused a request with, when Mastra's client met one. */
export function refusedWith(error: unknown): number | undefined {
  const status = (error as { data?: { status?: unknown } } | undefined)?.data?.status;
  return error instanceof MastraA2AError && typeof status === "number" ? status : undefined;
}

/** Whether an agent answered that the task a message named is gone or over. */
export const taskIsGone = (error: unknown): boolean =>
  error instanceof MastraA2AError &&
  (error.code === A2A_ERROR.taskNotFound || error.code === A2A_ERROR.unsupportedOperation);

/**
 * Says a text to an agent and writes its answer as it arrives: streamed when the agent
 * streams, else when it is done. A task that is still worked on when the stream ends is
 * asked for until it ended or waits for the next message.
 */
export async function say(
  remote: A2AAgent,
  text: string,
  signal: AbortSignal,
  write: (text: string) => void,
): Promise<Thread> {
  const runId = randomUUID();
  let room = A2A_TEXT_LIMIT;
  const put = (words: string) => {
    if (room <= 0 || !words) return;
    write(words.length > room ? `${words.slice(0, room)}…` : words);
    room -= words.length;
  };
  const output = await remote.stream(text, { runId, abortSignal: signal });
  for await (const chunk of output.fullStream as AsyncIterable<{
    type: string;
    payload?: { text?: string };
  }>) {
    if (chunk.type === "text-delta") put(chunk.payload?.text ?? "");
  }
  let result = await output.getResult();
  if (result.resumePayload && !result.resumePayload.waitingForInput) {
    result = await remote.resumeGenerate(undefined, { runId, abortSignal: signal });
  }

  const { task, message } = result;
  const state = task?.status.state;
  const said = wordsOf(task?.status.message?.parts as Part[] | undefined);
  const contextId = task?.contextId ?? message?.contextId;
  if (state === "failed" || state === "rejected" || state === "canceled") {
    const how =
      state === "rejected"
        ? "It did not take the task"
        : state === "canceled"
          ? "The task was stopped"
          : "The task failed";
    throw new Error(said ? `${how}: ${said}` : `${how}.`);
  }
  if (state === "auth-required")
    throw new Error(said || "It asks for a sign-in the home cannot do.");
  if (room === A2A_TEXT_LIMIT) {
    // Nothing was streamed: the answer is in the result, as text or as other parts.
    const made = wordsOf(task?.artifacts?.flatMap((artifact) => artifact.parts) as Part[]);
    put(
      state === "input-required"
        ? said || result.text || "It needs more from you to go on."
        : result.text || made || wordsOf(message?.parts as Part[] | undefined) || "(no answer)",
    );
  }
  return { contextId, taskId: state === "input-required" ? task?.id : undefined };
}

export { A2AAgent };

// ── Answering a message ─────────────────────────────────────────────────────

export const A2ARequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type A2ARequest = z.infer<typeof A2ARequest>;

export type RpcId = string | number | null;

export const rpcError = (id: RpcId, code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  id,
  error: { code, message },
});

/** The methods that say something to the agent, in A2A 1.0 and in 0.3. */
const SAYS = new Set(["SendMessage", "SendStreamingMessage", "message/send", "message/stream"]);

/**
 * What the home takes from a request before Mastra answers it: the text of a message, or why
 * the request is not taken. An agent of the home reads text, and the home calls no address a
 * caller names, so it sends no notifications.
 */
export function taken(
  rpc: A2ARequest,
): { refused: ReturnType<typeof rpcError> } | { text?: string; messageId?: string } {
  const refuse = (code: number, message: string) => ({ refused: rpcError(rpc.id, code, message) });
  if (/pushnotification/i.test(rpc.method))
    return refuse(A2A_ERROR.pushNotSupported, "This agent sends no notifications.");
  if (!SAYS.has(rpc.method)) return {};
  const configuration = (rpc.params?.configuration ?? {}) as Record<string, unknown>;
  if (configuration.taskPushNotificationConfig || configuration.pushNotificationConfig)
    return refuse(A2A_ERROR.pushNotSupported, "This agent sends no notifications.");
  const message = (rpc.params?.message ?? {}) as { messageId?: unknown; parts?: unknown };
  const parts = (Array.isArray(message.parts) ? message.parts : []) as Record<string, unknown>[];
  if (parts.some((part) => typeof part?.text !== "string"))
    return refuse(A2A_ERROR.contentTypeNotSupported, "This agent takes text only.");
  const text = parts
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (!text) return refuse(A2A_ERROR.invalidParams, "The message has no text.");
  if (text.length > A2A_TEXT_LIMIT)
    return refuse(A2A_ERROR.invalidParams, "The message is too long.");
  return { text, messageId: typeof message.messageId === "string" ? message.messageId : undefined };
}

/** The tasks of one sender with one agent. Mastra keeps them while the home runs. */
export class Tasks extends InMemoryTaskStore {}

/**
 * Answers a JSON-RPC request with Mastra's A2A handler: a message, a streamed message, a
 * task that is asked for, listed, stopped or followed, in the version the request names with
 * `A2A-Version` (none: 0.3). `context` carries the agent's turn and the conversation.
 */
export function answer(input: {
  mastra: Mastra;
  agentId: string;
  /** The request as it came: its `A2A-Version`, and its end when the sender leaves. */
  request: Request;
  rpc: A2ARequest;
  context: RequestContext;
  tasks: Tasks;
}): Promise<Response> {
  const run = AGENT_EXECUTION_ROUTE.handler as unknown as (
    params: Record<string, unknown>,
  ) => Promise<Response>;
  return run({
    mastra: input.mastra,
    agentId: input.agentId,
    requestContext: input.context,
    taskStore: input.tasks,
    abortSignal: input.request.signal,
    request: input.request,
    ...input.rpc,
  });
}

/**
 * What an agent answered to a message, once the task Mastra made for it is no longer worked
 * on. Nothing when the message made no task.
 */
export async function answered(
  tasks: Tasks,
  agentId: string,
  messageId: string,
): Promise<{ text: string; failed: boolean } | undefined> {
  const made = tasks
    .list({ agentId })
    .find((task) => task.history?.some((message) => message.messageId === messageId));
  if (!made) return undefined;
  let now = tasks.loadWithVersion({ agentId, taskId: made.id });
  while (now && (now.task.status.state === "submitted" || now.task.status.state === "working")) {
    now = await tasks.waitForNextUpdate({ agentId, taskId: made.id, afterVersion: now.version });
  }
  const task = now?.task ?? made;
  const text = (task.artifacts ?? [])
    .flatMap((artifact) => artifact.parts as Part[])
    .map((part) => part.text ?? "")
    .join("");
  return {
    text: text || wordsOf(task.status.message?.parts as Part[] | undefined),
    failed: task.status.state !== "completed",
  };
}

/** Passes a streamed answer on and calls `done` when it ended, however it ended. */
export function whenEnded(response: Response, done: () => void): Response {
  if (!response.body) {
    done();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await reader.read().catch(() => ({ done: true as const, value: undefined }));
      if (next.done) {
        done();
        controller.close();
      } else controller.enqueue(next.value);
    },
    cancel(reason) {
      done();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: response.status, headers: response.headers });
}

/**
 * The card of an agent of the home that answers at `url`, as A2A 1.0 writes it or as 0.3
 * does. It says the agent's name and what it is for, never its instructions. A caller signs
 * in with a token.
 */
export function agentCard(
  agent: { name: string; about: string },
  url: string,
  version: A2AVersion,
) {
  const description = agent.about || agent.name;
  const tokenIs = "An access token the agent's owner made for this caller.";
  const shared = {
    name: agent.name,
    description,
    version: "1",
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [{ id: "talk", name: agent.name, description, tags: [] }],
  };
  if (version === "0.3") {
    return {
      ...shared,
      url,
      preferredTransport: "JSONRPC",
      protocolVersion: "0.3.0",
      capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
      securitySchemes: { token: { type: "http", scheme: "bearer", description: tokenIs } },
      security: [{ token: [] }],
    };
  }
  return {
    ...shared,
    supportedInterfaces: A2A_VERSIONS.map((protocolVersion) => ({
      url,
      protocolBinding: "JSONRPC",
      protocolVersion,
    })),
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
    securitySchemes: {
      token: { httpAuthSecurityScheme: { scheme: "Bearer", description: tokenIs } },
    },
    securityRequirements: [{ schemes: { token: { list: [] } } }],
  };
}
