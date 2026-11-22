import { randomInt } from "node:crypto";
import type { Card, CardField, Channel, Message } from "@wizards-bot/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import { defineTool, type Tool } from "../agent/tool.ts";
import type { Trigger, TurnContext } from "../agent/turns.ts";
import type { Home } from "../home.ts";
import { now } from "../ids.ts";

export type ChannelId = Extract<Channel, "slack" | "email" | "whatsapp" | "signal">;

/** What a channel hands the home when someone writes. */
export interface Incoming {
  /** Who wrote, as the channel names them: a Slack user id, an address, a phone number. */
  from: string;
  /** Where the answer goes, when that is not `from`: a Slack DM channel. */
  peer?: string;
  text: string;
  /** Lets the answer stay in the same thread: an email's Message-ID and subject. */
  thread?: string;
  /** The person pressed a button of a card. */
  answer?: { cardId: string; action: string };
}

/** What the home hands a channel to send. */
export interface Outgoing {
  text: string;
  /** Open cards the message carries. A channel without buttons sends `cardsAsText`. */
  cards: Card[];
  thread?: string;
}

export interface ChannelSetup {
  /** Steps for the person, Markdown. */
  body: string;
  fields: CardField[];
}

export interface ChannelContext {
  receive(incoming: Incoming): void;
  /** The home's public address, for channels that call it. */
  publicUrl: string | undefined;
  log(line: string): void;
}

export interface ChannelAdapter {
  id: ChannelId;
  label: string;
  setup: ChannelSetup;
  /** What has to be done before the claim code can arrive, when connecting is not enough. */
  beforeClaim?: string;
  /** Starts listening. Throws when the settings do not work. Returns how to stop. */
  start(settings: Record<string, string>, context: ChannelContext): Promise<() => void>;
  send(settings: Record<string, string>, peer: string, out: Outgoing): Promise<void>;
  /** Routes the channel needs on the home's server, e.g. a webhook. */
  routes?(app: Hono, channels: Channels): void;
}

interface Row {
  id: string;
  state: string;
  config: string;
  owner: string | null;
}

interface Running {
  adapter: ChannelAdapter;
  settings: Record<string, string>;
  stop: () => void;
}

const ENDS_TURN =
  "The card is in the chat. End your turn now with at most one short sentence. The answer arrives as the next message.";

/** A card for a channel that has no buttons: the person answers with a number. */
export function cardsAsText(cards: Card[]): string {
  return cards
    .map((card) => {
      const lines = [card.title];
      if (card.body) lines.push(card.body);
      if (card.url) lines.push(card.url);
      if (card.fields?.length) lines.push("Answer this one in the wizards.bot app.");
      else if (card.actions.length) {
        lines.push(
          card.actions.map((action, index) => `${index + 1}: ${action.label}`).join("   "),
        );
        lines.push("Reply with the number.");
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

/** The action a reply like "2" or "Send" picks on a card, if any. */
export function pickAction(card: Card, text: string): string | undefined {
  if (card.fields?.length) return undefined;
  const reply = text.trim().toLowerCase().replace(/[.!]$/, "");
  const number = /^\d$/.test(reply) ? Number(reply) : Number.NaN;
  if (!Number.isNaN(number)) return card.actions[number - 1]?.id;
  return card.actions.find((action) => action.label.toLowerCase() === reply)?.id;
}

/** The first line of a mail or chat message that is a claim, e.g. "claim 4821". */
export function claimCode(text: string): string | undefined {
  return /\bclaim[\s-]*(\d{4})\b/i.exec(text)?.[1];
}

/**
 * The ways to reach the agent besides the app. Each channel belongs to the person alone:
 * after the setup the person sends a claim code over the channel, and from then on only
 * that sender is heard.
 */
export class Channels {
  private readonly adapters = new Map<ChannelId, ChannelAdapter>();
  private readonly running = new Map<ChannelId, Running>();
  private readonly home: Home;

  constructor(home: Home, adapters: ChannelAdapter[]) {
    this.home = home;
    for (const adapter of adapters) this.adapters.set(adapter.id, adapter);
    home.addTools((context) => this.tools(context));
    home.onDelivered((message, trigger) => void this.deliver(message, trigger));
    this.registerCards();
  }

  routes(app: Hono): void {
    for (const adapter of this.adapters.values()) adapter.routes?.(app, this);
  }

  /** Starts every channel that is set up. */
  async start(): Promise<void> {
    for (const row of this.home.db.all<Row>("select * from channel")) {
      try {
        await this.startOne(row.id as ChannelId);
      } catch (error) {
        console.error(`[${row.id}] did not start: ${(error as Error).message}`);
        this.home.db.run("update channel set state = 'failed' where id = ?", row.id);
      }
    }
  }

  stop(): void {
    for (const running of this.running.values()) running.stop();
    this.running.clear();
  }

  settings(id: ChannelId): Record<string, string> | undefined {
    const raw = this.home.secrets.get(`channel.${id}`);
    return raw ? (JSON.parse(raw) as Record<string, string>) : undefined;
  }

  owner(id: ChannelId): string | undefined {
    return this.home.db.get<Row>("select * from channel where id = ?", id)?.owner ?? undefined;
  }

  /** What a channel calls when someone writes. Only the person is heard. */
  receive(id: ChannelId, incoming: Incoming): void {
    const { home } = this;
    const owner = this.owner(id);
    if (!owner) {
      const code = claimCode(incoming.text);
      if (!code || code !== home.db.meta(`channel.${id}.claim`)) return;
      home.db.run(
        "update channel set owner = ?, state = 'connected' where id = ?",
        incoming.from,
        id,
      );
      home.db.setMeta(`channel.${id}.claim`, "");
      void this.send(id, incoming.peer ?? incoming.from, {
        text: `This is ${home.store.mainAgent().name}. From now on I hear only you here.`,
        cards: [],
        thread: incoming.thread,
      });
      return;
    }
    // Mail from someone else starts no turn by itself. A task may wait for it.
    if (incoming.from !== owner) {
      if (id === "email") home.tasks.mail(incoming);
      return;
    }
    const peer = incoming.peer ?? incoming.from;
    home.db.setMeta("channel.last", JSON.stringify({ channel: id, peer, thread: incoming.thread }));
    const conversationId = home.store.mainAgent().conversationId;
    const by = this.adapters.get(id)?.label ?? id;

    if (incoming.answer) {
      void home
        .answer(incoming.answer.cardId, { action: incoming.answer.action, by })
        .catch(() => {});
      return;
    }
    // A bare number or a button's label answers the newest open card.
    const open = home.store.openCards(conversationId).at(-1);
    const action = open ? pickAction(open, incoming.text) : undefined;
    if (open && action) {
      void home.answer(open.id, { action, by }).catch(() => {});
      return;
    }
    home.store.addMessage({
      conversationId,
      role: "you",
      channel: id,
      parts: [{ type: "text", text: incoming.text }],
    });
    void home.turns.enqueue({
      conversationId,
      text: incoming.text,
      channel: id,
      replyTo: { channel: id, peer, thread: incoming.thread },
    });
  }

  async send(id: ChannelId, peer: string, out: Outgoing): Promise<void> {
    const running = this.running.get(id);
    if (!running) return;
    try {
      await running.adapter.send(running.settings, peer, out);
    } catch (error) {
      console.error(`[${id}] could not send: ${(error as Error).message}`);
    }
  }

  /**
   * A reply goes back where the message came from. What the agent starts by itself reaches
   * the person's devices by push; without a push key it goes to the channel used last.
   */
  private async deliver(message: Message, trigger: Trigger): Promise<void> {
    let target = trigger.replyTo as
      | { channel: ChannelId; peer: string; thread?: string }
      | undefined;
    if (!target && trigger.channel === "home" && !trigger.done && !this.home.notifier.key()) {
      const last = this.home.db.meta("channel.last");
      if (last) target = JSON.parse(last) as typeof target;
    }
    if (!target || !this.running.has(target.channel)) return;
    const text = message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n\n")
      .trim();
    const documents = message.parts
      .filter((part) => part.type === "document")
      .map((part) => `Document “${part.title}” is in the wizards.bot app.`);
    const artifacts = message.parts
      .filter((part) => part.type === "artifact")
      .map((part) => `“${part.title}” is in the wizards.bot app.`);
    const cards = message.parts
      .filter((part) => part.type === "card")
      .map((part) => part.card)
      .filter((card) => card.state === "open");
    if (!text && !cards.length && !documents.length && !artifacts.length) return;
    await this.send(target.channel, target.peer, {
      text: [text, ...documents, ...artifacts].filter(Boolean).join("\n\n"),
      cards,
      thread: target.thread,
    });
  }

  private async startOne(id: ChannelId): Promise<void> {
    const adapter = this.adapters.get(id);
    const settings = this.settings(id);
    if (!adapter || !settings) return;
    this.running.get(id)?.stop();
    this.running.delete(id);
    const stop = await adapter.start(settings, {
      receive: (incoming) => this.receive(id, incoming),
      publicUrl: this.home.config.publicUrl,
      log: (line) => console.log(`[${id}] ${line}`),
    });
    this.running.set(id, { adapter, settings, stop });
  }

  private remove(id: ChannelId): void {
    this.running.get(id)?.stop();
    this.running.delete(id);
    this.home.secrets.delete(`channel.${id}`);
    this.home.db.run("delete from channel where id = ?", id);
  }

  // ── What the agent can do ─────────────────────────────────────────────────

  private tools(context: TurnContext): Tool[] {
    const { home, agent, conversationId, draft } = context;
    if (!agent.main) return [];
    const ids = [...this.adapters.keys()] as [ChannelId, ...ChannelId[]];
    return [
      defineTool({
        name: "channel_connect",
        description: `Set up a channel the person can reach you on besides the app: ${ids.join(", ")}. Shows a card with the steps and the fields. Ends your turn.`,
        input: z.object({ channel: z.enum(ids) }),
        label: (input) => `Setting up ${String(input.channel ?? "a channel")}`,
        run: async (input) => {
          const adapter = this.adapters.get(input.channel) as ChannelAdapter;
          const card = home.store.createCard(
            {
              kind: "secret",
              level: "needs_you",
              title: `Connect ${adapter.label}`,
              body: adapter.setup.body.replaceAll(
                "{home}",
                home.config.publicUrl ?? "(your Bot Server has no public address yet)",
              ),
              fields: adapter.setup.fields,
              actions: [
                { id: "save", label: "Connect", style: "primary" },
                { id: "cancel", label: "Not now", style: "plain" },
              ],
              payload: { type: "channel", channel: adapter.id },
            },
            { agentId: agent.id, conversationId, messageId: draft.id },
          );
          draft.add({ type: "card", card });
          return ENDS_TURN;
        },
      }),
      defineTool({
        name: "channel_list",
        description: "List the channels that are set up and whether the person has claimed them.",
        input: z.object({}),
        label: () => "Looking at the channels",
        run: async () => {
          const rows = home.db.all<Row>("select * from channel");
          if (!rows.length) return `No channel is set up. Possible: ${ids.join(", ")}.`;
          return rows
            .map(
              (row) =>
                `- ${row.id}: ${row.state}${row.owner ? `, hears ${row.owner}` : ", waits for the claim code"}`,
            )
            .join("\n");
        },
      }),
      defineTool({
        name: "channel_remove",
        description: "Disconnect a channel and forget its keys.",
        input: z.object({ channel: z.enum(ids) }),
        label: (input) => `Disconnecting ${String(input.channel ?? "a channel")}`,
        run: async (input) => {
          this.remove(input.channel);
          return `${input.channel} is disconnected.`;
        },
      }),
    ];
  }

  private registerCards(): void {
    const { home } = this;
    home.onCard("channel", async ({ card, action, values, payload }) => {
      const id = String(payload.channel) as ChannelId;
      const adapter = this.adapters.get(id);
      if (!adapter) return;
      if (action !== "save")
        return home.tell(card.conversationId, `The person did not set up ${adapter.label}.`);
      const settings: Record<string, string> = {};
      for (const [key, value] of Object.entries(values)) settings[key] = String(value).trim();
      home.secrets.set(`channel.${id}`, JSON.stringify(settings));
      home.db.run(
        "insert into channel (id, state, created_at) values (?, 'waiting', ?) on conflict(id) do update set state = 'waiting', owner = null",
        id,
        now(),
      );
      try {
        await this.startOne(id);
      } catch (error) {
        this.remove(id);
        return home.tell(
          card.conversationId,
          `${adapter.label} did not connect: ${(error as Error).message}. Offer to try again.`,
        );
      }
      const code = String(randomInt(1000, 10_000));
      home.db.setMeta(`channel.${id}.claim`, code);
      home.tell(
        card.conversationId,
        `${adapter.label} is connected. So that only the person is heard there, they now send the words "claim ${code}" to you over ${adapter.label}.${adapter.beforeClaim ? ` ${adapter.beforeClaim}` : ""} Tell them exactly that, in one or two sentences.`,
      );
    });
  }
}
