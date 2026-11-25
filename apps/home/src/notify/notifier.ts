import type { Card, Message } from "@wizards-bot/protocol";
import type { Trigger } from "../agent/turns.ts";
import { runsHome } from "../group.ts";
import type { Home } from "../home.ts";
import { type DeviceRecord, preview } from "../store/store.ts";
import { Apns, type ApnsKey, type PushSender } from "./apns.ts";

/**
 * Tells the person's devices what happened. A card that waits for the person interrupts;
 * a reply does not, and stays silent in a device's quiet hours.
 */
export class Notifier {
  private apns: PushSender | undefined;
  /** Sends instead of Apple's service, with or without a key: a stand-in in tests. */
  private standIn: PushSender | undefined;
  private readonly home: Home;

  constructor(home: Home) {
    this.home = home;
    home.onDelivered((message, trigger) => void this.replied(message, trigger));
  }

  /** The signing key of the person's Apple developer account, or none. */
  key(): ApnsKey | undefined {
    const key = this.home.secrets.get("apns.key");
    const keyId = this.home.db.meta("apns.keyId");
    const teamId = this.home.db.meta("apns.teamId");
    return key && keyId && teamId ? { key, keyId, teamId } : undefined;
  }

  setKey(key: ApnsKey): void {
    this.home.secrets.set("apns.key", key.key);
    this.home.db.setMeta("apns.keyId", key.keyId);
    this.home.db.setMeta("apns.teamId", key.teamId);
    this.apns?.close();
    this.apns = undefined;
  }

  async replied(message: Message, trigger: Trigger): Promise<void> {
    const agent = message.agentId ? this.home.store.agent(message.agentId) : undefined;
    if (!agent) return;
    // A push goes to who runs the home, and a member's own conversation is not theirs to read.
    if (this.home.store.memberOf(message.conversationId)) return;
    const cards = message.parts
      .filter((part) => part.type === "card")
      .map((part) => part.card)
      .filter((card) => card.state === "open" && card.level === "needs_you");
    for (const card of cards) await this.card(card, agent.name);
    const body = preview(message);
    if (cards.length || !body) return;
    // An agent answering another agent is not news for the person.
    if (trigger.handed?.length || (trigger.channel === "home" && trigger.done)) return;
    await this.alert({
      title: agent.name,
      body,
      category: "message",
      level: "active",
      thread: agent.id,
      collapseId: message.id,
      data: { conversationId: message.conversationId, agentId: agent.id, messageId: message.id },
    });
  }

  async card(card: Card, agentName: string): Promise<void> {
    if (this.home.store.memberOf(card.conversationId)) return;
    const quick = card.actions.length <= 2 && !card.fields?.length;
    await this.alert({
      title: agentName,
      body: card.title,
      category: `card.${card.kind}`,
      level: "time-sensitive",
      thread: card.agentId,
      collapseId: card.id,
      data: {
        cardId: card.id,
        conversationId: card.conversationId,
        agentId: card.agentId,
        actions: quick
          ? card.actions.map((action) => ({ id: action.id, label: action.label }))
          : [],
      },
    });
  }

  /** Takes answered cards off every device's notifications. */
  resolved(cardIds: string[]): void {
    const badge = this.home.store.itemsFor().length;
    void this.each(
      () => true,
      (device) => ({
        type: "background",
        payload: { aps: { "content-available": 1, badge }, resolved: cardIds },
        token: device.push?.token ?? "",
      }),
    );
  }

  close(): void {
    this.apns?.close();
  }

  /** Sends every push through `sender` from now on; undefined goes back to Apple's service. */
  useSender(sender: PushSender | undefined): void {
    this.standIn = sender;
  }

  /**
   * Wakes a device whose app is closed with a silent push naming a hand-off: the app gets a
   * moment to answer it, and asks the person with a notification when it needs them. False
   * when the device cannot be woken (no push token, or no key on the home).
   */
  async wake(device: DeviceRecord, handoffId: string): Promise<boolean> {
    if (!device.push) return false;
    const sender = this.sender();
    if (!sender) return false;
    const result = await sender.send({
      type: "background",
      collapseId: handoffId,
      payload: { aps: { "content-available": 1 }, handoff: handoffId },
      ...device.push,
    });
    if (!result.ok) console.error(`[push] ${device.name}: ${result.status} ${result.reason}`);
    return result.ok;
  }

  /** Whether a push can reach a device at all. */
  canWake(device: DeviceRecord): boolean {
    return device.push !== undefined && (this.standIn !== undefined || this.key() !== undefined);
  }

  private sender(): PushSender | undefined {
    if (this.standIn) return this.standIn;
    const key = this.key();
    if (!key) return undefined;
    this.apns ??= new Apns(key);
    return this.apns;
  }

  private async alert(input: {
    title: string;
    body: string;
    category: string;
    level: "active" | "time-sensitive";
    thread: string;
    collapseId: string;
    data: Record<string, unknown>;
  }): Promise<void> {
    const badge = this.home.store.itemsFor().length;
    await this.each(
      (device) => input.level === "time-sensitive" || !isQuiet(device),
      () => ({
        type: "alert",
        collapseId: input.collapseId,
        payload: {
          aps: {
            alert: { title: input.title, body: input.body },
            category: input.category,
            "thread-id": input.thread,
            "interruption-level": input.level,
            sound: "default",
            badge,
            "mutable-content": 1,
          },
          ...input.data,
        },
      }),
    );
  }

  private async each(
    wanted: (device: DeviceRecord) => boolean,
    build: (device: DeviceRecord) => {
      type: "alert" | "background";
      payload: unknown;
      collapseId?: string;
    },
  ): Promise<void> {
    const sender = this.sender();
    if (!sender) return;
    for (const device of this.home.store.devices()) {
      // What is said to the agents of a group home reaches only who runs it.
      if (!device.push || !runsHome(device.person) || !wanted(device)) continue;
      const result = await sender.send({ ...build(device), ...device.push });
      if (result.ok) continue;
      if (
        result.status === 410 ||
        result.reason === "BadDeviceToken" ||
        result.reason === "Unregistered"
      ) {
        this.home.store.updateDevice(device.id, { push: null });
      } else {
        console.error(`[push] ${device.name}: ${result.status} ${result.reason}`);
      }
    }
  }
}

/** Whether it is inside the device's quiet hours right now. */
export function isQuiet(device: Pick<DeviceRecord, "quiet">, at: Date = new Date()): boolean {
  const quiet = device.quiet;
  if (!quiet) return false;
  let hour: number;
  try {
    hour = Number(
      new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        hour12: false,
        timeZone: quiet.timezone,
      }).format(at),
    );
  } catch {
    return false;
  }
  return quiet.from <= quiet.to
    ? hour >= quiet.from && hour < quiet.to
    : hour >= quiet.from || hour < quiet.to;
}
