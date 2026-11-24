import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

interface Rpc {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
}

/** What a retried call carries back: the answers by question, and the server's token. */
export interface Retry {
  arguments: Record<string, unknown>;
  inputResponses?: Record<string, { action: string; content?: Record<string, unknown> }>;
  requestState?: string;
}

/**
 * What a tool of the fake answers: a result, questions for the person, or (`needs`, the
 * older way only) the error that names a page to open before the tool is called again.
 */
export type Outcome =
  | {
      text: string;
      /** What the result carries besides its text: for the client, not the model. */
      structured?: Record<string, unknown>;
      meta?: Record<string, unknown>;
      resources?: { uri: string; mimeType: string; text: string }[];
    }
  | { ask: Record<string, Record<string, unknown>>; state?: unknown }
  | { needs: string };

export interface FakeTool {
  title?: string;
  description?: string;
  readOnly?: boolean;
  /** The tool's own `_meta` in the list (MCP Apps: `ui.resourceUri`, `ui.visibility`). */
  meta?: Record<string, unknown>;
  run(call: Retry, state: unknown): Outcome;
}

const KEY = "fake-mcp-key";
const ACCESS = "fake-access";
const SERVER = { name: "fake", version: "1" };

/**
 * An MCP server that asks the person in the middle of a tool call. `modern` speaks
 * 2026-07-28: it keeps nothing, answers `input_required` with a signed token and expects
 * the token back unchanged. `legacy` speaks 2025-11-25: it keeps the call open, sends its
 * question as a request on the call's stream and waits for the client's answer.
 */
export class FakeMcp {
  readonly era: "modern" | "legacy";
  readonly tools: Record<string, FakeTool>;
  /** Every `tools/call` that arrived, newest last. */
  readonly calls: Retry[] = [];
  /** Every body the server got, as text: to look for what must not have been sent. */
  readonly bodies: string[] = [];
  /** How long a legacy call waits for the person before the server gives up. */
  patience = 5000;
  /** Whether the server wants a sign-in first (OAuth with a code), as a service on the internet does. */
  signIn = false;
  /** The codes a sign-in was finished with. */
  readonly codes: string[] = [];
  url = "";
  private server: Server | undefined;
  private readonly waiting = new Map<string, (answer: unknown) => void>();
  private asked = 0;

  constructor(era: "modern" | "legacy", tools: Record<string, FakeTool>) {
    this.era = era;
    this.tools = tools;
  }

  async start(): Promise<void> {
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => void this.handle(request, response, body));
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  }

  stop(): void {
    this.server?.closeAllConnections();
    this.server?.close();
  }

  private sign(state: unknown): string {
    const body = Buffer.from(JSON.stringify(state)).toString("base64url");
    return `${body}.${createHmac("sha256", KEY).update(body).digest("base64url")}`;
  }

  /** The state a token carries. Throws when the token is not the one this server made. */
  private verify(token: string): unknown {
    const [body = "", mac] = token.split(".");
    if (createHmac("sha256", KEY).update(body).digest("base64url") !== mac)
      throw new Error("requestState was changed");
    return JSON.parse(Buffer.from(body, "base64url").toString());
  }

  private listed(): unknown[] {
    return Object.entries(this.tools).map(([name, tool]) => ({
      name,
      ...(tool.title ? { title: tool.title } : {}),
      description: tool.description ?? name,
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: tool.readOnly === true },
      ...(tool.meta ? { _meta: tool.meta } : {}),
    }));
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
    body: string,
  ): Promise<void> {
    const json = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const origin = this.url.replace("/mcp", "");
    const path = (request.url ?? "").split("?")[0];
    if (this.signIn) {
      if (path?.startsWith("/.well-known/oauth-protected-resource"))
        return json(200, { resource: this.url, authorization_servers: [origin] });
      if (path === "/.well-known/oauth-authorization-server")
        return json(200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      if (path === "/register") return json(201, { ...JSON.parse(body), client_id: "client-1" });
      if (path === "/token") {
        this.codes.push(new URLSearchParams(body).get("code") ?? "");
        return json(200, { access_token: ACCESS, token_type: "Bearer" });
      }
      if (path === "/mcp" && request.headers.authorization !== `Bearer ${ACCESS}`) {
        response.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
        });
        response.end();
        return;
      }
    }
    if (path !== "/mcp") return json(404, {});
    if (request.method !== "POST") return json(405, {});
    this.bodies.push(body);
    const rpc = JSON.parse(body) as Rpc;
    const reply = (result: unknown) => json(200, { jsonrpc: "2.0", id: rpc.id, result });
    const fail = (status: number, code: number, message: string) =>
      json(status, { jsonrpc: "2.0", id: rpc.id ?? null, error: { code, message } });
    const params = rpc.params ?? {};

    if (this.era === "legacy") {
      // The client's answer to a question this server sent on an open call.
      if (rpc.method === undefined && rpc.id !== undefined) {
        this.waiting.get(String(rpc.id))?.(rpc.error ? { error: rpc.error } : rpc.result);
        response.writeHead(202).end();
        return;
      }
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      if (rpc.method === "initialize")
        return reply({
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: SERVER,
        });
      if (rpc.method === "tools/list") return reply({ tools: this.listed() });
      if (rpc.method !== "tools/call") return fail(400, -32000, "Bad Request");
      return this.held(response, rpc, params);
    }

    if (request.headers["mcp-protocol-version"] !== "2026-07-28")
      return fail(400, -32022, "Unsupported protocol version");
    const meta = { "io.modelcontextprotocol/serverInfo": SERVER };
    const complete = { resultType: "complete", _meta: meta };
    if (rpc.method === "server/discover")
      return reply({
        ...complete,
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
        ttlMs: 0,
        cacheScope: "private",
      });
    if (rpc.method === "tools/list")
      return reply({ ...complete, tools: this.listed(), ttlMs: 0, cacheScope: "private" });
    if (rpc.method !== "tools/call") return fail(200, -32601, "Unknown method");

    const call: Retry = {
      arguments: (params.arguments ?? {}) as Record<string, unknown>,
      inputResponses: params.inputResponses as Retry["inputResponses"],
      requestState: params.requestState as string | undefined,
    };
    this.calls.push(call);
    const tool = this.tools[String(params.name)];
    if (!tool) return fail(200, -32602, "Unknown tool");
    let state: unknown;
    try {
      state = call.requestState === undefined ? undefined : this.verify(call.requestState);
    } catch (error) {
      return fail(200, -32602, (error as Error).message);
    }
    const outcome = tool.run(call, state);
    if ("needs" in outcome) return fail(200, -32603, "This revision has no such error");
    if ("text" in outcome)
      return reply({
        ...complete,
        content: [
          { type: "text", text: outcome.text },
          ...(outcome.resources ?? []).map((resource) => ({ type: "resource", resource })),
        ],
        ...(outcome.structured ? { structuredContent: outcome.structured } : {}),
        ...(outcome.meta ? { _meta: outcome.meta } : {}),
      });
    reply({
      resultType: "input_required",
      _meta: meta,
      inputRequests: Object.fromEntries(
        Object.entries(outcome.ask).map(([key, question]) => [
          key,
          { method: "elicitation/create", params: question },
        ]),
      ),
      ...(outcome.state === undefined ? {} : { requestState: this.sign(outcome.state) }),
    });
  }

  /** The older way: the call stays open while the server asks and waits. */
  private async held(
    response: ServerResponse,
    rpc: Rpc,
    params: Record<string, unknown>,
  ): Promise<void> {
    const call: Retry = { arguments: (params.arguments ?? {}) as Record<string, unknown> };
    this.calls.push(call);
    const tool = this.tools[String(params.name)];
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (message: unknown) =>
      response.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    const finish = (text: string, isError = false) => {
      send({
        jsonrpc: "2.0",
        id: rpc.id,
        result: { content: [{ type: "text", text }], ...(isError ? { isError } : {}) },
      });
      response.end();
    };
    if (!tool) return finish("Unknown tool", true);
    let outcome = tool.run(call, undefined);
    if ("needs" in outcome) {
      const page = { mode: "url", elicitationId: "page", url: outcome.needs, message: "Connect." };
      send({
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32042, message: "A page is needed", data: { elicitations: [page] } },
      });
      response.end();
      return;
    }
    while ("ask" in outcome) {
      const answers: Retry["inputResponses"] = {};
      for (const [key, question] of Object.entries(outcome.ask)) {
        const id = `ask-${++this.asked}`;
        const answer = await new Promise<unknown>((resolve) => {
          this.waiting.set(id, resolve);
          setTimeout(() => resolve(undefined), this.patience);
          // Before 2026-07-28 a page carries an id of its own.
          const params = question.mode === "url" ? { ...question, elicitationId: id } : question;
          send({ jsonrpc: "2.0", id, method: "elicitation/create", params });
        });
        this.waiting.delete(id);
        if (answer === undefined) return finish("The person did not answer in time.", true);
        if ((answer as { error?: unknown }).error)
          return finish(`The client refused: ${JSON.stringify(answer)}`, true);
        answers[key] = answer as { action: string; content?: Record<string, unknown> };
      }
      call.inputResponses = { ...call.inputResponses, ...answers };
      outcome = tool.run({ ...call, inputResponses: answers }, outcome.state);
    }
    finish("text" in outcome ? outcome.text : "A page is needed", !("text" in outcome));
  }
}
