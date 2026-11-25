import { TOOL_CALL } from "@engenty/tool-harness";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { Picture } from "../files/pictures.ts";
import type { NewCard } from "../store/store.ts";
import type { Draft } from "./draft.ts";

/**
 * Something an agent can do. The same definition serves a model the home steps through
 * (as a Mastra tool) and a client that steps by itself (over MCP).
 */
// biome-ignore lint/suspicious/noExplicitAny: a list of tools holds tools of any input
export interface Tool<I = any> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  /** What the person sees while it runs, e.g. "Writing “Packing list”". */
  label?(input: Record<string, unknown>): string;
  /** What a call does, in the person's words, for a card that asks before it runs. Markdown. */
  says?(input: Record<string, unknown>): string;
  /** Set on a tool that asks the person with `call.ask`: it runs again with the answer. */
  asks?: true;
  /** Returns what the model reads, and with `pictures` what it looks at. */
  run(input: I, call: Call): Promise<string | Looked>;
}

/** A card a tool asks the person with. `private`: what is typed into it is stored nowhere. */
export type AskCard = Omit<NewCard, "payload"> & { private?: true };

/** How the person answered the card of a tool that asked. */
export interface Answer {
  /** The id of the card's action the person chose. */
  action: string;
  /** Field values as the person typed them. */
  values: Record<string, string | string[]>;
  /** The card as it was answered. */
  card: { id: string; title: string; actions: { id: string; label: string }[] };
  /** What the tool kept with `ask`, to know where it was. */
  kept: unknown;
  /** In a group home: the admin who answered. */
  by?: string;
}

/** What a tool gets besides its input. */
export interface Call {
  /** The person's answer, when the tool runs again after it asked. */
  answer?: Answer;
  /**
   * Shows the person a card and stops the tool here: return what this returns. The tool
   * runs again, from the start, with the answer in `call.answer` and `kept` beside it.
   */
  ask(card: AskCard, kept?: unknown): Promise<string>;
}

/**
 * How a tool's question reaches the person in the run it is part of. A model the home
 * steps through is suspended by Mastra (`suspend`) and resumed with the answer; a client
 * that steps by itself is told to end its turn, and the home runs the tool again.
 */
export interface Asking {
  /** Puts the card of a tool's question into the chat. */
  card(tool: Tool, input: unknown, card: AskCard, kept: unknown): { id: string };
  /** Mastra's suspension of the tool call, where the home steps the model. */
  suspend?(payload: { cardId: string }): Promise<void>;
  answer?: Answer;
}

/** What a client that steps by itself reads when a tool asked the person. */
export const ENDS_TURN =
  "The card is in the chat. End your turn now with at most one short sentence. The answer arrives as the next message.";

/** A tool's answer with pictures: the text, and the pictures after it. */
export interface Looked {
  text: string;
  pictures: Picture[];
}

export const defineTool = <I>(tool: Tool<I>): Tool<I> => tool;

/**
 * A tool's answer as a model reads it, in the AI SDK's tool output: the text alone, or the
 * text followed by the pictures.
 */
export function modelOutput(output: unknown): unknown {
  if (typeof output === "string") return { type: "text", value: output };
  const looked = output as Looked;
  return {
    type: "content",
    value: [
      { type: "text", text: looked.text },
      ...looked.pictures.map((picture) => ({
        type: "image-data",
        data: picture.base64,
        mediaType: picture.mime,
      })),
    ],
  };
}

/** What Mastra keeps of a suspended call, and what resumes it: the card, never its answer. */
const SUSPENDED = z.object({ cardId: z.string() });
const RESUMED = z.object({ answered: z.string() });

/** The part of Mastra's tool context the home uses, in a run of an agent. */
interface MastraCall {
  agent?: {
    suspend?: (payload: { cardId: string }) => Promise<void>;
    resumeData?: { answered: string };
  };
}

let calls = 0;

/**
 * Runs a tool for a model and shows it as one line of the message. A failure is not
 * thrown: the model reads what went wrong and can try again.
 */
export async function runTool(
  tool: Tool,
  raw: unknown,
  draft: Draft,
  asking?: Asking,
): Promise<{ text: string; pictures: Picture[]; failed: boolean }> {
  const id = `call_${++calls}`;
  const input = (raw ?? {}) as Record<string, unknown>;
  let label = tool.name;
  try {
    label = tool.label?.(input) ?? tool.name;
  } catch {}
  draft.activity(id, label, "running");
  try {
    const call: Call = {
      answer: asking?.answer,
      ask: async (card, kept) => {
        if (!asking) throw new Error("This tool cannot ask the person here.");
        const made = asking.card(tool, input, card, kept);
        await asking.suspend?.({ cardId: made.id });
        return ENDS_TURN;
      },
    };
    const answer = await tool.run(tool.input.parse(input), call);
    draft.activity(id, label, "done");
    // In a group home the agent hears which admin decided.
    const by = call.answer?.by ? `${call.answer.by} answered the card.\n` : "";
    return typeof answer === "string"
      ? { text: `${by}${answer}`, pictures: [], failed: false }
      : { ...answer, text: `${by}${answer.text}`, failed: false };
  } catch (error) {
    draft.activity(id, label, "failed");
    const text =
      error instanceof z.ZodError
        ? `Invalid input: ${z.prettifyError(error)}`
        : String((error as Error)?.message ?? error);
    return { text, pictures: [], failed: true };
  }
}

/** The tools as Mastra's agent takes them, by name. */
export function mastraTools(
  tools: Tool[],
  draft: Draft,
  asking: Asking,
  /** The answer to the card a suspended call waits on. */
  answerOf: (cardId: string) => Answer | undefined,
  /** What a `tool_call` means: the tool and its input, or what the model reads instead. */
  resolve?: (input: unknown) => { tool: Tool; input: unknown } | string,
): Record<string, ReturnType<typeof createTool>> {
  const byName: Record<string, ReturnType<typeof createTool>> = {};
  for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    byName[tool.name] = createTool({
      id: tool.name,
      description: tool.description,
      inputSchema: tool.input,
      // With these Mastra runs the tool alone in its step and can suspend it.
      ...(tool.asks ? { suspendSchema: SUSPENDED, resumeSchema: RESUMED } : {}),
      execute: async (input: unknown, context?: MastraCall) => {
        const run = tool.asks ? context?.agent : undefined;
        const meant = tool.name === TOOL_CALL ? resolve?.(input) : { tool, input };
        if (typeof meant !== "object") return meant ?? "Nothing was done.";
        const { text, pictures } = await runTool(meant.tool, meant.input, draft, {
          ...asking,
          suspend: run?.suspend,
          // The answer itself travels beside Mastra, so nothing typed enters its store.
          answer: run?.resumeData ? answerOf(run.resumeData.answered) : undefined,
        });
        return pictures.length ? { text, pictures } : text;
      },
      toModelOutput: modelOutput,
    }) as ReturnType<typeof createTool>;
  }
  return byName;
}

/** A tool's input as JSON schema, for MCP. */
export function inputSchemaOf(tool: Tool): Record<string, unknown> {
  const { $schema: _, ...schema } = z.toJSONSchema(tool.input, { io: "input" }) as Record<
    string,
    unknown
  >;
  return { properties: {}, ...schema, type: "object" };
}
