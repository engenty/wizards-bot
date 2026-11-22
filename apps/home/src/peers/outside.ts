import { EngentyKind } from "@wizards-bot/protocol";
import { z } from "zod";
import { defineTool, type Tool } from "../agent/tool.ts";
import type { TurnContext } from "../agent/turns.ts";
import type { Home } from "../home.ts";
import { sha256 } from "../identity.ts";
import { newId, newToken, now } from "../ids.ts";
import type { AgentRecord, NewCard } from "../store/store.ts";
import {
  A2A_VERSIONS,
  A2AAgent,
  type Fetch,
  guarded,
  inThread,
  isPrivateHost,
  type OutsideCard,
  outsideUrl,
  readCard,
  refusedWith,
  say,
  taskIsGone,
} from "./a2a.ts";

// Agents that are not wizards.bot homes, in both directions. An outside agent is added by the
// address of its A2A agent card and then stands among the person's agents; talking to it is
// Mastra's `A2AAgent`, with the home's sign-in and conversation around it. A caller is an
// outside agent the person lets write to one of their own agents: it signs in with an access
// token the home made for it and reaches that one agent in a conversation of its own.

const ENDS_TURN =
  "The card is in the chat. End your turn now with at most one short sentence. The answer arrives as the next message.";
const ANSWER_WAIT_MS = 6 * 60_000;

/** An outside agent the person let write to one of their agents. */
export interface Caller {
  id: string;
  agentId: string;
  name: string;
  createdAt: string;
  heardAt?: string;
}

interface CallerRow {
  id: string;
  agent_id: string;
  name: string;
  created_at: string;
  heard_at: string | null;
}

interface OutsideRow {
  agent_id: string;
  card_url: string;
  tenant: string | null;
  version: string;
  sign_in: string;
  context_id: string | null;
  task_id: string | null;
}

const SignInShape = z.union([
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("bearer") }),
  z.object({
    kind: z.literal("apiKey"),
    location: z.enum(["header", "query", "cookie"]),
    name: z.string(),
  }),
]);

/** What the person said yes to when they added an outside agent. */
const AddPayload = z.object({
  cardUrl: z.string(),
  url: z.string(),
  version: z.enum(A2A_VERSIONS),
  tenant: z.string().optional(),
  name: z.string(),
  about: z.string(),
  kind: EngentyKind,
  from: z.string(),
  signIn: SignInShape,
});

const secretOf = (agentId: string): string => `outside.${agentId}`;

/** A text from an agent's card as one line a card shows as it is, not as Markdown. */
const plain = (text: string, limit: number): string =>
  text
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit)
    .replace(/([\\`*_{}[\]<>()#+!|~])/g, "\\$1");

export class Outside {
  private readonly home: Home;
  /** Mastra's client for each outside agent that was written to since the home started. */
  private readonly remotes = new Map<string, A2AAgent>();

  constructor(home: Home) {
    this.home = home;
    home.addTools((context) => this.tools(context));
    this.registerCards();
  }

  /** Whether an agent in the list is an outside agent, not one a contact shared. */
  is(agent: AgentRecord): boolean {
    return agent.origin === "shared" && /^https?:\/\//.test(agent.remote ?? "");
  }

  private row(agentId: string): OutsideRow | undefined {
    return this.home.db.get<OutsideRow>("select * from outside_agent where agent_id = ?", agentId);
  }

  /** Says a text to an outside agent and writes its answer as it arrives. */
  async ask(
    agent: AgentRecord,
    text: string,
    signal: AbortSignal,
    write: (text: string) => void,
  ): Promise<void> {
    const row = this.row(agent.id);
    if (!row || !agent.remote) throw new Error("This agent has no address to ask.");
    const signIn = SignInShape.parse(JSON.parse(row.sign_in));
    const remote = this.remoteOf(agent, row);
    const within = AbortSignal.any([signal, AbortSignal.timeout(ANSWER_WAIT_MS)]);
    try {
      const thread = await say(remote, text, within, write).catch((error) => {
        // The task the agent waited in is gone or ended: the message starts a new one.
        if (!taskIsGone(error) || !this.row(agent.id)?.task_id) throw error;
        this.home.db.run("update outside_agent set task_id = null where agent_id = ?", agent.id);
        return say(remote, text, within, write);
      });
      this.home.db.run(
        "update outside_agent set context_id = ?, task_id = ? where agent_id = ?",
        thread.contextId ?? row.context_id,
        thread.taskId ?? null,
        agent.id,
      );
    } catch (error) {
      // Whatever went wrong, the next message does not go on in a task that may be over.
      this.home.db.run("update outside_agent set task_id = null where agent_id = ?", agent.id);
      const status = refusedWith(error);
      if (status === 401 || status === 403) {
        throw new Error(
          signIn.kind === "none"
            ? `${agent.name} asks for a sign-in now. Remove it and add it again.`
            : `${agent.name} did not accept the ${signIn.kind === "bearer" ? "token" : "key"}. Remove it and add it again with a new one.`,
        );
      }
      if (within.aborted && !signal.aborted)
        throw new Error(`${agent.name} did not answer in time.`);
      throw error;
    }
  }

  /**
   * Mastra's client for an outside agent. Its requests go through the home: only to
   * addresses the home may call, signed in the way the card asked for, and in the
   * conversation the agent's chat is.
   */
  private remoteOf(agent: AgentRecord, row: OutsideRow): A2AAgent {
    const known = this.remotes.get(agent.id);
    if (known) return known;
    const signIn = SignInShape.parse(JSON.parse(row.sign_in));
    const secret = this.home.secrets.get(secretOf(agent.id)) ?? "";
    const approved = new URL(agent.remote as string).toString();
    const open = guarded(this.allowPrivate);
    const signedIn: Fetch = async (input, init) => {
      // The card is read without the secret: that is for the address the person said yes to.
      if (init?.method !== "POST") return open(input, init);
      const url = new URL(String(input));
      if (url.toString() !== approved)
        throw new Error(
          `${agent.name} takes messages at another address now. Remove it and add it again.`,
        );
      const headers = new Headers(init.headers);
      if (signIn.kind === "bearer") headers.set("authorization", `Bearer ${secret}`);
      if (signIn.kind === "apiKey") {
        if (signIn.location === "header") headers.set(signIn.name, secret);
        if (signIn.location === "cookie")
          headers.set("cookie", `${signIn.name}=${encodeURIComponent(secret)}`);
        if (signIn.location === "query") url.searchParams.set(signIn.name, secret);
      }
      return open(url, { ...init, headers });
    };
    const remote = new A2AAgent({
      url: row.card_url,
      protocolVersion: A2A_VERSIONS.find((version) => version === row.version) ?? "1.0",
      name: agent.name,
      fetch: inThread(signedIn, () => {
        const now = this.row(agent.id);
        return {
          contextId: now?.context_id ?? undefined,
          taskId: now?.task_id ?? undefined,
          tenant: now?.tenant ?? undefined,
        };
      }),
    });
    this.remotes.set(agent.id, remote);
    return remote;
  }

  /** The secret of an outside agent goes with the agent. */
  forget(agentId: string): void {
    this.remotes.delete(agentId);
    this.home.secrets.delete(secretOf(agentId));
  }

  // ── Callers ───────────────────────────────────────────────────────────────

  /** The caller a request's access token belongs to. */
  callerOf(headers: Headers): Caller | undefined {
    const token = /^Bearer\s+(\S+)$/i.exec(headers.get("authorization") ?? "")?.[1];
    if (!token) return undefined;
    const row = this.home.db.get<CallerRow>(
      "select * from caller where token_hash = ?",
      sha256(token),
    );
    return row ? toCaller(row) : undefined;
  }

  callers(agentId?: string): Caller[] {
    const rows = agentId
      ? this.home.db.all<CallerRow>(
          "select * from caller where agent_id = ? order by created_at",
          agentId,
        )
      : this.home.db.all<CallerRow>("select * from caller order by created_at");
    return rows.map(toCaller);
  }

  heard(callerId: string): void {
    this.home.db.run("update caller set heard_at = ? where id = ?", now(), callerId);
  }

  /** Whether this home calls private addresses: only one that is private itself does. */
  private get allowPrivate(): boolean {
    const own = this.home.config.publicUrl;
    return !own || isPrivateHost(new URL(own).host);
  }

  /** Puts a card that waits for the person into a conversation, outside a turn. */
  private show(where: { conversationId: string; agentId: string }, card: NewCard): void {
    const { home } = this;
    const message = home.store.addMessage({
      conversationId: where.conversationId,
      role: "agent",
      agentId: where.agentId,
      channel: "home",
      parts: [],
    });
    const created = home.store.createCard(card, { ...where, messageId: message.id });
    home.store.updateMessage(message.id, { parts: [{ type: "card", card: created }] });
    void home.notifier.card(created, home.store.agent(where.agentId)?.name ?? "");
  }

  // ── What the agent can do ─────────────────────────────────────────────────

  private tools(context: TurnContext): Tool[] {
    const { home, agent, conversationId, draft } = context;
    if (!agent.main) return [];
    const where = { agentId: agent.id, conversationId, messageId: draft.id };
    return [
      defineTool({
        name: "outside_agent_add",
        description:
          "Add an agent that is not a Bot Server, by the address of its A2A agent card or of its site. Reads the card, shows the person who it is and asks first. When the agent asks for a token or a key, the card has a field for it: never ask for it in the chat. Ends your turn.",
        input: z.object({
          url: z.string().describe("The address the person gave."),
          kind: EngentyKind.optional().describe("Its figure in the list of agents."),
        }),
        label: () => "Reading an agent's card",
        run: async (input) => {
          let card: OutsideCard;
          try {
            card = await readCard(input.url, this.allowPrivate);
          } catch (error) {
            return (error as Error).message;
          }
          const name = card.name.replace(/\s+/g, " ").trim().slice(0, 80);
          let address: URL;
          try {
            address = outsideUrl(card.url, this.allowPrivate);
          } catch (error) {
            return `${name} cannot be added. ${(error as Error).message}`;
          }
          const { signIn } = card;
          if ("why" in signIn)
            return `${name} cannot be added yet. ${signIn.why} The Bot Server signs in with a token or a key. A sign-in with OAuth is not built yet.`;
          const known = home.db.get<{ agent_id: string }>(
            "select agent_id from outside_agent where card_url = ?",
            card.cardUrl,
          );
          if (known) return `${name} is among the agents already, as ${known.agent_id}.`;

          const from = new URL(card.cardUrl).host;
          const skills = card.skills
            .map((skill) => plain(skill, 60))
            .filter(Boolean)
            .slice(0, 6);
          const body = [
            `**${from}**${card.organization ? `, run by ${plain(card.organization, 80)}` : ""}`,
            plain(card.description, 400),
            skills.length ? `It says it can: ${skills.join(", ")}.` : "",
            `It is not a Bot Server. What you write to it goes to ${address.host}. Your agents ask you before they write to it.`,
            signIn.kind === "none"
              ? ""
              : `It asks for ${signIn.kind === "bearer" ? "an access token" : "a key"}. It stays on your Bot Server. No model reads it.`,
          ]
            .filter(Boolean)
            .join("\n\n");
          const created = home.store.createCard(
            {
              kind: signIn.kind === "none" ? "approval" : "secret",
              level: "needs_you",
              title: `Add “${name}”?`,
              body,
              fields:
                signIn.kind === "none"
                  ? undefined
                  : [
                      {
                        id: "secret",
                        label: signIn.kind === "bearer" ? "Access token" : "Key",
                        type: "secret",
                        required: true,
                      },
                    ],
              actions: [
                { id: "add", label: "Add agent", style: "primary" },
                { id: "refuse", label: "Don't add", style: "plain" },
              ],
              payload: {
                type: "outside_add",
                cardUrl: card.cardUrl,
                url: address.toString(),
                version: card.version,
                tenant: card.tenant,
                name,
                about: card.description.replace(/\s+/g, " ").trim().slice(0, 400),
                kind: input.kind ?? "oval",
                from,
                signIn,
              } satisfies z.input<typeof AddPayload> & { type: string },
            },
            where,
          );
          draft.add({ type: "card", card: created });
          return ENDS_TURN;
        },
      }),
      defineTool({
        name: "outside_agent_let_in",
        description:
          "Let an agent that is not a Bot Server write to one of the person's own agents over A2A. `name` says who it is, e.g. “the booking agent of Hotel Lux”. Asks the person first, then shows an access token once in a card. The caller gets a conversation of its own with that agent and reaches nothing else. Ends your turn.",
        input: z.object({ agentId: z.string(), name: z.string().min(1).max(80) }),
        label: () => "Asking to let an agent in",
        run: async (input) => {
          const target = home.store.agent(input.agentId);
          if (target?.origin !== "own")
            return `There is no agent of your own with the id ${input.agentId}.`;
          if (target.main)
            return "The first agent of a Bot Server is yours alone. Make an agent for the task and let the caller write to that one.";
          if (!home.config.publicUrl)
            return "Your Bot Server has no public address yet. It needs one (WIZARDS_BOT_URL) before an agent from outside can reach it.";
          const card = home.store.createCard(
            {
              kind: "approval",
              level: "needs_you",
              title: `Let ${input.name} write to “${target.name}”?`,
              body: `${target.name} answers it from its instructions and its memory and has no tools there. The caller reaches no other agent and nothing else on your Bot Server. You can shut it out at any time.`,
              actions: [
                { id: "let_in", label: "Let it in", style: "primary" },
                { id: "refuse", label: "Don't let it in", style: "plain" },
              ],
              payload: { type: "caller_add", agentId: target.id, name: input.name },
            },
            where,
          );
          draft.add({ type: "card", card });
          return ENDS_TURN;
        },
      }),
      defineTool({
        name: "outside_list",
        description:
          "List the agents from outside the person added, and the callers: outside agents that may write to one of the person's agents.",
        input: z.object({}),
        label: () => "Looking at the agents from outside",
        run: async () => {
          const added = home.store
            .agents()
            .filter((other) => this.is(other))
            .map((other) => `- ${other.name} (${other.id}), from ${other.from}`);
          const callers = this.callers().map(
            (caller) =>
              `- ${caller.name} (${caller.id}) writes to ${home.store.agent(caller.agentId)?.name ?? caller.agentId}, since ${caller.createdAt.slice(0, 10)}, ${caller.heardAt ? `last heard ${caller.heardAt.slice(0, 16).replace("T", " ")} UTC` : "not heard yet"}`,
          );
          return `Agents from outside:\n${added.join("\n") || "None."}\n\nCallers:\n${callers.join("\n") || "None."}`;
        },
      }),
      defineTool({
        name: "outside_shut_out",
        description:
          "Shut a caller out, by its id from `outside_list`. Its access token stops working at once.",
        input: z.object({ id: z.string() }),
        label: () => "Shutting a caller out",
        run: async (input) => {
          const caller = this.callers().find((candidate) => candidate.id === input.id);
          if (!caller) return `There is no caller ${input.id}.`;
          home.db.run("delete from caller where id = ?", caller.id);
          return `${caller.name} is shut out. Its access token no longer works.`;
        },
      }),
    ];
  }

  private registerCards(): void {
    const { home } = this;

    home.onCard("outside_add", ({ card, action, values, payload }) => {
      if (action !== "add") return;
      const add = AddPayload.parse(payload);
      const secret = typeof values.secret === "string" ? values.secret.trim() : "";
      if (add.signIn.kind !== "none" && !secret) {
        home.tell(
          card.conversationId,
          `The person gave nothing to sign in with, so ${add.name} was not added.`,
        );
        return;
      }
      const created = home.store.createAgent({
        name: add.name,
        kind: add.kind,
        about: add.about,
        origin: "shared",
        from: add.from,
        remote: add.url,
      });
      home.db.run(
        "insert into outside_agent (agent_id, card_url, tenant, version, sign_in) values (?, ?, ?, ?, ?)",
        created.id,
        add.cardUrl,
        add.tenant ?? null,
        add.version,
        JSON.stringify(add.signIn),
      );
      if (secret) home.secrets.set(secretOf(created.id), secret);
      home.tell(
        card.conversationId,
        `${created.name} (${created.id}) is in the list of agents now. The person writes to it in its own chat; you hand it a task with agent_message. Say so in one sentence.`,
      );
    });

    home.onCard("caller_add", ({ card, action, payload }) => {
      if (action !== "let_in") return;
      const agent = home.store.agent(String(payload.agentId));
      const name = String(payload.name);
      const base = home.config.publicUrl;
      if (agent?.origin !== "own" || agent.main || !base) return;
      const token = newToken();
      const id = newId("clr");
      home.db.run(
        "insert into caller (id, agent_id, name, token_hash, created_at) values (?, ?, ?, ?, ?)",
        id,
        agent.id,
        name,
        sha256(token),
        now(),
      );
      this.show(
        { conversationId: card.conversationId, agentId: card.agentId },
        {
          kind: "approval",
          level: "needs_you",
          title: `Access token for ${name}`,
          body: [
            `Give both lines to whoever runs ${name}. The token is shown this once: the Bot Server keeps no copy it could show again.`,
            `Agent card: \`${base}/a2a/agents/${agent.id}/agent-card.json\``,
            `Access token: \`${token}\``,
            "The caller sends the token as `Authorization: Bearer <token>`.",
          ].join("\n\n"),
          actions: [{ id: "hide", label: "I copied it", style: "primary" }],
          payload: { type: "caller_token", callerId: id },
        },
      );
      home.tell(
        card.conversationId,
        `${name} may write to ${agent.name} now, as caller ${id}. A card shows its access token and the address of ${agent.name}'s agent card once. Say in one or two sentences that both go to whoever runs ${name}.`,
      );
    });

    // The token leaves the chat as soon as the person has it.
    home.onCard("caller_token", ({ card }) => {
      home.store.updateCard(card.id, {
        body: "The access token was shown once and is not kept in the chat. When it is lost, shut the caller out and let it in again.",
      });
    });
  }
}

function toCaller(row: CallerRow): Caller {
  return {
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    createdAt: row.created_at,
    heardAt: row.heard_at ?? undefined,
  };
}
