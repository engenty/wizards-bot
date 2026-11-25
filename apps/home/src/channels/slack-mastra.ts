import { createSlackAdapter } from "@chat-adapter/slack";
import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { Actions, Button, Card, CardText, type Chat, ConsoleLogger } from "chat";
import {
  type ChannelAdapter,
  type ChannelContext,
  cardsAsText,
  type Outgoing,
} from "./channels.ts";
import { cardAnswer, slack } from "./slack.ts";

// Slack over Mastra's channels (the Chat SDK's Slack adapter, in Socket Mode). Mastra is the
// transport only: the handlers below replace its own, so a message goes to the home's one
// conversation, only the person is heard, and a card is the home's card with its buttons.

export interface SlackMastraOptions {
  /** Slack's Web API address, ending in a slash. Tests point it at a local server. */
  api?: string;
}

interface Running {
  sdk: Chat;
  stop: () => Promise<void>;
}

/** The agent Mastra's channels hang on. It never answers: every handler is the home's. */
const NO_MODEL = {
  specificationVersion: "v3",
  provider: "none",
  modelId: "none",
  supportedUrls: {},
  doStream: async () => {
    throw new Error("The Slack transport has no model.");
  },
  doGenerate: async () => {
    throw new Error("The Slack transport has no model.");
  },
};

/** A Slack DM as the Chat SDK names it, without the message a button sat on. */
const dmOf = (threadId: string): string => `${threadId.split(":").slice(0, 2).join(":")}:`;

export function slackMastraAdapter(options: SlackMastraOptions = {}): ChannelAdapter {
  let running: Running | undefined;

  async function start(
    settings: Record<string, string>,
    context: ChannelContext,
  ): Promise<() => void> {
    await running?.stop();
    running = undefined;
    const logger = new ConsoleLogger("silent");
    const adapter = createSlackAdapter({
      mode: "socket",
      appToken: settings.appToken,
      botToken: settings.botToken,
      logger,
      ...(options.api ? { apiUrl: options.api } : {}),
    });
    const heard = async (
      thread: { id: string; isDM?: boolean },
      message: {
        text?: string;
        author?: { userId: string; isMe?: boolean; isBot?: boolean | "unknown" };
      },
    ): Promise<void> => {
      const author = message.author;
      if (!author || author.isMe || author.isBot === true || !thread.isDM) return;
      const text = (message.text ?? "").trim();
      if (text) context.receive({ from: author.userId, peer: thread.id, text });
    };
    const transport = new Agent({
      id: "slack-transport",
      name: "Slack",
      instructions: "",
      model: NO_MODEL as never,
      channels: {
        adapters: { slack: adapter },
        chatOptions: { logger },
        handlers: {
          onDirectMessage: heard,
          onSubscribedMessage: heard,
          onMention: false,
          onSlashCommand: false,
          onAction: async (event: {
            actionId: string;
            value?: string;
            threadId: string;
            messageId: string;
            user: { userId: string };
            adapter: {
              editMessage(threadId: string, messageId: string, message: unknown): Promise<unknown>;
            };
          }) => {
            const answer = cardAnswer(event.actionId);
            if (!answer) return;
            context.receive({
              from: event.user.userId,
              peer: dmOf(event.threadId),
              text: "",
              answer,
            });
            // The buttons go, so the choice shows and cannot be pressed twice.
            await event.adapter
              .editMessage(event.threadId, event.messageId, {
                markdown: `You chose “${event.value ?? answer.action}”.`,
              })
              .catch(() => {});
          },
        },
      } as never,
    });
    const mastra = new Mastra({ agents: { transport }, logger: false });
    const channels = transport.getChannels();
    if (!channels) throw new Error("Slack could not be set up");
    try {
      await channels.initialize(mastra as never);
    } catch (error) {
      await adapter.disconnect().catch(() => {});
      throw new Error(`Slack did not accept the tokens (${(error as Error).message})`);
    }
    const sdk = channels.sdk as Chat | null;
    if (!sdk) throw new Error("Slack could not be set up");
    running = {
      sdk,
      stop: async () => {
        await sdk.shutdown().catch(() => {});
        await adapter.disconnect().catch(() => {});
      },
    };
    context.log("Connected over Mastra's channels (Socket Mode).");
    const mine = running;
    return () => {
      if (running === mine) running = undefined;
      void mine.stop();
    };
  }

  async function send(
    _settings: Record<string, string>,
    peer: string,
    out: Outgoing,
  ): Promise<void> {
    if (!running) throw new Error("Slack is not connected");
    const thread = running.sdk.thread(peer);
    const withButtons = out.cards.filter((card) => card.actions.length && !card.fields?.length);
    const asText = out.cards.filter((card) => !withButtons.includes(card));
    const text = [out.text, asText.length ? cardsAsText(asText, out.lang) : ""]
      .filter(Boolean)
      .join("\n\n");
    if (text) await thread.post({ markdown: text });
    for (const card of withButtons) {
      await thread.post(
        Card({
          title: card.title,
          children: [
            ...(card.body ? [CardText(card.body)] : []),
            Actions(
              card.actions.map((action) =>
                Button({
                  id: `card:${card.id}:${action.id}`,
                  label: action.label,
                  value: action.label,
                  ...(action.style === "plain" ? {} : { style: action.style }),
                }),
              ),
            ),
          ],
        }),
      );
    }
  }

  return { id: "slack", label: slack.label, setup: slack.setup, start, send };
}

export const slackMastra = slackMastraAdapter();
