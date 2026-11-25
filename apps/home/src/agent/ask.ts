import type { Card, CardField, FileRef } from "@wizards-bot/protocol";
import { REPLY_ACTION, REPLY_FIELD } from "@wizards-bot/protocol/limits";
import { z } from "zod";
import { type Lang, langOf, say, w } from "../setup/words.ts";
import type { AskCard } from "./tool.ts";
import { type Answer, defineTool, type Tool } from "./tool.ts";
import type { TurnContext } from "./turns.ts";

// How an agent asks the person. The question is the agent's own message, and what is written in
// the chat answers it. One free answer needs nothing more; a decision brings buttons, several
// things at once a form whose values come back typed. Only an approval is a card of its own.

const KINDS = [
  "text",
  "long_text",
  "number",
  "choice",
  "choices",
  "yes_no",
  "date",
  "file",
] as const;

const PARTS = 12;

const FormPart = z.object({
  label: z.string().min(1).describe("What is asked for, in a few words."),
  kind: z
    .enum(KINDS)
    .optional()
    .describe("Default: choice when there are options, else text. choices: several of them."),
  options: z.array(z.string().min(1)).min(2).max(12).optional().describe("For choice and choices."),
  unit: z.string().optional().describe("Of a number: m, €, people."),
  hint: z.string().optional().describe("An example, or where to find it."),
  optional: z.boolean().optional().describe("It may stay empty."),
  unsure: z.boolean().optional().describe('The person may say "I don\'t know".'),
});
type FormPart = z.infer<typeof FormPart>;

const AskInput = z.object({
  title: z.string().min(1).describe("The question, one sentence."),
  body: z
    .string()
    .optional()
    .describe("What the person needs to know to answer. Markdown. No further questions in it."),
  hint: z
    .string()
    .optional()
    .describe("For one free answer: what it is, in two or three words, shown in the empty input."),
  choices: z
    .array(z.string().min(1))
    .max(4)
    .optional()
    .describe("For a decision: button labels, verb + object, the one you would pick first."),
  form: z
    .array(FormPart)
    .max(PARTS)
    .optional()
    .describe("For several things at once: one part for each thing."),
  approval: z
    .boolean()
    .optional()
    .describe("True when you want a yes before you do something. With choices."),
});
type AskInput = z.infer<typeof AskInput>;

const WORDS = {
  send: w("Send", "Senden"),
  yes: w("Yes", "Ja"),
  no: w("No", "Nein"),
  unsure: w("I don't know", "Weiß ich nicht"),
  answer: w("Your answer", "Deine Antwort"),
  own: w("Or answer in your own words", "Oder antworte in deinen Worten"),
  date: w("2026-12-31", "31.12.2026"),
};

/** A form's field ids are its parts' places: `p1`, `p2`. */
const idOf = (at: number): string => `p${at + 1}`;

const kindOf = (part: FormPart): (typeof KINDS)[number] =>
  part.kind ?? (part.options?.length ? "choice" : "text");

/** The fields of a form as devices draw them. */
export function formFields(parts: FormPart[], lang: Lang): CardField[] {
  return parts.map((part, at) => {
    const kind = kindOf(part);
    const unsure = say(WORDS.unsure, lang);
    const base = { id: idOf(at), label: part.label, placeholder: part.hint };
    // A part the person may not know is never required: a device that cannot say so leaves it empty.
    const required = !part.optional && !part.unsure;
    if (kind === "choice" || kind === "choices" || kind === "yes_no") {
      const named =
        kind === "yes_no"
          ? [
              { id: "yes", label: say(WORDS.yes, lang) },
              { id: "no", label: say(WORDS.no, lang) },
            ]
          : (part.options ?? []).map((label, option) => ({ id: `o${option + 1}`, label }));
      return {
        ...base,
        type: kind === "choices" ? "multi" : "choice",
        options: part.unsure ? [...named, { id: "unsure", label: unsure }] : named,
        required: !part.optional,
      };
    }
    return {
      ...base,
      type: "text",
      ...(kind === "text" ? {} : { format: kind === "long_text" ? "long" : kind }),
      ...(kind === "number" && part.unit ? { unit: part.unit } : {}),
      placeholder:
        part.hint ??
        (kind === "number" ? part.unit : kind === "date" ? say(WORDS.date, lang) : undefined),
      ...(part.unsure ? { unsure } : {}),
      required,
    };
  });
}

/** A value of a form as the agent reads it. */
type Value = string | number | boolean | string[] | { file: string; id: string }[] | null;

/** "2.4", "2,4" and "2,4 m" are 2.4, "1.200,50" is 1200.5. */
export function numberOf(typed: string, unit?: string): number | undefined {
  let text = typed.trim();
  if (unit && text.toLowerCase().endsWith(unit.toLowerCase()))
    text = text.slice(0, text.length - unit.length);
  text = text.replace(/[\s'’]/g, "");
  if (/^[+-]?\d{1,3}(\.\d{3})+(,\d+)?$/.test(text) && text.includes(","))
    text = text.replaceAll(".", "");
  if (/^[+-]?\d{1,3}(,\d{3})+\.\d+$/.test(text)) text = text.replaceAll(",", "");
  text = text.replace(",", ".");
  return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(text) ? Number(text) : undefined;
}

/** "2026-12-31", "31.12.2026" and "31. 12. 2026" are 2026-12-31; a day that is none is none. */
export function dateOf(typed: string): string | undefined {
  const text = typed.trim();
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  const local = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})$/.exec(text);
  const [year, month, day] = iso
    ? [iso[1], iso[2], iso[3]]
    : local
      ? [local[3], local[2], local[1]]
      : [];
  if (!year || !month || !day) return undefined;
  const date = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const at = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== date ? undefined : date;
}

/**
 * A form as the person filled it in: each field's value with its type, or what is wrong with
 * one, in the person's language.
 */
export function readForm(
  fields: CardField[],
  typed: Record<string, string | string[]>,
  fileOf: (id: string) => FileRef | undefined,
  lang: Lang,
): { values: Record<string, Value>; files: FileRef[] } | { problem: string } {
  const values: Record<string, Value> = {};
  const files: FileRef[] = [];
  for (const field of fields) {
    const raw = typed[field.id];
    const list = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw])
      .map((each) => each.trim())
      .filter(Boolean);
    const [first] = list;
    const problem = (en: string, de: string) => ({
      problem: `${field.label}: ${say(w(en, de), lang)}`,
    });
    if (first === undefined) {
      if (field.required)
        return problem("this one is still empty.", "das ist noch nicht ausgefüllt.");
      values[field.id] = null;
    } else if (field.options) {
      const labels = list.map((id) => field.options?.find((option) => option.id === id));
      if (labels.some((option) => !option) || (field.type === "choice" && list.length > 1))
        return problem("choose one of the options.", "wähle eine der Antworten.");
      const yes = field.options[0]?.id === "yes";
      values[field.id] = list.includes("unsure")
        ? "unknown"
        : field.type === "multi"
          ? labels.map((option) => option?.label ?? "")
          : yes
            ? first === "yes"
            : (labels[0]?.label ?? "");
    } else if (field.unsure && (first === "unsure" || first === "?" || first === field.unsure)) {
      values[field.id] = "unknown";
    } else if (field.format === "number") {
      const number = numberOf(first, field.unit);
      if (number === undefined) return problem("that is not a number.", "das ist keine Zahl.");
      values[field.id] = number;
    } else if (field.format === "date") {
      const date = dateOf(first);
      if (!date)
        return problem(
          "that is not a date, e.g. 2026-12-31.",
          "das ist kein Datum, z. B. 31.12.2026.",
        );
      values[field.id] = date;
    } else if (field.format === "file") {
      const given = list.map(fileOf);
      // A device that cannot attach a file says in words what it would be.
      if (given.some((file) => !file)) values[field.id] = list.join(", ");
      else {
        const known = given.filter((file) => file !== undefined);
        files.push(...known);
        values[field.id] = known.map((file) => ({ file: file.name, id: file.id }));
      }
    } else {
      values[field.id] = list.join(", ");
    }
  }
  return { values, files };
}

/** The fields a question's card is answered with as a form; none for one that is answered in words. */
export const formOf = (card: Card): CardField[] | undefined =>
  card.reply && card.fields && !card.fields.some((field) => field.id === REPLY_FIELD)
    ? card.fields
    : undefined;

/** The card of a question, as `ask` makes it. */
export function questionCard(input: AskInput, lang: Lang): AskCard {
  const { title, body, choices = [], form = [] } = input;
  const base = { level: "needs_you" as const, title, body };
  if (input.approval) {
    const labels = choices.length ? choices : [say(WORDS.yes, lang), say(WORDS.no, lang)];
    return {
      ...base,
      kind: "approval",
      actions: labels.map((label, at) => ({
        id: `choice_${at}`,
        label,
        style: at === 0 ? "primary" : "plain",
      })),
    };
  }
  const own = { placeholder: say(WORDS.own, lang) };
  if (form.length)
    return {
      ...base,
      kind: "question",
      reply: own,
      fields: formFields(form, lang),
      actions: [{ id: "send", label: say(WORDS.send, lang), style: "primary" }],
    };
  if (choices.length)
    return {
      ...base,
      kind: "question",
      reply: own,
      actions: choices.map((label, at) => ({
        id: `choice_${at}`,
        label,
        style: at === 0 ? "primary" : "plain",
      })),
    };
  // The field and its button are for a device that answers every question on its card.
  const placeholder = input.hint ?? say(WORDS.answer, lang);
  return {
    ...base,
    kind: "question",
    reply: { placeholder },
    fields: [{ id: REPLY_FIELD, label: placeholder, type: "text", required: true }],
    actions: [{ id: REPLY_ACTION, label: say(WORDS.send, lang), style: "primary" }],
  };
}

/** Whether a question that waits for one free answer asks for several things. */
function asksSeveral({ title, body = "" }: AskInput): boolean {
  const marks = `${title}\n${body}`.match(/\?(?=\s|$)/g)?.length ?? 0;
  const listed = body.match(/^\s*(?:[-*]|\d+[.)])\s+/gm)?.length ?? 0;
  return marks >= 3 || listed >= 3;
}

const MAYBE =
  "If this does not answer your question (they ask back, or want something else), answer them, and ask again while you still need it.";

export function askTool(context: TurnContext): Tool {
  const { home } = context;
  const { db } = home;
  // Said once in a turn: a model that insists is let through.
  let told = false;
  const read = async (input: AskInput, answer: Answer) => {
    const { action, values, card } = answer;
    const looked = async (text: string, files: FileRef[] = []) => {
      const given = [...(answer.files ?? []), ...files];
      if (!given.length) return text;
      const read = await home.files.forModel(given);
      return { text: [text, read.text].filter(Boolean).join("\n\n"), pictures: read.pictures };
    };
    if (action === REPLY_ACTION) {
      const said = typeof values[REPLY_FIELD] === "string" ? values[REPLY_FIELD].trim() : "";
      const what = input.form?.length
        ? "The person wrote instead of filling in the form"
        : input.choices?.length
          ? "The person wrote instead of choosing"
          : "The person answered";
      return looked(`${what} "${card.title}": ${said || "(only the files)"}\n${MAYBE}`);
    }
    if (input.form?.length) {
      const lang = langOf(db);
      const form = readForm(formFields(input.form, lang), values, (id) => home.files.get(id), lang);
      if ("problem" in form) return `The person filled in "${card.title}", but ${form.problem}`;
      const lines = input.form.map((part, at) => {
        const value = form.values[idOf(at)];
        const unit = typeof value === "number" && part.unit ? ` ${part.unit}` : "";
        return `- ${part.label}: ${value === null ? "(left empty)" : JSON.stringify(value)}${unit}`;
      });
      return looked(`The person filled in "${card.title}":\n${lines.join("\n")}`, form.files);
    }
    const label = card.actions.find((candidate) => candidate.id === action)?.label ?? action;
    return `The person answered "${card.title}" with "${label}"`;
  };
  return defineTool({
    name: "ask",
    description: [
      "Ask the person something you cannot find out yourself. The question stands in the chat as your own words: do not write it yourself as well.",
      "One way per question. One free answer: only `title`; the person writes it in the chat. A decision: `choices`. Several things at once: `form`, one part for each, never a list of questions in `body`. A yes before you do something: `approval` with `choices`.",
      "Every word in the language of the chat. Never ask for a secret, nor for the path of a folder: the person picks a folder on the card of `folder_connect`. Ends your turn.",
    ].join(" "),
    input: AskInput,
    asks: true,
    silent: true,
    run: async (input, call) => {
      if (call.answer) return read(input, call.answer);
      if (input.form?.length && input.choices?.length)
        throw new Error("Give `form` or `choices`, not both.");
      const unfit = input.form?.find(
        (part) => ["choice", "choices"].includes(kindOf(part)) && !part.options?.length,
      );
      if (unfit) throw new Error(`"${unfit.label}" needs options.`);
      const plain = !(input.form?.length || input.choices?.length || input.approval);
      if (plain && !told && asksSeveral(input)) {
        told = true;
        throw new Error(
          "This asks for several things at once. Call `ask` again with `form`: one part for each thing, with its kind, unit or options.",
        );
      }
      // A form of one text is one free answer.
      const [only, more] = input.form ?? [];
      const single = only && !more && ["text", "long_text"].includes(kindOf(only)) && !only.unsure;
      await call.ask(
        questionCard(
          single ? { ...input, form: undefined, hint: input.hint ?? only.label } : input,
          langOf(db),
        ),
      );
      return "The question is in the chat. End your turn now and write nothing more.";
    },
  });
}
