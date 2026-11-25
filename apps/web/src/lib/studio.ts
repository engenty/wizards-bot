import type { Space } from "@wizards-bot/protocol";
import { useEffect } from "react";
import { useHome } from "./queries";

// The studio the team works in shows this page inside a frame (Work's chats). The two pages speak
// with `postMessage`, each only to the other's origin: this page says `wizards.ready` once it
// listens, and the studio answers with the space that is open in it, again whenever the person
// opens another one. Each message the person sends carries that space, so the agent works in it.

/** The space that is open in the studio above this page, as it last said. */
let open: Space | undefined;

/** What a message to the home says about the studio's open space: nothing where none is. */
export const inOpenSpace = (): { space?: Space } => (open ? { space: open } : {});

/**
 * The space a message from another window names. Nothing when it is not the studio's page that
 * sent it, or when it says something else.
 */
export function spaceFrom(
  event: { origin: string; data: unknown },
  studio: string | undefined,
): Space | undefined {
  if (!studio || event.origin !== studio) return undefined;
  const data = event.data as { type?: unknown; id?: unknown; name?: unknown } | null;
  if (typeof data !== "object" || data === null || data.type !== "wizards.space") return undefined;
  const { id, name } = data;
  if (typeof id !== "string" || typeof name !== "string") return undefined;
  if (!id || id.length > 200 || !name.trim() || name.length > 200) return undefined;
  return { id, name: name.trim() };
}

/**
 * Listens to the studio's page and tells it that this page is ready. Does nothing where the page
 * is not in a frame. Returns how to stop.
 */
export function listenToStudio(studio: string, page: Window = window): () => void {
  if (page.parent === page) return () => undefined;
  const heard = (event: MessageEvent) => {
    const space = spaceFrom(event, studio);
    if (space) open = space;
  };
  page.addEventListener("message", heard);
  page.parent.postMessage({ type: "wizards.ready" }, studio);
  return () => {
    page.removeEventListener("message", heard);
    open = undefined;
  };
}

/** Keeps the studio's open space while the page is shown inside the studio's. */
export function useStudioSpace(): void {
  const studio = useHome().data?.studio;
  useEffect(() => (studio ? listenToStudio(studio) : undefined), [studio]);
}
