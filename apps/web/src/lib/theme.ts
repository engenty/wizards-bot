// From engenty wizards, apps/web/src/lib/theme.ts: light, branded and dark, picked by the person
// and kept in this browser; without a pick the system decides, and its dark is the branded one.
import { useSyncExternalStore } from "react";

export type ThemeMode = "light" | "branded" | "dark";

const KEY = "wizards.theme";
const MODES: readonly string[] = ["light", "branded", "dark"];
const listeners = new Set<() => void>();

function picked(): ThemeMode | null {
  try {
    const value = localStorage.getItem(KEY);
    return value && MODES.includes(value) ? (value as ThemeMode) : null;
  } catch {
    return null;
  }
}

const system = () => window.matchMedia("(prefers-color-scheme: dark)");

/** What the page shows: the pick, or the system's light or branded dark. */
function shown(): ThemeMode {
  return picked() ?? (system().matches ? "branded" : "light");
}

function apply() {
  const mode = shown();
  document.documentElement.classList.toggle("dark", mode !== "light");
  document.documentElement.classList.toggle("branded", mode === "branded");
  for (const listener of listeners) {
    listener();
  }
}

/**
 * Keeps the theme as picked, or as the system has it, also when that changes while the page is
 * open. index.html sets the classes before the first paint; this keeps them.
 */
export function followSystemTheme() {
  apply();
  system().addEventListener("change", apply);
}

export function setTheme(mode: ThemeMode) {
  try {
    localStorage.setItem(KEY, mode);
  } catch {}
  apply();
}

export function useThemeMode(): ThemeMode {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, shown);
}
