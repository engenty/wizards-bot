import { execFileSync } from "node:child_process";
import { hostname, networkInterfaces, userInfo } from "node:os";
import { join } from "node:path";
import type { Card, HomeInfo, HomePerson, Message } from "@wizards-bot/protocol";
import { PROTOCOL_VERSION } from "@wizards-bot/protocol";
import { REPLY_ACTION } from "@wizards-bot/protocol/limits";
import { Handed } from "./agent/handed.ts";
import { ToolSearch } from "./agent/harness.ts";
import { McpTurns } from "./agent/mcp.ts";
import type { Tool } from "./agent/tool.ts";
import { buildTools, registerCardHandlers } from "./agent/tools.ts";
import { type Trigger, type TurnContext, Turns } from "./agent/turns.ts";
import { Artifacts } from "./artifacts/artifacts.ts";
import { Avatars } from "./avatar/avatars.ts";
import { Browser } from "./browser/browser.ts";
import { type OwnCertificate, ownCertificate } from "./certificate.ts";
import { type ChannelAdapter, Channels } from "./channels/channels.ts";
import { ADAPTERS } from "./channels/index.ts";
import { type Config, isHosted, VERSION } from "./config.ts";
import { Apps } from "./connections/apps.ts";
import { Connections } from "./connections/connections.ts";
import { Handoffs } from "./devices/handoffs.ts";
import { Events } from "./events.ts";
import { Files } from "./files/files.ts";
import { Folders } from "./folders/folders.ts";
import { Group } from "./group.ts";
import { Hosted } from "./hosted.ts";
import { Identity, Secrets } from "./identity.ts";
import { Looks } from "./look.ts";
import { HomeMastra } from "./mastra.ts";
import { Models } from "./models/models.ts";
import { Notifier } from "./notify/notifier.ts";
import { Peers } from "./peers/peers.ts";
import { keyDomain } from "./peers/person.ts";
import { Plugins } from "./plugins/plugins.ts";
import { Setup } from "./setup/setup.ts";
import { Sharing } from "./sharing/sharing.ts";
import { Shell } from "./shell/shell.ts";
import { Skills } from "./skills/skills.ts";
import { Db } from "./store/db.ts";
import { AlreadyAnswered, Store } from "./store/store.ts";
import { Tasks } from "./tasks/tasks.ts";
import { Tunnel } from "./tunnel/tunnel.ts";
import { Vault } from "./vault/vault.ts";

/** Field values as the person typed them, secrets included. */
export type CardValues = Record<string, string | string[]>;

/** What the home does when a card of one payload type is answered. */
export type CardHandler = (input: {
  card: Card;
  action: string;
  values: CardValues;
  payload: Record<string, unknown>;
  /** The person answered with a message: what it would have started. */
  said?: Trigger;
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
  /** The agents' sandboxed shell. */
  readonly shell: Shell;
  readonly skills: Skills;
  readonly plugins: Plugins;
  readonly artifacts: Artifacts;
  readonly apps: Apps;
  readonly sharing: Sharing;
  readonly avatars: Avatars;
  readonly looks: Looks;
  readonly models: Models;
  readonly turns: Turns;
  /** Tasks agents handed to other agents, until their answer comes. */
  readonly handed: Handed;
  readonly toolSearch: ToolSearch;
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
  /** A home that belongs to a team: its people, from the Manage-App. */
  readonly group: Group;
  /** The address at wizards.host, when the person switched it on. */
  readonly tunnel: Tunnel;
  private readonly cardHandlers = new Map<string, CardHandler>();
  /** Card handlers that still run. */
  private readonly handling = new Set<Promise<void>>();
  /** More tools for a turn, from the parts of the home that are set up later. */
  private readonly toolSources: ((context: TurnContext) => Tool[])[] = [];
  /** The home's own certificate, once it was asked for. */
  private madeCertificate: OwnCertificate | undefined;
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
    this.toolSearch = new ToolSearch(this);
    this.turns = new Turns(this);
    this.handed = new Handed(this);
    registerCardHandlers(this);
    this.notifier = new Notifier(this);
    this.connections = new Connections(this);
    this.browser = new Browser(this);
    this.vault = new Vault(this);
    this.peers = new Peers(this);
    this.tasks = new Tasks(this);
    this.folders = new Folders(this);
    this.shell = new Shell(this);
    this.handoffs = new Handoffs(this);
    this.skills = new Skills(this);
    this.plugins = new Plugins(this, () => this.skills.ownNames());
    this.artifacts = new Artifacts(this);
    this.apps = new Apps(this);
    this.sharing = new Sharing(this);
    this.avatars = new Avatars(this);
    this.looks = new Looks(this);
    this.channels = new Channels(this, adapters);
    this.setup = new Setup(this);
    this.hosted = new Hosted(this);
    this.group = new Group(this);
    this.tunnel = new Tunnel(this);
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
    const print = this.certificate()?.print;
    return {
      protocol: PROTOCOL_VERSION,
      version: VERSION,
      name: this.person(),
      handle: this.handle(),
      publicKey: this.identity.publicKey,
      ...(print ? { print } : {}),
      hosted: isHosted(this.config),
      ...(this.group.isGroup() ? { group: { name: this.person() } } : {}),
      ...(this.group.studio() ? { studio: this.group.studio() } : {}),
    };
  }

  /**
   * The home's own certificate for https on the person's network, made the first time. None for
   * a home with an address of its own: that address has a certificate anyone checks.
   */
  certificate(): OwnCertificate | undefined {
    if (this.config.publicUrl) return undefined;
    this.madeCertificate ??= ownCertificate(join(this.config.dataDir, "certificate"));
    return this.madeCertificate;
  }

  /**
   * Where the apps pair: on this network the same address over https, with the print of the
   * key it answers with; elsewhere `address()`, whose certificate anyone checks. A browser keeps
   * `address()`: it cannot know the print.
   */
  pairingAddress(): { address: string; print?: string } {
    const address = this.address();
    const certificate = this.certificate();
    if (!certificate || !address.startsWith("http://")) return { address };
    return { address: `https://${address.slice("http://".length)}`, print: certificate.print };
  }

  /**
   * The address a device reaches this home at: its own, the one at wizards.host when the person
   * switched it on, or the one on this network.
   */
  address(): string {
    return (
      this.config.publicUrl ?? this.tunnel.address() ?? `http://${lanAddress()}:${this.config.port}`
    );
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
    // The members' own conversations with it go with it.
    const members = this.store.memberConversations({ agent: agentId });
    if (!this.store.removeAgent(agentId)) return false;
    for (const id of members) void this.mastra.forget(id);
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
    input: {
      action: string;
      values?: CardValues;
      /** The message that answered a question, and what it would have started. */
      message?: string;
      /** A view's answer: its form's values. */
      state?: Record<string, unknown>;
      said?: Trigger;
      by: string;
      person?: HomePerson;
    },
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
      message: input.message,
      ...(input.state ? { state: input.state } : {}),
      by: input.by,
      ...(input.person ? { person: { id: input.person.id, name: input.person.name } } : {}),
    });
    if (!card) return undefined;
    // A member's card was on no admin's device.
    if (!this.store.memberOf(card.conversationId)) this.notifier.resolved([card.id]);
    this.handed.answering(card);
    const payload = this.store.cardPayload<Record<string, unknown>>(cardId) ?? { type: "ask" };
    const handler = this.cardHandlers.get(String(payload.type));
    // The device gets its answer at once; what the card sets off runs after it.
    const work = Promise.resolve()
      .then(() => handler?.({ card, action: input.action, values, payload, said: input.said }))
      .then(() => this.handed.afterCard(card))
      .catch((error) => {
        this.tell(
          card.conversationId,
          `Acting on the card "${card.title}" failed: ${(error as Error).message}`,
        );
      })
      .finally(() => {
        this.handed.handled(card.id);
        this.handling.delete(work);
      });
    this.handling.add(work);
    return card;
  }

  /**
   * The person wrote something: it answers the question it is for, and starts or joins a turn
   * otherwise. `answers` is the question's card; null says it is for none. Left out, it is the
   * newest question that waits in the conversation, unless the agent works on something else
   * right now: the agent reads whether it is an answer.
   */
  said(
    trigger: Trigger,
    {
      answers,
      words,
      by,
      person,
    }: { answers?: string | null; words: string; by: string; person?: HomePerson },
  ): void {
    const open = this.store.openCards(trigger.conversationId).filter((card) => card.reply);
    const writing = this.turns.writing(trigger.conversationId);
    const question =
      answers === null
        ? undefined
        : answers === undefined
          ? open.findLast((card) => (writing ?? card.messageId) === card.messageId)
          : open.find((card) => card.id === answers);
    if (!question) {
      void this.turns.enqueue(trigger);
      return;
    }
    void this.answer(question.id, {
      action: REPLY_ACTION,
      message: words.trim(),
      by,
      person,
      said: trigger,
    }).catch((error) => {
      if (!(error instanceof AlreadyAnswered)) console.error("[answer]", error);
      // Another device was first: it is a message like any other.
      void this.turns.enqueue(trigger);
    });
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
    this.group.stop();
    this.tunnel.stop();
    this.peers.mailbox.stop();
    this.tasks.stop();
    this.channels.stop();
    this.notifier.close();
    this.connections.close();
    void this.browser.stop();
    void this.shell.close();
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
