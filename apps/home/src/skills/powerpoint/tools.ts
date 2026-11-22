import { z } from "zod";
import { defineTool, type Tool } from "../../agent/tool.ts";
import type { TurnContext } from "../../agent/turns.ts";
import { fileName, keepFile, openSource, SOURCE, TARGET } from "../office/documents.ts";
import { editPptx, makePptx, PPTX_MIME } from "../office/pptx.ts";

/** The tools the powerpoint skill brings. */
export function powerpointTools(context: TurnContext): Tool[] {
  return [
    defineTool({
      name: "powerpoint_make",
      description:
        "Make a PowerPoint deck (.pptx) from a Markdown outline. It appears in your message for the person to save.",
      input: z.object({
        name: z.string().describe("The file's name, e.g. Kickoff."),
        content: z
          .string()
          .describe(
            "The outline: `# Deck title` with the subtitle under it, then `## Slide title` with `- ` points under each.",
          ),
        ...TARGET,
      }),
      label: (input) => `Making ${String(input.name ?? "a deck")}`,
      run: async (input) => {
        const name = fileName(input.name, "pptx");
        const bytes = makePptx({ title: name.replace(/\.pptx$/, ""), content: input.content });
        return keepFile(
          context,
          { name, mime: PPTX_MIME, bytes },
          input.folder ? { folder: input.folder, path: input.path } : undefined,
        );
      },
    }),
    defineTool({
      name: "powerpoint_edit",
      description:
        "Change a PowerPoint deck and keep its design: replace words, take slides out, add slides. Read the deck first.",
      input: z.object({
        ...SOURCE,
        changes: z
          .array(
            z.object({
              find: z.string().min(1).describe("The exact words of one line."),
              replace: z.string(),
            }),
          )
          .optional(),
        remove: z.array(z.number().int().min(1)).optional().describe("Slide numbers to take out."),
        add: z
          .string()
          .optional()
          .describe("New slides as an outline: `## Slide title`, `- ` points."),
        after: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("The slide number the new slides go after. Without it: at the end."),
      }),
      label: (input) => `Changing ${String(input.path ?? input.file ?? "a deck")}`,
      run: async (input) => {
        const source = openSource(context, input, "pptx");
        if (!input.changes?.length && !input.remove?.length && !input.add?.trim())
          return "Nothing to change: give `changes`, `remove` or `add`.";
        const edited = editPptx(source.bytes, {
          changes: input.changes,
          remove: input.remove,
          add: input.add ? { content: input.add, after: input.after } : undefined,
        });
        const notes = edited.notes.join("\n");
        if (!edited.notes.some((note) => / replaced | removed| added/.test(note)))
          return `${notes}\nThe deck is unchanged.`;
        const kept = keepFile(
          context,
          { name: source.name, mime: PPTX_MIME, bytes: edited.bytes },
          source.folder ? { folder: source.folder.name, path: source.folder.path } : undefined,
        );
        return `${notes}\n${kept}`;
      },
    }),
  ];
}
