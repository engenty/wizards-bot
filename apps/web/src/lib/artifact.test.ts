import { describe, expect, it } from "vitest";
import { pageOpens } from "./artifact";

describe("pageOpens", () => {
  const now = Date.parse("2026-11-21T09:00:00.000Z");
  const page = (seconds: number) =>
    `/v1/artifacts/art_1/page?until=${Math.floor(now / 1000) + seconds}&key=abc`;

  it("is true while the key of the page works for more than a minute", () => {
    expect(pageOpens(page(3600), now)).toBe(true);
    expect(pageOpens(page(61), now)).toBe(true);
  });

  it("is false for an address that is over, nearly over, or carries no time", () => {
    expect(pageOpens(page(59), now)).toBe(false);
    expect(pageOpens(page(-10), now)).toBe(false);
    expect(pageOpens("/v1/artifacts/art_1/page", now)).toBe(false);
    expect(pageOpens("/v1/artifacts/art_1/page?until=soon&key=abc", now)).toBe(false);
  });
});
