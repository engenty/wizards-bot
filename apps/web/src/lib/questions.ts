import type { Card, CardField, Message } from "@wizards-bot/protocol";
import { UNSURE } from "@wizards-bot/protocol/limits";

/** The fields of a question that is a form; none for one that is answered in words or by a choice. */
export const formOf = (card: Card): CardField[] | undefined =>
  card.reply ? card.fields : undefined;

/** A question whose one answer is the next message. */
export const isFree = (card: Card) => Boolean(card.reply && !card.fields && !card.actions.length);

/** The questions that wait in one chat, oldest first. */
export const questionsIn = (items: Card[], conversationId: string): Card[] =>
  items.filter((card) => card.reply && card.conversationId === conversationId);

/** What the person picked for their next message: a question, or none of them. */
export interface Picked {
  cardId: string | null;
  /** The newest question when they picked: a newer one counts again by itself. */
  newest: string;
}

/**
 * The question the next message answers: the one the person picked, else the newest. While the
 * agent works on something else, its earlier question is answered only when it was picked.
 */
export function targetOf(
  questions: Card[],
  picked: Picked | undefined,
  { working, last }: { working: boolean; last?: Message },
): Card | undefined {
  const newest = questions.at(-1);
  if (!newest) {
    return undefined;
  }
  if (picked?.newest === newest.id) {
    if (picked.cardId === null) {
      return undefined;
    }
    const chosen = questions.find((card) => card.id === picked.cardId);
    if (chosen) {
      return chosen;
    }
  }
  return working && last?.id !== newest.messageId ? undefined : newest;
}

/** What a message says it answers: nothing to say where no question waits. */
export const answersOf = (questions: Card[], target: Card | undefined) =>
  target ? { answers: target.id } : questions.length ? { answers: null } : {};

type Values = Record<string, string | string[]>;

/** The fields of a form that still need an answer. "I don't know" is one. */
export function missingIn(fields: CardField[], values: Values): string[] {
  return fields
    .filter((field) => field.required && !values[field.id]?.length)
    .map((field) => field.id);
}

/** A field's answer as the form shows it once it is sent; none where it stayed empty. */
export function answerText(
  field: CardField,
  values: Values,
  lang: string,
  files: (n: number) => string,
): string | undefined {
  const value = values[field.id];
  const list = Array.isArray(value) ? value : value ? [value] : [];
  const [first] = list;
  if (first === undefined) {
    return undefined;
  }
  if (field.options) {
    return list
      .map((id) => field.options?.find((option) => option.id === id)?.label ?? id)
      .join(", ");
  }
  if (first === UNSURE && field.unsure) {
    return field.unsure;
  }
  if (field.type === "file") {
    return files(list.length);
  }
  if (field.type === "date") {
    return new Intl.DateTimeFormat(lang, { dateStyle: "long", timeZone: "UTC" }).format(
      new Date(`${first}T00:00:00Z`),
    );
  }
  return field.unit ? `${first} ${field.unit}` : list.join(", ");
}
