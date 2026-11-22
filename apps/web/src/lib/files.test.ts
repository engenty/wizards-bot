import { describe, expect, it } from "vitest";
import {
  FILE_LIMIT_LABEL,
  formatBytes,
  isPicture,
  kindOf,
  pastedName,
  roomFor,
  typeLabel,
} from "./files";

describe("kindOf", () => {
  it("goes by the type, and by the name where the type says nothing", () => {
    expect(kindOf({ mime: "image/jpeg", name: "ticket.jpg" })).toBe("image");
    expect(kindOf({ mime: "application/octet-stream", name: "plan.PDF" })).toBe("pdf");
    expect(kindOf({ mime: "", name: "notes.md" })).toBe("text");
    expect(kindOf({ mime: "application/zip", name: "all.zip" })).toBe("other");
  });
});

describe("isPicture", () => {
  it("is true for the types a message shows as the picture itself", () => {
    expect(["image/png", "image/jpeg", "image/webp", "image/gif"].every(isPicture)).toBe(true);
    expect(isPicture("image/svg+xml")).toBe(false);
    expect(isPicture("application/pdf")).toBe(false);
  });
});

describe("typeLabel", () => {
  it("is the name's ending, or else the type's", () => {
    expect(typeLabel({ mime: "application/pdf", name: "plan.pdf" })).toBe("PDF");
    expect(typeLabel({ mime: "image/png", name: "screenshot" })).toBe("PNG");
  });
});

describe("formatBytes", () => {
  it("writes sizes in decimal units", () => {
    expect(formatBytes(0)).toBe("0 KB");
    expect(formatBytes(200)).toBe("1 KB");
    expect(formatBytes(482_113)).toBe("482 KB");
    expect(formatBytes(2_400_000)).toBe("2.4 MB");
  });
});

describe("pastedName", () => {
  it("gives each pasted picture a name of its own and keeps a real name", () => {
    const pasted = new File(["x"], "image.png", { type: "image/png" });
    const first = pastedName(pasted, 0).name;
    const second = pastedName(pasted, 1).name;
    expect(first).toMatch(/^paste-\d{8}-\d{6}\.png$/);
    expect(second).toMatch(/^paste-\d{8}-\d{6}-2\.png$/);
    const named = new File(["x"], "ticket.jpg", { type: "image/jpeg" });
    expect(pastedName(named, 0)).toBe(named);
  });
});

describe("roomFor", () => {
  it("takes files until the message holds ten", () => {
    expect(roomFor(0, 3)).toBe(3);
    expect(roomFor(8, 5)).toBe(2);
    expect(roomFor(10, 1)).toBe(0);
  });
});

describe("the limit's name", () => {
  it("is the one the home's documents use", () => {
    expect(FILE_LIMIT_LABEL).toBe("15 MB");
  });
});
