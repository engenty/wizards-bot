import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Card } from "@wizards-bot/protocol";
import { type ChannelAdapter, cardsAsText, type Incoming } from "./channels.ts";

// WhatsApp over Meta's Cloud API: the agent has a business number. The home sends through
// the Graph API, and Meta calls the home's webhook when the person writes, so the home needs
// its public address.

const GRAPH = "https://graph.facebook.com";
/** The Graph API version every call names. */
const GRAPH_VERSION = "v27.0";
const WEBHOOK = "/channels/whatsapp/webhook";
const TEXT_LIMIT = 4096;
/** The text above reply buttons is shorter than a text message. */
const BODY_LIMIT = 1024;
const BUTTON_LIMIT = 20;
const BUTTONS = 3;
/** How many message ids the home remembers to drop a second delivery. */
const REMEMBERED = 1000;

const SETUP = `Your agent gets a WhatsApp business number from Meta. Meta calls your home when you write, so your home needs its public address.

1. Open [developers.facebook.com/apps](https://developers.facebook.com/apps) and create an app with the use case “Connect with customers through WhatsApp”.
2. In the app, open “API Setup” and copy the phone number ID of the number your agent uses.
3. Create an access token. The one from “Generate access token” expires quickly. A system user's token from your business settings stays valid. It needs the permissions \`business_management\`, \`whatsapp_business_messaging\` and \`whatsapp_business_management\`.
4. Open “App settings”, then “Basic”, and copy the app secret.
5. Choose a verify token. Any word works.
6. Enter the four values here and connect.

Then tell Meta where your home is:

7. In the app, open “Configuration” under WhatsApp. Enter \`{home}${WEBHOOK}\` as the callback URL and your verify token.
8. Subscribe to the webhook field \`messages\`.

WhatsApp lets your agent write to you for 24 hours after your last message. After that it can answer only when you write again.`;

export interface WhatsAppOptions {
  /** Where the Graph API is. Tests point it at a local server. */
  graph?: string;
}

interface WhatsAppMessage {
  /** The sender's number in digits. Missing when the person shows WhatsApp a username only. */
  from?: string;
  from_user_id?: string;
  id?: string;
  type?: string;
  text?: { body?: string };
  interactive?: { type?: string; button_reply?: { id?: string; title?: string } };
}

/** What Meta posts to the webhook. */
interface Notification {
  object?: string;
  entry?: {
    changes?: {
      field?: string;
      value?: { metadata?: { phone_number_id?: string }; messages?: WhatsAppMessage[] };
    }[];
  }[];
}

export function whatsappAdapter(options: WhatsAppOptions = {}): ChannelAdapter {
  const graph = `${options.graph ?? GRAPH}/${GRAPH_VERSION}`;
  // Meta delivers a message again when the home answered late.
  const delivered = new Set<string>();

  const firstDelivery = (id: string | undefined): boolean => {
    if (!id) return true;
    if (delivered.has(id)) return false;
    delivered.add(id);
    if (delivered.size > REMEMBERED) delivered.delete(delivered.values().next().value as string);
    return true;
  };

  return {
    id: "whatsapp",
    label: "WhatsApp",
    beforeClaim:
      "WhatsApp delivers it only after the webhook address and the verify token are entered at Meta, as the card's steps say.",
    setup: {
      body: SETUP,
      fields: [
        { id: "phoneNumberId", label: "Phone number ID", type: "text", required: true },
        { id: "accessToken", label: "Access token", type: "secret", required: true },
        { id: "appSecret", label: "App secret", type: "secret", required: true },
        {
          id: "verifyToken",
          label: "Verify token (any word you choose)",
          type: "text",
          required: true,
        },
      ],
    },

    // Nothing listens here: the messages arrive at the webhook. Start only checks the values.
    async start(settings, context) {
      const labels: Record<string, string> = {
        phoneNumberId: "phone number ID",
        accessToken: "access token",
        appSecret: "app secret",
        verifyToken: "verify token",
      };
      for (const [id, label] of Object.entries(labels)) {
        if (!settings[id]) throw new Error(`The ${label} is missing`);
      }
      if (!context.publicUrl) {
        throw new Error("Meta has to reach your home, and your home has no public address yet");
      }
      await call(
        `${graph}/${settings.phoneNumberId}?fields=display_phone_number`,
        settings.accessToken ?? "",
      ).catch((error) => {
        throw new Error(
          `Meta did not accept the phone number ID and the access token: ${(error as Error).message}`,
        );
      });
      return () => {};
    },

    async send(settings, peer, out) {
      const post = (message: Record<string, unknown>): Promise<void> =>
        call(`${graph}/${settings.phoneNumberId}/messages`, settings.accessToken ?? "", {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          ...recipient(peer),
          ...message,
        });
      const text = (body: string) => ({ type: "text", text: { body } });

      const card = out.cards.length === 1 ? out.cards[0] : undefined;
      if (!card || !hasButtons(card)) {
        const whole = [out.text, cardsAsText(out.cards)].filter(Boolean).join("\n\n");
        for (const part of chunks(whole, TEXT_LIMIT)) await post(text(part));
        return;
      }
      const about = [card.title, card.body, card.url].filter(Boolean).join("\n\n");
      const whole = [out.text, about].filter(Boolean).join("\n\n");
      // A long message goes ahead as text, and the card follows with its buttons.
      const fits = whole.length <= BODY_LIMIT;
      if (!fits) for (const part of chunks(out.text, TEXT_LIMIT)) await post(text(part));
      await post({
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: fits ? whole : cut(about, BODY_LIMIT) },
          action: {
            buttons: card.actions.map((action) => ({
              type: "reply",
              reply: { id: `card:${card.id}:${action.id}`, title: cut(action.label, BUTTON_LIMIT) },
            })),
          },
        },
      });
    },

    routes(app, channels) {
      // Meta checks the address once, when the person enters it in the app's settings.
      app.get(WEBHOOK, (c) => {
        const expected = channels.settings("whatsapp")?.verifyToken;
        const given = c.req.query("hub.verify_token") ?? "";
        if (!expected || c.req.query("hub.mode") !== "subscribe" || !same(given, expected)) {
          return c.text("Forbidden", 403);
        }
        return c.text(c.req.query("hub.challenge") ?? "");
      });

      app.post(WEBHOOK, async (c) => {
        const settings = channels.settings("whatsapp");
        // Meta signs the bytes it sends, so the signature is checked before anything reads them.
        const raw = Buffer.from(await c.req.arrayBuffer());
        if (
          !settings?.appSecret ||
          !signed(raw, c.req.header("x-hub-signature-256"), settings.appSecret)
        ) {
          return c.text("Unauthorized", 401);
        }
        let notification: Notification;
        try {
          notification = JSON.parse(raw.toString("utf8")) as Notification;
        } catch {
          return c.text("Bad Request", 400);
        }
        for (const message of messages(notification, settings.phoneNumberId ?? "")) {
          const incoming = firstDelivery(message.id) ? incomingMessage(message) : undefined;
          if (incoming) channels.receive("whatsapp", incoming);
        }
        return c.text("OK");
      });
    },
  };
}

export const whatsapp = whatsappAdapter();

/** The messages of a notification that went to the agent's number. */
function messages(notification: Notification, phoneNumberId: string): WhatsAppMessage[] {
  if (notification.object !== "whatsapp_business_account") return [];
  return (notification.entry ?? [])
    .flatMap((entry) => entry.changes ?? [])
    .filter(
      (change) =>
        change.field === "messages" && change.value?.metadata?.phone_number_id === phoneNumberId,
    )
    .flatMap((change) => change.value?.messages ?? []);
}

/** A text or a pressed button. Pictures, voice messages and the rest are dropped. */
function incomingMessage(message: WhatsAppMessage): Incoming | undefined {
  const from = message.from ?? message.from_user_id;
  if (!from) return undefined;
  if (message.type === "text" && message.text?.body) return { from, text: message.text.body };
  if (message.type === "interactive" && message.interactive?.type === "button_reply") {
    const match = /^card:([^:]+):(.+)$/.exec(message.interactive.button_reply?.id ?? "");
    if (match)
      return { from, text: "", answer: { cardId: match[1] as string, action: match[2] as string } };
  }
  return undefined;
}

/** A number goes into `to`. A person without a visible number is reached by their user id. */
function recipient(peer: string): { to: string } | { recipient: string } {
  return /^\d+$/.test(peer) ? { to: `+${peer}` } : { recipient: peer };
}

/** A card WhatsApp can show with reply buttons: up to three, each with a label of its own. */
function hasButtons(card: Card): boolean {
  if (card.fields?.length || card.actions.length < 1 || card.actions.length > BUTTONS) return false;
  const titles = card.actions.map((action) => cut(action.label, BUTTON_LIMIT));
  return titles.every(Boolean) && new Set(titles).size === titles.length;
}

/** Calls the Graph API. Throws Meta's own sentence for what went wrong. */
async function call(url: string, token: string, body?: unknown): Promise<void> {
  const response = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (response.ok) return;
  const answer = (await response.json().catch(() => undefined)) as
    | { error?: { message?: string } }
    | undefined;
  throw new Error(answer?.error?.message ?? `HTTP ${response.status}`);
}

/** Whether `header` is Meta's signature of `raw`: `sha256=` and the HMAC with the app secret. */
function signed(raw: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  return same(
    header.slice("sha256=".length),
    createHmac("sha256", appSecret).update(raw).digest("hex"),
  );
}

/** Compares two secrets in the same time, whatever they are. */
function same(a: string, b: string): boolean {
  const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

const cut = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;

/** Cuts a long text into pieces, at a line break where there is one. */
function chunks(text: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const at = rest.lastIndexOf("\n", limit);
    const end = at > limit / 2 ? at : limit;
    parts.push(rest.slice(0, end).trimEnd());
    rest = rest.slice(end).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}
