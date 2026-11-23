import { execFileSync } from "node:child_process";
import { hostname, networkInterfaces, userInfo } from "node:os";
import type { Card, HomeInfo, Message } from "@wizards-bot/protocol";
import { PROTOCOL_VERSION } from "@wizards-bot/protocol";
import { McpTurns } from "./agent/mcp.ts";
import type { Tool } from "./agent/tool.ts";
import { buildTools, registerCardHandlers } from "./agent/tools.ts";
import { type Trigger, type TurnContext, Turns } from "./agent/turns.ts";
import { Artifacts } from "./artifacts/artifacts.ts";
import { Avatars } from "./avatar/avatars.ts";
import { Browser } from "./browser/browser.ts";
import { type ChannelAdapter, Channels } from "./channels/channels.ts";
import { ADAPTERS } from "./channels/index.ts";
import { type Config, isHosted, VERSION } from "./config.ts";
import { Connections } from "./connections/connections.ts";
import { Handoffs } from "./devices/handoffs.ts";
import { Events } from "./events.ts";
import { Files } from "./files/files.ts";
import { Folders } from "./folders/folders.ts";
import { Hosted } from "./hosted.ts";
import { Identity, Secrets } from "./identity.ts";
import { HomeMastra } from "./mastra.ts";
import { Models } from "./models/models.ts";
import { Notifier } from "./notify/notifier.ts";
import { Peers } from "./peers/peers.ts";
import { keyDomain } from "./peers/person.ts";
import { Plugins } from "./plugins/plugins.ts";
import { Setup } from "./setup/setup.ts";
import { Sharing } from "./sharing/sharing.ts";
import { Skills } from "./skills/skills.ts";
import { Db } from "./store/db.ts";
import { Store } from "./store/store.ts";
import { Tasks } from "./tasks/tasks.ts";
import { Vault } from "./vault/vault.ts";

/** Field values as the person typed them, secrets included. */
export type CardValues = Record<string, string | string[]>;

/** What the home does when a card of one payload type is answered. */
export type CardHandler = (input: {
  card: Card;
  action: string;
  values: CardValues;
  payload: Record<string, unknown>;
}) => void | Promise<void>;

/** Everything one home is made of. */
export class Home {
  readonly config: Config;
  readonly db: Db;
  readonly identity: Identity;
  readonly secrets: Secrets;
  readonly events = new Events();
  readonly store: Store;
  readonly mastra: HomeMastra;
  readonly files: Files;
  readonly folders: Folders;
  readonly skills: Skills;
  readonly plugins: Plugins;
  readonly artifacts: Artifacts;
  readonly sharing: Sharing;
  readonly avatars: Avatars;
  readonly models: Models;
  readonly turns: Turns;
  readonly mcp = new McpTurns();
  readonly notifier: Notifier;
  readonly connections: Connections;
  readonly browser: Browser;
  readonly vault: Vault;
  readonly peers: Peers;
  readonly channels: Channels;
  readonly tasks: Tasks;
  readonly handoffs: Handoffs;
  /** The checks of the first start and of `doctor`. */
  readonly setup: Setup;
  /** What a home on wizards.bot has of the Manage-App: its setup code and its claim. */
  readonly hosted: Hosted;
  private readonly cardHandlers = new Map<string, CardHandler>();
  /** Card handlers that still run. */
  private readonly handling = new Set<Promise<void>>();
  /** More tools for a turn, from the parts of the home that are set up later. */
  private readonly toolSources: ((context: TurnContext) => Tool[])[] = [];
  /** Called with every finished message of an agent. */
  private readonly deliveries: ((message: Message, trigger: Trigger) => void)[] = [];

  constructor(config: Config, adapters: ChannelAdapter[] = ADAPTERS) {
    this.config = config;
    this.db = new Db(config.dataDir);
    this.identity = new Identity(config.dataDir);
    this.secrets = new Secrets(this.db, config.dataDir);
    this.store = new Store(this.db, this.events);
    this.mastra = new HomeMastra(config.dataDir);
    this.files = new Files(this);
    this.models = new Models(config, this.db, this.secrets, computerName());
    this.turns = new Turns(this);
    registerCardHandlers(this);
    this.notifier = new Notifier(this);
    this.connections = new Connections(this);
    this.browser = new Browser(this);
    this.vault = new Vault(this);
    this.peers = new Peers(this);
    this.tasks = new Tasks(this);
    this.folders = new Folders(this);
    this.handoffs = new Handoffs(this);
    this.skills = new Skills(this);
    this.plugins = new Plugins(this, () => this.skills.ownNames());
    this.artifacts = new Artifacts(this);
    this.sharing = new Sharing(this);
    this.avatars = new Avatars(this);
    this.channels = new Channels(this, adapters);
    this.setup = new Setup(this);
    this.hosted = new Hosted(this);
    this.store.failInterrupted();
    this.store.mainAgent();
  }

  // ── The person ────────────────────────────────────────────────────────────

  /**
   * The person's name: the one they said, the one their wizards account gave, or the one of this
   * computer's account. Empty while nobody said it on a hosted home or under `root`: the
   * setup asks for it then.
   */
  person(): string {
    const saved = this.db.meta("person.name");
    if (saved) return saved;
    const name = isHosted(this.config) ? "" : fullName();
    if (name) this.db.setMeta("person.name", name);
    return name;
  }

  /**
   * The person's handle. With an address the home is reached at, it is `name@domain`; without
   * one, the home is known by its person's key, once that key is made.
   */
  handle(): string | undefined {
    return this.handleFor(this.config.publicUrl ? undefined : this.peers?.person.current()?.id);
  }

  /** The handle as it is, or as it would be for a person of that id in a home without an address. */
  handleFor(personId: string | undefined): string | undefined {
    const name = (
      this.db.meta("person.handle") ??
      (this.person().split(/\s+/)[0] || "me")
    ).toLowerCase();
    const spelled = name.replace(/[^a-z0-9._-]/g, "");
    if (!this.config.publicUrl) return personId ? `${spelled}@${keyDomain(personId)}` : undefined;
    // The person's own domain, when one leads to this home; the home's address otherwise.
    const domain = this.db.meta("person.domain") ?? new URL(this.config.publicUrl).host;
    return `${spelled}@${domain}`;
  }

  info(): HomeInfo {
    return {
      protocol: PROTOCOL_VERSION,
      version: VERSION,
      name: this.person(),
      handle: this.handle(),
      publicKey: this.identity.publicKey,
    };
  }

  /** The address a device on the same network, or anywhere, reaches this home at. */
  address(): string {
    return this.config.publicUrl ?? `http://${lanAddress()}:${this.config.port}`;
  }

  // ── Turns ─────────────────────────────────────────────────────────────────

  tools(context: TurnContext): Tool[] {
    return [...buildTools(context), ...this.toolSources.flatMap((source) => source(context))];
  }

  addTools(source: (context: TurnContext) => Tool[]): void {
    this.toolSources.push(source);
  }

  onDelivered(listener: (message: Message, trigger: Trigger) => void): void {
    this.deliveries.push(listener);
  }

  delivered(message: Message, trigger: Trigger): void {
    for (const listener of this.deliveries) {
      try {
        listener(message, trigger);
      } catch (error) {
        console.error("[deliver]", error);
      }
    }
  }

  /** Starts a turn from the home itself, e.g. after a card was answered. */
  tell(conversationId: string, text: string): void {
    void this.turns.enqueue({ conversationId, text: `[home] ${text}`, channel: "home" });
  }

  /** Removes an agent with its conversation and what Mastra kept of it. The main agent stays. */
  removeAgent(agentId: string): boolean {
    const agent = this.store.agent(agentId);
    if (!agent || agent.main) return false;
    // A room that goes from the list is left, or closed when this home keeps it.
    const left = this.peers.rooms.leaving(agent);
    if (agent.origin === "own") this.peers.rooms.agentRemoved(agentId);
    if (!this.store.removeAgent(agentId)) return false;
    left?.();
    this.peers.left(agent);
    this.peers.outside.forget(agentId);
    void this.mastra.forget(agent.conversationId);
    return true;
  }

  // ── Cards ─────────────────────────────────────────────────────────────────

  onCard(type: string, handler: CardHandler): void {
    this.cardHandlers.set(type, handler);
  }

  /**
   * Answers a card for the person. Secret values reach the card's handler and nothing else:
   * the stored answer and every device see "•••". A card whose payload says `private`
   * keeps no value at all.
   */
  async answer(
    cardId: string,
    input: { action: string; values?: CardValues; by: string },
  ): Promise<Card | undefined> {
    const before = this.store.card(cardId);
    if (!before) return undefined;
    const values = input.values ?? {};
    const shown: CardValues = {};
    const hidden = this.store.cardPayload<{ private?: boolean }>(cardId)?.private === true;
    for (const [id, value] of hidden ? [] : Object.entries(values)) {
      const field = before.fields?.find((candidate) => candidate.id === id);
      shown[id] = field?.type === "secret" ? "•••" : value;
    }
    const card = this.store.answerCard(cardId, {
      action: input.action,
      values: Object.keys(shown).length ? shown : undefined,
      by: input.by,
    });
    if (!card) return undefined;
    this.notifier.resolved([card.id]);
    const payload = this.store.cardPayload<Record<string, unknown>>(cardId) ?? { type: "ask" };
    const handler = this.cardHandlers.get(String(payload.type));
    // The device gets its answer at once; what the card sets off runs after it.
    const work = Promise.resolve()
      .then(() => handler?.({ card, action: input.action, values, payload }))
      .catch((error) => {
        this.tell(
          card.conversationId,
          `Acting on the card "${card.title}" failed: ${(error as Error).message}`,
        );
      })
      .finally(() => this.handling.delete(work));
    this.handling.add(work);
    return card;
  }

  /** Resolves when no card handler and no turn runs or waits. */
  async idle(): Promise<void> {
    do {
      await Promise.all(this.handling);
      await this.turns.idle();
    } while (this.handling.size);
  }

  close(): void {
    this.hosted.stop();
    this.peers.mailbox.stop();
    this.tasks.stop();
    this.channels.stop();
    this.notifier.close();
    this.connections.close();
    void this.browser.stop();
    this.plugins.close();
    this.mastra.close();
    this.db.close();
  }
}

function fullName(): string {
  try {
    if (process.platform === "darwin") {
      const name = execFileSync("id", ["-F"], { encoding: "utf8" }).trim();
      if (name) return name;
    }
  } catch {}
  return accountName(userInfo().username);
}

/** A name from the computer's account. The superuser of a server or a container is no one's. */
export function accountName(user: string): string {
  if (user === "root") return "";
  return user.charAt(0).toUpperCase() + user.slice(1);
}

function computerName(): string {
  try {
    if (process.platform === "darwin") {
      return execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8" }).trim();
    }
  } catch {}
  return hostname();
}

function lanAddress(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return "127.0.0.1";
}
