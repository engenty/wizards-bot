import { useSyncExternalStore } from "react";

/** What the person typed into a card's fields, by field id. */
export type Draft = Record<string, string | string[]>;

const EMPTY: Draft = {};
const drafts = new Map<string, Draft>();
const listeners = new Set<() => void>();

/**
 * A card's unsent answers. They are kept beside the card, so the same card shows them in the
 * chat and under what needs you, and keeps them while another agent's chat is open. Kept in
 * memory only: a secret never reaches the browser's storage.
 */
export function useDraft(cardId: string): [Draft, (next: Draft | null) => void] {
  const draft = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => drafts.get(cardId) ?? EMPTY,
  );
  const set = (next: Draft | null) => {
    if (next) {
      drafts.set(cardId, next);
    } else {
      drafts.delete(cardId);
    }
    for (const listener of listeners) {
      listener();
    }
  };
  return [draft, set];
}
