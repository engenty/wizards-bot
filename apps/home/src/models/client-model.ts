import { createHash } from "node:crypto";
import {
  base64Of,
  type CallOptions,
  type ChatModel,
  generateFrom,
  type StreamPart,
  type StreamResult,
} from "./ollama.ts";
import type { ClientEvent } from "./subscription.ts";

/** One turn of an installed client. */
export interface ClientTurn {
  system: string;
  message: string;
  session: string | null;
  model: string;
  /** Opens the home's MCP endpoint for this turn. */
  mcpToken: string;
  /** Pictures that came with what the client has not read yet. */
  images?: ClientImage[];
  signal: AbortSignal;
}

export interface ClientImage {
  name: string;
  mime: string;
  base64: string;
}

export type ClientRun = (turn: ClientTurn, onEvent: (event: ClientEvent) => void) => Promise<void>;

/** Where a client's own conversation is remembered between turns. */
export interface ClientSessions {
  load(): { id: string; last: string } | null;
  save(session: { id: string; last: string }): void;
}

const digest = (text: string): string => createHash("sha256").update(text.trim()).digest("hex");

interface Said {
  role: "user" | "assistant";
  text: string;
  images: ClientImage[];
}

/** The AI SDK's prompt as the instructions and what was said, oldest first. */
export function clientPrompt(prompt: CallOptions["prompt"]): { system: string; said: Said[] } {
  const system: string[] = [];
  const said: Said[] = [];
  for (const message of prompt) {
    if (message.role === "system") {
      system.push(message.content);
    } else if (message.role === "user" || message.role === "assistant") {
      const images: ClientImage[] = [];
      let text = "";
      for (const part of message.content) {
        if (part.type === "text") text += part.text;
        else if (part.type === "file" && part.mediaType.startsWith("image/")) {
          const base64 = base64Of(part.data);
          if (base64)
            images.push({ name: part.filename ?? "picture", mime: part.mediaType, base64 });
        }
      }
      if (text.trim() || images.length)
        said.push({ role: message.role, text: text.trim(), images });
    }
  }
  return { system: system.join("\n\n"), said };
}

/** What was said as one message for a client that takes text: the part it has not read, then the new message. */
export function clientMessage(said: Pick<Said, "role" | "text">[], resumed: boolean): string {
  const earlier = said
    .slice(0, -1)
    .map((entry) => `${entry.role === "user" ? "Person" : "You"}: ${entry.text}`);
  const now = said.at(-1)?.text ?? "";
  if (!earlier.length) return now;
  return `The conversation ${resumed ? "since your last turn" : "so far"}:\n${earlier.join("\n")}\n\nNow:\n${now}`;
}

/**
 * An installed client (Claude, Codex) as a model Mastra can ask. The client steps by
 * itself and reaches the home's tools over MCP with the turn's token, so Mastra sees one
 * answer without tool calls. The client keeps its own conversation, with its tool calls
 * and their results: a turn resumes it and tells it only what it has not read.
 */
export function clientModel(options: {
  /** The source id, e.g. `claude` or `air/claude`. */
  provider: string;
  model: string;
  mcpToken: string;
  run: ClientRun;
  sessions?: ClientSessions;
}): ChatModel {
  const doStream = async (call: CallOptions): Promise<StreamResult> => {
    const { system, said } = clientPrompt(call.prompt);
    const signal = call.abortSignal ?? new AbortController().signal;
    const saved = options.sessions?.load() ?? null;
    const read = saved
      ? said.findLastIndex(
          (entry) => entry.role === "assistant" && digest(entry.text) === saved.last,
        )
      : -1;
    const stream = new ReadableStream<StreamPart>({
      async start(controller) {
        controller.enqueue({ type: "stream-start", warnings: [] });
        let wrote = false;
        let reply = "";
        let result = "";
        let session: string | undefined;
        const write = (delta: string) => {
          if (!delta) return;
          if (!wrote) controller.enqueue({ type: "text-start", id: "0" });
          wrote = true;
          reply += delta;
          controller.enqueue({ type: "text-delta", id: "0", delta });
        };
        const ask = (resume: string | null, unread: Said[]) =>
          options.run(
            {
              system,
              message: clientMessage(unread, resume !== null),
              session: resume,
              model: options.model,
              mcpToken: options.mcpToken,
              images: unread.flatMap((entry) => entry.images),
              signal,
            },
            (event) => {
              if (event.kind === "delta") write(event.text);
              else if (event.kind === "text") write(`${wrote ? "\n\n" : ""}${event.text}`);
              else if (event.kind === "result") result = event.text;
              else if (event.kind === "session") session = event.id;
            },
          );
        try {
          if (saved && read >= 0) {
            try {
              await ask(saved.id, said.slice(read + 1));
            } catch (error) {
              // The client no longer knows that conversation: it starts a new one and reads everything.
              if (wrote || signal.aborted) throw error;
              await ask(null, said);
            }
          } else {
            await ask(null, said);
          }
          if (!wrote) write(result);
          if (session && reply.trim()) options.sessions?.save({ id: session, last: digest(reply) });
          if (wrote) controller.enqueue({ type: "text-end", id: "0" });
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            usage: {
              inputTokens: {
                total: undefined,
                noCache: undefined,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: undefined, text: undefined, reasoning: undefined },
            },
          });
        } catch (error) {
          controller.enqueue({ type: "error", error });
        }
        controller.close();
      },
    });
    return { stream };
  };
  return {
    specificationVersion: "v3",
    provider: options.provider,
    modelId: options.model,
    supportedUrls: {},
    doStream,
    doGenerate: (call) => generateFrom(doStream, call),
  };
}
