import { z } from "zod";
import { defineTool, type Tool } from "../../agent/tool.ts";
import type { TurnContext } from "../../agent/turns.ts";
import { fileName, keepFile, openSource, SOURCE, TARGET } from "../office/documents.ts";
import { DOCX_MIME, editDocx, makeDocx } from "../office/docx.ts";

/** The tools the word skill brings. */
export function wordTools(context: TurnContext): Tool[] {
  return [
    defineTool({
      name: "word_make",
      description:
        "Make a Word document (.docx) from Markdown. It appears in your message for the person to save.",
      input: z.object({
        name: z.string().describe("The file's name, e.g. Offer for Lena."),
        content: z
          .string()
          .describe(
            "The whole document as Markdown: # title, ## headings, lists, tables, **bold**.",
          ),
        ...TARGET,
      }),
      label: (input) => `Writing ${String(input.name ?? "a document")}`,
      run: async (input) => {
        const name = fileName(input.name, "docx");
        const bytes = makeDocx({ title: name.replace(/\.docx$/, ""), content: input.content });
        return keepFile(
          context,
          { name, mime: DOCX_MIME, bytes },
          input.folder ? { folder: input.folder, path: input.path } : undefined,
        );
      },
    }),
    defineTool({
      name: "word_edit",
      description:
        "Change a Word document and keep its layout: replace words, add text. Read the document first.",
      input: z.object({
        ...SOURCE,
        changes: z
          .array(
            z.object({
              find: z.string().min(1).describe("The exact words, inside one paragraph."),
              replace: z.string(),
            }),
          )
          .optional(),
        add: z.string().optional().describe("Markdown to add."),
        after: z
          .string()
          .optional()
          .describe("Words of the paragraph the new text goes after. Without it: at the end."),
      }),
      label: (input) => `Changing ${String(input.path ?? input.file ?? "a document")}`,
      run: async (input) => {
        const source = openSource(context, input, "docx");
        if (!input.changes?.length && !input.add?.trim())
          return "Nothing to change: give `changes` or `add`.";
        const edited = editDocx(source.bytes, {
          changes: input.changes,
          insert: input.add ? { content: input.add, after: input.after } : undefined,
        });
        const notes = edited.notes.join("\n");
        if (!edited.notes.some((note) => / replaced | added /.test(note)))
          return `${notes}\nThe document is unchanged.`;
        const kept = keepFile(
          context,
          { name: source.name, mime: DOCX_MIME, bytes: edited.bytes },
          source.folder ? { folder: source.folder.name, path: source.folder.path } : undefined,
        );
        return `${notes}\n${kept}`;
      },
    }),
  ];
}
