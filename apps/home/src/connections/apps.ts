import { gzipSync } from "node:zlib";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Home } from "../home.ts";
import type { Carried } from "./calls.ts";
import type { Connection, ConnectionTool } from "./connections.ts";

/**
 * MCP Apps views: the page a connection's server shows a tool's result in (`ui://…`). The home
 * keeps the call as an artifact of `format: "app"`, so it stands in the chat and opens beside it
 * as an agent's page does. A device frames the home's host page (`/v1/artifacts/:id/host`),
 * which runs the MCP Apps bridge and frames the view (`/v1/artifacts/:id/page`). Both are closed
 * off like an agent's page: an origin of their own, no device token. The view reaches only what
 * its server named in `_meta.ui.csp`; the host reaches the home only with the artifact's key,
 * for this one call: what it was, the same connection's tools, a message as the person.
 */

/**
 * The largest view the home keeps. A view bundles its app in one file: the studio's flow widget
 * is 11 MB (7 MB packed).
 */
const VIEW_LIMIT = 16 * 1024 * 1024;
const SUMMARY_LIMIT = 600;

/** What an app artifact keeps of its call. */
export interface AppCall {
  connectionId: string;
  connection: string;
  tool: string;
  uri: string;
  input: Record<string, unknown>;
  /** The result as the view gets it: its text, structured content and `_meta`. */
  result: { content: unknown[]; structuredContent?: unknown; _meta?: Record<string, unknown> };
  /** What the view last told the agent (`ui/update-model-context`). */
  context?: string;
}

interface View {
  html: string;
  gzip: Buffer;
  csp: { connectDomains?: string[]; resourceDomains?: string[] };
}

/** A domain a server named for its view: an https origin, or localhost for development. */
function origins(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.filter(
    (one): one is string =>
      typeof one === "string" &&
      /^(https:\/\/[a-z0-9.-]+(:\d+)?|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/i.test(one),
  );
}

/** The policy a view is served with: closed off, and open only to what its server named. */
export function viewPolicy(csp: View["csp"]): string {
  const connect = origins(csp.connectDomains).join(" ");
  const resources = origins(csp.resourceDomains).join(" ");
  return [
    "sandbox allow-scripts allow-forms",
    "default-src 'none'",
    `script-src 'unsafe-inline' data: blob: ${resources}`,
    `style-src 'unsafe-inline' ${resources}`,
    `img-src data: blob: ${resources}`,
    `font-src data: ${resources}`,
    `media-src data: blob: ${resources}`,
    `connect-src ${connect || "'none'"}`,
    "form-action 'none'",
    "base-uri 'none'",
  ]
    .map((part) => part.trim())
    .join("; ");
}

/** The policy of the host page: it frames the view and asks the home for this one artifact. */
function hostPolicy(home: string): string {
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    `connect-src ${home}`,
    `frame-src ${home}`,
    "frame-ancestors 'self'",
    "base-uri 'none'",
  ].join("; ");
}

export class Apps {
  private readonly home: Home;
  /** Views read from their servers, by connection and address. An address names one build. */
  private readonly views = new Map<string, View>();

  constructor(home: Home) {
    this.home = home;
  }

  /** The `ui://` view of a call, if its tool or its result names one. */
  viewOf(tool: ConnectionTool | undefined, carried: Carried | undefined): string | undefined {
    const ui = (carried?.meta?.ui as { resourceUri?: unknown } | undefined)?.resourceUri;
    const named = typeof ui === "string" ? ui : tool?.view;
    return named?.startsWith("ui://") ? named : undefined;
  }

  /** Keeps a call that has a view as an artifact of the conversation. */
  keep(input: {
    connection: Connection;
    tool: ConnectionTool | undefined;
    name: string;
    args: Record<string, unknown>;
    text: string;
    carried: Carried | undefined;
    conversationId: string;
  }): { id: string; title: string } | undefined {
    const uri = this.viewOf(input.tool, input.carried);
    if (!uri) return undefined;
    const call: AppCall = {
      connectionId: input.connection.id,
      connection: input.connection.name,
      tool: input.name,
      uri,
      input: input.args,
      result: {
        content: [{ type: "text", text: input.text }],
        ...(input.carried?.structured !== undefined
          ? { structuredContent: input.carried.structured }
          : {}),
        ...(input.carried?.meta ? { _meta: input.carried.meta } : {}),
      },
    };
    const artifact = this.home.artifacts.writeApp({
      title: input.tool?.title ?? `${input.connection.name}: ${input.name}`,
      summary: input.text.slice(0, SUMMARY_LIMIT),
      content: JSON.stringify(call),
      conversationId: input.conversationId,
    });
    return { id: artifact.id, title: artifact.title };
  }

  private call(id: string): AppCall | undefined {
    const artifact = this.home.artifacts.get(id);
    if (artifact?.format !== "app") return undefined;
    return JSON.parse(artifact.content) as AppCall;
  }

  /**
   * The view's HTML and policy. A server names a new address for each build of its view, so an
   * address the server no longer knows sends the home to read the connection's tools again
   * and take the tool's view as it is now.
   */
  private async read(call: AppCall, artifactId: string): Promise<View> {
    try {
      return await this.readAt(call);
    } catch (error) {
      const fresh = await this.home.connections
        .refreshTools(call.connectionId)
        .catch(() => undefined);
      const uri = fresh?.find((tool) => tool.name === call.tool)?.view;
      if (!uri || uri === call.uri) throw error;
      const moved = { ...call, uri };
      this.home.artifacts.setAppContent(artifactId, moved);
      return this.readAt(moved);
    }
  }

  /** The view at one address, read from its server once. */
  private async readAt(call: AppCall): Promise<View> {
    const key = `${call.connectionId}\n${call.uri}`;
    const known = this.views.get(key);
    if (known) return known;
    const read = (await this.home.connections.readResource(call.connectionId, call.uri)) as {
      contents?: {
        text?: string;
        blob?: string;
        mimeType?: string;
        _meta?: { ui?: { csp?: View["csp"] } };
      }[];
    };
    const content = read.contents?.find((one) => one.mimeType?.startsWith("text/html"));
    const html =
      content?.text ?? (content?.blob ? Buffer.from(content.blob, "base64").toString("utf8") : "");
    if (!html) throw new Error("The view is empty.");
    if (Buffer.byteLength(html) > VIEW_LIMIT) throw new Error("The view is too large.");
    const view = { html, gzip: gzipSync(html), csp: content?._meta?.ui?.csp ?? {} };
    this.views.set(key, view);
    return view;
  }

  /** `GET /v1/artifacts/:id/page` of an app: the view, under its server's policy. */
  async view(c: Context, artifact: { id: string }): Promise<Response> {
    const call = this.call(artifact.id);
    try {
      if (!call) throw new Error("no call");
      const view = await this.read(call, artifact.id);
      const headers = {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": viewPolicy(view.csp),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        vary: "accept-encoding",
      };
      // A view carries its whole app, so it travels packed where the browser takes that.
      if (!/\bgzip\b/.test(c.req.header("accept-encoding") ?? "")) {
        return c.body(view.html, 200, headers);
      }
      return c.body(new Uint8Array(view.gzip), 200, { ...headers, "content-encoding": "gzip" });
    } catch {
      return c.html("<p>The view could not be loaded from its service.</p>", 502, {
        "content-security-policy": "sandbox; default-src 'none'",
      });
    }
  }

  /** The routes the host page uses, with the artifact's key instead of a device token. */
  openRoutes(app: Hono, host: () => string | undefined): void {
    const opened = (c: Context): { id: string; call: AppCall } | undefined => {
      const id = c.req.param("id") ?? "";
      if (!this.home.artifacts.opens(id, c.req.query("until"), c.req.query("key"))) return;
      const call = this.call(id);
      return call ? { id, call } : undefined;
    };
    // The host page has no origin of its own to name: it is closed off.
    const cors = { "access-control-allow-origin": "null", vary: "origin" };
    const refused = (c: Context) =>
      c.json({ error: "forbidden", message: "This view is not open any more." }, 403, cors);

    app.get("/v1/artifacts/:id/host", (c) => {
      if (!opened(c)) return c.html("<p>This view is not open any more.</p>", 403);
      const html = host();
      if (!html) return c.html("<p>The web app is not built: run pnpm build.</p>", 503);
      const home = new URL(c.req.url).origin;
      return c.body(html, 200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": hostPolicy(home),
        "cache-control": "private, no-store",
        "referrer-policy": "no-referrer",
      });
    });

    app.options("/v1/artifacts/:id/app/*", (c) =>
      c.body(null, 204, {
        ...cors,
        "access-control-allow-methods": "GET, POST",
        "access-control-allow-headers": "content-type",
      }),
    );

    // What the call was: the view gets it as its tool input and result.
    app.get("/v1/artifacts/:id/app/call", (c) => {
      const found = opened(c);
      if (!found) return refused(c);
      const artifact = this.home.artifacts.get(found.id);
      return c.json(
        {
          title: artifact?.title,
          tool: found.call.tool,
          input: found.call.input,
          result: found.call.result,
        },
        200,
        cors,
      );
    });

    // A tool of the same connection, which the view calls.
    app.post("/v1/artifacts/:id/app/tool", async (c) => {
      const found = opened(c);
      if (!found) return refused(c);
      const body = z
        .object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) })
        .safeParse(await c.req.json().catch(() => null));
      if (!body.success) return c.json({ error: "invalid" }, 400, cors);
      return c.json(await this.useTool(found.id, found.call, body.data), 200, cors);
    });

    // What the view tells the agent; it reads it with the artifact.
    app.post("/v1/artifacts/:id/app/context", async (c) => {
      const found = opened(c);
      if (!found) return refused(c);
      const text = z
        .object({ text: z.string().max(4000) })
        .safeParse(await c.req.json().catch(() => null));
      if (!text.success) return c.json({ error: "invalid" }, 400, cors);
      this.home.artifacts.setAppContent(found.id, { ...found.call, context: text.data.text });
      return c.json({ ok: true }, 200, cors);
    });

    // A message the view sends as the person, who pressed something in it.
    app.post("/v1/artifacts/:id/app/message", async (c) => {
      const found = opened(c);
      if (!found) return refused(c);
      const text = z
        .object({ text: z.string().min(1).max(4000) })
        .safeParse(await c.req.json().catch(() => null));
      if (!text.success) return c.json({ error: "invalid" }, 400, cors);
      const artifact = this.home.artifacts.get(found.id);
      if (!artifact) return refused(c);
      this.home.store.addMessage({
        conversationId: artifact.conversationId,
        role: "you",
        channel: "app",
        parts: [{ type: "text", text: text.data.text }],
      });
      void this.home.turns.enqueue({
        conversationId: artifact.conversationId,
        // What the view sends came from the server's page: data the person sent along.
        text: `From the view "${artifact.title}" of ${found.call.connection}, sent by the person:\n${text.data.text}`,
        channel: "app",
      });
      return c.json({ ok: true }, 200, cors);
    });
  }

  /**
   * Runs a tool the view calls. The person pressed something in it, so it runs without a card;
   * a tool that changes something for good asks the person in the chat first, and a tool the
   * person never allows is refused.
   */
  private async useTool(
    id: string,
    call: AppCall,
    input: { name: string; arguments: Record<string, unknown> },
  ): Promise<{
    content: unknown[];
    isError?: boolean;
    structuredContent?: unknown;
    _meta?: unknown;
  }> {
    const failed = (text: string) => ({ content: [{ type: "text", text }], isError: true });
    const connection = this.home.connections.byName(call.connection);
    if (connection?.state !== "connected") return failed(`${call.connection} is not connected.`);
    const tool = connection.tools.find((one) => one.name === input.name);
    if (!tool) return failed(`${call.connection} has no tool ${input.name}.`);
    if (connection.policies[tool.name] === "never")
      return failed("The person does not allow this tool.");
    if (tool.destructive) {
      const artifact = this.home.artifacts.get(id);
      if (artifact) this.home.connections.askFromView(artifact, connection, tool, input.arguments);
      return failed("This changes something for good: the person is asked in the chat first.");
    }
    const step = await this.home.connections.use(connection, tool.name, input.arguments);
    if (!("result" in step)) {
      if ("held" in step) this.home.connections.dropCall(step.held);
      return failed("The service wants to ask the person something: use it from the chat.");
    }
    const text = typeof step.result === "string" ? step.result : step.result.text;
    return {
      content: [{ type: "text", text }],
      ...(step.carried?.structured !== undefined
        ? { structuredContent: step.carried.structured }
        : {}),
      ...(step.carried?.meta ? { _meta: step.carried.meta } : {}),
    };
  }
}
