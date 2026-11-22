/** The words of `when`, very short, in the two languages the app speaks. */
const AGO = {
  en: {
    now: "now",
    minutes: (n: number) => `${n} min ago`,
    hours: (n: number) => `${n} h ago`,
    yesterday: "yesterday",
    days: (n: number) => `${n} d ago`,
  },
  de: {
    now: "jetzt",
    minutes: (n: number) => `vor ${n} min`,
    hours: (n: number) => `vor ${n} h`,
    yesterday: "gestern",
    days: (n: number) => `vor ${n} T`,
  },
};

/**
 * When a conversation last changed, as short as a list wants it: "jetzt", "vor 3 min",
 * "vor 2 h", "gestern", "vor 3 T" within a week, the date before that. "" for a time that
 * cannot be read.
 */
export function when(iso: string, now: Date, lang: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) {
    return "";
  }
  const words = lang.startsWith("de") ? AGO.de : AGO.en;
  const minutes = Math.floor((now.getTime() - at.getTime()) / 60_000);
  if (minutes < 1) {
    return words.now;
  }
  if (minutes < 60) {
    return words.minutes(minutes);
  }
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  if (days <= 0) {
    return words.hours(Math.floor(minutes / 60));
  }
  if (days === 1) {
    return words.yesterday;
  }
  if (days < 7) {
    return words.days(days);
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
