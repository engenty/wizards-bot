import { describe, expect, it } from "vitest";
import { ruleText, taskLine } from "./tasks";

describe("when a scheduled task runs", () => {
  it("is said as a sentence in the person's language", () => {
    expect(ruleText({ at: "2026-11-24T08:00:00.000Z" }, "en")).toBe("Once");
    expect(ruleText({ every: "hour" }, "de")).toBe("Jede Stunde");
    expect(ruleText({ every: "day", time: "08:30" }, "en")).toBe("Every day at 08:30");
    expect(ruleText({ every: "weekday", time: "7:00" }, "de")).toBe("Montag bis Freitag um 7:00");
    expect(ruleText({ every: "week", time: "09:00", weekday: 1 }, "en")).toBe(
      "Every Monday at 09:00",
    );
    expect(ruleText({ every: "week", time: "09:00", weekday: 0 }, "de")).toBe(
      "Jeden Sonntag um 09:00",
    );
  });
});

describe("what a task waits for", () => {
  it("is said as a sentence too", () => {
    expect(ruleText({ on: "folder", folder: "Notes", path: "2026" }, "en")).toBe(
      "When a file is added or changed in Notes/2026",
    );
    expect(ruleText({ on: "mail" }, "de")).toBe("Wenn eine Mail kommt");
    expect(ruleText({ on: "mail", from: "@shop.example", subject: "Invoice" }, "en")).toBe(
      "When mail arrives from @shop.example with “Invoice” in the subject",
    );
    expect(ruleText({ on: "mail", subject: "Rechnung" }, "de")).toBe(
      "Wenn eine Mail mit „Rechnung“ im Betreff kommt",
    );
    expect(ruleText({ on: "webhook" }, "en")).toBe("When another service calls its address");
    expect(
      ruleText(
        { on: "connection", connection: "calendar", tool: "list_events", minutes: 15 },
        "de",
      ),
    ).toBe("Wenn sich calendar ändert, alle 15 Min. nachgesehen");
  });
});

describe("a task's line", () => {
  const task = { id: "sch_1", title: "Look", prompt: "Look at it", quiet: false };

  it("names when a scheduled task runs next", () => {
    const line = taskLine(
      { ...task, rule: { every: "hour" }, nextAt: "2026-11-23T08:00:00.000Z", quiet: true },
      "en",
    );
    expect(line).toMatch(/^Every hour · next: .+ · quiet$/);
  });

  it("names when a task that waits for an event ran last, and that it failed", () => {
    const rule = { on: "webhook" } as const;
    expect(taskLine({ ...task, rule }, "en")).toBe("When another service calls its address");
    const line = taskLine(
      { ...task, rule, lastAt: "2026-11-23T08:00:00.000Z", last: "failed" },
      "de",
    );
    expect(line).toMatch(
      /^Wenn ein anderer Dienst seine Adresse aufruft · zuletzt: .+, fehlgeschlagen$/,
    );
  });

  it("names the last run of a paused task, not a next one", () => {
    const line = taskLine(
      {
        ...task,
        rule: { every: "hour" },
        nextAt: "2026-11-23T08:00:00.000Z",
        lastAt: "2026-11-22T08:00:00.000Z",
        last: "failed",
        paused: "It failed 3 times in a row.",
      },
      "en",
    );
    expect(line).toMatch(/^Every hour · last: .+, failed$/);
  });
});
