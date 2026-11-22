import type { Card } from "@wizards-bot/protocol";
import WebSocket from "ws";
import {
  type ChannelAdapter,
  type ChannelContext,
  cardsAsText,
  type Outgoing,
} from "./channels.ts";

// Slack over Socket Mode: the home opens a WebSocket to Slack and Slack sends everything
// through it, so the home needs no public address. The agent is a Slack app of its own, and
// the person writes to it in a direct message.

const API = "https://slack.com/api";
/** Slack takes at most this many characters in the text of one section. */
const SECTION_LIMIT = 3000;
const BUTTON_LIMIT = 75;
const BUTTONS_PER_CARD = 25;
const HELLO_TIMEOUT = 15_000;
const HEARTBEAT = 30_000;
const LONGEST_WAIT = 60_000;

/** What the person pastes at api.slack.com/apps. Everything the adapter uses is in it. */
const MANIFEST = {
  display_information: { name: "wizards.bot" },
  features: {
    app_home: { messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    bot_user: { display_name: "wizards.bot", always_online: true },
  },
  oauth_config: { scopes: { bot: ["chat:write", "im:history", "im:read", "im:write"] } },
  settings: {
    event_subscriptions: { bot_events: ["message.im"] },
    interactivity: { is_enabled: true },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
};

const SETUP = `Your agent gets its own Slack app. You write to it in a direct message.

1. Open [api.slack.com/apps](https://api.slack.com/apps) and choose “Create New App”, then “From a manifest”.
2. Choose your workspace, paste this manifest and create the app.

\`\`\`json
${JSON.stringify(MANIFEST, null, 2)}
\`\`\`

3. On “Basic Information”, find “App-Level Tokens” and generate a token with the scope \`connections:write\`. It starts with \`xapp-\`.
4. On “Install App”, install the app to your workspace. Then copy the “Bot User OAuth Token”. It starts with \`xoxb-\`.
5. Enter both tokens here.

After that you find the app in Slack under “Apps”.`;

export interface SlackOptions {
  /** Where Slack's Web API is. Tests point it at a local server. */
  api?: string;
  /** The first wait before a new try to connect, in milliseconds. It doubles up to a minute. */
  retry?: number;
}

interface Block {
  type: string;
  block_id?: string;
  [key: string]: unknown;
}

interface MessageEvent {
  type?: string;
  channel_type?: string;
  channel?: string;
  user?: string;
  text?: string;
  subtype?: string;
  bot_id?: string;
}

interface Action {
  action_id?: string;
  text?: { text?: string };
}

/** One frame Slack sends through the socket. */
interface Envelope {
  type?: string;
  envelope_id?: string;
  reason?: string;
  payload?: {
    type?: string;
    event?: MessageEvent;
    user?: { id?: string };
    channel?: { id?: string };
    actions?: Action[];
    response_url?: string;
    message?: { text?: string; blocks?: Block[] };
  };
}

export function slackAdapter(options: SlackOptions = {}): ChannelAdapter {
  const api = options.api ?? API;
  const firstWait = options.retry ?? 1000;

  return {
    id: "slack",
    label: "Slack",
    setup: {
      body: SETUP,
      fields: [
        {
          id: "appToken",
          label: "App-level token",
          type: "secret",
          placeholder: "xapp-…",
          required: true,
        },
        {
          id: "botToken",
          label: "Bot token",
          type: "secret",
          placeholder: "xoxb-…",
          required: true,
        },
      ],
    },

    async start(settings, context) {
      const { appToken = "", botToken = "" } = settings;
      if (!appToken.startsWith("xapp-")) {
        throw new Error(
          "The app-level token starts with xapp-. Copy it again from “Basic Information”",
        );
      }
      if (!botToken.startsWith("xoxb-")) {
        throw new Error("The bot token starts with xoxb-. Copy it again from “Install App”");
      }
      const self = await call<{ user_id?: string }>(api, "auth.test", botToken).catch((error) => {
        throw new Error(`Slack did not accept the bot token: ${reason(error)}`);
      });

      let stopped = false;
      let current: WebSocket | undefined;
      let opening: Promise<void> | undefined;
      let timer: NodeJS.Timeout | undefined;
      let attempt = 0;

      // Opens a new socket and resolves once Slack said hello on it. The socket before stays
      // open until then, so nothing is lost while Slack moves the home to a new one.
      const connect = async (): Promise<void> => {
        const { url } = await call<{ url: string }>(api, "apps.connections.open", appToken);
        const socket = new WebSocket(url);
        let alive = true;
        const heartbeat = setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN) return;
          if (!alive) return socket.terminate();
          alive = false;
          socket.ping();
        }, HEARTBEAT);
        socket.on("pong", () => {
          alive = true;
        });
        // A close always follows an error, and the close starts the new try.
        socket.on("error", () => {});

        await new Promise<void>((resolve, reject) => {
          const late = setTimeout(() => socket.terminate(), HELLO_TIMEOUT);
          socket.on("close", () => {
            clearTimeout(late);
            clearInterval(heartbeat);
            reject(new Error("Slack closed the connection"));
            if (socket === current) retry();
          });
          socket.on("message", (data) => {
            alive = true;
            const envelope = parse(data.toString());
            if (envelope.type === "hello") {
              clearTimeout(late);
              if (stopped) return socket.close();
              const before = current;
              current = socket;
              attempt = 0;
              before?.close();
              resolve();
            } else if (envelope.type === "disconnect") {
              // Slack announces that it closes this socket soon. With Socket Mode switched
              // off there is no new one to get, and the close leads to the slow retries.
              if (socket !== current) return;
              if (envelope.reason === "link_disabled") {
                context.log("Socket Mode is switched off for the Slack app.");
              } else {
                open().catch(() => retry());
              }
            } else if (envelope.envelope_id) {
              // Slack sends again what is not acknowledged.
              socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
              handle(envelope, self.user_id, context);
            }
          });
        });
      };

      const open = (): Promise<void> => {
        opening ??= connect().finally(() => {
          opening = undefined;
        });
        return opening;
      };

      const retry = (): void => {
        if (stopped || timer) return;
        const wait = Math.min(firstWait * 2 ** attempt++, LONGEST_WAIT);
        timer = setTimeout(() => {
          timer = undefined;
          if (stopped || current?.readyState === WebSocket.OPEN) return;
          open().catch((error) => {
            context.log(`Slack is out of reach: ${reason(error)}`);
            retry();
          });
        }, wait);
      };

      await open().catch((error) => {
        stopped = true;
        throw new Error(
          `Slack did not open a connection for the app-level token: ${reason(error)}`,
        );
      });

      return () => {
        stopped = true;
        clearTimeout(timer);
        current?.close();
      };
    },

    async send(settings, peer, out) {
      const text = mrkdwn([out.text, cardsAsText(out.cards)].filter(Boolean).join("\n\n"));
      // With blocks, Slack shows `text` in the notification only.
      const body = out.cards.some(hasButtons)
        ? { channel: peer, text, blocks: blocks(out) }
        : { channel: peer, text };
      await call(api, "chat.postMessage", settings.botToken ?? "", body);
    },
  };
}

export const slack = slackAdapter();

/** Hands a message of the person, or a pressed button, to the home. */
function handle(envelope: Envelope, self: string | undefined, context: ChannelContext): void {
  const payload = envelope.payload;
  if (envelope.type === "events_api") {
    const event = payload?.event;
    if (event?.type !== "message" || event.channel_type !== "im") return;
    // Edits, joins and files carry a subtype, apps a bot id.
    if (event.subtype || event.bot_id || !event.user || !event.text || event.user === self) return;
    context.receive({ from: event.user, peer: event.channel, text: plainText(event.text) });
  }
  if (envelope.type === "interactive" && payload?.type === "block_actions") {
    const from = payload.user?.id;
    for (const action of payload.actions ?? []) {
      const answer = cardAnswer(action.action_id ?? "");
      if (!from || !answer) continue;
      context.receive({ from, peer: payload.channel?.id, text: "", answer });
      void settle(payload, answer.cardId, action).catch((error) => {
        context.log(`Could not take the buttons off a message: ${reason(error)}`);
      });
    }
  }
}

/** Swaps a card's buttons for the choice, so the message shows what was pressed. */
async function settle(
  payload: NonNullable<Envelope["payload"]>,
  cardId: string,
  action: Action,
): Promise<void> {
  const blocks = payload.message?.blocks;
  if (!payload.response_url || !blocks) return;
  const chosen: Block = {
    type: "context",
    elements: [{ type: "mrkdwn", text: `You chose “${entities(action.text?.text ?? "")}”.` }],
  };
  const response = await fetch(payload.response_url, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      replace_original: "true",
      text: payload.message?.text ?? "",
      blocks: blocks.map((block) => (block.block_id === `card:${cardId}` ? chosen : block)),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

/** Calls a method of Slack's Web API. Throws Slack's own word for what went wrong. */
async function call<T>(api: string, method: string, token: string, body?: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${api}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": body
          ? "application/json; charset=utf-8"
          : "application/x-www-form-urlencoded",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    // Slack says how long to wait when the home sends too fast.
    if (response.status === 429 && attempt === 0) {
      const seconds = Number(response.headers.get("retry-after")) || 1;
      await new Promise((resolve) => setTimeout(resolve, Math.min(seconds, 30) * 1000));
      continue;
    }
    const answer = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!answer.ok) throw new Error(answer.error ?? `HTTP ${response.status}`);
    return answer as T;
  }
}

function parse(frame: string): Envelope {
  try {
    return JSON.parse(frame) as Envelope;
  } catch {
    return {};
  }
}

const reason = (error: unknown): string => (error as Error)?.message ?? String(error);

/** A card Slack can show with buttons. One with fields is answered in the app. */
const hasButtons = (card: Card): boolean => card.actions.length > 0 && !card.fields?.length;

/** The card and action a button stands for, from its `card:<cardId>:<actionId>`. */
export function cardAnswer(actionId: string): { cardId: string; action: string } | undefined {
  const match = /^card:([^:]+):(.+)$/.exec(actionId);
  return match ? { cardId: match[1] as string, action: match[2] as string } : undefined;
}

/** A message as Block Kit: the text, then each card with its buttons under it. */
export function blocks(out: Outgoing): Block[] {
  const section = (text: string): Block => ({ type: "section", text: { type: "mrkdwn", text } });
  const list: Block[] = chunks(mrkdwn(out.text), SECTION_LIMIT).map(section);
  for (const card of out.cards) {
    if (!hasButtons(card)) {
      list.push(...chunks(mrkdwn(cardsAsText([card])), SECTION_LIMIT).map(section));
      continue;
    }
    const about = [`*${entities(card.title)}*`, mrkdwn(card.body ?? ""), entities(card.url ?? "")];
    list.push(section(about.filter(Boolean).join("\n").slice(0, SECTION_LIMIT)));
    list.push({
      type: "actions",
      block_id: `card:${card.id}`,
      elements: card.actions.slice(0, BUTTONS_PER_CARD).map((action) => ({
        type: "button",
        text: { type: "plain_text", text: action.label.slice(0, BUTTON_LIMIT) },
        action_id: `card:${card.id}:${action.id}`,
        value: action.id,
        ...(action.style === "plain" ? {} : { style: action.style }),
      })),
    });
  }
  return list;
}

/** Slack reads these three characters as markup. */
const entities = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** Markdown as Slack's own markup. Code stays as it is. */
export function mrkdwn(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, index) => {
      if (index % 2) return entities(part);
      return (
        part
          .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "\uE000$2\uE001$1\uE002")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          // A `>` at the start of a line is a quote in both markups.
          .replace(/(?<!^[ \t]*)>/gm, "&gt;")
          .replace(/\uE000(.*?)\uE001(.*?)\uE002/g, "<$1|$2>")
          .replace(
            /^#{1,6}[ \t]+(.+?)[ \t]*$/gm,
            (_, title: string) => `\uE000${title.replace(/\*\*|__/g, "")}\uE000`,
          )
          .replace(/\*\*(.+?)\*\*|__(.+?)__/g, "\uE000$1$2\uE000")
          .replace(/(?<![*\w])\*(?![\s*])(.+?)(?<![\s*])\*(?![*\w])/g, "_$1_")
          .replaceAll("\uE000", "*")
          .replace(/~~(.+?)~~/g, "~$1~")
          .replace(/^([ \t]*)[-*][ \t]+/gm, "$1• ")
      );
    })
    .join("");
}

/** What the person typed, without Slack's wrapping of links and its escapes. */
export function plainText(text: string): string {
  return text
    .replace(/<((?:https?:\/\/|mailto:)[^|>]+)(?:\|[^>]*)?>/g, (_, target: string) =>
      target.replace(/^mailto:/, ""),
    )
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** Cuts a long text into pieces, at a line break where there is one. */
function chunks(text: string, limit: number): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const cut = rest.lastIndexOf("\n", limit);
    const at = cut > limit / 2 ? cut : limit;
    parts.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}
