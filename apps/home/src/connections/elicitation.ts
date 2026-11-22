import type { CardAction, CardField } from "@wizards-bot/protocol";

/**
 * What a connected server may ask the person while one of its tools runs (MCP elicitation),
 * turned into what a card shows, and the person's answer turned back into what the server
 * gets. A form is a flat list of texts, numbers, yes or no and choices; a page is a link
 * the person opens in a browser.
 */

/** How the person answered: sent it, said no, or put it off. */
export type ElicitAction = "accept" | "decline" | "cancel";

/** What goes back to the server for one question. */
export type ElicitAnswer = { action: ElicitAction; content?: Content };

/** A filled form as a server gets it. */
export type Content = Record<string, string | number | boolean | string[]>;

/** Field values of a card as a device sends them. */
type Values = Record<string, string | string[] | undefined>;

export const FORM_ACTIONS: CardAction[] = [
  { id: "accept", label: "Send", style: "primary" },
  { id: "decline", label: "Don't", style: "plain" },
  { id: "cancel", label: "Not now", style: "plain" },
];

/** The link is the card's first step, so "Go on" does not compete with it. */
export const PAGE_ACTIONS: CardAction[] = [
  { id: "accept", label: "Go on", style: "plain" },
  { id: "decline", label: "Don't", style: "plain" },
  { id: "cancel", label: "Not now", style: "plain" },
];

const MAX_FIELDS = 12;
const MAX_OPTIONS = 40;
const MAX_LABEL = 120;
const MAX_TEXT = 4000;
const YES = "yes";
const NO = "no";

/**
 * Names that ask for something that opens an account or pays. MCP forbids a server to ask
 * for these in a form: they belong on a page of the service, which the home never reads.
 */
const SECRET =
  /pass(word|code|phrase)|passwd|\bpin\b|secret|api[\s_-]?key|access[\s_-]?key|private[\s_-]?key|\btoken\b|credit[\s_-]?card|card[\s_-]?number|\bcvv\b|\bcvc\b|security[\s_-]?code|\botp\b|one[\s_-]?time[\s_-]?(code|password)/i;

type Property =
  | { kind: "text"; min?: number; max?: number; format?: string }
  | { kind: "number"; whole: boolean; min?: number; max?: number }
  | { kind: "yes_no" }
  | { kind: "choice"; options: { id: string; label: string }[] }
  | { kind: "multi"; options: { id: string; label: string }[]; min?: number; max?: number };

interface Entry {
  /** The property's name in the server's schema. */
  name: string;
  field: CardField;
  property: Property;
  /** What the server says about the field. */
  description?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** The choices of an enum: plain values, or values with titles. */
function optionsOf(schema: Record<string, unknown>): { id: string; label: string }[] | undefined {
  const titled = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : undefined;
  if (titled) {
    const options = titled.map((entry) =>
      isRecord(entry) && typeof entry.const === "string"
        ? { id: entry.const, label: (text(entry.title) ?? entry.const).slice(0, MAX_LABEL) }
        : undefined,
    );
    return options.every((option) => option !== undefined) ? options : undefined;
  }
  if (!Array.isArray(schema.enum)) return undefined;
  if (!schema.enum.every((value) => typeof value === "string")) return undefined;
  const names = Array.isArray(schema.enumNames) ? schema.enumNames : [];
  return (schema.enum as string[]).map((value, index) => ({
    id: value,
    label: (text(names[index]) ?? value).slice(0, MAX_LABEL),
  }));
}

function hintOf(property: Property): string | undefined {
  if (property.kind === "number") {
    const what = property.whole ? "A whole number" : "A number";
    if (property.min !== undefined && property.max !== undefined)
      return `${what} from ${property.min} to ${property.max}`;
    if (property.min !== undefined) return `${what}, at least ${property.min}`;
    if (property.max !== undefined) return `${what}, at most ${property.max}`;
    return what;
  }
  if (property.kind !== "text") return undefined;
  if (property.format === "email") return "An email address";
  if (property.format === "uri") return "A link, starting with https://";
  if (property.format === "date") return "A date, like 2026-11-21";
  if (property.format === "date-time") return "A date and time, like 2026-11-21T09:30:00Z";
  return undefined;
}

/** The fields of a form, or why the home does not show it. */
function entriesOf(schema: unknown): Entry[] | { refused: string } {
  if (!isRecord(schema) || schema.type !== "object")
    return { refused: "its form is not a flat list of fields" };
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const names = Object.keys(properties);
  if (names.length > MAX_FIELDS) return { refused: `its form has more than ${MAX_FIELDS} fields` };
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const entries: Entry[] = [];
  for (const [index, name] of names.entries()) {
    const definition = properties[name];
    if (!isRecord(definition)) return { refused: `its field ${name} has no kind` };
    const label = (text(definition.title) ?? name).slice(0, MAX_LABEL);
    const description = text(definition.description);
    if (SECRET.test(`${name} ${label} ${description ?? ""}`))
      return { refused: `it asks for a secret in a form ("${label}")` };

    let property: Property;
    let value: string | string[] | undefined;
    if (definition.type === "array") {
      const options = isRecord(definition.items) ? optionsOf(definition.items) : undefined;
      if (!options) return { refused: `its field "${label}" is a list the Bot Server cannot show` };
      property = {
        kind: "multi",
        options,
        min: number(definition.minItems),
        max: number(definition.maxItems),
      };
      if (Array.isArray(definition.default))
        value = definition.default.filter((one) => options.some((option) => option.id === one));
    } else if (definition.type === "string") {
      const options = optionsOf(definition);
      if (options) {
        property = { kind: "choice", options };
        if (options.some((option) => option.id === definition.default))
          value = definition.default as string;
      } else {
        property = {
          kind: "text",
          min: number(definition.minLength),
          max: number(definition.maxLength),
          format: text(definition.format),
        };
        value = typeof definition.default === "string" ? definition.default : undefined;
      }
    } else if (definition.type === "number" || definition.type === "integer") {
      property = {
        kind: "number",
        whole: definition.type === "integer",
        min: number(definition.minimum),
        max: number(definition.maximum),
      };
      const start = number(definition.default);
      value = start === undefined ? undefined : String(start);
    } else if (definition.type === "boolean") {
      property = { kind: "yes_no" };
      if (typeof definition.default === "boolean") value = definition.default ? YES : NO;
    } else {
      return { refused: `its field "${label}" is of a kind the Bot Server cannot show` };
    }
    if ("options" in property) {
      if (!property.options.length || property.options.length > MAX_OPTIONS)
        return { refused: `its field "${label}" has no choices or too many` };
    }

    const options =
      property.kind === "yes_no"
        ? [
            { id: YES, label: "Yes" },
            { id: NO, label: "No" },
          ]
        : "options" in property
          ? property.options
          : undefined;
    const field: CardField = {
      id: `f${index}`,
      label,
      type: property.kind === "multi" ? "multi" : options ? "choice" : "text",
      ...(options ? { options } : {}),
      ...(required.has(name) ? { required: true } : {}),
    };
    const hint = hintOf(property);
    if (hint) field.placeholder = hint;
    if (value?.length) field.value = value;
    entries.push({ name, field, property, description });
  }
  return entries;
}

/**
 * Markdown that shows a server's words as they are: nothing in them becomes a link, a
 * picture or a heading, so a server cannot dress a link up as something else.
 */
export function plain(value: string): string {
  return value
    .slice(0, MAX_TEXT)
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/[!-/:-@[-`{-~]/g, (character) => `\\${character}`))
    .join("  \n");
}

/** The card for a form, or why the home refuses it. */
export function formOf(
  schema: unknown,
): { fields: CardField[]; notes: string[] } | { refused: string } {
  const entries = entriesOf(schema);
  if ("refused" in entries) return entries;
  return {
    fields: entries.map((entry) => entry.field),
    notes: entries
      .filter((entry) => entry.description && entry.description !== entry.field.label)
      .map((entry) => `**${plain(entry.field.label)}**: ${plain(entry.description as string)}`),
  };
}

const FORMATS: Record<string, (value: string) => boolean> = {
  email: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value),
  uri: (value) => URL.canParse(value),
  date: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)),
  "date-time": (value) => /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value)),
};

/**
 * What the person typed, as the server's schema wants it: numbers as numbers, yes and no
 * as true and false, an empty field left out. `problems` says what does not fit, in the
 * person's words.
 */
export function contentOf(
  schema: unknown,
  values: Values,
): { content: Content } | { problems: string[] } {
  const entries = entriesOf(schema);
  if ("refused" in entries) return { problems: ["This form cannot be answered."] };
  const content: Content = {};
  const problems: string[] = [];
  for (const { name, field, property } of entries) {
    const raw = values[field.id];
    const label = field.label;
    if (property.kind === "multi") {
      const picked = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter((one) =>
        property.options.some((option) => option.id === one),
      );
      if (!picked.length && !field.required) continue;
      if (picked.length < Math.max(property.min ?? 0, field.required ? 1 : 0))
        problems.push(`${label}: pick at least ${Math.max(property.min ?? 1, 1)}.`);
      else if (property.max !== undefined && picked.length > property.max)
        problems.push(`${label}: pick at most ${property.max}.`);
      else content[name] = picked;
      continue;
    }
    const typed = (Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "")).trim();
    if (!typed) {
      if (field.required) problems.push(`${label} is missing.`);
      continue;
    }
    if (property.kind === "yes_no") {
      if (typed !== YES && typed !== NO) problems.push(`${label}: pick yes or no.`);
      else content[name] = typed === YES;
    } else if (property.kind === "choice") {
      if (!property.options.some((option) => option.id === typed))
        problems.push(`${label}: pick one of the choices.`);
      else content[name] = typed;
    } else if (property.kind === "number") {
      const parsed = Number(typed.replace(",", "."));
      if (!Number.isFinite(parsed) || (property.whole && !Number.isInteger(parsed)))
        problems.push(`${label} takes ${property.whole ? "a whole number" : "a number"}.`);
      else if (property.min !== undefined && parsed < property.min)
        problems.push(`${label} is at least ${property.min}.`);
      else if (property.max !== undefined && parsed > property.max)
        problems.push(`${label} is at most ${property.max}.`);
      else content[name] = parsed;
    } else {
      const check = property.format ? FORMATS[property.format] : undefined;
      if (property.min !== undefined && typed.length < property.min)
        problems.push(`${label} takes at least ${property.min} characters.`);
      else if (property.max !== undefined && typed.length > property.max)
        problems.push(`${label} takes at most ${property.max} characters.`);
      else if (check && !check(typed))
        problems.push(`${label}: ${(hintOf(property) ?? "").toLowerCase()} is needed.`);
      else content[name] = typed;
    }
  }
  return problems.length ? { problems } : { content };
}

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The page a server wants the person to open, or why the home does not show it. The home
 * never fetches the page: only the person opens it, in a browser.
 */
export function pageOf(
  address: unknown,
): { url: string; host: string; warning?: string } | { refused: string } {
  if (typeof address !== "string" || !URL.canParse(address))
    return { refused: "it sent no address a browser can open" };
  const url = new URL(address);
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOCAL.has(url.hostname));
  if (!secure) return { refused: `it sent an address that is not https (${url.protocol})` };
  if (url.username || url.password) return { refused: "it sent an address with a sign-in in it" };
  return {
    // A backtick would end the block the card shows the address in.
    url: url.href.replaceAll("`", "%60"),
    host: url.host,
    warning: url.hostname.split(".").some((label) => label.startsWith("xn--"))
      ? "The address is written with unusual letters. Read it before you open it."
      : undefined,
  };
}

/** What the card says besides its fields: the server's words, then where the answer goes. */
export function formBody(name: string, message: unknown, notes: string[]): string {
  return [
    plain(text(message) ?? "It gave no reason."),
    ...notes,
    `Your answer goes to **${plain(name)}** only. No model reads it.`,
  ].join("\n\n");
}

export function pageBody(
  name: string,
  message: unknown,
  page: { url: string; host: string; warning?: string },
): string {
  return [
    plain(text(message) ?? "It gave no reason."),
    `The page is at **${plain(page.host)}**:`,
    `\`\`\`\n${page.url}\n\`\`\``,
    ...(page.warning ? [page.warning] : []),
    `**${plain(name)}** sent this link. What you do on the page stays there: your Bot Server does not read it, and no model does. Come back when you are done.`,
  ].join("\n\n");
}
