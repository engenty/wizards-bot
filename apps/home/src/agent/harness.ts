import { createHash } from "node:crypto";
import { type DecisionModel, decisionBy, type SystemOneResponse } from "@engenty/decision-model";
import { type CatalogSearch, createCatalogSearch, type VectorStore } from "@engenty/search-index";
import { embedderOf } from "@engenty/search-index/embedders";
import {
  createToolHarness,
  type HarnessTool,
  type Level,
  type MetaTool,
  reaches,
  TOOL_CALL,
  TOOL_SEARCH,
  type ToolHarness,
  toolJudge,
} from "@engenty/tool-harness";
import { z } from "zod";
import { isHosted } from "../config.ts";
import type { Home } from "../home.ts";
import { ACCOUNT, accountEmbedder } from "../models/models.ts";
import { langOf, say, w } from "../setup/words.ts";
import { inputSchemaOf, type Tool } from "./tool.ts";

/**
 * The harness around an agent's tools (@engenty/tool-harness), for the models the home steps
 * itself. The few an agent uses in most conversations are in every prompt. The others are found
 * (`tool_search`) or named with the newest message, and run with `tool_call`: what is found stands
 * at the end of the prompt, so its start stays the same and need not be read again. A client that
 * steps by itself gets all tools over MCP.
 */

interface Trait {
  /** In every prompt. */
  core?: true;
  /** The least a model has to be. Without it: `basic`. */
  needs?: Level;
  /** It leaves something behind: a basic model runs it only after the person read what it does. */
  changes?: true;
  /** What people ask for when they mean it. */
  uses?: string;
}

const TRAITS: Record<string, Trait> = {
  ask: { core: true },
  remember: { core: true },
  skill_load: { core: true },
  go_on: { core: true, needs: "standard" },
  document_read: { core: true },
  document_write: { core: true },
  artifact_read: { core: true },
  artifact_write: { core: true, needs: "standard" },
  file_read: { core: true },
  folder_list: { core: true },
  folder_read: { core: true },
  folder_search: { core: true },
  agent_message: { core: true },
  connection_tools: { core: true },
  connection_call: { core: true },

  schedule_set: {
    changes: true,
    uses: "Remind the person, reminder, every day, every week, on Fridays, at a time, regularly.",
  },
  when_set: {
    changes: true,
    needs: "standard",
    uses: "Tell the person when, as soon as, whenever something arrives or changes; watch, notify.",
  },
  task_list: { uses: "Which reminders and automatic tasks there are." },
  task_remove: { changes: true, uses: "Stop, cancel or delete a reminder or an automatic task." },
  task_resume: { changes: true, uses: "Run a paused reminder or task again." },

  agent_create: {
    changes: true,
    needs: "standard",
    uses: "Make a new bot, a Wizard, an assistant for a topic.",
  },
  agent_update: {
    changes: true,
    needs: "standard",
    uses: "Change a bot's task, instructions, name or look.",
  },
  agent_remove: { changes: true, uses: "Delete a bot." },
  agent_share: { changes: true, uses: "Share a bot with a contact, let someone else use it." },
  agent_unshare: { changes: true, uses: "Stop sharing a bot." },

  invite_make: { changes: true, uses: "Invite someone, let a person in with a link or QR code." },
  invite_open: { uses: "Join, accept an invitation, open an invite link." },
  invite_take_back: { changes: true, uses: "Withdraw an invitation." },
  contact_connect: { changes: true, uses: "Add a person by their handle or address." },
  contact_remove: { changes: true },
  contact_send: { changes: true, uses: "Write to someone, send a person a message." },
  room_open: { changes: true, uses: "Group chat with several people and bots." },
  room_add: { changes: true, uses: "Add a bot to a group chat." },
  room_invite: { changes: true, uses: "Add a person to a group chat." },
  link_publish: { changes: true, uses: "Share a document or page publicly, make a link to it." },
  link_take_back: { changes: true, uses: "Make a published link private again." },
  outside_agent_add: { changes: true, needs: "standard", uses: "Connect an agent by its URL." },
  outside_agent_let_in: {
    changes: true,
    needs: "standard",
    uses: "Let someone's Claude, ChatGPT or other agent call in from outside.",
  },
  outside_shut_out: { changes: true },

  models: { uses: "Which AI models there are and which one answers." },
  models_order: { changes: true, uses: "Switch the AI model: use Claude, Codex, Ollama first." },
  gateway_add: { changes: true, uses: "Add an API key of OpenRouter, OpenAI, Vercel, Anthropic." },
  person_name: { changes: true, uses: "What to call the person, their name." },
  person_key: { changes: true, needs: "standard" },
  handle_set: { changes: true, uses: "Claim a public name, a username." },
  avatar_set: {
    changes: true,
    needs: "standard",
    uses: "Change the person's picture: hair, eyes, clothes, look.",
  },
  home_check: { uses: "Is the server fine, its status, its health, what is wrong." },
  device_pair: { uses: "Connect a new phone, watch or computer." },
  channel_connect: {
    changes: true,
    uses: "Telegram, WhatsApp, Slack, Signal, e-mail: be reached and answer there.",
  },
  channel_remove: { changes: true, uses: "Disconnect Telegram, WhatsApp, Slack, Signal." },
  plugin_switch: { changes: true, uses: "Turn a plugin on or off." },
  connection_add: { changes: true, uses: "Connect an account: calendar, mail, notes, shop." },
  connection_find: { uses: "Is there an integration for a service: Notion, Google Calendar." },
  connection_remove: { changes: true },

  folder_connect: { changes: true, uses: "Give access to a folder of the computer." },
  folder_disconnect: { changes: true },
  folder_make: { changes: true },
  folder_write: { changes: true },
  folder_edit: { changes: true, needs: "standard" },
  folder_copy: { changes: true },
  folder_move: { changes: true },
  folder_delete: { changes: true },

  vault_sign_in: {
    changes: true,
    needs: "standard",
    uses: "Log in to a website with the saved password.",
  },
  vault_logins: { uses: "Which passwords and logins are saved." },
  vault_code: { uses: "Two-factor code, one-time password, authenticator." },
  shell_run: {
    changes: true,
    needs: "standard",
    uses: "Run a command, a script, Python, tests; compute something with code.",
  },

  browser_open: { needs: "standard", uses: "Visit a website, read a web page, look it up online." },
  browser_back: { needs: "standard" },
  browser_click: { needs: "standard", uses: "Press a button or link on the web page." },
  browser_close: { needs: "standard" },
  browser_press: { needs: "standard", uses: "Press a key on the web page." },
  browser_scroll: { needs: "standard" },
  browser_select: { needs: "standard" },
  browser_snapshot: { needs: "standard", uses: "Read what the open web page shows." },
  browser_tabs: { needs: "standard" },
  browser_type: { needs: "standard", uses: "Fill in a field on the web page." },
  browser_wait: { needs: "standard" },
};

/** A tool of which nothing is known here (a plugin's) changes something, unless its name says it reads. */
const READS = /(?:^|_)(?:read|list|get|search|find|look|info|show|check|status)(?:_|$)/;

export const traitOf = (name: string): Trait =>
  TRAITS[name] ?? (READS.test(name) ? {} : { changes: true });

/** The tools the traits name: a tool that is not among them says so in its own test. */
export const KNOWN_TOOLS = Object.keys(TRAITS);

/** What these answer is no source: they ask, keep or look for something. */
const NO_SOURCE = new Set(["ask", "go_on", "remember", "skill_load", TOOL_SEARCH, "agent_message"]);

export const isSource = (tool: string): boolean => !NO_SOURCE.has(tool);

type Held = HarnessTool & { tool: Tool };

const held = (tool: Tool): Held => {
  const { needs, uses } = traitOf(tool.name);
  return {
    name: tool.name,
    description: tool.description,
    input: inputSchemaOf(tool),
    ...(needs ? { needs } : {}),
    ...(uses ? { uses } : {}),
    tool,
  };
};

/** What the model reads when it calls a tool it cannot be trusted with and no other one can help. */
const beyond = (tool: Tool) =>
  `Nothing was done. ${tool.name} needs a more capable model than the one that answers now. Tell the person so: they choose one in the settings.`;

/** What the model reads of such tools when a more capable model can be offered. */
export const CALL_ANYWAY =
  "Not for the model that answers now. Call the one that fits anyway, with an empty input: the person is asked whether a more capable model takes over";

/** A call's input as the person reads it on the card. */
function shownInput(tool: Tool, input: Record<string, unknown>): string {
  const said = tool.says?.(input);
  if (said) return said;
  return Object.entries(input)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([name, value]) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return `- **${name.replaceAll("_", " ")}:** ${text.length > 400 ? `${text.slice(0, 400)}…` : text}`;
    })
    .join("\n");
}

/**
 * A tool as a model of this level may run it. Whatever way it is called, a model below what the
 * tool needs is refused. What a basic model changes is shown to the person first, from the call
 * itself and not from what the model says of it: it fills in a wrong input and does not notice.
 */
export function guarded(
  tool: Tool,
  level: () => Level,
  home: Home,
  /** The tool ran through. */
  ran: (name: string) => void = () => undefined,
  /** Asks the person whether a more capable model takes over; what the model reads then. */
  offer: (tool: Tool, needs: Level) => string | undefined = () => undefined,
): Tool {
  const { needs = "basic", changes } = traitOf(tool.name);
  const confirms = changes === true && !tool.asks;
  const run: Tool["run"] = async (input, call) => {
    const answer = await tool.run(input, call);
    ran(tool.name);
    return answer;
  };
  return {
    ...tool,
    ...(confirms ? { asks: true as const } : {}),
    run: async (input, call) => {
      if (!reaches(level(), needs)) return offer(tool, needs) ?? beyond(tool);
      if (!confirms) return run(input, call);
      if (call.answer) {
        if (call.answer.action !== "do") return "The person said no. Nothing was done.";
        return run(input, { ...call, answer: undefined });
      }
      if (level() !== "basic") return run(input, call);
      const wrong = tool.wrong?.(input as Record<string, unknown>);
      if (wrong) return `Nothing was done. ${wrong}`;
      const lang = langOf(home.db);
      return call.ask({
        kind: "approval",
        level: "needs_you",
        title: say(w("Shall I do this?", "Soll ich das tun?"), lang),
        body: `**${tool.label?.(input as Record<string, unknown>) ?? tool.name}**\n\n${shownInput(tool, input as Record<string, unknown>)}`,
        actions: [
          { id: "do", label: say(w("Yes", "Ja"), lang), style: "primary" },
          { id: "leave", label: say(w("No", "Nein"), lang), style: "plain" },
        ],
      });
    },
  };
}

/** The harness of one turn. `always`: tools that are shown by another rule (a loaded skill's). */
export function turnHarness(
  tools: Tool[],
  level: Level,
  search: CatalogSearch,
  always: (name: string) => boolean,
  /** A more capable model can be offered. */
  offers = false,
): ToolHarness<Held> {
  return createToolHarness({
    tools: tools.map(held),
    core: (tool) => traitOf(tool.name).core === true || always(tool.name),
    level,
    search,
    ...(offers ? { beyond: CALL_ANYWAY } : {}),
  });
}

/** `tool_search` as a tool of the home. `tool_call` is run by `mastraTools`. */
export function metaTools(harness: ToolHarness<Held>): Tool[] {
  const of = (name: string): MetaTool | undefined =>
    harness.meta.find((tool) => tool.name === name);
  const find = of(TOOL_SEARCH);
  const call = of(TOOL_CALL);
  if (!(find && call)) return [];
  return [
    {
      name: find.name,
      description: find.description,
      input: z.object({ query: z.string().describe("What you need to do.") }),
      label: (input) => `Looking for a tool: ${String(input.query ?? "")}`,
      run: ({ query }: { query: string }) => harness.find(query),
    },
    {
      name: call.name,
      description: call.description,
      input: z.looseObject({
        name: z.string().describe("The tool's name."),
        input: z.record(z.string(), z.unknown()).optional().describe("Its input."),
      }),
      asks: true,
      run: async () => "Nothing was done.",
    },
  ];
}

/** How long a search waits for vectors where the answer itself takes seconds. */
const LOCAL_WAIT_MS = 8000;

const onThisComputer = (sourceId: string) => ["ollama", "lmstudio", "mlx"].includes(sourceId);

/** Vectors of the tools' texts, in the home's database. */
function vectorStore(home: Home): VectorStore {
  const key = (text: string) => createHash("sha256").update(text).digest("base64url");
  return {
    get(space, texts) {
      const found = new Map<string, number[]>();
      for (const text of texts) {
        const row = home.db.get<{ vector: Uint8Array }>(
          "select vector from tool_vector where space = ? and key = ?",
          space,
          key(text),
        );
        if (row) {
          const { buffer, byteOffset, byteLength } = Uint8Array.from(row.vector);
          found.set(text, Array.from(new Float32Array(buffer, byteOffset, byteLength / 4)));
        }
      }
      return found;
    },
    put(space, vectors) {
      for (const [text, vector] of vectors) {
        home.db.run(
          "insert or replace into tool_vector (space, key, vector) values (?, ?, ?)",
          space,
          key(text),
          new Uint8Array(new Float32Array(vector).buffer),
        );
      }
    },
  };
}

/**
 * The search over tools, for the source that answers. What the person writes is embedded on this
 * computer, or by the service that reads the message anyway: no other one hears of it.
 */
export class ToolSearch {
  private readonly searches = new Map<string, CatalogSearch>();
  private readonly home: Home;

  constructor(home: Home) {
    this.home = home;
  }

  for(sourceId: string): CatalogSearch {
    const known = this.searches.get(sourceId);
    if (known) return known;
    const made = createCatalogSearch({
      store: vectorStore(this.home),
      embedder: () => this.embedder(sourceId),
      judge: toolJudge(() => this.decision(sourceId)),
      // A model on this computer takes longer than that for its own first word.
      ...(onThisComputer(sourceId) ? { waitMs: LOCAL_WAIT_MS } : {}),
    });
    this.searches.set(sourceId, made);
    return made;
  }

  private key(sourceId: string, gateway: string): string | undefined {
    return sourceId === gateway ? this.home.secrets.get(`gateway.${gateway}`) : undefined;
  }

  private embedder(sourceId: string) {
    const { config, models } = this.home;
    const account = models.account();
    const accountKey = models.accountKey();
    return embedderOf(
      "auto",
      {
        ollamaUrl: isHosted(config) ? "" : config.ollamaUrl,
        gatewayKey: this.key(sourceId, "vercel"),
        openaiKey: this.key(sourceId, "openai"),
      },
      sourceId === ACCOUNT.id && account && accountKey
        ? [{ way: ACCOUNT.id, open: async () => accountEmbedder(account, accountKey) }]
        : [],
    );
  }

  /** Jev, where the source that answers brings it. */
  private async decision(sourceId: string): Promise<DecisionModel | null> {
    const gatewayKey = this.key(sourceId, "vercel");
    if (gatewayKey) return decisionBy("gateway", { gatewayKey }, { retries: 1, timeoutMs: 3000 });
    const account = this.home.models.account();
    const key = this.home.models.accountKey();
    if (!(sourceId === ACCOUNT.id && account && key)) return null;
    return {
      way: ACCOUNT.id,
      model: "wizards/classifier",
      systemOne: async (request) => {
        const response = await fetch(`${account.gatewayUrl}/v4/ai/systemone`, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(3000),
        });
        if (!response.ok) throw new Error(`the decision model answered ${response.status}`);
        return (await response.json()) as SystemOneResponse;
      },
    };
  }
}
