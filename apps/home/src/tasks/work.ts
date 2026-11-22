import { z } from "zod";
import { defineTool, type Tool } from "../agent/tool.ts";
import type { TurnContext } from "../agent/turns.ts";

/**
 * Longer work: what does not fit into one turn. The agent says what is done and what is
 * next, and the home gives it the next turn without the person writing. The home counts the
 * turns in a row and stops giving them at a limit; a card that waits for the person, or the
 * person pressing stop, ends the row before that.
 */
export function workTools(context: TurnContext): Tool[] {
  return [
    defineTool({
      name: "go_on",
      description:
        "Ask for another turn when the work is not finished and this turn is running out, or at a point where it is good to say where the work stands. Say what is done and what is next: the home gives you the next turn with that, without the person writing. Not for waiting on the person: when you need them, call `ask`.",
      input: z.object({
        done: z.string().describe("What is done so far, one or two sentences."),
        next: z.string().describe("What you do in the next turn, one sentence."),
      }),
      label: (input) => `Going on: ${String(input.next ?? "")}`,
      run: async (input) =>
        context.goOn(input.done, input.next)
          ? "You get the next turn after this one. End this turn now with one sentence on where the work stands."
          : "The home gives no further turn in a row. End this turn with where the work stands and what is open; the person decides whether you go on.",
    }),
  ];
}
