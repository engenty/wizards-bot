import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { type ChannelAdapter, type ChannelContext, cardsAsText } from "./channels.ts";

// Signal through signal-cli: the program runs beside the home, holds the agent's number and
// speaks HTTP on this computer. New messages come as server-sent events, and the home sends
// with a JSON-RPC call.

const DAEMON = "http://127.0.0.1:8080";
const LONGEST_WAIT = 60_000;

const SETUP = `Your agent gets its own Signal number. The program signal-cli holds that number and runs beside your Bot Server.

1. Install [signal-cli](https://github.com/AsamK/signal-cli) on the computer your Bot Server runs on.
2. Register a number for the agent with signal-cli. Use a number that is not your own Signal number. The signal-cli page shows how.
3. Start signal-cli with the agent's number and leave it running:

\`\`\`
signal-cli -a +491701234567 daemon --http 127.0.0.1:8080
\`\`\`

4. Enter the agent's number here, with the country code. Change the address only if signal-cli runs somewhere else.`;

export interface SignalOptions {
  /** The first wait before a new try to connect, in milliseconds. It doubles up to a minute. */
  retry?: number;
}

/** One event of signal-cli's stream. */
interface SignalEvent {
  envelope?: {
    sourceNumber?: string | null;
    /** Who wrote, when the person does not show Signal their number. */
    sourceUuid?: string | null;
    dataMessage?: { message?: string | null; groupInfo?: unknown };
  };
}

function accountOf(settings: Record<string, string>): { url: string; number: string } {
  const url = (settings.url || DAEMON).replace(/\/+$/, "");
  const number = (settings.number ?? "").replace(/[\s()-]/g, "");
  if (!/^\+\d{6,15}$/.test(number)) {
    throw new Error("The agent's number starts with + and the country code, as in +491701234567");
  }
  if (!URL.canParse(url))
    throw new Error("The address of signal-cli is not a web address, as in http://127.0.0.1:8080");
  return { url, number };
}

export function signalAdapter(options: SignalOptions = {}): ChannelAdapter {
  const firstWait = options.retry ?? 1000;

  return {
    id: "signal",
    label: "Signal",
    setup: {
      body: SETUP,
      fields: [
        {
          id: "number",
          label: "The agent's number",
          type: "text",
          placeholder: "e.g. +491701234567",
          required: true,
        },
        { id: "url", label: "Address of signal-cli", type: "text", placeholder: DAEMON },
      ],
    },

    async start(settings, context) {
      const { url, number } = accountOf(settings);
      const stopped = new AbortController();
      /** The id of the last event. A new connection asks for what came after it. */
      let last: string | undefined;

      const stream = (): Promise<Response> =>
        fetch(`${url}/api/v1/events?account=${encodeURIComponent(number)}`, {
          headers: { accept: "text/event-stream", ...(last ? { "last-event-id": last } : {}) },
          signal: stopped.signal,
        });

      const command = `signal-cli -a ${number} daemon --http ${new URL(url).host}`;
      const silent = `signal-cli does not answer at ${url}. Start it with “${command}”, then connect again`;
      const check = await fetch(`${url}/api/v1/check`, { signal: AbortSignal.timeout(5000) }).catch(
        () => undefined,
      );
      if (!check?.ok) throw new Error(silent);
      let response = await stream().catch(() => undefined);
      if (!response?.ok) {
        stopped.abort();
        // signal-cli answers 400 for a number it holds no account for.
        if (response?.status !== 400) throw new Error(silent);
        throw new Error(
          `signal-cli does not know the number ${number}. Register it with signal-cli first`,
        );
      }

      const listen = async (): Promise<void> => {
        let attempt = 0;
        while (!stopped.signal.aborted) {
          try {
            response ??= await stream();
            if (!response.ok || !response.body) {
              void response.body?.cancel();
              throw new Error(`HTTP ${response.status}`);
            }
            attempt = 0;
            for await (const event of events(response.body)) {
              if (event.id) last = event.id;
              if (event.data) hear(event.data, number, context);
            }
          } catch (error) {
            if (stopped.signal.aborted) return;
            context.log(`signal-cli is out of reach: ${(error as Error).message}`);
          }
          response = undefined;
          const wait = Math.min(firstWait * 2 ** attempt++, LONGEST_WAIT);
          await sleep(wait, undefined, { signal: stopped.signal }).catch(() => {});
        }
      };
      void listen();

      return () => stopped.abort();
    },

    async send(settings, peer, out) {
      const { url, number } = accountOf(settings);
      const message = [out.text, cardsAsText(out.cards)].filter(Boolean).join("\n\n");
      const response = await fetch(`${url}/api/v1/rpc`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: randomUUID(),
          method: "send",
          params: { account: number, recipient: [peer], message },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const answer = (await response.json().catch(() => undefined)) as
        | { error?: { message?: string } }
        | undefined;
      if (!response.ok || !answer || answer.error)
        throw new Error(answer?.error?.message ?? `HTTP ${response.status}`);
    },
  };
}

export const signal = signalAdapter();

/** Hands a text the person sent to the agent alone to the home. */
function hear(data: string, own: string, context: ChannelContext): void {
  let event: SignalEvent;
  try {
    event = JSON.parse(data) as SignalEvent;
  } catch {
    return;
  }
  const envelope = event.envelope;
  const text = envelope?.dataMessage?.message;
  const from = envelope?.sourceNumber ?? envelope?.sourceUuid;
  // Receipts, typing marks and what the agent's own devices sent carry no text of a person.
  // A text in a group is not said to the agent.
  if (!text || !from || from === own || envelope?.dataMessage?.groupInfo) return;
  context.receive({ from, text });
}

/** The events of a server-sent event stream. Lines that start with a colon keep it alive. */
async function* events(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ id?: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = "";
  let id: string | undefined;
  let data: string[] = [];
  for await (const bytes of body) {
    buffer += decoder.decode(bytes, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line === "") {
        // An empty line ends an event.
        if (id !== undefined || data.length) yield { id, data: data.join("\n") };
        id = undefined;
        data = [];
        continue;
      }
      const colon = line.indexOf(":");
      if (colon === 0) continue;
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "data") data.push(value);
      if (field === "id") id = value;
    }
  }
}
