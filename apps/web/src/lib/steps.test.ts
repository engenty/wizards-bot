import type { Part } from "@wizards-bot/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "./i18n";
import {
  durationOf,
  nowLine,
  rowLine,
  rowsOf,
  runsOf,
  type Step,
  shownOf,
  summaryOf,
  targetOf,
} from "./steps";

const step = (over: Partial<Step> = {}): Step => ({
  type: "activity",
  label: "Writing a file",
  state: "done",
  ...over,
});
const file = (path: string, over: Partial<Step> = {}) =>
  step({ kind: "file_write", object: { name: path, folderId: "fld_1" }, ...over });
const page = (url?: string, name?: string, over: Partial<Step> = {}) =>
  step({
    kind: "page_read",
    label: "Browser: open",
    object: { ...(url ? { url } : {}), ...(name ? { name } : {}) },
    ...over,
  });
const text = (words: string): Part => ({ type: "text", text: words });

beforeEach(() => {
  vi.stubGlobal("document", { documentElement: {} });
  setLang("de");
});

const shape = (parts: Part[]) =>
  runsOf(parts).map((run) => (run.type === "steps" ? `${run.parts.length} steps` : run.part.type));

describe("runsOf", () => {
  it("makes one run of the steps between two texts, and leaves the texts where they are", () => {
    const parts = [file("a"), file("b"), text("So far."), file("c"), file("d"), text("Done.")];
    expect(shape(parts)).toEqual(["2 steps", "text", "2 steps", "text"]);
  });

  it("never takes a card, a document, an artifact or a file in", () => {
    const parts = [
      file("a"),
      { type: "document", documentId: "doc_1", title: "Plan" },
      file("b"),
      file("c"),
      { type: "artifact", artifactId: "art_1", title: "Chart" },
      { type: "card", card: {} },
    ] as Part[];
    expect(shape(parts)).toEqual(["1 steps", "document", "2 steps", "artifact", "card"]);
  });

  it("looks past empty texts and sources, and takes what was thought between steps", () => {
    const parts: Part[] = [
      { type: "reasoning", text: "First." },
      file("a"),
      text("\n\n"),
      { type: "source", url: "https://example.com" },
      { type: "reasoning", text: "Then." },
      file("b"),
      text("Done."),
    ];
    expect(shape(parts)).toEqual(["4 steps", "source", "text"]);
    // With one step, the thought stays a line of its own.
    expect(shape(parts.slice(0, 2))).toEqual(["reasoning", "1 steps"]);
  });

  it("keeps its place from the first step on, and is the last while nothing follows", () => {
    const [one] = runsOf([file("a")]);
    const [two] = runsOf([file("a"), file("b")]);
    expect(one?.at).toBe(two?.at);
    expect(runsOf([file("a"), text("x")])[0]).toMatchObject({ last: false });
    expect(two).toMatchObject({ last: true });
  });
});

describe("rowsOf", () => {
  it("has a file that was written twice once", () => {
    const rows = rowsOf([file("law/a.md"), file("law/b.md"), file("law/a.md")]);
    expect(rows.map(rowLine)).toEqual([
      { title: "a.md", details: ["geschrieben", "2×", "law"] },
      { title: "b.md", details: ["geschrieben", "law"] },
    ]);
  });

  it("has a page that was opened, read and used once, by its title and host", () => {
    const rows = rowsOf([
      page("https://www.ris.bka.gv.at/a#top"),
      page("https://www.ris.bka.gv.at/a", "Bauordnung"),
      step({ kind: "page_use", object: { url: "https://www.ris.bka.gv.at/a" } }),
      page(),
      page("https://wien.gv.at/b"),
      page(undefined, undefined, { label: "Browser: close" }),
    ]);
    expect(rows.map(rowLine)).toEqual([
      { title: "Bauordnung", details: ["ris.bka.gv.at", "1 Eingabe im Browser"] },
      { title: "wien.gv.at", details: [] },
    ]);
  });

  it("merges a tool that says nothing more by its label, and one of a newer home", () => {
    const rows = rowsOf([
      step({ label: "Browser: open" }),
      step({ label: "Browser: snapshot" }),
      step({ label: "Browser: open", kind: "teleport" as Step["kind"] }),
    ]);
    expect(rows.map(rowLine)).toEqual([
      { title: "Browser: open", details: ["2×"] },
      { title: "Browser: snapshot", details: [] },
    ]);
  });

  it("says what failed, and not that it was done", () => {
    const [once] = rowsOf([file("a.md", { state: "failed" })]);
    const [again] = rowsOf([file("a.md", { state: "failed" }), file("a.md")]);
    expect(once && rowLine(once)).toEqual({
      title: "a.md",
      details: [],
      failed: "fehlgeschlagen",
    });
    expect(again && rowLine(again)).toEqual({
      title: "a.md",
      details: ["2×"],
      failed: "1 fehlgeschlagen",
    });
  });
});

describe("shownOf", () => {
  const steps = [
    file("a"),
    file("a"),
    file("b", { state: "failed" }),
    file("c", { state: "running" }),
  ];
  const titles = (detail: "none" | "summary" | "all") =>
    shownOf(steps, detail).map((row) => rowLine(row).title);

  it("has what runs now and what failed, each thing once, or every step", () => {
    expect(titles("none")).toEqual(["b", "c"]);
    expect(titles("summary")).toEqual(["a", "b", "c"]);
    expect(titles("all")).toEqual(["a", "a", "b", "c"]);
    const keys = shownOf(steps, "all").map((row) => row.key);
    expect(new Set(keys).size).toBe(4);
  });

  it("has nothing of steps that all went well, where the person wants none", () => {
    expect(shownOf([file("a"), file("b")], "none")).toEqual([]);
  });
});

describe("summaryOf", () => {
  it("counts what was done, what changed something first", () => {
    const steps = [
      page("https://a.at"),
      page("https://a.at", "A"),
      page("https://b.at"),
      file("a"),
      file("b"),
      file("a"),
    ];
    expect(summaryOf(steps)).toEqual({
      done: ["2 Dateien geschrieben", "2 Seiten im Browser gelesen"],
    });
    setLang("en");
    expect(summaryOf(steps).done).toEqual(["2 files written", "2 pages read in the browser"]);
  });

  it("names what failed and counts it nowhere else", () => {
    expect(summaryOf([file("a"), file("b", { state: "failed" })])).toEqual({
      done: ["1 Datei geschrieben"],
      failed: "1 fehlgeschlagen",
    });
    expect(summaryOf([file("a", { state: "failed" }), file("b", { state: "failed" })])).toEqual({
      done: [],
      failed: "2 fehlgeschlagen",
    });
  });

  it("does not say a step was done that asked first", () => {
    expect(summaryOf([file("a"), file("b", { kind: "ask" })]).done).toEqual([
      "1 Datei geschrieben",
      "1 Frage an dich",
    ]);
  });

  it("counts several at once, and names three things at most", () => {
    const steps = [
      step({ kind: "file_move", object: { count: 12 } }),
      file("a"),
      step({ kind: "search", object: { name: "x" } }),
      step({ kind: "document_read", object: { name: "D", documentId: "doc_1" } }),
      step({ kind: "memory" }),
    ];
    expect(summaryOf(steps).done).toEqual([
      "1 Datei geschrieben",
      "12 Dateien verschoben",
      "1 Dokument gelesen",
      "2 weitere Schritte",
    ]);
  });

  it("says steps without a kind by their one label, or counts them", () => {
    const call = step({ label: "Mail: search" });
    expect(summaryOf([call, call]).done).toEqual(["Mail: search 2×"]);
    expect(summaryOf([call, step({ label: "Mail: read" })]).done).toEqual(["2 Schritte"]);
    expect(summaryOf([file("a"), call, step({ label: "Mail: read" })]).done).toEqual([
      "1 Datei geschrieben",
      "2 weitere Schritte",
    ]);
  });

  it("says something of steps that only looked for a tool", () => {
    const looked = step({ kind: "tool_search", object: { name: "x" } });
    expect(summaryOf([looked, looked]).done).toEqual(["2 Schritte"]);
  });
});

describe("nowLine", () => {
  it("is the present, with the file's own name, and the label where nothing is known", () => {
    expect(nowLine(file("law/a.md"))).toBe("Schreibt a.md");
    expect(nowLine(page("https://www.wien.gv.at/b"))).toBe("Liest wien.gv.at");
    expect(nowLine(step({ kind: "look", object: { topic: "models" } }))).toBe(
      "Sieht nach: Modelle",
    );
    expect(nowLine(step({ kind: "file_write" }))).toBe("Writing a file");
    expect(nowLine(step({ label: "Mail: search" }))).toBe("Mail: search");
  });
});

describe("targetOf", () => {
  const to = (one: Step) => {
    const [row] = rowsOf([one]);
    return row && targetOf(row);
  };

  it("leads to the file, the folder, the document, the agent and the page", () => {
    expect(to(file("law/a.md"))).toEqual({
      to: "file",
      folderId: "fld_1",
      path: "law/a.md",
      folder: false,
    });
    expect(
      to(step({ kind: "folder_look", object: { name: "Docs/2026", folderId: "fld_1" } })),
    ).toEqual({ to: "file", folderId: "fld_1", path: "2026", folder: true });
    expect(to(step({ kind: "agent_ask", object: { agentId: "agt_2", name: "Lex" } }))).toEqual({
      to: "agent",
      id: "agt_2",
    });
    expect(to(page("https://a.at/b"))).toEqual({ to: "page", url: "https://a.at/b" });
  });

  it("leads nowhere from what failed, asked first or is no web address", () => {
    expect(to(file("a", { state: "failed" }))).toBeUndefined();
    expect(to(file("a", { kind: "ask" }))).toBeUndefined();
    expect(to(page("javascript:alert(1)"))).toBeUndefined();
  });
});

describe("durationOf", () => {
  const at = (from: string, to: string) =>
    step({ startedAt: `2026-11-25T10:${from}Z`, endedAt: `2026-11-25T10:${to}Z` });

  it("is the time from the first to the last, short", () => {
    expect(durationOf([at("00:00.000", "00:04.000"), at("00:06.000", "00:12.000")])).toBe("12 s");
    expect(durationOf([at("00:00.000", "00:04.000"), at("01:50.000", "02:05.000")])).toBe("2 min");
    expect(durationOf([step(), step()])).toBeUndefined();
  });
});
