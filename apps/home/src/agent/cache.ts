/**
 * The provider's prompt cache. Anthropic reads a request from its cache up to the last of its
 * marks, as long as everything before the mark is the same as before: tools, the system prompt,
 * the messages. So the home keeps the start of every request stable and marks three places:
 *
 * - the instructions (`markedInstructions`), the stable part of the prompt (`prompt.ts`);
 * - the message before the newest message of the person: what the conversation already said,
 *   the same in the next turn;
 * - the newest message once tool steps follow it within the turn, so each step reads the
 *   steps before it from the cache.
 *
 * The newest message itself carries what changes from turn to turn (the time, the cards that
 * wait): never marked, and never stored, so the next turn's request does not have it there.
 * Other providers ignore the marks: OpenAI caches a stable start by itself, and Ollama keeps the
 * start of the last request loaded. Mastra builds the prompt; the processor only marks it
 * (`processLLMRequest`, whose changes are not written back to the thread).
 */

const EPHEMERAL = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

interface PromptPart {
  type: string;
  text?: string;
}

export interface PromptMessage {
  role: string;
  content: unknown;
  providerOptions?: Record<string, unknown>;
}

const marked = <M extends PromptMessage>(message: M): M => ({
  ...message,
  providerOptions: {
    ...message.providerOptions,
    anthropic: {
      ...(message.providerOptions?.anthropic as Record<string, unknown> | undefined),
      ...EPHEMERAL.anthropic,
    },
  },
});

/**
 * The newest message with the turn's changing context after what it says, set apart by an empty
 * line: a model that reads the parts as one text (a subscription's client) still sees two.
 */
const withContext = <M extends PromptMessage>(message: M, context: string): M => {
  const block: PromptPart = { type: "text", text: `\n\n${context}` };
  const content = Array.isArray(message.content)
    ? [...(message.content as PromptPart[]), block]
    : [{ type: "text", text: String(message.content ?? "") }, block];
  return { ...message, content };
};

/** The request's prompt with the cache marks set and `context` added to the newest user message. */
export function cacheMarks<M extends PromptMessage>(prompt: M[], context = ""): M[] {
  const lastUser = prompt.findLastIndex((message) => message.role === "user");
  return prompt.map((message, at) => {
    const historyEnd = at === lastUser - 1 && message.role !== "system";
    const stepEnd = at === prompt.length - 1 && at > lastUser && lastUser >= 0;
    const current = at === lastUser && context ? withContext(message, context) : message;
    return historyEnd || stepEnd ? marked(current) : current;
  });
}

/** The instructions as a system message with the cache mark. */
export const markedInstructions = (content: string) => ({
  role: "system" as const,
  content,
  providerOptions: EPHEMERAL,
});

/**
 * The input processor that sets the marks on every request of a run. `contextOf` gives the
 * turn's changing context from the run's request context.
 */
export function cacheProcessor(
  contextOf: (requestContext: { get(key: string): unknown } | undefined) => string,
) {
  return {
    id: "cache-marks",
    processLLMRequest: ({
      prompt,
      requestContext,
    }: {
      prompt: PromptMessage[];
      requestContext?: { get(key: string): unknown };
    }) => ({ prompt: cacheMarks(prompt, contextOf(requestContext)) }),
  };
}
