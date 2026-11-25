import { useSyncExternalStore } from "react";

const FINE = "(pointer: fine)";

/** Whether the page is used with a mouse, and so with keys: not on a phone or a tablet. */
function has(): boolean {
  return typeof matchMedia !== "function" || matchMedia(FINE).matches;
}

function watch(changed: () => void): () => void {
  const query = matchMedia(FINE);
  query.addEventListener("change", changed);
  return () => query.removeEventListener("change", changed);
}

/** Whether keys are worth naming here: a hint at ⌘↩ says nothing to a finger. */
export function useKeyboard(): boolean {
  return useSyncExternalStore(watch, has);
}
