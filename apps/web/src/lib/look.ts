// How the chat looks to the person: how an agent's messages stand in it and how much of its tool
// calls is shown. The home keeps the pick for all the person's devices (`GET /v1/look`); this
// browser keeps the last one it heard of, so the chat is drawn right before the home answers.
import { useSyncExternalStore } from "react";

/** An agent's words on the page, or in a bubble beside its figure. */
export const CHAT_VIEWS = ["canvas", "bubbles"] as const;
export type ChatView = (typeof CHAT_VIEWS)[number];

/**
 * How much of an agent's tool calls is shown: only what runs now and what failed, one line that
 * opens, or every step.
 */
export const TOOL_DETAILS = ["none", "summary", "all"] as const;
export type ToolDetail = (typeof TOOL_DETAILS)[number];

export interface ChatLook {
  view: ChatView;
  tools: ToolDetail;
}

const KEY = "wizards.look";
export const PLAIN_LOOK: ChatLook = { view: "canvas", tools: "summary" };
const listeners = new Set<() => void>();

/** A look from outside (the home, this browser's storage): what it lacks is the plain one's. */
export function lookFrom(value: unknown): ChatLook {
  const given = (value ?? {}) as Partial<ChatLook>;
  return {
    view: CHAT_VIEWS.find((view) => view === given.view) ?? PLAIN_LOOK.view,
    tools: TOOL_DETAILS.find((tools) => tools === given.tools) ?? PLAIN_LOOK.tools,
  };
}

function kept(): ChatLook {
  try {
    return lookFrom(JSON.parse(localStorage.getItem(KEY) ?? "null"));
  } catch {
    return PLAIN_LOOK;
  }
}

let look = kept();

/** The look the chat is drawn with. */
export const chatLook = (): ChatLook => look;

/** Draws the chat with a look from now on, and keeps it in this browser. */
export function showLook(next: ChatLook) {
  look = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // It lasts for this visit only.
  }
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** How an agent's messages stand in the chat. */
export const useChatView = (): ChatView =>
  useSyncExternalStore(
    subscribe,
    () => look.view,
    () => look.view,
  );

/** How much of an agent's tool calls is shown. */
export const useToolDetail = (): ToolDetail =>
  useSyncExternalStore(
    subscribe,
    () => look.tools,
    () => look.tools,
  );
