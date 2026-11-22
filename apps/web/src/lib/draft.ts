import type { Document } from "@wizards-bot/protocol";

/**
 * A document while it is edited beside the chat: the text in the editor, and the text and
 * version the home has. The home takes a save only against the version it has, so a version
 * that arrives while there is unsaved text is a conflict the person settles.
 */
export interface Draft {
  /** The version of the home's text. */
  base: number;
  /** The home's text at `base`. */
  saved: string;
  /** The text in the editor. */
  text: string;
  /** `failed`: the last save did not arrive; the next change tries again. */
  saving: "idle" | "saving" | "failed";
  /** The text of the save that is on its way. */
  sent: string | null;
  /** A newer version of someone else's, while this text is not saved. */
  conflict: Document | null;
}

export type DraftEvent =
  /** The person changed the text. */
  | { type: "edited"; text: string }
  /** The home has this version: it came over the event stream, or as the answer to a save. */
  | { type: "arrived"; document: Document }
  | { type: "saving" }
  /** The home took the text that was sent and made it this version. */
  | { type: "saved"; document: Document }
  | { type: "failed" }
  /** The home did not take the save: it has this newer version. */
  | { type: "refused"; document: Document }
  /** The person's text stays: it is saved over the newer version. */
  | { type: "keepMine" }
  /** The newer version stays: the person's unsaved text is dropped. */
  | { type: "takeNewer" };

export function startDraft(document: Document): Draft {
  return {
    base: document.version,
    saved: document.content,
    text: document.content,
    saving: "idle",
    sent: null,
    conflict: null,
  };
}

/** Whether the editor holds text the home does not have. */
export function unsaved(draft: Draft): boolean {
  return draft.text !== draft.saved;
}

/**
 * Whether a save is due: there is unsaved text, none is on its way, no conflict waits for the
 * person, and the last save did not fail (after a failure the next change asks again).
 */
export function saveDue(draft: Draft): boolean {
  return unsaved(draft) && draft.saving === "idle" && draft.conflict === null;
}

export function draftReducer(draft: Draft, event: DraftEvent): Draft {
  switch (event.type) {
    case "edited":
      return {
        ...draft,
        text: event.text,
        saving: draft.saving === "failed" ? "idle" : draft.saving,
      };
    case "arrived": {
      const { document } = event;
      if (document.version <= draft.base) {
        return draft;
      }
      // The save that is on its way, told by the event stream before its own answer came.
      if (document.content === draft.sent) {
        return { ...draft, base: document.version, saved: document.content };
      }
      // Nothing unsaved, or the very text that is here: the editor follows the home.
      if (!unsaved(draft) || document.content === draft.text) {
        return {
          ...draft,
          base: document.version,
          saved: document.content,
          text: document.content,
          conflict: null,
        };
      }
      return { ...draft, conflict: document };
    }
    case "saving":
      return { ...draft, saving: "saving", sent: draft.text };
    case "saved":
      // What was typed while the save was on its way stays unsaved, and is saved next.
      return {
        ...draft,
        base: Math.max(draft.base, event.document.version),
        saved: draft.base > event.document.version ? draft.saved : event.document.content,
        saving: "idle",
        sent: null,
      };
    case "failed":
      return { ...draft, saving: "failed", sent: null };
    case "refused":
      return draftReducer(
        { ...draft, saving: "idle", sent: null },
        { type: "arrived", document: event.document },
      );
    case "keepMine":
      return draft.conflict
        ? {
            ...draft,
            base: draft.conflict.version,
            saved: draft.conflict.content,
            saving: "idle",
            conflict: null,
          }
        : draft;
    case "takeNewer":
      return draft.conflict
        ? {
            base: draft.conflict.version,
            saved: draft.conflict.content,
            text: draft.conflict.content,
            saving: "idle",
            sent: null,
            conflict: null,
          }
        : draft;
  }
}
