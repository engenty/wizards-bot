import { totalmem } from "node:os";
import { createGateway } from "@ai-sdk/gateway";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { detectClient } from "@engenty/local-models/clients";
import {
  type ChatModel,
  fits,
  type InstalledModel,
  ollamaModel,
} from "@engenty/local-models/ollama";
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
  clientModel,
  isSubscription,
  runTurn,
  SUBSCRIPTIONS,
  type SubscriptionId,
} from "./client-model.ts";
import { chatModels, MEMORY_SHARE, onThisComputer } from "./ollama.ts";
import { agreed, serviceOf, services } from "./services.ts";

export type { ClientTurn } from "./client-model.ts";

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

/**
 * The wizards account: the Manage-App's gateway, paid with the credits of the team the home's
 * key names. A hosted home gets the key with its claim (`hosted.ts`).
 */
export const ACCOUNT = {
  id: "wizards",
  label: "wizards account",
  /** The gateway's classes of text models, the cheaper first: it binds each to a model. */
  models: ["wizards/standard", "wizards/high", "wizards/highest"],
} as const;

/** Where the account's gateway is. Its key is in the home's secrets. */
export interface Account {
  gatewayUrl: string;
}

const ACCOUNT_KEY = "account.gateway";

/**
 * A model of the account's gateway: the AI SDK's gateway client, as engenty wizards' runtime
 * calls the Manage-App, at `<gatewayUrl>/v4/ai` with the home's key as bearer. The key names
 * the team, so no tenant header goes with it.
 */
export function accountModel(
  account: Account,
  key: string,
  model: string,
  doFetch?: typeof fetch,
): LanguageModel {
  return createGateway({
    baseURL: `${account.gatewayUrl}/v4/ai`,
    apiKey: key,
    ...(doFetch ? { fetch: doFetch } : {}),
  })(model);
}

/** Whether the person picked Ollama: "on" or "off". */
const OLLAMA = "models.ollama";

const REFRESH_MS = 60_000;

export class Models {
  private ollama: InstalledModel[] = [];
  private clients: SubscriptionId[] = [];
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
    this.ollama = await chatModels(
      this.config.ollamaUrl,
      onThisComputer(this.config.ollamaUrl) ? this.memory : undefined,
    );
    const wanted = this.config.subscriptions.filter(isSubscription);
    const found = await Promise.all(
      wanted.map((id) => detectClient(SUBSCRIPTIONS[id].client, force)),
    );
    this.clients = wanted.filter((_, at) => found[at]?.version);
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

  // ── The wizards account ───────────────────────────────────────────────────

  account(): Account | undefined {
    const saved = this.db.meta("models.account");
    return saved ? (JSON.parse(saved) as Account) : undefined;
  }

  accountKey(): string | undefined {
    return this.secrets.get(ACCOUNT_KEY);
  }

  setAccount(account: Account, key: string): void {
    this.db.setMeta("models.account", JSON.stringify(account));
    this.secrets.set(ACCOUNT_KEY, key);
  }

  // ── What the person sees ──────────────────────────────────────────────────

  localSources(): ModelSource[] {
    const sources: ModelSource[] = [];
    for (const id of this.clients) {
      sources.push({
        id,
        kind: "subscription",
        label: SUBSCRIPTIONS[id].label,
        where: this.where,
        online: true,
        models: SUBSCRIPTIONS[id].models,
      });
    }
    if (this.ollama.length) {
      sources.push({
        id: "ollama",
        kind: "ollama",
        label: "Ollama",
        where: this.where,
        online: true,
        models: this.ollama.map((model) => ({ id: model.name, label: model.name })),
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
    const account = this.account();
    if (account) {
      gateways.unshift({
        id: ACCOUNT.id,
        kind: "gateway",
        label: ACCOUNT.label,
        where: "the cloud",
        online: this.secrets.has(ACCOUNT_KEY),
        models: ACCOUNT.models.map((id) => ({ id, label: id })),
      });
    }
    return [...this.localSources(), ...(this.remote?.sources() ?? []), ...gateways].map(
      (source) => ({ ...source, service: serviceOf(source)?.id }),
    );
  }

  // ── Ollama ────────────────────────────────────────────────────────────────

  /**
   * Whether the home may have this computer's Ollama load a model: the person picked it, or put
   * one of its models into their order. A model takes a large part of the computer's memory, so
   * finding Ollama is not enough.
   */
  ollamaPicked(): boolean {
    const said = this.db.meta(OLLAMA);
    if (said) return said === "on";
    return this.order().some((ref) => splitRef(ref).sourceId === "ollama");
  }

  /** Whether the person has said yes or no to Ollama. */
  ollamaSaid(): boolean {
    return Boolean(this.db.meta(OLLAMA));
  }

  pickOllama(on: boolean): void {
    this.db.setMeta(OLLAMA, on ? "on" : "off");
    if (!on) {
      const rest = this.order().filter((ref) => splitRef(ref).sourceId !== "ollama");
      this.db.setMeta("models.order", JSON.stringify(rest));
    }
  }

  /** The model Ollama would load once the person picks it; none when none leaves the computer room. */
  ollamaOffer(): { model: string; size: number } | undefined {
    const first = this.ollama[0];
    if (!first) return undefined;
    const here = onThisComputer(this.config.ollamaUrl);
    if (here && !fits(first, this.memory, MEMORY_SHARE)) return undefined;
    return { model: first.name, size: first.size };
  }

  order(): string[] {
    return JSON.parse(this.db.meta("models.order") ?? "[]") as string[];
  }

  setOrder(refs: string[]): void {
    this.db.setMeta("models.order", JSON.stringify(refs));
    // Naming one of its models in the order picks Ollama.
    if (refs.some((ref) => splitRef(ref).sourceId === "ollama")) this.db.setMeta(OLLAMA, "on");
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
   * subscription, then Ollama, then a gateway; this computer before another one. This
   * computer's Ollama is among them only once the person picked it.
   */
  candidates(): string[] {
    const available = new Map<string, ModelSource>();
    const picked = this.ollamaPicked();
    for (const source of this.sources()) {
      if (source.online && (picked || source.id !== "ollama")) available.set(source.id, source);
    }
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
    const here = this.ollamaPicked()
      ? this.ollama.filter((model) => model.vision).map((model) => `ollama:${model.name}`)
      : [];
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
    const account = this.account();
    if (sourceId === ACCOUNT.id && account) {
      const key = this.accountKey();
      if (!key) return undefined;
      const chat = accountModel(account, key, model);
      return { ref, model: () => chat };
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
    const found = this.ollama.find((m) => m.name === model);
    if (!found) return undefined;
    return ollamaModel({
      url: this.config.ollamaUrl,
      model,
      tools: found.tools,
      thinking: found.thinking,
      context: Number(process.env.WIZARDS_BOT_OLLAMA_CONTEXT ?? 16_384),
    });
  }

  /** How a turn of an installed client runs on this computer, when the client is there. */
  localClient(sourceId: string): ClientRun | undefined {
    if (!(isSubscription(sourceId) && this.clients.includes(sourceId))) return undefined;
    const subscription = SUBSCRIPTIONS[sourceId];
    return (turn, onEvent) => runTurn(subscription, turn, this.mcpUrl, onEvent);
  }
}

export function splitRef(ref: string): { sourceId: string; model: string } {
  const colon = ref.indexOf(":");
  return colon < 0
    ? { sourceId: ref, model: "default" }
    : { sourceId: ref.slice(0, colon), model: ref.slice(colon + 1) };
}
