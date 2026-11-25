import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import {
  antigravity,
  type ChatCall,
  type Client,
  type ClientId,
  claude,
  codex,
  cursor,
  cursorWorkspace,
  ownCursorServers,
  resolveEnv,
} from "@engenty/local-models/clients";
import {
  base64Of,
  type CallOptions,
  type ChatModel,
  generateFrom,
  type StreamPart,
  type StreamResult,
} from "@engenty/local-models/ollama";

// An installed client (Claude Code, Codex, Cursor Agent, Antigravity) answering a turn of the home: the client runs its own
// steps, reaches only the home's tools over MCP (named `home`) and keeps the conversation itself.
// How each client is started and read is `@engenty/local-models`.

/** A client the home runs on the person's subscription. */
export interface Subscription {
  client: Client;
  /** The name the person sees. */
  label: string;
  /** Models the person can name; the first is what the home uses. `default`: the client picks. */
  models: { id: string; label: string }[];
  /** It continues a conversation from any folder; else each turn tells it everything. */
  resumes: boolean;
}

export type SubscriptionId = ClientId;

export const SUBSCRIPTIONS: Record<SubscriptionId, Subscription> = {
  claude: {
    client: claude,
    label: "Claude",
    models: [
      { id: "default", label: "Claude (your subscription's default)" },
      { id: "opus", label: "Claude Opus" },
      { id: "sonnet", label: "Claude Sonnet" },
      { id: "haiku", label: "Claude Haiku" },
    ],
    resumes: true,
  },
  codex: {
    client: codex,
    label: "Codex",
    models: [{ id: "default", label: "Codex (your subscription's default)" }],
    resumes: true,
  },
  antigravity: {
    client: antigravity,
    label: "Antigravity",
    models: [{ id: "default", label: "Antigravity (your subscription's default)" }],
    resumes: true,
  },
  // Cursor keeps its chats per folder, and a turn's folder goes with the turn.
  cursor: {
    client: cursor,
    label: "Cursor",
    models: [{ id: "default", label: "Cursor (your subscription's default)" }],
    resumes: false,
  },
};

export const isSubscription = (id: string): id is SubscriptionId =>
  Object.hasOwn(SUBSCRIPTIONS, id);

/** The client behind a source, also one of a linked computer (`<computer>/<client>`). */
export function subscriptionOf(sourceId: string): Subscription | undefined {
  const id = sourceId.slice(sourceId.lastIndexOf("/") + 1);
  return isSubscription(id) ? SUBSCRIPTIONS[id] : undefined;
}

/** The home's MCP server as the client knows it, and the variable Codex reads its key from. */
const MCP_NAME = "home";
const MCP_KEY_VAR = "WIZARDS_BOT_MCP_KEY";

/** What one output line of a client's turn says, as it travels over the link. */
export type ClientEvent =
  | { kind: "text"; text: string }
  | { kind: "delta"; text: string }
  /**
   * What the client's model thinks: a new block, then its text as it streams, or `whole` once
   * the block is done where the client does not stream it.
   */
  | { kind: "thinkingStart" }
  | { kind: "thinking"; text: string; whole?: boolean }
  | { kind: "tool"; name: string; started: boolean }
  | { kind: "session"; id: string }
  | { kind: "failure"; detail: string }
  /** The client's own summary of the answer, used where no text came before it. */
  | { kind: "result"; text: string };

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

/**
 * Marks the signal that asks for a turn on a message stored before it (`agent/turns.ts`), in its
 * `providerOptions.home`.
 */
export const ASKED_OPTION = "asked";

/** The AI SDK's prompt as the instructions and what was said, oldest first. */
export function clientPrompt(prompt: CallOptions["prompt"]): { system: string; said: Said[] } {
  const system: string[] = [];
  const said: Said[] = [];
  for (const message of prompt) {
    // The signal that asks for a turn on what was stored before it: the stored message is "Now".
    const options = (message as { providerOptions?: { home?: Record<string, unknown> } })
      .providerOptions;
    if (options?.home?.[ASKED_OPTION]) continue;
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
 * An installed client as a model Mastra can ask. The client steps by
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
        // What the client's model thinks, one block at a time: as it streams, or whole where the
        // client hands it over only once it is done.
        let thought: string | undefined;
        let thoughts = 0;
        let streamedThought = false;
        const endThought = () => {
          if (thought) controller.enqueue({ type: "reasoning-end", id: thought });
          thought = undefined;
        };
        const think = (event: Extract<ClientEvent, { kind: "thinkingStart" | "thinking" }>) => {
          if (event.kind === "thinkingStart") {
            endThought();
            streamedThought = false;
            return;
          }
          if (!event.text || (event.whole && streamedThought)) return;
          if (!thought) {
            thought = `reasoning-${thoughts++}`;
            controller.enqueue({ type: "reasoning-start", id: thought });
          }
          if (!event.whole) streamedThought = true;
          controller.enqueue({ type: "reasoning-delta", id: thought, delta: event.text });
        };
        const write = (delta: string) => {
          if (!delta) return;
          endThought();
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
              else if (event.kind === "thinkingStart" || event.kind === "thinking") think(event);
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
          endThought();
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

/**
 * A client's output lines as the events of a turn: text as it streams, a whole message only
 * where nothing of it streamed before. A failed API call comes from Claude Code as a message it
 * makes itself ("API Error: …"): it is a failure, so the home asks the next model instead of
 * showing it as the answer.
 */
export function turnEvents(client: Client): (line: string) => ClientEvent[] {
  let streamed = false;
  return (line) => {
    let raw: { type?: string; message?: { model?: string; content?: { text?: string }[] } };
    try {
      raw = JSON.parse(line);
    } catch {
      return [];
    }
    if (raw?.type === "assistant" && raw.message?.model === "<synthetic>") {
      streamed = false;
      const said = (raw.message.content ?? [])
        .map((block) => block.text ?? "")
        .join(" ")
        .trim();
      return [{ kind: "failure", detail: said || "error" }];
    }
    const out: ClientEvent[] = [];
    for (const event of client.events(line)) {
      if (event.kind === "writing") {
        if (event.text) {
          streamed = true;
          out.push({ kind: "delta", text: event.text });
        }
      } else if (event.kind === "text") {
        if (!streamed) out.push(event);
      } else if (event.kind === "thinkingStart" || event.kind === "thinking") {
        out.push(event);
      } else if (event.kind === "tool") {
        out.push({ kind: "tool", name: event.name, started: event.started });
      } else if (event.kind === "session" || event.kind === "failure" || event.kind === "result") {
        out.push(event);
      }
    }
    if (raw?.type === "assistant") streamed = false;
    return out;
  };
}

/** Runs one turn of an installed client on this computer and reports what its output lines mean. */
export async function runTurn(
  subscription: Subscription,
  turn: ClientTurn,
  mcpUrl: string,
  onEvent: (event: ClientEvent) => void,
): Promise<void> {
  const { client, label } = subscription;
  const dir = mkdtempSync(join(tmpdir(), "wizards-bot-turn-"));
  const configFile = join(dir, "mcp.json");
  writeFileSync(
    configFile,
    JSON.stringify({
      mcpServers: {
        [MCP_NAME]: {
          type: "http",
          url: mcpUrl,
          headers: { Authorization: `Bearer ${turn.mcpToken}` },
        },
      },
    }),
    { mode: 0o600 },
  );
  if (client.id === "cursor") {
    for (const [path, text] of Object.entries(
      cursorWorkspace({
        system: turn.system,
        mcp: { name: MCP_NAME, url: mcpUrl },
        key: turn.mcpToken,
        ownServers: ownCursorServers(),
      }),
    )) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text, { mode: 0o600 });
    }
  }
  const images = (turn.images ?? []).map((image, at) => {
    const file = join(dir, `picture-${at}.${image.mime.split("/")[1] ?? "png"}`);
    writeFileSync(file, Buffer.from(image.base64, "base64"), { mode: 0o600 });
    return { mime: image.mime, base64: image.base64, file };
  });
  const call: ChatCall = {
    system: turn.system,
    message: turn.message,
    session: turn.session,
    dir,
    ...(turn.model === "default" ? {} : { model: turn.model }),
    mcp: { name: MCP_NAME, url: mcpUrl, keyVar: MCP_KEY_VAR, configFile },
    images,
  };
  try {
    const { env } = await resolveEnv(client);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(client.bin, client.args(call), {
        cwd: dir,
        env: { ...env, [MCP_KEY_VAR]: turn.mcpToken },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const read = turnEvents(client);
      let stderr = "";
      let failed: string | undefined;
      turn.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
      child.stdin.on("error", () => {
        // The client went away before reading the message; `close` reports it.
      });
      child.stdin.end(client.stdin(call));
      createInterface({ input: child.stdout }).on("line", (line) => {
        for (const event of read(line)) {
          if (event.kind === "failure") failed = event.detail;
          onEvent(event);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-2000);
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (turn.signal.aborted) return resolve();
        if (failed !== undefined) {
          return reject(
            new Error(
              client.signedOut(failed)
                ? `${label} is not signed in on this computer. Sign in there, then ask again.`
                : failed,
            ),
          );
        }
        if (code !== 0)
          return reject(new Error(stderr.trim() || `${label} ended with code ${code}.`));
        resolve();
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
