import { describe, expect, it } from "vitest";
import {
  canShare,
  documentFile,
  endsAt,
  fileName,
  pageFile,
  passwordFits,
  shareOut,
  showsEarlier,
} from "./share";

describe("fileName", () => {
  it("keeps a title and drops what a file system refuses", () => {
    expect(fileName("Trip plan", "md")).toBe("Trip plan.md");
    expect(fileName('Q3: costs / "net" <draft>?', "md")).toBe("Q3 costs net draft.md");
    expect(fileName("  ..hidden\n\tname  ", "md")).toBe("hidden name.md");
  });

  it("is never empty and never long", () => {
    expect(fileName(" /// ", "md")).toBe("document.md");
    expect(fileName("a".repeat(300), "md")).toHaveLength(83);
  });
});

describe("documentFile", () => {
  it("is the document's text as Markdown, named after its title", async () => {
    const file = documentFile({ title: "Packing list", content: "- Socks\n" });
    expect(file.name).toBe("Packing list.md");
    expect(file.type).toBe("text/markdown");
    expect(await file.text()).toBe("- Socks\n");
  });
});

describe("pageFile", () => {
  it("is the artifact's page as an HTML file, named after its title", async () => {
    const file = pageFile("Spending: 2026", new Blob(["<!doctype html>"]));
    expect(file.name).toBe("Spending 2026.html");
    expect(file.type).toBe("text/html");
    expect(await file.text()).toBe("<!doctype html>");
  });
});

describe("passwordFits", () => {
  it("takes no password or one that is long enough", () => {
    expect(passwordFits("")).toBe(true);
    expect(passwordFits("abc")).toBe(false);
    expect(passwordFits("abcd")).toBe(true);
  });
});

describe("showsEarlier", () => {
  it("is true for a link made before the last change", () => {
    expect(showsEarlier({ version: 2 }, 3)).toBe(true);
    expect(showsEarlier({ version: 3 }, 3)).toBe(false);
  });
});

describe("endsAt", () => {
  const now = new Date(2026, 10, 21, 9, 0);

  it("is the day and the time, with the year only when it is another one", () => {
    expect(endsAt(new Date(2026, 10, 28, 10, 43).toISOString(), now, "en-GB")).toBe(
      "28 Nov, 10:43",
    );
    expect(endsAt(new Date(2027, 0, 2, 8, 5).toISOString(), now, "de")).toBe("2. Jan. 2027, 08:05");
    expect(endsAt("soon", now, "en")).toBe("");
  });
});

describe("the share sheet", () => {
  const link = { title: "Plan", url: "https://me.example.com/p/abc" };
  const file = { files: [documentFile({ title: "Plan", content: "x" })] };

  it("is not there in a browser without one", async () => {
    expect(canShare({}, link)).toBe(false);
    expect(await shareOut({}, link)).toBe("unavailable");
  });

  it("takes a link, and a file only where the browser says so", async () => {
    const plain = { share: async () => undefined };
    expect(canShare(plain, link)).toBe(true);
    expect(canShare(plain, file)).toBe(false);
    const picky = { ...plain, canShare: (data?: ShareData) => !data?.files?.length };
    expect(await shareOut(picky, file)).toBe("unavailable");
    expect(await shareOut(picky, link)).toBe("shared");
  });

  it("tells a closed sheet from one that failed", async () => {
    const failing = (name: string) => ({
      share: async () => {
        throw Object.assign(new Error("no"), { name });
      },
    });
    expect(await shareOut(failing("AbortError"), link)).toBe("closed");
    expect(await shareOut(failing("NotAllowedError"), link)).toBe("unavailable");
  });
});
