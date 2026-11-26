import { totalmem } from "node:os";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { accountGateway } from "@engenty/model-providers/account";
import { detectClient } from "@engenty/model-providers/clients";
import { lmStudioFetch } from "@engenty/model-providers/lmstudio";
import { mlxModel, type Waiting } from "@engenty/model-providers/mlx";
import { type ChatModel, ollamaModel } from "@engenty/model-providers/ollama";
import { PROVIDERS, type ProviderId } from "@engenty/model-providers/providers";
import { compatibleModel, providerModel } from "@engenty/model-providers/providers/model";
import {
  fits,
  type InstalledModel,
  SERVERS,
  type ServerId,
} from "@engenty/model-providers/servers";
import { defineEmbedder, type SearchEmbedder } from "@engenty/search-index";
import { type Level, levelOf } from "@engenty/tool-harness";
import {
  type ModelService,
  type ModelSource,
  type Models as ModelsView,
  waitingForYes,
} from "@wizards-bot/protocol";
import { embedMany, type LanguageModel } from "ai";
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
  subscriptionOf,
} from "./client-model.ts";
import { chatModels, isServer, MEMORY_SHARE, onThisComputer } from "./ollama.ts";
import { agreed, serviceOf, services } from "./services.ts";

export type { ClientTurn } from "./client-model.ts";

/** The servers on this computer, the one the home asks first in front. */
const SERVERS_HERE: readonly ServerId[] = ["ollama", "lmstudio", "mlx"];

/** What answers a turn: a model Mastra asks. A subscription's model needs the turn's MCP token. */
export interface Engine {
  ref: string;
  /** What the model can be trusted with. */
  level: Level;
  /** A client that steps by itself and reaches the tools over MCP. */
  steps?: true;
  model(turn: {
    mcpToken: string;
    conversationId: string;
    /** What a model on this computer waits for before its first word; null once it answers. */
    onWaiting?: (waiting: Waiting | null) => void;
  }): LanguageModel;
  /** The model as one that only reads ahead, when it can: a turn after it starts at once. */
  ahead?(): LanguageModel;
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

/**
 * The provider of `@engenty/model-providers` behind a gateway's id: who it is, its first model and
 * how a model on its key is asked come from there. The home's id of the Vercel AI Gateway stays
 * `vercel`, as the gateways and keys it has stored name it.
 */
export const PROVIDER_OF: Record<string, ProviderId> = {
  openrouter: "openrouter",
  vercel: "gateway",
  openai: "openai",
  anthropic: "anthropic",
};

/** Where each known gateway answers as OpenAI's API does: what a stored gateway carries. */
const ADDRESSES: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  vercel: "https://ai-gateway.vercel.sh/v1",
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
};

export const GATEWAY_PRESETS: Record<string, Omit<Gateway, "models">> = Object.fromEntries(
  Object.entries(PROVIDER_OF).map(([id, provider]) => [
    id,
    { id, label: PROVIDERS[provider].name, baseUrl: ADDRESSES[id] as string },
  ]),
);

/** A known gateway's first model when the person adds it; they may name another. */
export const GATEWAY_MODELS: Record<string, string> = Object.fromEntries(
  Object.entries(PROVIDER_OF).map(([id, provider]) => [id, PROVIDERS[provider].model as string]),
);

/**
 * A model of a gateway, on its key. A known provider at its own address is asked through its
 * own AI SDK package (`providerModel`), so what only its API has reaches the model. A gateway of
 * the person's own, and a known one that was given another address, is asked as OpenAI's API is.
 */
export function gatewayModel(
  gateway: Pick<Gateway, "id" | "baseUrl">,
  key: string,
  model: string,
  doFetch?: typeof fetch,
): LanguageModel {
  const provider = PROVIDER_OF[gateway.id];
  if (provider && gateway.baseUrl === ADDRESSES[gateway.id]) {
    return providerModel(provider, key, model, doFetch ? { fetch: doFetch } : {});
  }
  return compatibleModel({
    name: gateway.id,
    baseUrl: gateway.baseUrl,
    key,
    model,
    ...(doFetch ? { fetch: doFetch } : {}),
  });
}

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
/** Names the space of the account's vectors; their own length is what the search compares. */
const ACCOUNT_DIMENSIONS = 1536;

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
  return accountGateway({
    url: account.gatewayUrl,
    key,
    ...(doFetch ? { fetch: doFetch } : {}),
  })(model);
}

/** The account's embedding model, for the search over tools. */
export function accountEmbedder(account: Account, key: string): SearchEmbedder {
  const model = accountGateway({ url: account.gatewayUrl, key }).embeddingModel(
    "wizards/embedding",
  );
  return defineEmbedder(async (texts) => (await embedMany({ model, values: texts })).embeddings, {
    dimensions: ACCOUNT_DIMENSIONS,
    modelId: "wizards/embedding",
  });
}

/** The sources the person picked in the setup. */
const PICKED = "models.picked";

/** The sources whose model the person chose: of them that model answers, and no other. */
const CHOSEN = "models.chosen";

/** Whether the person picked Ollama: "on" or "off". */
const OLLAMA = "models.ollama";

const REFRESH_MS = 60_000;

/** Tokens a model on this computer reads at most. */
const CONTEXT = Number(process.env.WIZARDS_BOT_OLLAMA_CONTEXT ?? 16_384);

/**
 * Sources that answer only once the person picked them or put one of their models into the
 * order, on every home: found alone they answer nowhere.
 */
const ON_PICK = new Set<string>(["antigravity", "cursor", "lmstudio", "mlx"]);

/** A model its source does not have. */
export class ModelRefused extends Error {}

export class Models {
  private held: Record<ServerId, InstalledModel[]> = { ollama: [], lmstudio: [], mlx: [] };
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
    const held = await Promise.all(
      SERVERS_HERE.map((id) => {
        const url = this.serverUrl(id);
        const memory = id === "mlx" || onThisComputer(url) ? this.memory : undefined;
        return chatModels(url, memory, undefined, id);
      }),
    );
    for (const [at, id] of SERVERS_HERE.entries()) this.held[id] = held[at] ?? [];
    const wanted = this.config.subscriptions.filter(isSubscription);
    const found = await Promise.all(
      wanted.map((id) => detectClient(SUBSCRIPTIONS[id].client, force)),
    );
    this.clients = wanted.filter((_, at) => found[at]?.version);
  }

  /** Where a server of this computer answers. */
  serverUrl(id: ServerId): string {
    switch (id) {
      case "ollama":
        return this.config.ollamaUrl;
      case "lmstudio":
        return this.config.lmstudioUrl;
      case "mlx":
        return this.config.mlxFolder;
    }
  }

  // ── Gateways ──────────────────────────────────────────────────────────────

  gateways(): Gateway[] {
    return JSON.parse(this.db.meta("models.gateways") ?? "[]") as Gateway[];
  }

  setGateway(gateway: Gateway, key: string): void {
    const rest = this.gateways().filter((g) => g.id !== gateway.id);
    this.db.setMeta("models.gateways", JSON.stringify([...rest, gateway]));
    this.secrets.set(`gateway.${gateway.id}`, key);
    this.addPicked(gateway.id);
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
    for (const id of SERVERS_HERE) {
      const held = this.held[id];
      if (!held.length) continue;
      sources.push({
        id,
        kind: id,
        label: SERVERS[id].name,
        where: this.where,
        online: true,
        models: held.map((model) => ({ id: model.name, label: model.name })),
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

  // ── What the person picked ────────────────────────────────────────────────

  /**
   * The sources the person picked in the setup, or added since; undefined on a home whose setup
   * asked for none. Once they picked, nothing else answers: not a client that happens to be
   * installed, not a gateway that happens to have a key.
   */
  picked(): string[] | undefined {
    const saved = this.db.meta(PICKED);
    return saved ? (JSON.parse(saved) as string[]) : undefined;
  }

  /** The person picks one source in the setup: it alone answers. */
  pickSource(id: string): void {
    if (id === "ollama") this.db.setMeta(OLLAMA, "on");
    else if (this.ollamaPicked()) this.pickOllama(false);
    this.db.setMeta("models.order", JSON.stringify([]));
    this.db.setMeta(PICKED, JSON.stringify([id]));
  }

  /** Another source beside the picked ones: a key added later, a model named in the order. */
  private addPicked(id: string): void {
    const picked = this.picked();
    if (picked && !picked.includes(id)) this.db.setMeta(PICKED, JSON.stringify([...picked, id]));
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
    if (on) {
      this.addPicked("ollama");
    } else {
      const picked = this.picked()?.filter((id) => id !== "ollama");
      if (picked) this.db.setMeta(PICKED, JSON.stringify(picked));
      const rest = this.order().filter((ref) => splitRef(ref).sourceId !== "ollama");
      this.db.setMeta("models.order", JSON.stringify(rest));
    }
  }

  /** The model of a source the person named first; the home's own choice when they named none. */
  namedModel(id: string): string | undefined {
    const ref = this.order().find((entry) => sourceOf(entry) === id);
    return ref && splitRef(ref).model;
  }

  /**
   * The person chooses the model of a source. The source keeps its place among those that answer,
   * one that did not answer comes last; the others keep theirs.
   */
  chooseModel(sourceId: string, model: string): void {
    const source = this.sources().find((candidate) => candidate.id === sourceId);
    if (!source?.models.some((offered) => offered.id === model)) {
      throw new ModelRefused(`${source?.label ?? sourceId} does not have ${model}.`);
    }
    this.db.setMeta(CHOSEN, JSON.stringify([...new Set([...this.chosen(), sourceId])]));
    const ref = `${sourceId}:${model}`;
    const order = this.order();
    const at = order.findIndex((entry) => sourceOf(entry) === sourceId);
    if (at >= 0) {
      const others = (entry: string) => sourceOf(entry) !== sourceId;
      this.setOrder([...order.slice(0, at), ref, ...order.slice(at + 1).filter(others)]);
      return;
    }
    // Those that answer before it are named too: a named source answers before one that is not.
    const named = new Set(order.map(sourceOf));
    const unnamed = this.candidates().filter((entry) => !named.has(sourceOf(entry)));
    const place = unnamed.findIndex((entry) => sourceOf(entry) === sourceId);
    this.setOrder([...order, ...(place < 0 ? unnamed : unnamed.slice(0, place)), ref]);
  }

  /** The sources whose model the person chose. */
  private chosen(): string[] {
    return JSON.parse(this.db.meta(CHOSEN) ?? "[]") as string[];
  }

  /** A model the person named for a gateway that had others. */
  addGatewayModel(id: string, model: string): void {
    const gateways = this.gateways().map((gateway) =>
      gateway.id === id && !gateway.models.includes(model)
        ? { ...gateway, models: [...gateway.models, model] }
        : gateway,
    );
    this.db.setMeta("models.gateways", JSON.stringify(gateways));
  }

  /** Whether the person picked a source, in the setup or by naming one of its models in the order. */
  isPicked(id: string): boolean {
    return (
      Boolean(this.picked()?.includes(id)) ||
      this.order().some((ref) => splitRef(ref).sourceId === id)
    );
  }

  /** Whether a server's models see the person's words: it was picked. */
  serverPicked(id: ServerId): boolean {
    return id === "ollama" ? this.ollamaPicked() : this.isPicked(id);
  }

  /** The model Ollama would load once the person picks it; none when none leaves the computer room. */
  ollamaOffer(): { model: string; size: number } | undefined {
    const first = this.held.ollama[0];
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
    for (const ref of refs) this.addPicked(splitRef(ref).sourceId);
  }

  view(): ModelsView {
    const sources = this.sources();
    const candidates = this.candidates();
    const used = candidates.map((ref) => splitRef(ref).sourceId);
    return {
      sources,
      order: this.order(),
      current: candidates[0],
      answers: candidates,
      services: services(sources, used, agreed(this.db)),
    };
  }

  /** The services in use that wait for the person's yes before a device's words reach them. */
  waitingForYes(): ModelService[] {
    return waitingForYes(this.view());
  }

  /**
   * Model refs in the order the home tries them: the person's order first, then a
   * subscription, then Ollama, then LM Studio, then MLX, then a gateway; this computer before another one. This
   * computer's Ollama is among them only once the person picked it; once they picked in the
   * setup, only what they picked is.
   */
  candidates(): string[] {
    const available = new Map<string, ModelSource>();
    const ollama = this.ollamaPicked();
    const picked = this.picked();
    for (const source of this.sources()) {
      // A linked computer and the account are picked by linking and by the sign-up.
      const asked = source.id.includes("/") || source.id === ACCOUNT.id;
      if (picked && !asked && !picked.includes(source.id)) continue;
      const own = source.id.slice(source.id.lastIndexOf("/") + 1);
      if (ON_PICK.has(own) && !this.isPicked(source.id)) continue;
      if (source.online && (ollama || source.id !== "ollama")) available.set(source.id, source);
    }
    const chosen = new Set(this.chosen());
    const refs: string[] = [];
    const add = (ref: string) => {
      const { sourceId, model } = splitRef(ref);
      const source = available.get(sourceId);
      if (!source?.models.some((m) => m.id === model)) return;
      if (!refs.includes(ref)) refs.push(ref);
    };
    for (const ref of this.order()) add(ref);
    for (const kind of ["subscription", "ollama", "lmstudio", "mlx", "gateway"] as const) {
      for (const source of available.values()) {
        const first = source.models[0];
        // Of a source the person picked, the model they named is the one: no other is loaded.
        const one = picked || chosen.has(source.id);
        if (one && refs.some((ref) => sourceOf(ref) === source.id)) continue;
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
    const here = SERVERS_HERE.filter((id) => this.serverPicked(id)).flatMap((id) =>
      this.held[id].filter((model) => model.vision).map((model) => `${id}:${model.name}`),
    );
    const elsewhere: { ref: string; label: string }[] = [];
    for (const ref of this.candidates()) {
      const { sourceId } = splitRef(ref);
      const source = this.sources().find((candidate) => candidate.id === sourceId);
      if (source && !isServer(source.kind)) elsewhere.push({ ref, label: source.label });
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
      return chat && { ref, level: this.localLevel(sourceId, model), model: () => chat };
    }
    if (sourceId === "lmstudio") {
      if (!this.held.lmstudio.some((held) => held.name === model)) return undefined;
      const url = this.config.lmstudioUrl;
      const chat = createOpenAICompatible({
        name: "lmstudio",
        baseURL: `${url}/v1`,
        fetch: lmStudioFetch(url, { context: CONTEXT }),
      })(model);
      return { ref, level: this.localLevel(sourceId, model), model: () => chat };
    }
    if (sourceId === "mlx") {
      const found = this.held.mlx.find((held) => held.name === model);
      if (!found) return undefined;
      const chat = {
        folder: this.config.mlxFolder,
        model,
        tools: found.tools,
        ...(found.thinking ? { thinking: true } : {}),
      };
      return {
        ref,
        level: this.localLevel(sourceId, model),
        model: ({ onWaiting }) => mlxModel({ ...chat, onWaiting }),
        ahead: () => mlxModel({ ...chat, warm: true }),
      };
    }
    const run = this.localClient(sourceId);
    if (run) {
      return {
        ref,
        level: "high",
        steps: true,
        model: ({ mcpToken, conversationId }) =>
          clientModel({
            provider: sourceId,
            model,
            mcpToken,
            run,
            sessions: subscriptionOf(sourceId)?.resumes
              ? clientSessions(this.db, conversationId, sourceId)
              : undefined,
          }),
      };
    }
    const account = this.account();
    if (sourceId === ACCOUNT.id && account) {
      const key = this.accountKey();
      if (!key) return undefined;
      const chat = accountModel(account, key, model);
      const level = model === ACCOUNT.models[0] ? "standard" : "high";
      return { ref, level, model: () => chat };
    }
    const gateway = this.gateways().find((g) => g.id === sourceId);
    const key = this.secrets.get(`gateway.${sourceId}`);
    if (!gateway || !key) return undefined;
    const chat = gatewayModel(gateway, key, model);
    return { ref, level: levelOf({ model }), model: () => chat };
  }

  /** What an open model on this computer can be trusted with, by its name and its size. */
  private localLevel(id: ServerId, model: string): Level {
    const size = this.held[id].find((held) => held.name === model)?.size;
    return levelOf({ model, local: true, ...(size ? { size } : {}) });
  }

  /** An Ollama model of this computer. A linked computer serves it to its home through this. */
  localChat(model: string): ChatModel | undefined {
    const found = this.held.ollama.find((m) => m.name === model);
    if (!found) return undefined;
    return ollamaModel({
      url: this.config.ollamaUrl,
      model,
      tools: found.tools,
      thinking: found.thinking,
      context: CONTEXT,
    });
  }

  /** How a turn of an installed client runs on this computer, when the client is there. */
  localClient(sourceId: string): ClientRun | undefined {
    if (!(isSubscription(sourceId) && this.clients.includes(sourceId))) return undefined;
    const subscription = SUBSCRIPTIONS[sourceId];
    return (turn, onEvent) => runTurn(subscription, turn, this.mcpUrl, onEvent);
  }
}

const sourceOf = (ref: string): string => splitRef(ref).sourceId;

export function splitRef(ref: string): { sourceId: string; model: string } {
  const colon = ref.indexOf(":");
  return colon < 0
    ? { sourceId: ref, model: "default" }
    : { sourceId: ref.slice(0, colon), model: ref.slice(colon + 1) };
}
