/**
 * When a conversation last changed, as short as a list wants it: the time today, the weekday
 * within a week, the date before that. "" for a time that cannot be read.
 */
export function when(iso: string, now: Date, lang: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return "";
  }
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days <= 0) {
    return at.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit" });
  }
  if (days < 7) {
    return at.toLocaleDateString(lang, { weekday: "short" });
  }
  return at.toLocaleDateString(lang, {
    day: "numeric",
    month: "short",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/**
 * Time that has passed while an agent works: nothing for the first 3 seconds, then "12 s",
 * and from a minute on "1:05".
 */
export function elapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds <= 3) {
    return "";
  }
  if (seconds < 60) {
    return `${seconds} s`;
  }
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
