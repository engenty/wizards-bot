import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  type ModelService,
  type ModelSource,
  type Models as ModelsView,
  waitingForYes,
} from "@wizards-bot/protocol";
import type { LanguageModel } from "ai";
import type { Config } from "../config.ts";
import type { Secrets } from "../identity.ts";
import type { Db } from "../store/db.ts";
import {
  type ClientRun,
  type ClientSessions,
  type ClientTurn,
  clientModel,
} from "./client-model.ts";
import { agreed, serviceOf, services } from "./services.ts";

export type { ClientTurn } from "./client-model.ts";

import { type ChatModel, type OllamaModel, ollamaModel, ollamaModels } from "./ollama.ts";
import {
  CLIENTS,
  type Client,
  type ClientEvent,
  CODEX_KEY_VAR,
  type SubscriptionClient,
} from "./subscription.ts";

/** What answers a turn: a model Mastra asks. A subscription's model needs the turn's MCP token. */
export interface Engine {
  ref: string;
  model(turn: { mcpToken: string; conversationId: string }): LanguageModel;
}

/** Where a subscription client's own conversation is remembered, per conversation and source. */
export function clientSessions(db: Db, conversationId: string, sourceId: string): ClientSessions {
  const key = `session.${conversationId}.${sourceId}`;
  return {
    load: () => JSON.parse(db.meta(key) ?? "null") as { id: string; last: string } | null,
    save: (session) => db.setMeta(key, JSON.stringify(session)),
  };
}

/** Model sources of another computer of the same person, reached over its link. */
export interface RemoteSources {
  sources(): ModelSource[];
  engine(sourceId: string, model: string): Engine | undefined;
}

export interface Gateway {
  id: string;
  label: string;
  baseUrl: string;
  models: string[];
}

export const GATEWAY_PRESETS: Record<string, Omit<Gateway, "models">> = {
  openrouter: {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
  },
  vercel: {
    id: "vercel",
    label: "Vercel AI Gateway",
    baseUrl: "https://ai-gateway.vercel.sh/v1",
  },
  openai: { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  anthropic: { id: "anthropic", label: "Anthropic", baseUrl: "https://api.anthropic.com/v1" },
};

const REFRESH_MS = 60_000;

export class Models {
  private ollama: OllamaModel[] = [];
  private clients: SubscriptionClient[] = [];
  private refreshedAt = 0;
  private readonly config: Config;
  private readonly db: Db;
  private readonly secrets: Secrets;
  /** Set by the link once it runs. */
  remote: RemoteSources | undefined;
  /** This computer's name, for `where`. */
  readonly where: string;
  /** Where a client on this computer reaches the home's tools. A linked computer sets its home's address. */
  mcpUrl: string;
  /** This computer's memory in bytes. It decides which of its Ollama models the home prefers. */
  memory = totalmem();

  constructor(config: Config, db: Db, secrets: Secrets, where: string) {
    this.config = config;
    this.db = db;
    this.secrets = secrets;
    this.where = where;
    this.mcpUrl = `http://127.0.0.1:${config.port}/mcp`;
  }

  async refresh(force = false): Promise<void> {
    if (!force && Date.now() - this.refreshedAt < REFRESH_MS) return;
    this.refreshedAt = Date.now();
    this.ollama = await ollamaModels(
      this.config.ollamaUrl,
      fetch,
      onThisComputer(this.config.ollamaUrl) ? this.memory : undefined,
    );
    this.clients = (Object.keys(CLIENTS) as SubscriptionClient[]).filter(
      (id) => this.config.subscriptions.includes(id) && onPath(CLIENTS[id].bin),
    );
  }

  // ── Gateways ──────────────────────────────────────────────────────────────

  gateways(): Gateway[] {
    return JSON.parse(this.db.meta("models.gateways") ?? "[]") as Gateway[];
  }

  setGateway(gateway: Gateway, key: string): void {
    const rest = this.gateways().filter((g) => g.id !== gateway.id);
    this.db.setMeta("models.gateways", JSON.stringify([...rest, gateway]));
    this.secrets.set(`gateway.${gateway.id}`, key);
  }

  removeGateway(id: string): void {
    this.db.setMeta("models.gateways", JSON.stringify(this.gateways().filter((g) => g.id !== id)));
    this.secrets.delete(`gateway.${id}`);
  }

  // ── What the person sees ──────────────────────────────────────────────────

  localSources(): ModelSource[] {
    const sources: ModelSource[] = [];
    for (const id of this.clients) {
      sources.push({
        id,
        kind: "subscription",
        label: CLIENTS[id].name,
        where: this.where,
        online: true,
        models: CLIENTS[id].models,
      });
    }
    if (this.ollama.length) {
      sources.push({
        id: "ollama",
        kind: "ollama",
        label: "Ollama",
        where: this.where,
        online: true,
        models: this.ollama.map((model) => ({ id: model.id, label: model.id })),
      });
    }
    return sources;
  }

  sources(): ModelSource[] {
    const gateways = this.gateways().map(
      (gateway): ModelSource => ({
        id: gateway.id,
        kind: "gateway",
        label: gateway.label,
        where: "the cloud",
        online: this.secrets.has(`gateway.${gateway.id}`),
        models: gateway.models.map((id) => ({ id, label: id })),
      }),
    );
    return [...this.localSources(), ...(this.remote?.sources() ?? []), ...gateways].map(
      (source) => ({ ...source, service: serviceOf(source)?.id }),
    );
  }

  order(): string[] {
    return JSON.parse(this.db.meta("models.order") ?? "[]") as string[];
  }

  setOrder(refs: string[]): void {
    this.db.setMeta("models.order", JSON.stringify(refs));
  }

  view(): ModelsView {
    const sources = this.sources();
    const candidates = this.candidates();
    const used = candidates.map((ref) => splitRef(ref).sourceId);
    return {
      sources,
      order: this.order(),
      current: candidates[0],
      services: services(sources, used, agreed(this.db)),
    };
  }

  /** The services in use that wait for the person's yes before a device's words reach them. */
  waitingForYes(): ModelService[] {
    return waitingForYes(this.view());
  }

  /**
   * Model refs in the order the home tries them: the person's order first, then a
   * subscription, then Ollama, then a gateway; this computer before another one.
   */
  candidates(): string[] {
    const available = new Map<string, ModelSource>();
    for (const source of this.sources()) if (source.online) available.set(source.id, source);
    const refs: string[] = [];
    const add = (ref: string) => {
      const { sourceId, model } = splitRef(ref);
      const source = available.get(sourceId);
      if (!source?.models.some((m) => m.id === model)) return;
      if (!refs.includes(ref)) refs.push(ref);
    };
    for (const ref of this.order()) add(ref);
    for (const kind of ["subscription", "ollama", "gateway"] as const) {
      for (const source of available.values()) {
        const first = source.models[0];
        if (source.kind === kind && first) add(`${source.id}:${first.id}`);
      }
    }
    return refs;
  }

  /**
   * The models that can look at a picture: those on this computer, and those anywhere
   * else, which a picture of the person reaches only when the person said so.
   */
  forPictures(): { here: string[]; elsewhere: { ref: string; label: string }[] } {
    const here = this.ollama.filter((model) => model.vision).map((model) => `ollama:${model.id}`);
    const elsewhere: { ref: string; label: string }[] = [];
    for (const ref of this.candidates()) {
      const { sourceId } = splitRef(ref);
      const source = this.sources().find((candidate) => candidate.id === sourceId);
      if (source && source.kind !== "ollama") elsewhere.push({ ref, label: source.label });
    }
    return { here, elsewhere };
  }

  /** The engine behind a model ref, or `undefined` when the source is gone. */
  engine(ref: string): Engine | undefined {
    const { sourceId, model } = splitRef(ref);
    if (sourceId.includes("/")) return this.remote?.engine(sourceId, model);
    return this.localEngine(sourceId, model, ref);
  }

  /** An engine of this computer. */
  localEngine(sourceId: string, model: string, ref = `${sourceId}:${model}`): Engine | undefined {
    if (sourceId === "ollama") {
      const chat = this.localChat(model);
      return chat && { ref, model: () => chat };
    }
    const run = this.localClient(sourceId);
    if (run) {
      return {
        ref,
        model: ({ mcpToken, conversationId }) =>
          clientModel({
            provider: sourceId,
            model,
            mcpToken,
            run,
            sessions: clientSessions(this.db, conversationId, sourceId),
          }),
      };
    }
    const gateway = this.gateways().find((g) => g.id === sourceId);
    const key = this.secrets.get(`gateway.${sourceId}`);
    if (!gateway || !key) return undefined;
    const chat = createOpenAICompatible({
      name: gateway.id,
      baseURL: gateway.baseUrl,
      apiKey: key,
    })(model);
    return { ref, model: () => chat };
  }

  /** An Ollama model of this computer. A linked computer serves it to its home through this. */
  localChat(model: string): ChatModel | undefined {
    const found = this.ollama.find((m) => m.id === model);
    if (!found) return undefined;
    return ollamaModel({
      baseUrl: this.config.ollamaUrl,
      model,
      tools: found.tools,
      thinking: found.thinking,
      context: Number(process.env.WIZARDS_BOT_OLLAMA_CONTEXT ?? 16_384),
    });
  }

  /** How a turn of an installed client runs on this computer, when the client is there. */
  localClient(sourceId: string): ClientRun | undefined {
    if (!(sourceId in CLIENTS) || !this.clients.includes(sourceId as SubscriptionClient))
      return undefined;
    const client = CLIENTS[sourceId as SubscriptionClient];
    return (turn, onEvent) => runClient(client, turn, this.mcpUrl, onEvent);
  }
}

export function splitRef(ref: string): { sourceId: string; model: string } {
  const colon = ref.indexOf(":");
  return colon < 0
    ? { sourceId: ref, model: "default" }
    : { sourceId: ref.slice(0, colon), model: ref.slice(colon + 1) };
}

/** Whether an address is this computer's own. */
function onThisComputer(url: string): boolean {
  return URL.canParse(url) && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
}

function onPath(bin: string): boolean {
  if (bin.includes("/")) return spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
  return spawnSync("which", [bin], { stdio: "ignore" }).status === 0;
}

/**
 * Settings that would make an installed client use something other than its own sign-in: an
 * API key or another address for Anthropic or OpenAI, and what a Claude Code that started this
 * home left behind for its own sessions. Without them, Claude Code and Codex run on the
 * subscription the person signed in with on this computer.
 */
const NOT_FOR_CLIENTS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
];

/** The environment an installed client runs in: this home's, without `NOT_FOR_CLIENTS`. */
export function clientEnv(
  env: NodeJS.ProcessEnv,
  extra: Record<string, string>,
): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (NOT_FOR_CLIENTS.includes(name)) continue;
    // A Claude Code session's own settings; a token the person set up for Claude stays.
    if (name.startsWith("CLAUDE_CODE_") && name !== "CLAUDE_CODE_OAUTH_TOKEN") continue;
    kept[name] = value;
  }
  return { ...kept, ...extra };
}

/** Runs one turn of an installed client and reports what its output lines mean. */
export async function runClient(
  client: Client,
  turn: ClientTurn,
  mcpUrl: string,
  onEvent: (event: ClientEvent) => void,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "wizards-bot-turn-"));
  const mcpConfigFile = join(dir, "mcp.json");
  writeFileSync(
    mcpConfigFile,
    JSON.stringify({
      mcpServers: {
        home: { type: "http", url: mcpUrl, headers: { Authorization: `Bearer ${turn.mcpToken}` } },
      },
    }),
    { mode: 0o600 },
  );
  const images = (turn.images ?? []).map((image, at) => {
    const file = join(dir, `picture-${at}.${image.mime.split("/")[1] ?? "png"}`);
    writeFileSync(file, Buffer.from(image.base64, "base64"), { mode: 0o600 });
    return { mime: image.mime, base64: image.base64, file };
  });
  const call = { ...turn, mcpUrl, mcpConfigFile, images };
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(client.bin, client.args(call), {
        cwd: dir,
        env: clientEnv(process.env, { [CODEX_KEY_VAR]: turn.mcpToken }),
        stdio: ["pipe", "pipe", "pipe"],
      });
      const parse = client.parser();
      let stderr = "";
      let failed: string | undefined;
      turn.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
      child.stdin.end(client.stdin(call));
      createInterface({ input: child.stdout }).on("line", (line) => {
        for (const event of parse(line)) {
          if (event.kind === "failure") failed = event.detail;
          onEvent(event);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-2000);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (turn.signal.aborted) return resolve();
        if (failed !== undefined) {
          return reject(
            new Error(
              client.signedOut(failed)
                ? `${client.name} is not signed in on this computer. Sign in there, then ask again.`
                : failed,
            ),
          );
        }
        if (code !== 0)
          return reject(new Error(stderr.trim() || `${client.name} ended with code ${code}.`));
        resolve();
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
