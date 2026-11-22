import { z } from "zod";
import { defineTool, type Tool } from "../../agent/tool.ts";
import type { TurnContext } from "../../agent/turns.ts";
import { fileName, keepFile, openSource, SOURCE, TARGET } from "../office/documents.ts";
import { editXlsx, makeXlsx, XLSX_MIME } from "../office/xlsx.ts";

const Value = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const Rows = z.array(z.array(Value));
const Sheet = z.object({
  name: z.string(),
  rows: Rows.describe(
    'The first row is the header. A number is a number; "=SUM(B2:B9)" is a formula; "2026-11-21" is a date.',
  ),
});

/** The tools the excel skill brings. */
export function excelTools(context: TurnContext): Tool[] {
  return [
    defineTool({
      name: "excel_make",
      description:
        "Make an Excel workbook (.xlsx) from rows. It appears in your message for the person to save.",
      input: z.object({
        name: z.string().describe("The file's name, e.g. Budget 2027."),
        sheets: z.array(Sheet).min(1),
        ...TARGET,
      }),
      label: (input) => `Making ${String(input.name ?? "a workbook")}`,
      run: async (input) => {
        const name = fileName(input.name, "xlsx");
        const bytes = makeXlsx({ title: name.replace(/\.xlsx$/, ""), sheets: input.sheets });
        return keepFile(
          context,
          { name, mime: XLSX_MIME, bytes },
          input.folder ? { folder: input.folder, path: input.path } : undefined,
        );
      },
    }),
    defineTool({
      name: "excel_edit",
      description:
        "Change an Excel workbook and keep the rest of it: set cells, add rows, add a sheet. Read the workbook first.",
      input: z.object({
        ...SOURCE,
        sheet: z
          .string()
          .optional()
          .describe("The sheet for `cells` and `rows`. Without it: the first."),
        cells: z
          .array(z.object({ cell: z.string().describe("Like B7."), value: Value }))
          .optional(),
        rows: Rows.optional().describe("Rows to add under the last row."),
        addSheet: Sheet.optional(),
      }),
      label: (input) => `Changing ${String(input.path ?? input.file ?? "a workbook")}`,
      run: async (input) => {
        const source = openSource(context, input, "xlsx");
        if (!input.cells?.length && !input.rows?.length && !input.addSheet)
          return "Nothing to change: give `cells`, `rows` or `addSheet`.";
        const edited = editXlsx(source.bytes, {
          sheet: input.sheet,
          cells: input.cells,
          rows: input.rows,
          addSheet: input.addSheet,
        });
        const notes = edited.notes.join("\n");
        if (!edited.notes.some((note) => / set in | added/.test(note)))
          return `${notes}\nThe workbook is unchanged.`;
        const kept = keepFile(
          context,
          { name: source.name, mime: XLSX_MIME, bytes: edited.bytes },
          source.folder ? { folder: source.folder.name, path: source.folder.path } : undefined,
        );
        return `${notes}\n${kept}`;
      },
    }),
  ];
}
