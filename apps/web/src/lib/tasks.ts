import type { Task, TaskRule } from "@wizards-bot/protocol";
import { type Lang, textOf } from "./i18n";

/** What starts a task, as a sentence: "Every day at 08:30", "When mail arrives from …". */
export function ruleText(rule: TaskRule, lang: Lang): string {
  if ("on" in rule) {
    if (rule.on === "folder") {
      const folder = rule.path ? `${rule.folder}/${rule.path}` : rule.folder;
      return textOf("task.onFolder", lang, { folder });
    }
    if (rule.on === "mail") {
      const { from, subject } = rule;
      if (from && subject) {
        return textOf("task.onMailFromSubject", lang, { from, subject });
      }
      if (from) {
        return textOf("task.onMailFrom", lang, { from });
      }
      return subject
        ? textOf("task.onMailSubject", lang, { subject })
        : textOf("task.onMail", lang);
    }
    if (rule.on === "webhook") {
      return textOf("task.onWebhook", lang);
    }
    return textOf("task.onConnection", lang, {
      connection: rule.connection,
      minutes: rule.minutes,
    });
  }
  if ("at" in rule) {
    return textOf("task.once", lang);
  }
  if (rule.every === "hour") {
    return textOf("task.hourly", lang);
  }
  if (!("weekday" in rule)) {
    return textOf(rule.every === "day" ? "task.daily" : "task.weekdays", lang, {
      time: rule.time,
    });
  }
  // 7 January 2024 is a Sunday, weekday 0.
  const weekday = new Date(2024, 0, 7 + rule.weekday).toLocaleDateString(lang, { weekday: "long" });
  return textOf("task.weekly", lang, { weekday, time: rule.time });
}

/** A day and a time, as a list wants it: "Mon, 23 Nov, 08:30". */
export function dayAndTime(iso: string, lang: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? ""
    : at.toLocaleString(lang, {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
}

/**
 * A task in one line under what it does: what starts it, when it runs next or ran last, and
 * whether it is quiet. A task that waits for an event has no next time, so its last run stands
 * there.
 */
export function taskLine(task: Task, lang: Lang): string {
  const last = task.lastAt
    ? [
        textOf("task.last", lang, { when: dayAndTime(task.lastAt, lang) }),
        task.last === "failed" ? textOf("task.failed", lang) : "",
      ]
        .filter(Boolean)
        .join(", ")
    : "";
  return [
    ruleText(task.rule, lang),
    task.nextAt && !task.paused
      ? textOf("task.next", lang, { when: dayAndTime(task.nextAt, lang) })
      : last,
    task.quiet ? textOf("task.quiet", lang) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
