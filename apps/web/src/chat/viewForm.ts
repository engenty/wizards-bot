import { checkView } from "@engenty/chatviews/chat";

// A view's Form as its program wrote it, read with the library's own parser: the name OpenUI
// keeps its state under, and its fields with what each starts with.

export interface ViewForm {
  /** The name OpenUI keeps the form's state under: the form's statement, or "form". */
  name: string;
  /** Its fields in their order, each with the value the program gave it. */
  fields: { name: string; value: unknown }[];
}

interface Element {
  type: "element";
  typeName: string;
  props: Record<string, unknown>;
  statementId?: string;
}

const isElement = (node: unknown): node is Element =>
  Boolean(node && typeof node === "object" && (node as Element).type === "element");

/** Every element under a node, the node itself first. */
function elements(node: unknown, found: Element[] = []): Element[] {
  if (Array.isArray(node)) {
    for (const each of node) elements(each, found);
  } else if (node && typeof node === "object") {
    if (isElement(node)) found.push(node);
    for (const each of Object.values(isElement(node) ? node.props : node)) elements(each, found);
  }
  return found;
}

/** The Form of a view, if it has one. A checked view holds at most one. */
export function formOf(program: string): ViewForm | undefined {
  const root = checkView(program).parsed?.root;
  const form = elements(root).find((element) => element.typeName === "Form");
  if (!form) return undefined;
  return {
    name: form.statementId ?? "form",
    fields: elements(form.props.children)
      .filter((element) => element.typeName === "Field" && typeof element.props.name === "string")
      .map((field) => ({ name: String(field.props.name), value: field.props.value })),
  };
}

const unwrapped = (held: unknown): unknown =>
  held && typeof held === "object" && !Array.isArray(held) && "value" in held
    ? (held as { value: unknown }).value
    : held;

const empty = (value: unknown): boolean =>
  value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length);

/**
 * The form's values by field name, as the person left them: what they typed, where they typed
 * nothing what the field started with, and null where it is empty. `state` is OpenUI's, which
 * keeps only the fields that were touched.
 */
export function valuesOf(
  form: ViewForm,
  state: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const held = (state?.[form.name] ?? {}) as Record<string, unknown>;
  return Object.fromEntries(
    form.fields.map((field) => {
      const typed = unwrapped(held[field.name]);
      const value = typed === undefined ? field.value : typed;
      return [field.name, empty(value) ? null : value];
    }),
  );
}

/** Values by field name as OpenUI takes a form's state, to show a form as it was sent. */
export function stateOf(form: ViewForm, values: Record<string, unknown>): Record<string, unknown> {
  return {
    [form.name]: Object.fromEntries(
      Object.entries(values)
        .filter(([, value]) => value !== null)
        .map(([name, value]) => [name, { value }]),
    ),
  };
}
