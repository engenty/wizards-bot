// From engenty wizards, apps/web/src/lib/theme.ts: light, branded and dark, picked by the person
// and kept in this browser, and the base colour: the branded theme stands on it, the light and
// the dark one take it for their buttons and marks. Without a pick it is branded, on petrol.
import { useSyncExternalStore } from "react";

export type ThemeMode = "light" | "branded" | "dark";

const KEY = "wizards.theme";
const GROUND_KEY = "wizards.ground";
const MODES: readonly string[] = ["light", "branded", "dark"];
const listeners = new Set<() => void>();

/**
 * The base colours the person picks from, as in engenty wizards. In the branded theme each is the
 * ground: deep and intense, as the engenty's blue; citron is the one light ground. `stage` is that
 * ground, `accent` the button on it. In the light and the dark theme the colour is the button's
 * own, in a tone text can stand on: `light` and `dark`. The tokens they set are in
 * ember-primitives.css (`[data-ground]`).
 */
export const BRANDED_GROUNDS = [
  {
    ground: "cobalt",
    stage: "oklch(34% 0.14 264)",
    accent: "oklch(70.5% 0.187 39)",
    light: "oklch(50% 0.2 264)",
    dark: "oklch(74% 0.13 264)",
  },
  {
    ground: "violet",
    stage: "oklch(33% 0.17 292)",
    accent: "oklch(82% 0.16 78)",
    light: "oklch(50% 0.22 292)",
    dark: "oklch(74% 0.14 292)",
  },
  {
    ground: "berry",
    stage: "oklch(36% 0.15 352)",
    accent: "oklch(82% 0.13 192)",
    light: "oklch(50% 0.19 352)",
    dark: "oklch(74% 0.17 352)",
  },
  {
    ground: "petrol",
    stage: "oklch(36% 0.085 214)",
    accent: "oklch(74% 0.16 35)",
    light: "oklch(50% 0.086 214)",
    dark: "oklch(74% 0.115 214)",
  },
  {
    ground: "emerald",
    stage: "oklch(35.5% 0.105 158)",
    accent: "oklch(90% 0.19 118)",
    light: "oklch(50% 0.115 158)",
    dark: "oklch(74% 0.15 158)",
  },
  {
    ground: "brick",
    stage: "oklch(38% 0.145 36)",
    accent: "oklch(84% 0.09 250)",
    light: "oklch(50% 0.168 36)",
    dark: "oklch(74% 0.155 36)",
  },
  {
    ground: "citron",
    stage: "oklch(90% 0.18 116)",
    accent: "oklch(23% 0.035 125)",
    light: "oklch(50% 0.112 116)",
    dark: "oklch(90% 0.18 116)",
  },
] as const;

export type BrandedGround = (typeof BRANDED_GROUNDS)[number]["ground"];

const GROUNDS: readonly string[] = BRANDED_GROUNDS.map((option) => option.ground);
/** The grounds the branded theme shows light on. */
const LIGHT_GROUNDS: readonly BrandedGround[] = ["citron"];
const DEFAULT_GROUND: BrandedGround = "petrol";

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
  const ground = pickedGround();
  const root = document.documentElement;
  root.classList.toggle(
    "dark",
    mode === "dark" || (mode === "branded" && !LIGHT_GROUNDS.includes(ground)),
  );
  root.classList.toggle("branded", mode === "branded");
  root.dataset.ground = ground;
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

/** The base colour, in whichever theme is shown. */
export function setGround(ground: BrandedGround) {
  try {
    localStorage.setItem(GROUND_KEY, ground);
  } catch {}
  apply();
}

export function useGround(): BrandedGround {
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
