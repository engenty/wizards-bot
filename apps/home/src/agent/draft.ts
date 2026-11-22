import type { Message, Part } from "@wizards-bot/protocol";
import type { Store } from "../store/store.ts";

/** The agent's message while it is being written. */
export class Draft {
  readonly id: string;
  readonly conversationId: string;
  private parts: Part[] = [];
  private readonly activities = new Map<string, number>();
  private readonly store: Store;

  constructor(store: Store, message: Message) {
    this.store = store;
    this.id = message.id;
    this.conversationId = message.conversationId;
  }

  /** Nothing the person could read has been written yet. */
  get empty(): boolean {
    return !this.parts.some(
      (part) => part.type !== "activity" && (part.type !== "text" || part.text.trim()),
    );
  }

  /** A card in the message waits for the person. */
  get asks(): boolean {
    return this.parts.some(
      (part) =>
        part.type === "card" && part.card.state === "open" && part.card.level === "needs_you",
    );
  }

  get text(): string {
    return this.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n\n");
  }

  write(delta: string): void {
    if (!delta) return;
    const last = this.parts.at(-1);
    if (last?.type === "text") {
      last.text += delta;
    } else {
      // A new text part is announced whole, so a device knows where the deltas go.
      this.parts.push({ type: "text", text: "" });
      this.save();
      (this.parts.at(-1) as { text: string }).text = delta;
    }
    this.store.emit({
      type: "message.delta",
      conversationId: this.conversationId,
      messageId: this.id,
      part: this.parts.length - 1,
      text: delta,
    });
  }

  activity(id: string, label: string, state: "running" | "done" | "failed"): void {
    const index = this.activities.get(id);
    if (index === undefined) {
      this.activities.set(id, this.parts.length);
      this.parts.push({ type: "activity", label, state });
    } else {
      this.parts[index] = { type: "activity", label, state };
    }
    this.save();
  }

  add(part: Part): void {
    this.parts.push(part);
    this.save();
  }

  /** Drops what was written, for a second try with another model. */
  reset(): void {
    this.parts = [];
    this.activities.clear();
    this.save();
  }

  /** Ends the message: as the agent's answer, or as a note that no one is told about. */
  finish(state: "done" | "failed", model?: string, role: "agent" | "note" = "agent"): Message {
    for (const [index, part] of this.parts.entries()) {
      if (part.type === "activity" && part.state === "running") {
        this.parts[index] = { ...part, state: state === "done" ? "done" : "failed" };
      }
    }
    return this.store.updateMessage(this.id, { parts: this.parts, state, model, role }) as Message;
  }

  /** Ends the message as one line the person can find: what a quiet task's run leaves. */
  finishAsNote(line: string, model?: string): Message {
    this.parts = [{ type: "text", text: line.trim() }];
    this.activities.clear();
    return this.finish("done", model, "note");
  }

  private save(): void {
    this.store.updateMessage(this.id, { parts: this.parts });
  }
}
