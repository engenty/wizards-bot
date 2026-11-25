import type { Part, StepKind } from "@wizards-bot/protocol";
import { type Key, t } from "./i18n";

/** A step of an agent, as its part of the message says it. */
export type Step = Extract<Part, { type: "activity" }>;
type Thought = Extract<Part, { type: "reasoning" }>;

/**
 * How a kind is counted: `things` are the files, pages or documents it was done to, each once;
 * `times` are the steps. The order is the one a summary names them in: what changed something
 * first. The kinds without a count are how the agent works, not what it did.
 */
const COUNTS: Record<StepKind, "things" | "times" | null> = {
  file_write: "things",
  file_edit: "things",
  file_copy: "things",
  file_move: "things",
  file_delete: "things",
  folder_make: "things",
  document_write: "things",
  artifact_write: "things",
  agent_make: "things",
  agent_ask: "times",
  device_ask: "times",
  task_set: "times",
  set: "times",
  draft: "times",
  command: "times",
  sign_in: "times",
  ask: "times",
  page_read: "things",
  page_use: "times",
  file_read: "things",
  picture_look: "things",
  document_read: "things",
  artifact_read: "things",
  search: "times",
  folder_look: "things",
  look: "times",
  skill: "things",
  memory: "times",
  tool_search: null,
  go_on: null,
};
const KINDS = Object.keys(COUNTS) as StepKind[];

/** The kinds that are done to something with a name; the others say all in their line. */
const NAMED = new Set<StepKind>([
  "file_write",
  "file_edit",
  "file_copy",
  "file_move",
  "file_delete",
  "folder_make",
  "document_write",
  "artifact_write",
  "agent_make",
  "agent_ask",
  "device_ask",
  "draft",
  "command",
  "page_read",
  "page_use",
  "file_read",
  "picture_look",
  "document_read",
  "artifact_read",
  "search",
  "folder_look",
  "look",
  "set",
  "skill",
]);

/** A kind's name the app has words for; a home newer than the page may send others. */
const kindOf = (step: Step): StepKind | undefined =>
  step.kind && step.kind in COUNTS ? step.kind : undefined;

const isPage = (kind: StepKind | undefined) => kind === "page_read" || kind === "page_use";

// ── The runs of a message ───────────────────────────────────────────────────

/** A part of a message in its place, or the steps that follow each other as one. */
export type Run =
  | { type: "part"; part: Part; at: number }
  | { type: "steps"; parts: (Step | Thought)[]; steps: Step[]; at: number; last: boolean };

/** Nothing the person sees: it parts no steps. */
const blank = (part: Part) =>
  part.type === "text" || part.type === "reasoning" ? !part.text.trim() : false;

/**
 * A message's parts, with the steps between two of its texts, cards or documents as one. What the
 * model thought between several steps is one of them; with a single step it stays what it is. A
 * source parts nothing: the sources stand together.
 */
export function runsOf(parts: Part[]): Run[] {
  const runs: Run[] = [];
  let open: { part: Step | Thought; at: number }[] = [];
  let held: Run[] = [];
  const close = (last: boolean) => {
    const steps = open.filter((each) => each.part.type === "activity");
    const [first] = steps;
    if (first && steps.length > 1) {
      runs.push({
        type: "steps",
        parts: open.map((each) => each.part),
        steps: steps.map((each) => each.part as Step),
        at: first.at,
        last,
      });
    } else {
      for (const { part, at } of open) {
        runs.push(
          part.type === "activity"
            ? { type: "steps", parts: [part], steps: [part], at, last }
            : { type: "part", part, at },
        );
      }
    }
    runs.push(...held);
    open = [];
    held = [];
  };
  for (const [at, part] of parts.entries()) {
    if (blank(part)) continue;
    if (part.type === "activity" || part.type === "reasoning") {
      open.push({ part, at });
    } else if (part.type === "source") {
      held.push({ type: "part", part, at });
    } else {
      close(false);
      runs.push({ type: "part", part, at });
    }
  }
  close(true);
  return runs;
}

// ── What was done, each thing once ──────────────────────────────────────────

/** Where a line leads. */
export type Target =
  | { to: "file"; folderId: string; path: string; folder: boolean }
  | { to: "page"; url: string }
  | { to: "document" | "artifact" | "agent"; id: string };

/** One thing the agent did, however often: a file it wrote twice, a page it opened and read. */
export interface Row {
  key: string;
  kind?: StepKind;
  steps: Step[];
  /** The page's steps that used it: a click, a text typed in. */
  used: number;
  failed: number;
}

const state = (row: Row, name: Step["state"]) =>
  row.steps.filter((step) => step.state === name).length;

/** A page's address without the place on it. */
const pageKey = (url: string) => url.replace(/#.*$/, "");

function keyOf(step: Step): string {
  const kind = kindOf(step);
  if (!kind) return `label:${step.label}`;
  const { object = {} } = step;
  const what =
    object.documentId ??
    object.artifactId ??
    object.agentId ??
    (object.name === undefined ? undefined : `${object.folderId ?? ""}/${object.name}`);
  return `${kind}:${what ?? object.topic ?? ""}`;
}

export function rowsOf(steps: Step[]): Row[] {
  const rows = new Map<string, Row>();
  // The steps on a page that say no address are on the page that is open.
  let page: Row | undefined;
  for (const step of steps) {
    const kind = kindOf(step);
    const url = step.object?.url;
    const key = isPage(kind) ? (url ? `page:${pageKey(url)}` : page?.key) : keyOf(step);
    const name = key ?? "page:";
    let row = rows.get(name);
    if (!row) {
      row = {
        key: name,
        ...(kind ? { kind: isPage(kind) ? "page_read" : kind } : {}),
        steps: [],
        used: 0,
        failed: 0,
      };
      rows.set(name, row);
    }
    row.steps.push(step);
    if (kind === "page_use" && step.state === "done") row.used++;
    if (step.state === "failed") row.failed++;
    if (isPage(kind)) page = row;
  }
  // A step on no page (it closed the browser) is none of its own beside the pages.
  if (rows.size > 1 && rows.get("page:")?.failed === 0) rows.delete("page:");
  return [...rows.values()];
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/** The newest of a row's steps that says something: a page has its title once it is read. */
const said = (row: Row) =>
  row.steps.findLast((step) => step.object?.name) ??
  row.steps.findLast((step) => step.object?.url) ??
  row.steps.at(-1);

const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const isFile = (kind: StepKind | undefined) =>
  kind?.startsWith("file_") || kind === "folder_make" || kind === "folder_look";

/** What a step is about, as a line names it; none where its line says all. */
function nameOf(step: Step | undefined): string | undefined {
  const kind = step && kindOf(step);
  if (!kind || !NAMED.has(kind)) return;
  const { name, count, url, topic } = step.object ?? {};
  if (count && count > 1) return t("step.files", { n: count });
  if (url) return name ?? hostOf(url);
  if (name) return isFile(kind) ? base(name) || name : name;
  return topic && t(`step.topic.${topic}`);
}

/** The present tense, for a step that runs: “Schreibt Quellen.md”. */
export function nowLine(step: Step): string {
  const kind = kindOf(step);
  if (!kind) return step.label;
  const name = nameOf(step);
  if (!NAMED.has(kind)) return t(`step.now.${kind}` as Key);
  return name ? t(`step.now.${kind}` as Key, { name }) : step.label;
}

const count = (key: string, n: number) => t(key as Key, { n });

/** A row as a line: what it is, and beside it what was done, where and how often. */
export function rowLine(row: Row): { title: string; details: string[]; failed?: string } {
  const last = said(row);
  const { kind } = row;
  const times = row.steps.length;
  const done = state(row, "done");
  const failed = row.failed
    ? times === 1
      ? t("step.failedOne")
      : t("step.failed", { n: row.failed })
    : undefined;
  if (!(kind && last)) {
    return {
      title: last?.label ?? "",
      details: times > 1 ? [t("step.times", { n: times })] : [],
      ...(failed ? { failed } : {}),
    };
  }
  const name = nameOf(last);
  const details: string[] = [];
  const object = last.object ?? {};
  if (isPage(kind)) {
    if (name && object.url && name !== hostOf(object.url)) details.push(hostOf(object.url));
    if (row.used) details.push(count("step.done.page_use", row.used));
  } else {
    if (name && done && !row.failed) details.push(t(`step.did.${kind}` as Key));
    if (kind === "ask" && object.name && !row.failed) details.push(t("step.did.ask"));
    if (times > 1 && name) details.push(t("step.times", { n: times }));
    // The folder it is in comes last: it is what gives way where there is no room.
    if (name && object.name && isFile(kind) && object.name.includes("/") && !object.count)
      details.push(base(object.name.slice(0, object.name.lastIndexOf("/"))));
  }
  const title =
    name ??
    (object.name && kind === "ask"
      ? object.folderId
        ? base(object.name)
        : object.name
      : done
        ? count(`step.done.${kind}`, done)
        : (last.label ?? ""));
  return { title, details, ...(failed ? { failed } : {}) };
}

/** Where a row leads, where the app can show it. A web address only: what an agent was given. */
export function targetOf(row: Row): Target | undefined {
  const step = row.steps.findLast((each) => each.state === "done" && each.object);
  const { object } = step ?? {};
  if (!(step && object)) return;
  const kind = kindOf(step);
  if (object.documentId) return { to: "document", id: object.documentId };
  if (object.artifactId) return { to: "artifact", id: object.artifactId };
  if (object.agentId) return { to: "agent", id: object.agentId };
  if (object.url)
    return /^https?:\/\//i.test(object.url) ? { to: "page", url: object.url } : undefined;
  if (object.folderId && kind !== "ask") {
    const folder = kind === "folder_look" || kind === "folder_make";
    // A folder's name comes first in what a look into it says.
    const path =
      kind === "folder_look" ? (object.name ?? "").split("/").slice(1).join("/") : object.name;
    return { to: "file", folderId: object.folderId, path: path ?? "", folder };
  }
}

// ── The one line of several ─────────────────────────────────────────────────

/** So many things a line names; the rest is counted as steps. */
const NAMES = 3;

/** How long the steps took, from the first to the end of the last; none where they do not say. */
export function durationOf(steps: Step[]): string | undefined {
  const from = steps.map((step) => Date.parse(step.startedAt ?? "")).filter(Number.isFinite);
  const to = steps.map((step) => Date.parse(step.endedAt ?? "")).filter(Number.isFinite);
  if (!(from.length && to.length)) return;
  const seconds = Math.round((Math.max(...to) - Math.min(...from)) / 1000);
  if (seconds < 1) return;
  return seconds < 60
    ? t("step.seconds", { n: seconds })
    : t("step.minutes", { n: Math.round(seconds / 60) });
}

/**
 * What several steps did, in the person's words: “15 Dateien geschrieben”, “7 Seiten im Browser
 * gelesen”. What failed is said apart, and nothing that failed is counted as done.
 */
export function summaryOf(steps: Step[]): { done: string[]; failed?: string } {
  const rows = rowsOf(steps);
  const counted = new Map<StepKind, number>();
  const add = (kind: StepKind, n: number) => n && counted.set(kind, (counted.get(kind) ?? 0) + n);
  const other = rows.filter((row) => !row.kind && state(row, "done"));
  for (const row of rows) {
    const done = row.steps.filter((step) => step.state === "done");
    if (!(row.kind && done.length)) continue;
    const how = COUNTS[row.kind];
    if (how === "things") {
      add(row.kind, Math.max(...done.map((step) => step.object?.count ?? 1)));
    } else if (how === "times") {
      add(row.kind, done.length);
    }
    add("page_use", row.used);
  }
  const named = KINDS.filter((kind) => counted.has(kind));
  const done = named
    .slice(0, NAMES)
    .map((kind) => count(`step.done.${kind}`, counted.get(kind) ?? 0));
  const rest =
    named.slice(NAMES).reduce((sum, kind) => sum + (counted.get(kind) ?? 0), 0) +
    other.reduce((sum, row) => sum + state(row, "done"), 0);
  const [only] = other;
  if (only && other.length === 1 && named.length <= NAMES) {
    const { title, details } = rowLine({
      ...only,
      steps: only.steps.filter((s) => s.state === "done"),
      failed: 0,
    });
    done.push([title, ...details].join(" "));
  } else if (rest) {
    done.push(count(done.length ? "step.more" : "step.steps", rest));
  }
  const failed = steps.filter((step) => step.state === "failed").length;
  // Only what the agent looked for among its tools, or nothing that came of it.
  if (!done.length && !failed) done.push(count("step.steps", steps.length));
  return { done, ...(failed ? { failed: t("step.failed", { n: failed }) } : {}) };
}
