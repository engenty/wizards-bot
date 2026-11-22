import { randomBytes } from "node:crypto";
import { getMcpCallToolContent } from "@mastra/mcp";
import type { AskCard, Looked } from "../agent/tool.ts";
import type { Picture } from "../files/pictures.ts";
import {
  type ElicitAnswer,
  FORM_ACTIONS,
  formBody,
  formOf,
  PAGE_ACTIONS,
  pageBody,
  pageOf,
} from "./elicitation.ts";

const RESULT_LIMIT = 12_000;
/** How long a call may take while nobody is asked anything. */
const QUIET_MS = 60_000;
/** How long the home keeps a call open while its server waits for the person. */
export const HOLD_MS = 10 * 60_000;

interface Target {
  id: string;
  name: string;
}

/** What a server asks the person: MCP's `elicitation/create`, as it arrived. */
export type Question = Record<string, unknown>;

/** Where a call stands: it answered, or its server asks the person and waits. */
export type Step = { result: string | Looked } | { asks: Question; held: string };

/** A call of a connection's tool that is under way. Its server may ask while it is open. */
interface Held {
  id: string;
  connection: Target;
  tool: string;
  /** What the server asked and nobody answered yet, oldest first. */
  questions: { question: Question; answer(value: ElicitAnswer): void }[];
  /** Whether the oldest question is with the person. */
  shown: boolean;
  /** Set when the call is over. */
  ended?: { result: string | Looked } | { error: Error };
  /** Someone waits for what the call does next. */
  watched: boolean;
  moved(): void;
  next: Promise<void>;
  within(ms: number, why: string): void;
}

function clip(value: string): string {
  return value.length > RESULT_LIMIT
    ? `${value.slice(0, RESULT_LIMIT)}\n[cut: ${value.length} characters in all]`
    : value;
}

/** A tool's answer as the agent reads it: the text, and the pictures the server sent. */
function resultOf(raw: unknown): string | Looked {
  const whole = (raw ?? {}) as { content?: unknown; isError?: boolean };
  const parts = (getMcpCallToolContent(raw) ?? whole.content) as
    | { type: string; text?: string; data?: string; mimeType?: string }[]
    | undefined;
  if (!Array.isArray(parts)) return clip(typeof raw === "string" ? raw : JSON.stringify(raw));
  const pictures: Picture[] = [];
  const lines: string[] = [];
  for (const part of parts) {
    if (part.type === "text") lines.push(part.text ?? "");
    else if (part.type === "image" && part.data && part.mimeType)
      pictures.push({ base64: part.data, mime: part.mimeType } as Picture);
    else lines.push(`[${part.type}]`);
  }
  const text = clip(lines.join("\n"));
  if (whole.isError) return `The tool failed: ${text}`;
  return pictures.length ? { text: text || "Done.", pictures } : text || "Done.";
}

/**
 * The calls of connections' tools that are under way. Mastra's MCP client answers a
 * server's question inside the open call, through the handler a connection gets from
 * here: the question becomes a step the calling tool shows as a card, and the person's
 * answer goes back into the same call. Nothing of a call survives a start of the home.
 */
export class Calls {
  private readonly held = new Map<string, Held>();
  /** Called when a call ends while its question is still with the person. */
  private readonly over: (held: string, connection: Target, tool: string, said: string) => void;

  constructor(over: (held: string, connection: Target, tool: string, said: string) => void) {
    this.over = over;
  }

  /** What a connection's client does when its server asks the person. */
  handler(connectionId: string) {
    return (request: { params: unknown }): Promise<ElicitAnswer> => {
      // The request does not say which call it belongs to: the oldest that asks nothing yet.
      const calls = [...this.held.values()].filter((call) => call.connection.id === connectionId);
      const call = calls.find((candidate) => !candidate.questions.length) ?? calls[0];
      if (!call) throw new Error("No call is open.");
      const question = request.params as Question;
      const shown = this.card(call.connection, question);
      if ("refused" in shown)
        throw new Error(`The home does not show the person this: ${shown.refused}.`);
      return new Promise<ElicitAnswer>((resolve) => {
        call.questions.push({ question, answer: resolve });
        call.moved();
      });
    };
  }

  /** Starts a tool and waits until it answers or its server asks the person. */
  start(
    connection: Target,
    tool: string,
    execute: (signal: AbortSignal) => Promise<unknown>,
  ): Promise<Step> {
    const abort = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    let moved: () => void = () => {};
    const call: Held = {
      id: randomBytes(9).toString("base64url"),
      connection,
      tool,
      questions: [],
      shown: false,
      watched: false,
      next: Promise.resolve(),
      moved: () => {
        const done = moved;
        call.next = new Promise<void>((resolve) => {
          moved = resolve;
        });
        done();
      },
      within: (ms, why) => {
        clearTimeout(timer);
        timer = setTimeout(() => abort.abort(new Error(why)), ms);
      },
    };
    call.moved();
    call.within(QUIET_MS, `${connection.name} did not answer in time.`);
    this.held.set(call.id, call);
    void execute(abort.signal)
      .then(
        (raw) => ({ result: resultOf(raw) }),
        // What went wrong is for the agent to read: the first lines say it.
        (error) => ({ error: new Error(String((error as Error)?.message ?? error).slice(0, 600)) }),
      )
      .then((ended) => {
        clearTimeout(timer);
        call.ended = ended;
        this.held.delete(call.id);
        if (!call.watched && call.shown) {
          const said = "error" in ended ? `The tool failed: ${ended.error.message}` : ended.result;
          this.over(call.id, connection, tool, typeof said === "string" ? said : said.text);
        }
        call.moved();
      });
    return this.watch(call);
  }

  /**
   * Gives a call the person's answer and waits for what it does next. Nothing comes back
   * when the call is not open any more.
   */
  answer(held: string, value: ElicitAnswer): Promise<Step> | undefined {
    const call = this.held.get(held);
    const waiting = call?.shown ? call.questions.shift() : undefined;
    if (!call || !waiting) return undefined;
    call.shown = false;
    call.within(QUIET_MS, `${call.connection.name} did not answer in time.`);
    waiting.answer(value);
    return this.watch(call);
  }

  /**
   * Ends every call still under way, when the home stops: nothing waits for an answer that can
   * no longer come, and nobody is told, since the home is going away.
   */
  stop(): void {
    for (const id of [...this.held.keys()]) this.drop(id);
  }

  /** Ends a call nobody will answer. */
  drop(held: string): void {
    const call = this.held.get(held);
    if (!call) return;
    call.shown = false;
    call.within(0, "Nobody could be asked.");
  }

  private async watch(call: Held): Promise<Step> {
    call.watched = true;
    try {
      for (;;) {
        if (call.ended) {
          if ("error" in call.ended) throw call.ended.error;
          return call.ended;
        }
        const waiting = call.questions[0];
        if (waiting) {
          call.shown = true;
          call.within(HOLD_MS, "No answer came in time.");
          return { asks: waiting.question, held: call.id };
        }
        await call.next;
      }
    } finally {
      call.watched = false;
    }
  }

  /** The card for one question, or why the home does not show it. */
  card(
    connection: Target,
    question: Question,
    problems: string[] = [],
  ): AskCard | { refused: string } {
    const again = problems.length ? `${problems.join(" ")}\n\n` : "";
    if (question.mode === "url") {
      const page = pageOf(question.url);
      if ("refused" in page) return page;
      return {
        kind: "question",
        level: "needs_you",
        title: `${connection.name} asks you to open a page`,
        body: pageBody(connection.name, question.message, page),
        url: page.url,
        actions: PAGE_ACTIONS,
        private: true,
      };
    }
    if (question.mode !== undefined && question.mode !== "form")
      return { refused: `it asks in a way the home does not know (${String(question.mode)})` };
    const form = formOf(question.requestedSchema);
    if ("refused" in form) return form;
    return {
      kind: "question",
      level: "needs_you",
      title: `${connection.name} asks you something`,
      body: again + formBody(connection.name, question.message, form.notes),
      fields: form.fields.length ? form.fields : undefined,
      actions: FORM_ACTIONS,
      private: true,
    };
  }
}
