import { useEffect, useState, useSyncExternalStore } from "react";

const LESS_MOTION = "(prefers-reduced-motion: reduce)";

/** Whether the person asked their system for less motion. */
function still(): boolean {
  return typeof matchMedia === "function" && matchMedia(LESS_MOTION).matches;
}

function watchStill(changed: () => void): () => void {
  const query = matchMedia(LESS_MOTION);
  query.addEventListener("change", changed);
  return () => query.removeEventListener("change", changed);
}

/** Whether the person asks for less motion, and again when they change it. */
export function useStill(): boolean {
  return useSyncExternalStore(watchStill, still);
}

/**
 * `value`, and for `ms` after it turned null what it was last, marked as leaving: the time a
 * thing needs for its way out. With less motion asked for, it is gone at once.
 */
export function useLingering<T extends string | number | boolean>(
  value: T | null,
  ms: number,
): { value: T | null; leaving: boolean } {
  const [kept, setKept] = useState<T | null>(value);
  useEffect(() => {
    if (value !== null) {
      setKept(value);
      return;
    }
    const timer = setTimeout(() => setKept(null), still() ? 0 : ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return { value: value ?? kept, leaving: value === null && kept !== null };
}
