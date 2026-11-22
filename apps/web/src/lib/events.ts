import type { QueryClient } from "@tanstack/react-query";
import type {
  Agent,
  Avatar,
  Card,
  Device,
  Event,
  Folder,
  Message,
  Models,
  Setup,
} from "@wizards-bot/protocol";
import { keys } from "./keys";

/** A conversation as far as it is loaded: its messages, oldest first, and whether older ones exist. */
export interface Thread {
  messages: Message[];
  more: boolean;
}

/** The thread with a message the home made or changed: in its place, or at the end. */
export function withMessage(thread: Thread, message: Message): Thread {
  const known = thread.messages.some((m) => m.id === message.id);
  return {
    ...thread,
    messages: known
      ? thread.messages.map((m) => (m.id === message.id ? message : m))
      : [...thread.messages, message],
  };
}

/** The thread with more text on one text part of a message that is being written. */
export function withDelta(
  thread: Thread,
  delta: Extract<Event, { type: "message.delta" }>,
): Thread {
  const message = thread.messages.find((m) => m.id === delta.messageId);
  const part = message?.parts[delta.part];
  if (!message || part?.type !== "text") {
    return thread;
  }
  const parts = message.parts.map((p, i) =>
    i === delta.part ? { ...part, text: part.text + delta.text } : p,
  );
  return {
    ...thread,
    messages: thread.messages.map((m) => (m === message ? { ...message, parts } : m)),
  };
}

/** The thread with a card as it is now, wherever a message shows it. */
function withCard(thread: Thread, card: Card): Thread {
  if (
    !thread.messages.some((m) => m.parts.some((p) => p.type === "card" && p.card.id === card.id))
  ) {
    return thread;
  }
  return {
    ...thread,
    messages: thread.messages.map((m) => ({
      ...m,
      parts: m.parts.map((p) => (p.type === "card" && p.card.id === card.id ? { ...p, card } : p)),
    })),
  };
}

/** Whether a card waits for the person. */
function needsYou(card: Card): boolean {
  return card.state === "open" && card.level === "needs_you";
}

/** What needs the person, with a card as it is now: listed while it waits, gone once it does not. */
export function itemsWith(items: Card[], card: Card): Card[] {
  const rest = items.filter((item) => item.id !== card.id);
  if (!needsYou(card)) {
    return rest;
  }
  return items.some((item) => item.id === card.id)
    ? items.map((item) => (item.id === card.id ? card : item))
    : [...rest, card];
}

/** The agents with one as it is now: in its place, or at the end. */
function agentsWith(agents: Agent[], agent: Agent): Agent[] {
  return agents.some((a) => a.id === agent.id)
    ? agents.map((a) => (a.id === agent.id ? agent : a))
    : [...agents, agent];
}

/**
 * Writes what the home said into the lists the app shows. A list that is not loaded stays so:
 * it comes whole from the home when it is asked for.
 */
export function applyEvent(client: QueryClient, event: Event) {
  const listed = (card: Card) =>
    client.setQueryData<Card[]>(keys.items(), (items) => (items ? itemsWith(items, card) : items));
  switch (event.type) {
    case "message.created":
    case "message.updated": {
      const { message } = event;
      client.setQueryData<Thread>(keys.thread(message.conversationId), (thread) =>
        thread ? withMessage(thread, message) : thread,
      );
      for (const part of message.parts) {
        if (part.type === "card") {
          listed(part.card);
        }
      }
      return;
    }
    case "message.delta":
      client.setQueryData<Thread>(keys.thread(event.conversationId), (thread) =>
        thread ? withDelta(thread, event) : thread,
      );
      return;
    case "card.updated":
      client.setQueriesData<Thread>({ queryKey: keys.threads() }, (thread) =>
        thread ? withCard(thread, event.card) : thread,
      );
      listed(event.card);
      return;
    case "agent.updated":
      client.setQueryData<Agent[]>(keys.agents(), (agents) =>
        agents ? agentsWith(agents, event.agent) : agents,
      );
      // What it works on and when its tasks ran last may have changed with it.
      void client.invalidateQueries({ queryKey: keys.agent(event.agent.id) });
      return;
    case "agent.removed":
      client.setQueryData<Agent[]>(keys.agents(), (agents) =>
        agents?.filter((a) => a.id !== event.agentId),
      );
      return;
    case "document.updated": {
      // The event carries no text: an open document that is behind is loaded again.
      const key = keys.document(event.document.id);
      const open = client.getQueryData<{ version: number }>(key);
      if (open && open.version !== event.document.version) {
        void client.invalidateQueries({ queryKey: key });
      }
      return;
    }
    case "artifact.updated": {
      // The event carries no page: an open artifact that is behind is read again.
      const key = keys.artifact(event.artifact.id);
      const open = client.getQueryData<{ version: number }>(key);
      if (open && open.version !== event.artifact.version) {
        void client.invalidateQueries({ queryKey: key });
      }
      return;
    }
    case "models.updated":
      client.setQueryData<Models>(keys.models(), event.models);
      return;
    case "folders.updated":
      client.setQueryData<Folder[]>(keys.folders(), event.folders);
      return;
    case "devices.updated":
      client.setQueryData<Device[]>(keys.devices(), event.devices);
      return;
    case "avatar.updated":
      client.setQueryData<Avatar | null>(keys.avatar(), event.avatar);
      return;
    case "setup.updated":
      client.setQueryData<Setup>(keys.setup(), event.setup);
      return;
    case "reset":
      void client.invalidateQueries();
      return;
  }
}
