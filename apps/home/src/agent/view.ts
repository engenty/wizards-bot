import { CHAT_LIBRARY, chatViewPrompt, checkView } from "@engenty/chatviews/chat";
import { Space } from "@wizards-bot/protocol";
import { z } from "zod";
import { runsHome } from "../group.ts";
import type { Home } from "../home.ts";
import { defineTool, type Tool } from "./tool.ts";
import type { TurnContext } from "./turns.ts";

// How an agent shows a view in a card: key figures, a list, a table, a form. The view is a
// program of @engenty/chatviews (OpenUI Lang). The library checks it and words what is wrong
// for the model; the home stores only what passed, so a device draws what was checked. A view
// never holds a tool: a button that asks the agent or a form's send answers the card, and the
// answer is the person's next message.

/** The components that show a file, and the prop of others that names one. */
const FILES = new Set(["Image", "File"]);
const FILE_PROP = "image";

/**
 * What an agent reads to write a view: the library's own prompt (the language, the components,
 * how a view is made), opened with what holds on a Bot Server.
 */
export function viewRules(person: string): string {
  return chatViewPrompt(
    [
      "Views:",
      `- A view is a card you show with \`show_view\`: key figures, a list, a table, a chart, a form. Show one when the answer is better looked at than read, and say in one sentence what it shows. A short answer stays in the chat, a text ${person} edits is a document, a page to explore or print is an artifact.`,
      `- A Button with @ToAssistant and a Form's send button answer the card: what ${person} chose or filled in arrives as their next message. A view with one of them ends your turn.`,
      "- No Image, File, Ref or @Open, and no `image` of a Row or a Card: a view on a Bot Server shows no files.",
      "- The `view` you hand to `show_view` is openui-lang code and nothing else, as described here.",
    ].join("\n"),
  );
}

/** What a view on a Bot Server may not hold, worded for the model that wrote it. */
function unfit(node: unknown, issues: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const each of node) unfit(each, issues);
  } else if (node && typeof node === "object") {
    const element = node as { type?: unknown; typeName?: unknown; props?: Record<string, unknown> };
    if (element.type === "element" && typeof element.typeName === "string") {
      const names = FILES.has(element.typeName) || typeof element.props?.[FILE_PROP] === "string";
      if (names) issues.push(`${element.typeName}: a view here shows no files. Leave it out.`);
    }
    for (const each of Object.values(node)) unfit(each, issues);
  }
  return issues;
}

/** A value of a view's form as the agent reads it. */
const shown = (value: unknown): string =>
  value === undefined || value === null || value === "" ? "(left empty)" : JSON.stringify(value);

/**
 * The values of a view's form by field name. OpenUI keeps a form's state by the form's name,
 * each field as `{ value }`; a device may send the values alone.
 */
export function formValues(state: Record<string, unknown> | undefined): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const read = (fields: Record<string, unknown>) => {
    for (const [name, held] of Object.entries(fields)) {
      if (name.startsWith("$")) continue;
      const field = held as { value?: unknown; componentType?: unknown } | null;
      if (field && typeof field === "object" && !Array.isArray(field)) {
        if ("value" in field) values[name] = field.value;
        else read(field as Record<string, unknown>);
      } else {
        values[name] = held;
      }
    }
  };
  read(state ?? {});
  return values;
}

/** A view's answer as the agent reads it: what the person said with it, and what they filled in. */
export function viewAnswer(
  title: string,
  message: string | undefined,
  state: Record<string, unknown> | undefined,
): string {
  const lines = Object.entries(formValues(state)).map(
    ([name, value]) => `- ${name}: ${shown(value)}`,
  );
  const said = message?.trim() || "(a button without a label)";
  return lines.length
    ? `${said}\n\n[home] Sent from the view "${title}". What they filled in:\n${lines.join("\n")}`
    : `${said}\n\n[home] Pressed in the view "${title}".`;
}

export function viewTool(context: TurnContext): Tool {
  const { home, agent, conversationId, draft, trigger } = context;
  return defineTool({
    name: "show_view",
    description:
      "Show a view in a card in the chat: key figures, a list, a table, a chart or a form, written in openui-lang as your instructions describe under Views. A view with a Form or a Button that asks you waits for the person and ends your turn.",
    input: z.object({
      title: z.string().min(1).describe("What the view shows, in a few words."),
      text: z
        .string()
        .min(1)
        .describe(
          "The same in plain words, with the figures that matter. Markdown. A watch or a phone that cannot draw the view shows this instead.",
        ),
      view: z.string().min(1).describe("The openui-lang code. `root = Column([...])` first."),
    }),
    silent: true,
    run: async (input) => {
      const checked = checkView(input.view);
      const issues = checked.issues.length ? checked.issues : unfit(checked.parsed?.root);
      if (issues.length)
        throw new Error(
          `The view was not shown. Correct it and call show_view again:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
        );
      const card = home.store.createCard(
        {
          kind: checked.asks ? "question" : "info",
          level: checked.asks ? "needs_you" : "update",
          title: input.title,
          body: input.text,
          view: { program: input.view, library: CHAT_LIBRARY },
          actions: [],
          payload: { type: "view", writer: trigger.writer?.id, space: trigger.space },
        },
        { agentId: agent.id, conversationId, messageId: draft.id },
      );
      draft.add({ type: "card", card });
      return checked.asks
        ? "The view is in the chat and waits for the person. End your turn now with at most one short sentence. Their answer arrives as the next message."
        : "The view is in the chat. Say in one sentence what it shows; do not repeat it in words.";
    },
  });
}

/** A view's answer is the person's message: it starts a turn, or joins the one that runs. */
export function registerViewCards(home: Home): void {
  home.onCard("view", ({ card, payload }) => {
    const { group } = home;
    // Whoever answers does not get to do more than the one the view was shown to.
    const asked = group.known(payload.writer);
    const answered = group.known(card.answer?.person?.id);
    const writer = runsHome(asked) ? (answered ?? asked) : asked;
    const text = viewAnswer(card.title, card.answer?.message, card.answer?.state);
    void home.turns.enqueue({
      conversationId: card.conversationId,
      text: writer?.name ? `${writer.name} writes:\n${text}` : text,
      channel: "app",
      writer,
      space: Space.safeParse(payload.space).data,
    });
  });
}
