import { randomBytes } from "node:crypto";
import { noopLogger } from "@mastra/core/logger";
import { MCPClient } from "@mastra/mcp";
import {
  auth,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthTokens,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import { type Call, defineTool, ENDS_TURN, type Looked, type Tool } from "../agent/tool.ts";
import type { TurnContext } from "../agent/turns.ts";
import type { Home } from "../home.ts";
import { newId, now } from "../ids.ts";
import {
  Calls,
  type Carried,
  HOLD_MS,
  type Question,
  type Step,
  TASK_MS,
  type Where,
} from "./calls.ts";
import { contentOf, type ElicitAnswer } from "./elicitation.ts";

const REGISTRY = "https://registry.modelcontextprotocol.io/v0/servers";

/** Where `connection_call` was when it asked the person. */
type Kept =
  | { stage: "approval" }
  /** The connection's server asked: the call it waits in, and its question. */
  | { stage: "question"; held: string; question: Question };

/** One tool of a connection as Mastra's client gives it. */
interface Runs {
  execute(
    args: unknown,
    context: { abortSignal: AbortSignal; writer?: { write(chunk: unknown): Promise<void> } },
  ): Promise<unknown>;
}

export interface ConnectionTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: unknown;
  /** The server says the tool only reads. Everything else asks the person first. */
  readOnly: boolean;
  /** Only the server's own view calls it (MCP Apps `visibility: ["app"]`), never the agent. */
  appOnly?: boolean;
  /** The view the server shows the tool's result in (MCP Apps), a `ui://` resource. */
  view?: string;
  /** The server says the tool may change something for good. */
  destructive?: boolean;
}

/** As much of a tool's description as the home keeps. */
const DESCRIPTION_LIMIT = 4000;
/** How long a tool's line in the list may be. */
const LINE_LIMIT = 160;

/** A tool's description in one line: its first sentence. */
function firstSentence(description: string): string {
  const flat = description.replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](\s|$)/);
  const sentence = end >= 0 ? flat.slice(0, end + 1) : flat;
  return sentence.length > LINE_LIMIT ? `${sentence.slice(0, LINE_LIMIT - 1)}…` : sentence;
}

/** The `ui://` view of a tool, as MCP Apps (or the older OpenAI key) names it. */
function viewOf(meta: unknown): string | undefined {
  const m = meta as
    | { ui?: { resourceUri?: unknown }; "openai/outputTemplate"?: unknown }
    | undefined;
  const uri = m?.ui?.resourceUri ?? m?.["openai/outputTemplate"];
  return typeof uri === "string" && uri.startsWith("ui://") ? uri : undefined;
}

/** Who may call a tool, as its MCP Apps metadata says. */
function appOnlyOf(meta: unknown): boolean {
  const visibility = (meta as { ui?: { visibility?: unknown } } | undefined)?.ui?.visibility;
  return Array.isArray(visibility) && visibility.length > 0 && !visibility.includes("model");
}

export interface Connection {
  id: string;
  name: string;
  url: string;
  state: "needs_sign_in" | "connected" | "failed";
  tools: ConnectionTool[];
  /** Per tool: `always` runs without asking, `never` refuses. */
  policies: Record<string, "always" | "never">;
}

interface Row {
  id: string;
  name: string;
  url: string;
  state: string;
  tools: string;
  policies: string;
}

interface OAuthState {
  state?: string;
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
}

/** A connection's sign-in, kept in the home's secrets. */
class StoredOAuth implements OAuthClientProvider {
  /** Where the person signs in, once the server asked for it. */
  pending: URL | undefined;
  private readonly home: Home;
  private readonly connectionId: string;

  constructor(home: Home, connectionId: string) {
    this.home = home;
    this.connectionId = connectionId;
  }

  get redirectUrl(): string {
    const base = this.home.config.publicUrl ?? `http://localhost:${this.home.config.port}`;
    return `${base}/oauth/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "wizards.bot",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    const state = randomBytes(16).toString("base64url");
    this.save({ state });
    return state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.load().client;
  }

  saveClientInformation(client: OAuthClientInformationMixed): void {
    this.save({ client });
  }

  tokens(): OAuthTokens | undefined {
    return this.load().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.save({ tokens });
  }

  redirectToAuthorization(url: URL): void {
    this.pending = url;
  }

  saveCodeVerifier(verifier: string): void {
    this.save({ verifier });
  }

  codeVerifier(): string {
    return this.load().verifier ?? "";
  }

  load(): OAuthState {
    return JSON.parse(
      this.home.secrets.get(`connection.${this.connectionId}.oauth`) ?? "{}",
    ) as OAuthState;
  }

  private save(patch: OAuthState): void {
    this.home.secrets.set(
      `connection.${this.connectionId}.oauth`,
      JSON.stringify({ ...this.load(), ...patch }),
    );
  }
}

/** The person's accounts and apps, reached over MCP and set up in the conversation. */
export class Connections {
  /** Mastra's MCP client of each connected connection, and its tools to run. */
  private readonly clients = new Map<string, MCPClient>();
  private readonly runs = new Map<string, Record<string, Runs>>();
  private readonly home: Home;
  private readonly calls: Calls;

  constructor(home: Home) {
    this.home = home;
    this.calls = new Calls({
      over: (held, connection, tool, said) => {
        // The server gave up, or the home did: the question's card is closed, the agent hears it.
        const card = this.waiting().find((one) => one.kept.held === held)?.card;
        if (!card) return;
        home.store.expireCard(card.id);
        home.tell(
          card.conversationId,
          `${connection.name} asked the person something during ${tool} and stopped waiting before an answer came. The card is closed. If the person still wants it, use the tool again. ${connection.name} said:\n${said}`,
        );
      },
      asked: (held, connection, tool, question, where) =>
        this.askLater(held, connection, tool, question, where),
      finished: (held, connection, tool, ended, where) => {
        // A question of the task that is still open is over with it.
        for (const card of this.later())
          if (card.payload.held === held) home.store.expireCard(card.id);
        const said =
          "error" in ended
            ? `The tool failed: ${ended.error.message}`
            : typeof ended.result === "string"
              ? ended.result
              : ended.result.text;
        this.ended(
          where,
          connection.name,
          tool,
          said,
          "error" in ended ? undefined : ended.carried,
        );
      },
    });
    // No call survives a start of the home: a card of a server's question is over.
    for (const { card } of this.waiting()) home.store.expireCard(card.id);
    for (const card of this.later()) {
      home.store.expireCard(card.id);
      home.tell(
        card.conversationId,
        `${String(card.payload.connection)} was running ${String(card.payload.tool)} as a task when the Bot Server started again; the home follows it no more and its question is closed. The task may still go on at ${String(card.payload.connection)} itself.`,
      );
    }
    home.addTools((context) => this.tools(context));
    this.registerCards();
  }

  /** The open cards of questions a task asked after its turn. */
  private later() {
    return this.home.store.items().flatMap((card) => {
      const payload = this.home.store.cardPayload<Record<string, unknown>>(card.id);
      return payload?.type === "connection_task" ? [{ ...card, payload }] : [];
    });
  }

  /** A card in the conversation for what a task asks after its turn. */
  private askLater(
    held: string,
    connection: { id: string; name: string },
    tool: string,
    question: Question,
    where: Where,
  ): void {
    const shown = this.calls.card(connection, question);
    if ("refused" in shown) {
      this.calls.reply(held, { action: "decline" });
      this.home.tell(
        where.conversationId,
        `${connection.name} asked something during ${tool} that the Bot Server does not show: ${shown.refused}. It was told no.`,
      );
      return;
    }
    const { store } = this.home;
    const empty = store.addMessage({
      conversationId: where.conversationId,
      role: "agent",
      agentId: where.agentId,
      channel: "home",
      parts: [],
    });
    const card = store.createCard(
      {
        ...shown,
        payload: { type: "connection_task", held, question, connection: connection.name, tool },
      },
      { agentId: where.agentId, conversationId: where.conversationId, messageId: empty.id },
    );
    store.updateMessage(empty.id, { parts: [{ type: "card", card }] });
  }

  /** Tells the conversation what a task came to. */
  private ended(
    where: Where,
    connection: string,
    tool: string,
    said: string,
    carried?: Carried,
  ): void {
    const found = this.byName(connection);
    const kept = found
      ? this.home.apps.keep({
          connection: found,
          tool: found.tools.find((one) => one.name === tool),
          name: tool,
          args: {},
          text: said,
          carried,
          conversationId: where.conversationId,
        })
      : undefined;
    if (kept) {
      // The view stands in the chat where the task ended.
      const message = this.home.store.addMessage({
        conversationId: where.conversationId,
        role: "agent",
        agentId: where.agentId,
        channel: "home",
        parts: [{ type: "artifact", artifactId: kept.id, title: kept.title }],
      });
      void message;
    }
    this.home.tell(
      where.conversationId,
      `${connection} finished ${tool}, which ran as a task:\n${said}${kept ? `\n\nIts view stands in the chat (${kept.id}).` : ""}`,
    );
  }

  /** The open cards of questions a connection's server asked. */
  private waiting() {
    return this.home.store.items().flatMap((card) => {
      const payload = this.home.store.cardPayload<{ type?: string; tool?: string; kept?: Kept }>(
        card.id,
      );
      const kept = payload?.kept;
      return payload?.type === "tool" &&
        payload.tool === "connection_call" &&
        kept?.stage === "question"
        ? [{ card, kept }]
        : [];
    });
  }

  list(): Connection[] {
    return this.home.db.all<Row>("select * from connection order by name").map(toConnection);
  }

  names(): string[] {
    return this.list()
      .filter((connection) => connection.state === "connected")
      .map((connection) => connection.name);
  }

  byName(name: string): Connection | undefined {
    const row = this.home.db.get<Row>(
      "select * from connection where name = ?",
      name.toLowerCase(),
    );
    return row ? toConnection(row) : undefined;
  }

  /**
   * Adds a connection and tries it. `signIn` is set when the server wants the person to
   * sign in first.
   */
  async add(input: {
    name: string;
    url: string;
    key?: string;
  }): Promise<{ connection: Connection; signIn?: string }> {
    const name = input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const existing = this.byName(name);
    const id = existing?.id ?? newId("con");
    if (!existing) {
      this.home.db.run(
        "insert into connection (id, name, url, state, created_at) values (?, ?, ?, 'failed', ?)",
        id,
        name,
        input.url,
        now(),
      );
    } else {
      this.home.db.run("update connection set url = ? where id = ?", input.url, id);
    }
    if (input.key) this.home.secrets.set(`connection.${id}.key`, input.key);
    const signIn = await this.connect(id);
    return { connection: this.byName(name) as Connection, signIn };
  }

  /** Finishes a sign-in from the address the person was sent back to. */
  async finishSignIn(
    state: string,
    code: string,
    issuer?: string,
  ): Promise<Connection | undefined> {
    for (const connection of this.list()) {
      const oauth = new StoredOAuth(this.home, connection.id);
      if (oauth.load().state !== state) continue;
      await auth(oauth, { serverUrl: connection.url, authorizationCode: code, iss: issuer });
      await this.connect(connection.id);
      return this.byName(connection.name);
    }
    return undefined;
  }

  /**
   * Uses one tool outside a conversation, where nobody can be asked. Returns nothing when
   * the service wants something from the person first: the call is ended.
   */
  async call(
    connection: Connection,
    tool: string,
    args: Record<string, unknown>,
    _at?: unknown,
  ): Promise<string | undefined> {
    const step = await this.use(connection, tool, args);
    // Nobody can be asked here, nor told later.
    if ("asks" in step || "started" in step) {
      this.calls.drop(step.held);
      return undefined;
    }
    return typeof step.result === "string" ? step.result : step.result.text;
  }

  /** Starts one tool and waits until it answers or its server asks the person. */
  async use(connection: Connection, tool: string, args: Record<string, unknown>): Promise<Step> {
    if (!this.clients.has(connection.id)) await this.reconnect(connection.id);
    const runs = this.runs.get(connection.id)?.[tool];
    if (!runs) throw new Error(`${connection.name} has no tool ${tool} any more.`);
    return this.calls.start(connection, tool, (abortSignal, writer) =>
      runs.execute(args, { abortSignal, writer }),
    );
  }

  /** Reads one resource of a connection's server: an MCP Apps view (connections/apps.ts). */
  async readResource(connectionId: string, uri: string): Promise<unknown> {
    const row = this.home.db.get<Row>("select * from connection where id = ?", connectionId);
    if (!row) throw new Error("The connection is gone.");
    const client = this.clients.get(connectionId) ?? (await this.reconnect(connectionId));
    return client.resources.read(row.name, uri);
  }

  /** Ends a call nobody will answer. */
  dropCall(held: string): void {
    this.calls.drop(held);
  }

  /**
   * A view asks for a tool that changes something for good: the person decides on a card in
   * the conversation, and the agent hears what came of it.
   */
  askFromView(
    artifact: { id: string; title: string; conversationId: string },
    connection: Connection,
    tool: ConnectionTool,
    args: Record<string, unknown>,
  ): void {
    const { store } = this.home;
    const agent = store.agents().find((one) => one.conversationId === artifact.conversationId);
    if (!agent) return;
    const empty = store.addMessage({
      conversationId: artifact.conversationId,
      role: "agent",
      agentId: agent.id,
      channel: "home",
      parts: [],
    });
    const card = store.createCard(
      {
        kind: "approval",
        level: "needs_you",
        title: `"${artifact.title}" wants to use ${tool.title ?? tool.name}`,
        body: `**${connection.name}** · \`${tool.name}\`\n\n\`\`\`json\n${JSON.stringify(args, null, 2).slice(0, 1500)}\n\`\`\``,
        actions: [
          { id: "once", label: "Allow once", style: "primary" },
          { id: "deny", label: "Don't", style: "plain" },
        ],
        payload: { type: "app_tool", connection: connection.name, tool: tool.name, args },
      },
      { agentId: agent.id, conversationId: artifact.conversationId, messageId: empty.id },
    );
    store.updateMessage(empty.id, { parts: [{ type: "card", card }] });
  }

  remove(connection: Connection): void {
    void this.clients
      .get(connection.id)
      ?.disconnect()
      .catch(() => {});
    this.clients.delete(connection.id);
    this.home.secrets.delete(`connection.${connection.id}.oauth`);
    this.home.secrets.delete(`connection.${connection.id}.key`);
    this.home.db.run("delete from connection where id = ?", connection.id);
  }

  setPolicy(connection: Connection, tool: string, policy: "always" | "never"): void {
    this.home.db.run(
      "update connection set policies = ? where id = ?",
      JSON.stringify({ ...connection.policies, [tool]: policy }),
      connection.id,
    );
  }

  close(): void {
    this.calls.stop();
    for (const client of this.clients.values()) void client.disconnect().catch(() => {});
    this.clients.clear();
  }

  private async reconnect(id: string): Promise<MCPClient> {
    const signIn = await this.connect(id);
    const client = this.clients.get(id);
    if (!client)
      throw new Error(
        signIn ? "This account needs a new sign-in." : "The connection does not answer.",
      );
    return client;
  }

  /** Connects and reads the tools. Returns the sign-in address when the server asks for one. */
  private async connect(id: string): Promise<string | undefined> {
    const row = this.home.db.get<Row>("select * from connection where id = ?", id);
    if (!row) return undefined;
    const oauth = new StoredOAuth(this.home, id);
    const key = this.home.secrets.get(`connection.${id}.key`);
    await this.clients
      .get(id)
      ?.disconnect()
      .catch(() => {});
    this.clients.delete(id);
    const client = new MCPClient({
      id: `connection-${id}`,
      // The home ends its connections itself when it closes.
      registerProcessHooks: false,
      // A call stays open while its server waits for the person.
      timeout: HOLD_MS * 2,
      servers: {
        [row.name]: {
          url: new URL(row.url),
          ...(key
            ? {
                requestInit: {
                  headers: { Authorization: key.startsWith("Bearer ") ? key : `Bearer ${key}` },
                },
              }
            : { authProvider: oauth }),
          clientInfo: { name: "wizards.bot", version: "1" },
          // A failed tool comes back as its answer, for the agent to read.
          onToolError: "return",
          // The home shows forms and pages a server asks for, as cards.
          capabilities: { elicitation: { form: {}, url: {} } },
          inputRequests: this.calls.handler(id),
          // A server may run a long call as a task (MCP Tasks): Mastra follows it to its end.
          tasks: { maxWaitMs: TASK_MS },
        },
      },
    });
    // What fails is told to the agent or the person, not written to the console.
    client.__setLogger(noopLogger);
    try {
      const listed = await client.listToolDefinitionsWithErrors();
      const found = listed.definitions[row.name];
      if (!found) throw new Error(listed.errors[row.name] ?? "The connection does not answer.");
      const tools: ConnectionTool[] = Object.values(found).map((tool) => ({
        name: tool.name,
        ...(tool.title ? { title: tool.title } : {}),
        description: (tool.description ?? "").slice(0, DESCRIPTION_LIMIT),
        inputSchema: tool.inputSchema,
        readOnly: tool.annotations?.readOnlyHint === true,
        ...(appOnlyOf(tool._meta) ? { appOnly: true } : {}),
        ...(viewOf(tool._meta) ? { view: viewOf(tool._meta) } : {}),
        ...(tool.annotations?.destructiveHint === true ? { destructive: true } : {}),
      }));
      this.clients.set(id, client);
      this.runs.set(id, ((await client.listToolsets())[row.name] ?? {}) as Record<string, Runs>);
      this.home.db.run(
        "update connection set state = 'connected', tools = ? where id = ?",
        JSON.stringify(tools),
        id,
      );
      return undefined;
    } catch (error) {
      await client.disconnect().catch(() => {});
      if (oauth.pending) {
        this.home.db.run("update connection set state = 'needs_sign_in' where id = ?", id);
        return oauth.pending.toString();
      }
      this.home.db.run("update connection set state = 'failed' where id = ?", id);
      throw error;
    }
  }

  /** Shows what a call came to: its answer, or the card of what its server asks. */
  private shown(
    connection: Connection,
    step: Step,
    call: Call,
    where: Where,
    view?: { tool: ConnectionTool; args: Record<string, unknown>; draft: TurnContext["draft"] },
  ): Promise<string | Looked> {
    if ("result" in step) {
      // A result with a view of its server: it stands in the chat, the agent hears it is there.
      const text = typeof step.result === "string" ? step.result : step.result.text;
      const kept = view
        ? this.home.apps.keep({
            connection,
            tool: view.tool,
            name: view.tool.name,
            args: view.args,
            text,
            carried: step.carried,
            conversationId: where.conversationId,
          })
        : undefined;
      if (!kept || !view) return Promise.resolve(step.result);
      view.draft.add({ type: "artifact", artifactId: kept.id, title: kept.title });
      const note = `\n\n${connection.name} shows this in a view of its own, which the person sees in the chat (${kept.id}). Do not repeat what it shows.`;
      return Promise.resolve(
        typeof step.result === "string"
          ? step.result + note
          : { ...step.result, text: step.result.text + note },
      );
    }
    if ("started" in step) {
      this.calls.background(step.held, where);
      return Promise.resolve(
        `${connection.name} runs this as a task (${step.started}), which goes on after your turn. The home tells you in this conversation when it ends, and asks the person with a card when it needs them. Say so in one sentence; do not call it again.`,
      );
    }
    const card = this.calls.card(connection, step.asks);
    // The handler showed the same question before it let the call wait.
    if ("refused" in card) return Promise.resolve(`The tool failed: ${card.refused}.`);
    return call.ask(card, { stage: "question", held: step.held, question: step.asks });
  }

  // ── What the agent can do ─────────────────────────────────────────────────

  private tools(context: TurnContext): Tool[] {
    const { home, agent, conversationId, draft } = context;
    const where = { agentId: agent.id, conversationId, messageId: draft.id };
    const use: Tool[] = [
      defineTool({
        name: "connection_tools",
        description:
          "List what a connected account or app can do: one line per tool. Name a tool to get all it says about itself and its input, before you call it.",
        input: z.object({
          name: z.string().describe("The connection."),
          tool: z.string().optional().describe("One of its tools, in full."),
        }),
        label: (input) => `Looking at ${String(input.tool ?? input.name ?? "a connection")}`,
        run: async (input) => {
          const connection = this.byName(input.name);
          if (!connection)
            return `There is no connection ${input.name}. Connected: ${this.names().join(", ") || "none"}.`;
          if (connection.state !== "connected")
            return `${connection.name} is not connected (${connection.state}).`;
          const tools = connection.tools.filter((tool) => !tool.appOnly);
          const what = (tool: ConnectionTool) =>
            tool.readOnly ? "reads" : "changes something: the person is asked first";
          if (input.tool) {
            const tool = tools.find((candidate) => candidate.name === input.tool);
            if (!tool)
              return `${connection.name} has no tool ${input.tool}. Its tools: ${tools.map((t) => t.name).join(", ")}.`;
            return `${tool.name}${tool.title ? ` (${tool.title})` : ""}, ${what(tool)}\n\n${tool.description}\n\ninput: ${JSON.stringify(tool.inputSchema)}`;
          }
          return tools
            .map((tool) => `- ${tool.name} (${what(tool)}): ${firstSentence(tool.description)}`)
            .join("\n");
        },
      }),
      defineTool({
        name: "connection_call",
        description:
          "Use one tool of a connected account or app. A tool that changes something shows the person an approval card first and ends your turn. The service may also ask the person something itself: that is a card too, and its answer goes to the service, not to you.",
        input: z.object({
          name: z.string().describe("The connection."),
          tool: z.string(),
          arguments: z.record(z.string(), z.unknown()).default({}),
          why: z.string().describe("One sentence for the person: what this does."),
        }),
        label: (input) => `${String(input.name ?? "")}: ${String(input.tool ?? "")}`,
        asks: true,
        run: async (input, call) => {
          const connection = this.byName(input.name);
          if (connection?.state !== "connected") return `${input.name} is not connected.`;
          const tool = connection.tools.find(
            (candidate) => candidate.name === input.tool && !candidate.appOnly,
          );
          if (!tool)
            return `${connection.name} has no tool ${input.tool}. Call connection_tools first.`;
          const policy = connection.policies[tool.name];
          if (policy === "never") return "The person does not allow this tool.";
          const go = async () =>
            this.shown(
              connection,
              await this.use(connection, tool.name, input.arguments),
              call,
              { agentId: agent.id, conversationId },
              { tool, args: input.arguments, draft },
            );
          const kept = call.answer?.kept as Kept | undefined;
          if (!call.answer || !kept) {
            // In a turn that read data from outside the home, "always" does not count: what
            // changes something asks, so nothing that arrived can make the agent act.
            if (tool.readOnly || (policy === "always" && !context.outside())) return go();
            return call.ask(
              {
                kind: "approval",
                level: "needs_you",
                title: input.why,
                body: `**${connection.name}** · \`${tool.name}\`\n\n\`\`\`json\n${JSON.stringify(input.arguments, null, 2).slice(0, 1500)}\n\`\`\``,
                actions: [
                  { id: "once", label: "Allow once", style: "primary" },
                  { id: "always", label: "Always allow", style: "plain" },
                  { id: "deny", label: "Don't", style: "plain" },
                ],
              },
              { stage: "approval" } satisfies Kept,
            );
          }
          const { action, values, card } = call.answer;
          if (kept.stage === "approval") {
            if (action === "deny")
              return `The person said no to "${card.title}". Do not try it another way.`;
            if (action === "always") this.setPolicy(connection, tool.name, "always");
            return go();
          }

          // The connection's server asked, and this is the person's answer to it.
          const answer: ElicitAnswer = {
            action: action === "accept" || action === "decline" ? action : "cancel",
          };
          if (answer.action === "accept" && kept.question.mode !== "url") {
            const checked = contentOf(kept.question.requestedSchema, values);
            if ("problems" in checked) {
              // What was typed does not fit and is gone: the same question, once more.
              const again = this.calls.card(connection, kept.question, checked.problems);
              return "refused" in again
                ? `The tool failed: ${again.refused}.`
                : call.ask(again, kept);
            }
            answer.content = checked.content;
          }
          const next = this.calls.answer(kept.held, answer);
          if (!next)
            return `${connection.name} is not waiting any more for what it asked during ${tool.name}. Nothing was sent. If the person still wants it, use the tool again.`;
          const said =
            answer.action === "accept"
              ? ""
              : answer.action === "decline"
                ? `The person said no to what ${connection.name} asked. Do not try it another way. ${connection.name} answered:\n`
                : `The person put off what ${connection.name} asked. ${connection.name} answered:\n`;
          const result = await this.shown(
            connection,
            await next,
            call,
            { agentId: agent.id, conversationId },
            { tool, args: input.arguments, draft },
          );
          if (!said || result === ENDS_TURN) return result;
          return typeof result === "string"
            ? said + result
            : { ...result, text: said + result.text };
        },
      }),
    ];
    if (!agent.main) return use;
    return [
      ...use,
      defineTool({
        name: "connection_find",
        description:
          "Search the public MCP registry for a service the person wants to connect (calendar, mail, notes, a shop…).",
        input: z.object({ query: z.string() }),
        label: (input) => `Searching for ${String(input.query ?? "")}`,
        run: async (input) => {
          const response = await fetch(
            `${REGISTRY}?search=${encodeURIComponent(input.query)}&limit=8`,
            {
              signal: AbortSignal.timeout(10_000),
            },
          );
          if (!response.ok) return `The registry did not answer (${response.status}).`;
          const body = (await response.json()) as {
            servers?: {
              server: {
                name: string;
                title?: string;
                description?: string;
                remotes?: { type: string; url: string; headers?: unknown[] }[];
              };
            }[];
          };
          const lines = (body.servers ?? [])
            .map(({ server }) => {
              const remote = server.remotes?.find(
                (candidate) => candidate.type === "streamable-http",
              );
              if (!remote) return "";
              return `- ${server.title ?? server.name}: ${server.description ?? ""}\n  url: ${remote.url}${remote.headers?.length ? " (needs a key)" : " (sign-in or open)"}`;
            })
            .filter(Boolean);
          return (
            lines.join("\n") ||
            "Nothing found that a Bot Server can reach over the internet. Ask the person for the service's MCP address."
          );
        },
      }),
      defineTool({
        name: "connection_add",
        description:
          "Connect an account or app by its MCP address. When it needs a sign-in or a key, a card appears and your turn ends.",
        input: z.object({
          name: z.string().describe("Short name, e.g. notion."),
          url: z.string().url(),
          needsKey: z
            .boolean()
            .optional()
            .describe("The service takes an API key instead of a sign-in."),
        }),
        label: (input) => `Connecting ${String(input.name ?? "")}`,
        run: async (input) => {
          if (input.needsKey) {
            const card = home.store.createCard(
              {
                kind: "secret",
                level: "needs_you",
                title: `Key for ${input.name}`,
                body: "The key stays on your Bot Server. No model reads it.",
                fields: [{ id: "key", label: "API key", type: "secret", required: true }],
                actions: [
                  { id: "save", label: "Save key", style: "primary" },
                  { id: "cancel", label: "Not now", style: "plain" },
                ],
                payload: { type: "connection_key", name: input.name, url: input.url },
              },
              where,
            );
            draft.add({ type: "card", card });
            return ENDS_TURN;
          }
          try {
            const { connection, signIn } = await this.add(input);
            if (!signIn)
              return `${connection.name} is connected with ${connection.tools.length} tools.`;
            const card = home.store.createCard(
              {
                kind: "connect",
                level: "needs_you",
                title: `Sign in to ${connection.name}`,
                body: "The sign-in opens in your browser. Your Bot Server keeps the access, no model reads it.",
                url: signIn,
                actions: [{ id: "cancel", label: "Not now", style: "plain" }],
                payload: { type: "connection", connectionId: connection.id, name: connection.name },
              },
              where,
            );
            draft.add({ type: "card", card });
            return ENDS_TURN;
          } catch (error) {
            return `Connecting failed: ${(error as Error).message}. The address may be wrong, or the service needs a key.`;
          }
        },
      }),
      defineTool({
        name: "connection_remove",
        description: "Disconnect an account or app and forget its sign-in.",
        input: z.object({ name: z.string() }),
        label: (input) => `Disconnecting ${String(input.name ?? "")}`,
        run: async (input) => {
          const connection = this.byName(input.name);
          if (!connection) return `There is no connection ${input.name}.`;
          this.remove(connection);
          return `${connection.name} is disconnected.`;
        },
      }),
    ];
  }

  private registerCards(): void {
    const { home } = this;
    // The person decided on a tool a view asked for: it runs, and the agent hears the result.
    home.onCard("app_tool", async ({ card, action, payload }) => {
      const name = String(payload.connection);
      const toolName = String(payload.tool);
      if (action !== "once")
        return home.tell(
          card.conversationId,
          `The person did not let a view of ${name} use ${toolName}.`,
        );
      const connection = this.byName(name);
      if (connection?.state !== "connected")
        return home.tell(card.conversationId, `${name} is not connected.`);
      const step = await this.use(connection, toolName, payload.args as Record<string, unknown>);
      if (!("result" in step)) {
        this.calls.drop(step.held);
        return home.tell(
          card.conversationId,
          `${name} wanted to ask the person something during ${toolName}; use it from the chat.`,
        );
      }
      const text = typeof step.result === "string" ? step.result : step.result.text;
      home.tell(
        card.conversationId,
        `A view of ${name} used ${toolName}, which the person allowed. It answered:\n${text}`,
      );
    });
    // The person answered what a task asked after its turn: the answer goes to the server.
    home.onCard("connection_task", ({ card, action, values, payload }) => {
      const held = String(payload.held);
      const question = payload.question as Question;
      const name = String(payload.connection);
      const answer: ElicitAnswer = {
        action: action === "accept" || action === "decline" ? action : "cancel",
      };
      if (answer.action === "accept" && question.mode !== "url") {
        const checked = contentOf(question.requestedSchema, values);
        if ("problems" in checked) {
          // What was typed does not fit: the same question once more, the task still waits.
          const again = this.calls.card({ id: "", name }, question, checked.problems);
          if (!("refused" in again)) {
            const empty = home.store.addMessage({
              conversationId: card.conversationId,
              role: "agent",
              agentId: card.agentId,
              channel: "home",
              parts: [],
            });
            const next = home.store.createCard(
              { ...again, payload },
              { agentId: card.agentId, conversationId: card.conversationId, messageId: empty.id },
            );
            home.store.updateMessage(empty.id, { parts: [{ type: "card", card: next }] });
          }
          return;
        }
        answer.content = checked.content;
      }
      if (!this.calls.reply(held, answer))
        home.tell(
          card.conversationId,
          `${name} is not waiting any more for what it asked during ${String(payload.tool)}. Nothing was sent.`,
        );
    });
    home.onCard("connection", ({ card, action, payload }) => {
      const name = String(payload.name);
      if (action === "cancel") {
        const connection = this.byName(name);
        if (connection) this.remove(connection);
        return home.tell(card.conversationId, `The person did not sign in to ${name}.`);
      }
      const connection = this.byName(name);
      home.tell(
        card.conversationId,
        `${name} is connected with ${connection?.tools.length ?? 0} tools. Say so in one sentence and go on with what the person wanted.`,
      );
    });
    home.onCard("connection_key", async ({ card, action, values, payload }) => {
      const name = String(payload.name);
      if (action !== "save" || typeof values.key !== "string" || !values.key.trim()) {
        return home.tell(card.conversationId, `The person gave no key for ${name}.`);
      }
      try {
        const { connection } = await this.add({
          name,
          url: String(payload.url),
          key: values.key.trim(),
        });
        home.tell(
          card.conversationId,
          `${connection.name} is connected with ${connection.tools.length} tools. Say so in one sentence and go on.`,
        );
      } catch (error) {
        home.tell(
          card.conversationId,
          `Connecting ${name} with the key failed: ${(error as Error).message}`,
        );
      }
    });
  }
}

function toConnection(row: Row): Connection {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    state: row.state as Connection["state"],
    tools: JSON.parse(row.tools) as ConnectionTool[],
    policies: JSON.parse(row.policies) as Connection["policies"],
  };
}
