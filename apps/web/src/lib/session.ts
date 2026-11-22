import { useSyncExternalStore } from "react";

const TOKEN_KEY = "wizards.token";
const listeners = new Set<() => void>();

function stored(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

let token = stored();

/** The device token this browser got when it was paired; null: not paired. */
export function deviceToken(): string | null {
  return token;
}

/** Keeps the token of a new pairing, or forgets it (null) when the home no longer knows it. */
export function setDeviceToken(next: string | null) {
  token = next;
  try {
    if (next) {
      localStorage.setItem(TOKEN_KEY, next);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // Without storage the pairing lasts until the page is closed.
  }
  for (const listener of listeners) {
    listener();
  }
}

/** Whether this browser is paired, for the component that shows the pairing page or the chat. */
export function usePaired(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => token !== null,
  );
}
