import { readDocx } from "./docx.ts";
import { readPptx } from "./pptx.ts";
import { readXlsx } from "./xlsx.ts";

// The text of a document an agent cannot read as it is: a Word, Excel or PowerPoint file or
// a PDF.

export type DocumentKind = "docx" | "xlsx" | "pptx" | "pdf";

const KINDS: Record<DocumentKind, string> = {
  docx: "Word document",
  xlsx: "Excel workbook",
  pptx: "PowerPoint deck",
  pdf: "PDF",
};

/** What a person calls a file of this kind. */
export const kindName = (kind: DocumentKind): string => KINDS[kind];

/** The kind of document a file is, by the ending of its name. */
export function documentKind(name: string): DocumentKind | undefined {
  const ending = name.split(".").pop()?.toLowerCase() ?? "";
  return ending in KINDS ? (ending as DocumentKind) : undefined;
}

async function readPdf(bytes: Uint8Array): Promise<string> {
  // Loaded when the first PDF is read: most turns never need it.
  const { extractText, getDocumentProxy } = await import("unpdf");
  // The reader takes the bytes for itself, so it gets a copy.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = text.map((page) => page.trim());
  if (!pages.some(Boolean))
    return "(This PDF holds no text, only pictures of pages: a scan. It cannot be read here.)";
  return pages.length === 1
    ? (pages[0] as string)
    : pages.map((page, index) => `## Page ${index + 1}\n${page}`).join("\n\n");
}

/**
 * A document's text. `undefined` when the file is not a document this home reads; throws
 * with a sentence for the agent when it is one and cannot be read.
 */
export async function documentText(name: string, bytes: Uint8Array): Promise<string | undefined> {
  const kind = documentKind(name);
  if (!kind) return undefined;
  try {
    if (kind === "docx") return readDocx(bytes);
    if (kind === "xlsx") return readXlsx(bytes);
    if (kind === "pptx") return readPptx(bytes);
    return await readPdf(bytes);
  } catch (error) {
    const reason = String((error as Error)?.message ?? error);
    throw new Error(
      /password|encrypt/i.test(reason)
        ? `${name} is protected with a password and cannot be read.`
        : `${name} could not be read as a ${KINDS[kind]}: ${reason}`,
    );
  }
}

/** A piece of a long text from `from`, with a line that says how to read on. */
export function piece(text: string, from: number, limit: number, readOn: string): string {
  const start = Math.max(0, Math.min(from, text.length));
  const end = Math.min(text.length, start + limit);
  const cut = text.slice(start, end);
  return end < text.length
    ? `${cut}\n[cut at ${end} of ${text.length} characters; ${readOn} from ${end}]`
    : cut;
}
