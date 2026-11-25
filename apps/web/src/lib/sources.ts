import { clientEntry } from "@engenty/model-setup";
import type { SetupChoice, TestResult } from "@engenty/model-setup/react";
import type { ModelSource, Models, Setup, SetupCheck } from "@wizards-bot/protocol";

// The model sources as the settings list them, and which model of each is in use.

/** The client or server a source is, also on a linked computer (`<computer>/<client>`). */
export const ownId = (sourceId: string): string => sourceId.slice(sourceId.lastIndexOf("/") + 1);

/** Whether a source is on another computer of the person, reached over its link. */
export const elsewhere = (sourceId: string): boolean => sourceId.includes("/");

/** A source's name, a client's with its provider as in the setup: "Anthropic Claude Code". */
export function sourceName(source: Pick<ModelSource, "id" | "kind" | "label">): string {
  const client = source.kind === "subscription" ? clientEntry(ownId(source.id)) : null;
  return client?.label ?? source.label;
}

const modelOf = (refs: string[], sourceId: string): string | undefined =>
  refs.find((ref) => ref.startsWith(`${sourceId}:`))?.slice(sourceId.length + 1);

/** The model of a source that answers; undefined while the source does not answer. */
export const modelInUse = (models: Pick<Models, "answers">, sourceId: string) =>
  modelOf(models.answers, sourceId);

/** The order with a source in front, on its own model; undefined where it has none. */
export function orderWithFirst(models: Models, source: ModelSource): string[] | undefined {
  const model =
    modelInUse(models, source.id) ?? modelOf(models.order, source.id) ?? source.models[0]?.id;
  if (!model) {
    return undefined;
  }
  return [
    `${source.id}:${model}`,
    ...models.order.filter((ref) => !ref.startsWith(`${source.id}:`)),
  ];
}

/** Where a source stands among those that answer: 0 is first, -1 not among them. */
export function placeOf(models: Pick<Models, "answers">, sourceId: string): number {
  const sources = models.answers.map((ref) => ref.slice(0, ref.indexOf(":")));
  return [...new Set(sources)].indexOf(sourceId);
}

/** A row of the list: a source the home has, or one that can be set up. */
export interface SourceRow {
  id: string;
  name: string;
  source?: ModelSource;
  /** The same source as the setup offers it. */
  choice?: SetupChoice;
}

/**
 * The rows the list opens with and the rest behind "Show more", by the setup's rule: what cannot
 * answer as it is comes with the rest, unless the person has it in use.
 */
export function sourceRows(
  models: Models,
  choices: readonly SetupChoice[],
): { first: SourceRow[]; rest: SourceRow[] } {
  const rows: SourceRow[] = models.sources.map((source) => ({
    id: source.id,
    name: sourceName(source),
    source,
    choice: choices.find((choice) => choice.id === source.id),
  }));
  for (const choice of choices) {
    if (!rows.some((row) => row.id === choice.id)) {
      rows.push({ id: choice.id, name: choice.title, choice });
    }
  }
  const isRest = (row: SourceRow) => Boolean(row.choice?.more) && placeOf(models, row.id) < 0;
  return { first: rows.filter((row) => !isRest(row)), rest: rows.filter(isRest) };
}

export const works = (check: SetupCheck | undefined): boolean =>
  check?.state === "ok" || check?.state === "warning";

/** What a test call of one source came to, as the setup's parts show it. */
export function testResult(setup: Setup, sourceId: string, ms: number): TestResult {
  const check = setup.models.find((entry) => entry.id === sourceId);
  return works(check)
    ? { ok: true, ref: check?.model ?? check?.label ?? sourceId, reply: "OK", ms }
    : { ok: false, error: [check?.said, check?.todo].filter(Boolean).join(" "), ms };
}
