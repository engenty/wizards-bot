import type { Event } from "@wizards-bot/protocol";

/**
 * Who hears an event, where that is not every device that hears its kind: the people who run
 * the home, or the one member of a group in whose own conversation it happened.
 */
export type Audience = "admins" | { person: string };

export interface StoredEvent {
  /** Missing on `message.delta` and `message.waiting`, which are never replayed. */
  id?: number;
  event: Event;
  to?: Audience;
}

type Listener = (stored: StoredEvent) => void;

const KEEP = 2000;

/** Everything a device needs to stay current, in order. */
export class Events {
  private seq = Date.now();
  private readonly log: StoredEvent[] = [];
  private readonly listeners = new Set<Listener>();
  /** Who hears an event that is emitted without an audience. The store knows whose conversation it is in. */
  audience: (event: Event) => Audience | undefined = () => undefined;

  emit(event: Event, to: Audience | undefined = this.audience(event)): void {
    const stored: StoredEvent =
      event.type === "message.delta" || event.type === "message.waiting"
        ? { event, to }
        : { id: ++this.seq, event, to };
    if (stored.id !== undefined) {
      this.log.push(stored);
      if (this.log.length > KEEP) this.log.shift();
    }
    for (const listener of this.listeners) listener(stored);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** What a device missed since `lastId`, or `undefined` when the log no longer reaches back. */
  since(lastId: number): StoredEvent[] | undefined {
    const first = this.log[0];
    if (lastId >= this.seq) return [];
    if (!first?.id || lastId < first.id - 1) return undefined;
    return this.log.filter((stored) => (stored.id ?? 0) > lastId);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}
