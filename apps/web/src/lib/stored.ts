import { useCallback, useState } from "react";

/** A choice kept in this browser. Where the browser keeps nothing, it lasts for this visit. */
export function useStored<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const kept = localStorage.getItem(key);
      return kept === null ? initial : (JSON.parse(kept) as T);
    } catch {
      return initial;
    }
  });
  const keep = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Kept for this visit only.
      }
    },
    [key],
  );
  return [value, keep];
}
