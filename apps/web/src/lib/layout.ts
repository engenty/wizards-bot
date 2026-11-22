// The widths of the app's columns, in CSS pixels: the list of agents, the chat, and a document
// or an artifact beside the chat. The iPad app uses the same numbers.

/** The list of agents, open. */
export const SIDEBAR = 288;
/** The list of agents as a column of figures. */
const RAIL = 64;
/** Below this width of the window there is no column for the agents: the list opens over the chat. */
const PHONE = 640;
/** From this width of the window the list of agents is open beside the chat alone. */
const WIDE = 960;
/** The chat beside a document: as wide as a large phone. */
export const CHAT = 432;
/** The narrowest the person can make the chat. */
export const CHAT_MIN = 352;
/** The narrowest a document beside the chat gets. */
export const PANE_MIN = 400;
/** A document grows to this width, a tablet held upright, before the chat grows. */
const PANE_FULL = 768;
/** What a document needs for the list of agents to stay open beside it and the chat. */
const PANE_ROOM = 480;

/** Where the list of agents is: beside the chat, as a narrow column of figures, or out of sight. */
export type Side = "open" | "rail" | "none";

/** Whether the window has room for the open list of agents, with or without a document open. */
export function sidebarFits(window: number, pane: boolean): boolean {
  return window >= (pane ? SIDEBAR + CHAT + PANE_ROOM : WIDE);
}

/**
 * How the list of agents is shown: open where it fits and the person has not closed it, a
 * column of figures where it does not, and out of sight on a phone.
 */
export function sidebar(window: number, pane: boolean, collapsed: boolean): Side {
  if (window < PHONE) {
    return "none";
  }
  if (sidebarFits(window, pane) && !collapsed) {
    return "open";
  }
  // The column of figures gives way before a document has to lie over the chat.
  return pane && window - RAIL < CHAT_MIN + PANE_MIN ? "none" : "rail";
}

/**
 * How the chat and a document share `width`. `"over"`: they do not fit side by side, the
 * document lies over the chat. Without a width the person chose, the chat stays as wide as a
 * large phone until the document is as wide as an upright tablet; what is left goes to the
 * chat. A chosen width holds as far as both keep their least width.
 */
export function split(
  width: number,
  chosen: number | null,
): { chat: number; pane: number } | "over" {
  if (width < CHAT_MIN + PANE_MIN) {
    return "over";
  }
  const most = width - PANE_MIN;
  const chat = Math.round(
    chosen === null
      ? Math.max(Math.min(CHAT, most), width - PANE_FULL)
      : Math.min(Math.max(chosen, CHAT_MIN), most),
  );
  return { chat, pane: width - chat };
}
