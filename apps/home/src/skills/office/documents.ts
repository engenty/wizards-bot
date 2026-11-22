import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { FileRef } from "@wizards-bot/protocol";
import { z } from "zod";
import { defineTool, type Tool } from "../../agent/tool.ts";
import type { TurnContext } from "../../agent/turns.ts";
import type { Home } from "../../home.ts";
import { type DocumentKind, documentKind, documentText, kindName, piece } from "./read.ts";

// Where the document tools take a file from and where a made one goes: the files of the
// conversation, and the connected folders.

/** A document in a connected folder larger than this is not opened. */
const FOLDER_BYTES = 20 * 1024 * 1024;
/** Text one call of `file_read` returns. */
const READ_LIMIT = 20_000;

/** The file a tool works on: one of this conversation, or one in a connected folder. */
export const SOURCE = {
  file: z.string().optional().describe("A file of this conversation: its id (fil_…) or its name."),
  folder: z.string().optional().describe("Or a connected folder's name, with `path`."),
  path: z.string().optional().describe("The file in that folder, e.g. reports/q3.docx."),
};

/** Where a made file also goes, besides the message. */
export const TARGET = {
  folder: z
    .string()
    .optional()
    .describe("A connected folder to write the file into as well. The person is asked first."),
  path: z.string().optional().describe("Where in that folder, e.g. offers/lena.docx."),
};

export interface Source {
  name: string;
  bytes: Uint8Array;
  /** Set for a file in a connected folder: an edit goes back there, after asking. */
  folder?: { name: string; path: string };
}

/** The files of a conversation, the person's and those an agent made, oldest first. */
export function conversationFiles(context: TurnContext): FileRef[] {
  const files = new Map<string, FileRef>();
  const { messages } = context.home.store.messages(context.conversationId, { limit: 200 });
  for (const message of messages) {
    for (const part of message.parts) if (part.type === "file") files.set(part.file.id, part.file);
  }
  for (const file of context.trigger.files ?? []) files.set(file.id, file);
  return [...files.values()];
}

/** A file of the conversation by its id or its name; the newest one of that name. */
function conversationFile(context: TurnContext, wanted: string): FileRef | undefined {
  const files = conversationFiles(context);
  const name = wanted.trim().toLowerCase();
  return (
    files.find((file) => file.id === wanted.trim()) ??
    files.findLast((file) => file.name.toLowerCase() === name)
  );
}

/**
 * Opens the file a tool was pointed at. Without a pointer it is the conversation's newest
 * file of the kind, when there is one. Throws with a sentence for the agent.
 */
export function openSource(
  context: TurnContext,
  input: { file?: string; folder?: string; path?: string },
  kind?: DocumentKind,
): Source {
  const { home } = context;
  const fits = (name: string): boolean => !kind || documentKind(name) === kind;
  if (input.folder) {
    const folder = home.folders.byName(input.folder);
    if (!folder) throw new Error(`There is no connected folder ${input.folder}.`);
    if (!input.path) throw new Error("Name the file in the folder with `path`.");
    const full = home.folders.locate(folder, input.path);
    const stat = statSync(full, { throwIfNoEntry: false });
    if (!stat?.isFile()) throw new Error(`There is no file ${input.path} in ${folder.name}.`);
    if (stat.size > FOLDER_BYTES) throw new Error(`${input.path} is too large to open here.`);
    if (!fits(input.path))
      throw new Error(`${input.path} is not a ${kindName(kind as DocumentKind)}.`);
    return {
      name: basename(full),
      bytes: readFileSync(full),
      folder: { name: folder.name, path: input.path },
    };
  }
  const files = conversationFiles(context);
  const file = input.file
    ? conversationFile(context, input.file)
    : files.findLast((each) => kind && fits(each.name));
  if (!file) {
    const known = files
      .filter((each) => fits(each.name))
      .map((each) => `${each.name} (${each.id})`);
    throw new Error(
      input.file
        ? `There is no file ${input.file} in this conversation.${known.length ? ` Files: ${known.join(", ")}.` : ""}`
        : `Name the file: \`file\` for one of this conversation, or \`folder\` and \`path\` for one in a connected folder.`,
    );
  }
  if (!fits(file.name)) throw new Error(`${file.name} is not a ${kindName(kind as DocumentKind)}.`);
  const bytes = home.files.bytes(file.id);
  if (!bytes) throw new Error(`${file.name} is not kept in the home any more.`);
  return { name: file.name, bytes };
}

/** A file name with the ending of its kind, from what an agent called the document. */
export function fileName(wanted: string, kind: DocumentKind): string {
  const base =
    (wanted.split(/[\\/]/).pop() ?? "")
      .replace(new RegExp(`\\.${kind}$`, "i"), "")
      .replace(/[<>:"|?*]/g, " ")
      .trim() || "Document";
  return `${base}.${kind}`;
}

/**
 * Keeps a made file and shows it in the agent's message. With a folder it also asks the
 * person to write it there. Returns what the agent reads.
 */
export function keepFile(
  context: TurnContext,
  made: { name: string; mime: string; bytes: Uint8Array },
  target?: { folder: string; path?: string },
): string {
  const { home, draft, agent, conversationId } = context;
  const file = home.files.add(made);
  draft.add({ type: "file", file });
  const inMessage = `${file.name} (${file.id}) is in your message; the person saves it from there.`;
  if (!target) return `${inMessage} Say so in one sentence; do not repeat its text.`;
  const folder = home.folders.byName(target.folder);
  if (!folder)
    return `${inMessage} There is no connected folder ${target.folder}, so it was not written into one.`;
  if (folder.access !== "write")
    return `${inMessage} ${folder.name} is connected for reading only, so it was not written there. The person can allow changes in the list of folders.`;
  const path = target.path?.trim() || file.name;
  let full: string;
  try {
    full = home.folders.locate(folder, path);
  } catch (error) {
    return `${inMessage} ${(error as Error).message}`;
  }
  const exists = existsSync(full);
  if (exists && !statSync(full).isFile()) return `${inMessage} ${path} is a folder.`;
  const card = home.store.createCard(
    {
      kind: "approval",
      level: "needs_you",
      title: exists
        ? `Replace ${basename(full)} in ${folder.name}?`
        : `Write ${basename(full)} into ${folder.name}?`,
      body: `${exists ? "Replaces the file" : "New file"} in **${folder.name}**: \`${path}\`\n\nThe file is in the message above, to look at first.`,
      actions: [
        { id: "write", label: exists ? "Replace file" : "Write file", style: "primary" },
        { id: "keep", label: "Don’t", style: "plain" },
      ],
      payload: { type: "document_write", folderId: folder.id, path, fileId: file.id },
    },
    { agentId: agent.id, conversationId, messageId: draft.id },
  );
  draft.add({ type: "card", card });
  return `${file.name} (${file.id}) is in your message, and a card asks the person whether to write it to ${path} in ${folder.name}. End your turn now with at most one short sentence. The answer arrives as the next message.`;
}

/** What the home does when the person answers the card of a made file. */
export function registerDocumentCards(home: Home): void {
  home.onCard("document_write", ({ card, action, payload }) => {
    const path = String(payload.path);
    if (action !== "write")
      return home.tell(
        card.conversationId,
        `The person said no to writing ${path}. Do not try it another way.`,
      );
    const folder = home.folders.list().find((each) => each.id === payload.folderId);
    if (folder?.access !== "write")
      return home.tell(card.conversationId, "The folder is not connected for changes any more.");
    const bytes = home.files.bytes(String(payload.fileId));
    if (!bytes) return home.tell(card.conversationId, `The file for ${path} is not kept any more.`);
    const full = home.folders.locate(folder, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, bytes);
    home.tell(card.conversationId, `${path} in ${folder.name} is written. Say so in one sentence.`);
  });
}

/** The tool every agent reads a file of the conversation with, again or further. */
export function readingTools(context: TurnContext): Tool[] {
  return [
    defineTool({
      name: "file_read",
      description:
        "Read the text of a file of this conversation: a Word, Excel or PowerPoint file, a PDF or a text file. `from` reads on in a long one.",
      input: z.object({
        file: z.string().describe("Its id (fil_…) or its name."),
        from: z.number().int().min(0).optional().describe("The character to read on from."),
      }),
      label: (input) => `Reading ${String(input.file ?? "a file")}`,
      run: async (input) => {
        const source = openSource(context, { file: input.file });
        const text =
          (await documentText(source.name, source.bytes)) ??
          (source.bytes.includes(0) ? undefined : Buffer.from(source.bytes).toString("utf8"));
        if (text === undefined)
          return `${source.name} is not a kind of file that can be read here.`;
        return piece(text, input.from ?? 0, READ_LIMIT, "read on with `from`") || "(no text)";
      },
    }),
  ];
}
