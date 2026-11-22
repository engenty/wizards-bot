import type { ChannelAdapter } from "./channels.ts";
import { email } from "./email.ts";
import { signal } from "./signal.ts";
import { slack } from "./slack.ts";
import { slackMastra } from "./slack-mastra.ts";
import { whatsapp } from "./whatsapp.ts";

/**
 * The channels a home can set up, in the order the agent names them. Slack exists twice
 * while it moves to Mastra's channels: `WIZARDS_BOT_SLACK=mastra` picks the new transport,
 * until it has run against a real Slack and the home's own adapter goes.
 */
export const ADAPTERS: ChannelAdapter[] = [
  process.env.WIZARDS_BOT_SLACK === "mastra" ? slackMastra : slack,
  email,
  whatsapp,
  signal,
];
