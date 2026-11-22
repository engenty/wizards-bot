import type { Event } from "@wizards-bot/protocol";

export interface StoredEvent {
  /** Missing on `message.delta`, which is never replayed. */
  id?: number;
  event: Event;
}

type Listener = (stored: StoredEvent) => void;

const KEEP = 2000;

/** Everything a device needs to stay current, in order. */
export class Events {
  private seq = Date.now();
  private readonly log: StoredEvent[] = [];
  private readonly listeners = new Set<Listener>();

  emit(event: Event): void {
    const stored: StoredEvent =
      event.type === "message.delta" ? { event } : { id: ++this.seq, event };
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
