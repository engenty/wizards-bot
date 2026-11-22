// From engenty wizards, apps/web/src/lib/theme.ts: light, branded and dark, picked by the person
// and kept in this browser, and the colour the branded theme stands on. Without a pick it is
// branded, on citron.
import { useSyncExternalStore } from "react";

export type ThemeMode = "light" | "branded" | "dark";

const KEY = "wizards.theme";
const GROUND_KEY = "wizards.ground";
const MODES: readonly string[] = ["light", "branded", "dark"];
const listeners = new Set<() => void>();

/**
 * The colours the branded theme stands on, as in engenty wizards. Each dark one is deep and
 * intense, as the engenty's blue; citron is the one light ground. `stage` is the ground, `accent`
 * the button on it; the tokens they set are in ember-primitives.css (`[data-ground]`).
 */
export const BRANDED_GROUNDS = [
  { ground: "cobalt", stage: "oklch(34% 0.14 264)", accent: "oklch(70.5% 0.187 39)" },
  { ground: "violet", stage: "oklch(33% 0.17 292)", accent: "oklch(82% 0.16 78)" },
  { ground: "berry", stage: "oklch(36% 0.15 352)", accent: "oklch(82% 0.13 192)" },
  { ground: "petrol", stage: "oklch(36% 0.085 214)", accent: "oklch(74% 0.16 35)" },
  { ground: "emerald", stage: "oklch(35.5% 0.105 158)", accent: "oklch(90% 0.19 118)" },
  { ground: "brick", stage: "oklch(38% 0.145 36)", accent: "oklch(84% 0.09 250)" },
  { ground: "citron", stage: "oklch(90% 0.18 116)", accent: "oklch(23% 0.035 125)" },
] as const;

export type BrandedGround = (typeof BRANDED_GROUNDS)[number]["ground"];

const GROUNDS: readonly string[] = BRANDED_GROUNDS.map((option) => option.ground);
/** The grounds the branded theme shows light on. */
const LIGHT_GROUNDS: readonly BrandedGround[] = ["citron"];
const DEFAULT_GROUND: BrandedGround = "citron";

function pickedGround(): BrandedGround {
  try {
    const value = localStorage.getItem(GROUND_KEY);
    return value && GROUNDS.includes(value) ? (value as BrandedGround) : DEFAULT_GROUND;
  } catch {
    return DEFAULT_GROUND;
  }
}

function picked(): ThemeMode | null {
  try {
    const value = localStorage.getItem(KEY);
    return value && MODES.includes(value) ? (value as ThemeMode) : null;
  } catch {
    return null;
  }
}

/** What the page shows: the pick, branded until there is one. */
function shown(): ThemeMode {
  return picked() ?? "branded";
}

function apply() {
  const mode = shown();
  const ground = mode === "branded" ? pickedGround() : null;
  const root = document.documentElement;
  root.classList.toggle(
    "dark",
    mode === "dark" || (ground !== null && !LIGHT_GROUNDS.includes(ground)),
  );
  root.classList.toggle("branded", mode === "branded");
  if (ground && ground !== "cobalt") {
    root.dataset.ground = ground;
  } else {
    delete root.dataset.ground;
  }
  for (const listener of listeners) {
    listener();
  }
}

/** Keeps the theme as picked. index.html sets the classes before the first paint; this keeps them. */
export function applyTheme() {
  apply();
}

export function setTheme(mode: ThemeMode) {
  try {
    localStorage.setItem(KEY, mode);
  } catch {}
  apply();
}

/** The colour of the branded theme; picking one picks the branded theme too. */
export function setBrandedGround(ground: BrandedGround) {
  try {
    localStorage.setItem(GROUND_KEY, ground);
  } catch {}
  setTheme("branded");
}

export function useBrandedGround(): BrandedGround {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, pickedGround);
}

export function useThemeMode(): ThemeMode {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, shown);
}
