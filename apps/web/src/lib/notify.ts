import type { Event } from "@wizards-bot/protocol";
import { inMacApp, toMac } from "./mac";

/** What a notification says; `tag` is the card's or message's id, so one thing is told once. */
interface Notice {
  title: string;
  body: string;
  tag: string;
}

/**
 * What an event is worth telling the person about while the page is not in front: a card that
 * waits for them, and a finished answer without one. `nameOf` gives an agent's name.
 */
export function noticesOf(event: Event, nameOf: (agentId: string | undefined) => string): Notice[] {
  if (event.type !== "message.created" && event.type !== "message.updated") {
    return [];
  }
  const { message } = event;
  const cards = message.parts.flatMap((part) => (part.type === "card" ? [part.card] : []));
  const notices = cards
    .filter((card) => card.state === "open" && card.level === "needs_you")
    .map((card) => ({ title: nameOf(card.agentId), body: card.title, tag: card.id }));
  if (
    event.type === "message.updated" &&
    message.state !== "streaming" &&
    message.role === "agent" &&
    cards.length === 0
  ) {
    const text = message.parts.find((part) => part.type === "text" && part.text.trim());
    if (text?.type === "text") {
      notices.push({
        title: nameOf(message.agentId),
        body: text.text.slice(0, 160),
        tag: message.id,
      });
    }
  }
  return notices;
}

const told = new Set<string>();

/** Shows each notice once, and only while the page is hidden and the person allowed it. */
export function notify(notices: Notice[]) {
  for (const notice of notices) {
    if (told.has(notice.tag)) {
      continue;
    }
    told.add(notice.tag);
    if (inMacApp()) {
      // The app tells the Mac's notifications; it knows whether its window is in front.
      void toMac({ type: "notify", ...notice });
    } else if (
      document.hidden &&
      "Notification" in window &&
      Notification.permission === "granted"
    ) {
      const shown = new Notification(notice.title, {
        body: notice.body,
        tag: notice.tag,
        icon: "/icon.svg",
      });
      shown.onclick = () => {
        window.focus();
        shown.close();
      };
    }
  }
}

const LATER = "wizards.notify.later";

/**
 * Whether the chat offers to notify: in a browser that has not been asked yet, until the
 * person said not now. The Mac app asks through macOS when it first notifies.
 */
export function canAskToNotify(): boolean {
  if (inMacApp() || !("Notification" in window) || Notification.permission !== "default") {
    return false;
  }
  try {
    return localStorage.getItem(LATER) === null;
  } catch {
    return true;
  }
}

/** Asks whether the page may notify; called from a tap, as browsers want it. */
export function askToNotify(): Promise<unknown> {
  return canAskToNotify() ? Notification.requestPermission() : Promise.resolve();
}

/** The person does not want to be asked again in this browser. */
export function notifyLater() {
  try {
    localStorage.setItem(LATER, new Date().toISOString());
  } catch {
    // Without storage the offer comes back next time.
  }
}
