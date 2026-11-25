import type { TimeRule } from "@wizards-bot/protocol";
import { z } from "zod";

// When a scheduled task is due. The tasks themselves are kept and run in `tasks/tasks.ts`.

export type Rule = TimeRule;

/** The next time a rule is due after `from`, or `undefined` when it never is again. */
export function nextAfter(rule: Rule, from: Date): Date | undefined {
  if ("at" in rule) {
    const at = new Date(rule.at);
    return Number.isNaN(at.getTime()) || at <= from ? undefined : at;
  }
  if (rule.every === "hour") {
    const next = new Date(from);
    next.setMinutes(0, 0, 0);
    next.setHours(next.getHours() + 1);
    return next;
  }
  const [hours = 0, minutes = 0] = rule.time.split(":").map(Number);
  const next = new Date(from);
  next.setHours(hours, minutes, 0, 0);
  for (let day = 0; day < 8; day++) {
    const weekday = next.getDay();
    const fits =
      rule.every === "day" ||
      (rule.every === "weekday" && weekday >= 1 && weekday <= 5) ||
      (rule.every === "week" && weekday === rule.weekday);
    if (fits && next > from) return next;
    next.setDate(next.getDate() + 1);
  }
  return undefined;
}

/** How an agent says when: once (`at`) or again and again (`every`). */
export const When = z.object({
  at: z.string().optional().describe("Once, at this local time: 2026-11-24T09:00."),
  every: z
    .enum(["hour", "day", "weekday", "week"])
    .optional()
    .describe(
      "`week`: once a week, on the one day in `weekday` (“every Friday”). `weekday`: every day from Monday to Friday.",
    ),
  time: z
    .string()
    .regex(/^\d{1,2}:\d{2}$/)
    .optional()
    .describe("For day, weekday and week: 08:30."),
  weekday: z
    .number()
    .int()
    .min(0)
    .max(6)
    .optional()
    .describe("For week: 0 is Sunday, 1 Monday, 5 Friday, 6 Saturday."),
});

/** The rule an agent's input means, or what is missing, in words for the agent. */
export function ruleOf(input: z.infer<typeof When>): Rule | string {
  if (input.at && input.every) {
    return "Give `at` for once or `every` for a repeating task, not both. “Every Friday” is `every`: “week” with `weekday`: 5 and a `time`, without `at`.";
  }
  if (input.at) return { at: new Date(input.at).toISOString() };
  if (input.every === "hour") return { every: "hour" };
  if (!input.every) return "Give `at` for once or `every` for a repeating task.";
  if (!input.time) return "A daily or weekly task needs a time.";
  if (input.every === "week") {
    return input.weekday === undefined
      ? "A weekly task needs a weekday."
      : { every: "week", time: input.time, weekday: input.weekday };
  }
  return { every: input.every, time: input.time };
}
