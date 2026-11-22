import { z } from "zod";
import { defineTool, type Tool } from "../../agent/tool.ts";
import type { TurnContext } from "../../agent/turns.ts";

/**
 * Link schemes a card may open. `https` opens an app by its universal link where the app is
 * installed and the web page where it is not; the others are the forms the skill names. A
 * script, a file or the app's own scheme is never one of them.
 */
export const OPENS = new Set([
  "https:",
  "http:",
  "tel:",
  "sms:",
  "mailto:",
  "facetime:",
  "facetime-audio:",
  "shortcuts:",
  "app-settings:",
]);

/** The app's own address for a call or a message the phone puts together from its contacts. */
export const PHONE_ACTION = "wizardsbot://";

/** A query with spaces as `%20`: a phone reads every value as it was written, `+` included. */
const query = (params: URLSearchParams): string => params.toString().replaceAll("+", "%20");

/** Whether a card may open this link. */
export function opens(link: string): boolean {
  try {
    return OPENS.has(new URL(link).protocol);
  } catch {
    return false;
  }
}

/** The tools of the app-links skill: each puts a card the person taps; nothing happens by itself. */
export function appLinkTools(context: TurnContext): Tool[] {
  const { home, agent, conversationId, draft } = context;
  const card = (title: string, url: string, body: string): string => {
    const made = home.store.createCard(
      { kind: "info", level: "update", title, body, url, actions: [] },
      { agentId: agent.id, conversationId, messageId: draft.id },
    );
    draft.add({ type: "card", card: made });
    return "The card is in the chat. The person taps it on their phone; you do not learn whether they did.";
  };
  return [
    defineTool({
      name: "link_open",
      description:
        "Show a card that opens a link on the person's phone when they tap it: directions in a maps app, a chat, music, a shortcut, a web page. Use the link forms of the app-links skill.",
      input: z.object({
        url: z.string().max(2000),
        title: z
          .string()
          .max(120)
          .describe("What tapping does, e.g. Directions to the station in Apple Maps."),
      }),
      label: (input) => String(input.title ?? "Making a link"),
      run: async (input) => {
        if (!opens(input.url))
          return `A card does not open ${input.url.split(":")[0]} links. Use one of the forms of the app-links skill.`;
        return card(input.title, input.url, "");
      },
    }),
    defineTool({
      name: "call_start",
      description:
        "Show a card that starts a call from the person's phone when they tap it. Give a name from their contacts or a number; the phone finds the number, and the contact stays on the phone.",
      input: z.object({
        to: z.string().min(1).max(120).describe("A name as it is in the contacts, or a number."),
      }),
      label: (input) => `Call ${String(input.to ?? "")}`,
      run: async (input) =>
        card(
          `Call ${input.to}`,
          `${PHONE_ACTION}call?${query(new URLSearchParams({ to: input.to }))}`,
          "Your phone finds the number in your contacts and calls only when you tap Call.",
        ),
    }),
    defineTool({
      name: "message_draft",
      description:
        "Show a card that opens a written message on the person's phone, ready to send: by Messages, by mail or by WhatsApp. The person reads it and sends it; the phone finds the recipient in its contacts.",
      input: z.object({
        to: z
          .string()
          .min(1)
          .max(120)
          .describe("A name as it is in the contacts, a number or an address."),
        text: z.string().min(1).max(4000),
        via: z.enum(["messages", "mail", "whatsapp"]),
        subject: z.string().max(200).optional().describe("For mail."),
      }),
      label: (input) => `Writing to ${String(input.to ?? "")}`,
      run: async (input) => {
        const params = new URLSearchParams({ to: input.to, via: input.via, text: input.text });
        if (input.subject) params.set("subject", input.subject);
        const by = { messages: "Messages", mail: "Mail", whatsapp: "WhatsApp" }[input.via];
        const quoted = input.text
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n");
        return card(
          `Message to ${input.to} in ${by}`,
          `${PHONE_ACTION}message?${query(params)}`,
          `${input.subject ? `**${input.subject}**\n\n` : ""}${quoted}\n\nYour phone opens it ready to send. You read it and send it.`,
        );
      },
    }),
  ];
}
