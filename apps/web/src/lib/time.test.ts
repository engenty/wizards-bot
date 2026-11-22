import { describe, expect, it } from "vitest";
import { elapsed, when } from "./time";

describe("when a conversation last changed", () => {
  const now = new Date(2026, 10, 21, 15, 0);
  const at = (...date: [number, number, number, number, number, number?]) =>
    new Date(date[0], date[1], date[2], date[3], date[4], date[5] ?? 0).toISOString();

  it("is how long ago, very short, within a day", () => {
    expect(when(at(2026, 10, 21, 14, 59, 30), now, "de")).toBe("jetzt");
    expect(when(at(2026, 10, 21, 14, 57), now, "de")).toBe("vor 3 min");
    expect(when(at(2026, 10, 21, 14, 57), now, "en-GB")).toBe("3 min ago");
    expect(when(at(2026, 10, 21, 12, 30), now, "de")).toBe("vor 2 h");
  });

  it("is yesterday, then days, within a week", () => {
    expect(when(at(2026, 10, 20, 23, 50), now, "de")).toBe("gestern");
    expect(when(at(2026, 10, 18, 8, 0), now, "de")).toBe("vor 3 T");
    expect(when(at(2026, 10, 18, 8, 0), now, "en-GB")).toBe("3 d ago");
  });

  it("is the date before that, with the year when it is another one", () => {
    expect(when(at(2026, 10, 3, 8, 0), now, "en-GB")).toBe("3 Nov");
    expect(when(at(2025, 11, 24, 8, 0), now, "en-GB")).toBe("24 Dec 2025");
  });

  it("is nothing for a time that cannot be read", () => {
    expect(when("", now, "en")).toBe("");
  });
});

describe("elapsed", () => {
  it("says nothing for a moment, then seconds, then minutes and seconds", () => {
    expect(elapsed(2_500)).toBe("");
    expect(elapsed(3_900)).toBe("");
    expect(elapsed(12_000)).toBe("12 s");
    expect(elapsed(65_000)).toBe("1:05");
    expect(elapsed(600_000)).toBe("10:00");
  });
});
