import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Folder } from "@wizards-bot/protocol";
import { z } from "zod";
import type { Call } from "../agent/tool.ts";
import { defineTool, type Tool } from "../agent/tool.ts";
import type { TurnContext } from "../agent/turns.ts";
import { isText } from "../files/check.ts";
import { langOf, say, w } from "../setup/words.ts";
import type { Folders } from "./folders.ts";
import { visible } from "./rules.ts";

// The tools that change files in connected folders. Each change asks the person on a card,
// unless they said "Always allow" for the folder; deleting asks every time. What is replaced
// or deleted goes to the Trash first. Mastra's filesystem writes, edits and makes folders; the
// home decides who may and keeps what was there.

/** The largest file an agent writes. */
export const WRITE_BYTES = 10 * 1024 * 1024;
/** What one turn changes under "Always allow" before it asks again. */
const ALWAYS_FILES = 50;
const ALWAYS_BYTES = 500 * 1024 * 1024;
/** What a disk keeps free: a write that would leave less is refused. */
const FREE_BYTES = 1024 * 1024 * 1024;
/** Characters of a file's text a card shows. */
const SHOWN = 1200;

/** What a change is about to do, for its card and for the limits. */
export interface Change {
  /** The folders it writes in. */
  folders: Folder[];
  /** The agent's one sentence for the person. */
  why: string;
  /** What the card shows below it, Markdown. */
  body: string;
  /** It deletes: a card every time, and no "Always allow" on it. */
  deletes?: boolean;
  files: number;
  bytes: number;
}

/** What one turn changed without a card, by its message. */
const spent = new WeakMap<object, { files: number; bytes: number }>();

/**
 * Whether the change may go ahead now: `true`, or what the tool returns instead (the card it
 * showed, the person's no, or why it is not allowed at all).
 */
export async function permit(
  folders: Folders,
  context: TurnContext,
  call: Call,
  change: Change,
): Promise<true | string> {
  if (context.byEvent())
    return "A task that an event started changes no files. Say in your answer what you would change; the person asks for it in the chat.";
  for (const folder of change.folders) {
    if (folder.access !== "write")
      return `${folder.name} is connected for reading only. The person can allow changes in the list of folders.`;
  }
  const answer = call.answer;
  if (answer) {
    if (answer.action === "deny")
      return `The person said no to this: ${change.why} Do not try it another way.`;
    if (answer.action === "always")
      for (const folder of change.folders) folders.setAllow(folder.id, "always");
    return true;
  }
  const used = spent.get(context.draft) ?? { files: 0, bytes: 0 };
  const always =
    !change.deletes &&
    change.folders.every((folder) => folders.byId(folder.id)?.allow === "always") &&
    !context.outside() &&
    used.files + change.files <= ALWAYS_FILES &&
    used.bytes + change.bytes <= ALWAYS_BYTES;
  if (always) {
    spent.set(context.draft, {
      files: used.files + change.files,
      bytes: used.bytes + change.bytes,
    });
    return true;
  }
  const lang = langOf(context.home.db);
  const names = change.folders.map((folder) => folder.name).join(", ");
  return call.ask({
    kind: "approval",
    level: "needs_you",
    title: change.why,
    body: change.body,
    actions: change.deletes
      ? [
          {
            id: "once",
            label: say(w("Move to the Trash", "In den Papierkorb"), lang),
            style: "danger",
          },
          { id: "deny", label: say(w("Don’t", "Nicht löschen"), lang), style: "plain" },
        ]
      : [
          { id: "once", label: say(w("Allow", "Erlauben"), lang), style: "primary" },
          {
            id: "always",
            label: say(w(`Always allow in ${names}`, `In ${names} immer erlauben`), lang),
            style: "plain",
          },
          { id: "deny", label: say(w("Don’t", "Nicht erlauben"), lang), style: "plain" },
        ],
  });
}

/** Throws when the disk `full` is on would keep less than it should after `bytes` more. */
export function roomFor(full: string, bytes: number): void {
  let dir = dirname(full);
  while (!existsSync(dir)) dir = dirname(dir);
  const disk = statfsSync(dir);
  if (disk.bavail * disk.bsize - bytes < FREE_BYTES)
    throw new Error("The disk is almost full. Nothing was written.");
}

/** The files and bytes a file or a folder holds, as a copy would write them. */
export function sizeOf(full: string): { files: number; bytes: number } {
  const stat = lstatSync(full);
  if (stat.isFile()) return { files: 1, bytes: stat.size };
  let files = 0;
  let bytes = 0;
  if (stat.isDirectory())
    for (const name of readdirSync(full)) {
      if (!visible(name)) continue;
      const inner = sizeOf(join(full, name));
      files += inner.files;
      bytes += inner.bytes;
    }
  return { files, bytes };
}

/** Copies a file or a folder without what is hidden, secret or a link. */
export function copyPlain(from: string, to: string): void {
  cpSync(from, to, {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: (source) => {
      if (source === from) return true;
      const stat = lstatSync(source, { throwIfNoEntry: false });
      return Boolean(stat && !stat.isSymbolicLink() && visible(basename(source)));
    },
  });
}

/** Moves a file or a folder to a place that is free, also onto another disk. */
function moveTo(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    copyPlain(from, to);
    rmSync(from, { recursive: true });
  }
}

/** Paths one move or delete takes at most. */
const BATCH = 200;
/** Lines of a list a card shows; the rest are counted. */
const LISTED = 30;

const listed = (lines: string[]): string =>
  lines
    .slice(0, LISTED)
    .map((line) => `- ${line}`)
    .join("\n") + (lines.length > LISTED ? `\n- … ${lines.length - LISTED} more` : "");

/** A text in a card: cut where it gets long. */
const shown = (text: string): string =>
  `\`\`\`\n${text.slice(0, SHOWN)}${text.length > SHOWN ? "\n…" : ""}\n\`\`\``;

const where = (folder: Folder, path: string) => `**${folder.name}** · \`${path}\``;

/** The tools that make, copy, write, edit, move and delete files. */
export function changeTools(folders: Folders, context: TurnContext): Tool[] {
  const { home } = context;
  const lang = () => langOf(home.db);
  const trashLine = () =>
    say(
      w("The old version goes to the Trash.", "Die alte Fassung kommt in den Papierkorb."),
      lang(),
    );
  return [
    defineTool({
      name: "folder_info",
      description:
        "What a file or folder in a connected folder is: its kind, size and when it changed.",
      input: z.object({ folder: z.string(), path: z.string() }),
      label: (input) => `Looking at ${String(input.path ?? "a file")}`,
      run: async (input) => {
        const folder = folders.named(input.folder);
        const full = folders.locate(folder, input.path);
        const stat = statSync(full, { throwIfNoEntry: false });
        if (!stat) return `There is nothing at ${input.path} in ${folder.name}.`;
        const kind = stat.isDirectory() ? "folder" : "file";
        return `${input.path}: ${kind}, ${stat.isDirectory() ? `${sizeOf(full).files} files` : `${stat.size} bytes`}, changed ${stat.mtime.toISOString()}`;
      },
    }),
    defineTool({
      name: "folder_make",
      description:
        "Make a folder (with the folders on the way) inside a connected folder. Asks the person unless they said “Always allow” for it.",
      input: z.object({
        folder: z.string().optional().describe("The folder's name; your own folder without one."),
        path: z.string().describe("The new folder, e.g. 2026/invoices."),
        why: z.string().describe("One sentence for the person: what it is for."),
      }),
      label: (input) => `Making the folder ${String(input.path ?? "")}`,
      asks: true,
      run: async (input, call) => {
        const folder = folders.named(input.folder);
        const full = folders.writable(folder, input.path);
        if (existsSync(full))
          return `There is something at ${input.path} in ${folder.name} already.`;
        const gate = await permit(folders, context, call, {
          folders: [folder],
          why: input.why,
          body: `${say(w("New folder in", "Neuer Ordner in"), lang())} ${where(folder, input.path)}`,
          files: 1,
          bytes: 0,
        });
        if (gate !== true) return gate;
        await folders.disk(folder).mkdir(folders.relative(input.path), { recursive: true });
        folders.noted(context, folder, { action: "make", path: input.path });
        return `The folder ${input.path} is made in ${folder.name}.`;
      },
    }),
    defineTool({
      name: "folder_copy",
      description:
        "Copy a file or folder to a new place: inside a connected folder or into another one connected for changes. The new place must not be there yet. Asks the person unless they said “Always allow” for the folder it goes to.",
      input: z.object({
        folder: z.string().describe("The folder the file is in."),
        from: z.string(),
        to: z.string().describe("The new path."),
        toFolder: z.string().optional().describe("Another connected folder to copy into."),
        why: z.string().describe("One sentence for the person: what this is for."),
      }),
      label: (input) => `Copying ${String(input.from ?? "a file")}`,
      asks: true,
      run: async (input, call) => {
        const source = folders.named(input.folder);
        const target = input.toFolder ? folders.named(input.toFolder) : source;
        const from = folders.locate(source, input.from);
        const to = folders.writable(target, input.to);
        if (!existsSync(from)) return `There is nothing at ${input.from} in ${source.name}.`;
        if (existsSync(to)) return `There is something at ${input.to} in ${target.name} already.`;
        const size = sizeOf(from);
        const gate = await permit(folders, context, call, {
          folders: [target],
          why: input.why,
          body: `${where(source, input.from)} → ${where(target, input.to)}`,
          ...size,
        });
        if (gate !== true) return gate;
        roomFor(to, size.bytes);
        copyPlain(from, to);
        folders.noted(context, target, {
          action: "copy",
          path: input.to,
          from: `${source.name}/${input.from}`,
          bytes: size.bytes,
        });
        return `${input.from} is copied to ${input.to} in ${target.name}.`;
      },
    }),
    defineTool({
      name: "folder_write",
      description:
        "Write a file in a folder connected for changes: a text (`content`), or a file of this conversation (`file`, e.g. a Word file you made or a picture the person sent). A new file, or the new full text of one that exists. Without `folder`, your own folder, where new files for the person go. Asks the person unless they said “Always allow” for the folder.",
      input: z.object({
        folder: z.string().optional().describe("The folder's name; your own folder without one."),
        path: z.string(),
        content: z.string().optional().describe("The file's full text."),
        file: z
          .string()
          .optional()
          .describe("Instead of `content`: the id of a file of this conversation."),
        why: z.string().describe("One sentence for the person: what this changes."),
      }),
      label: (input) => `Writing ${String(input.path ?? "a file")}`,
      asks: true,
      run: async (input, call) => {
        if ((input.content === undefined) === (input.file === undefined))
          return "Give either `content` or `file`.";
        const folder = folders.named(input.folder);
        const full = folders.writable(folder, input.path);
        const exists = existsSync(full);
        if (exists && !statSync(full).isFile()) return `${input.path} is a folder.`;
        let bytes: Uint8Array;
        let preview: string;
        if (input.file !== undefined) {
          const stored = home.files.get(input.file);
          const data = stored && home.files.bytes(input.file);
          if (!stored || !data) return `There is no file ${input.file} in this conversation.`;
          bytes = data;
          preview = `${say(w("The file", "Die Datei"), lang())} ${stored.name}`;
        } else {
          bytes = Buffer.from(input.content ?? "", "utf8");
          preview = shown(input.content ?? "");
        }
        if (bytes.byteLength > WRITE_BYTES)
          return `${input.path} would be ${Math.round(bytes.byteLength / 1024 / 1024)} MB: larger than an agent writes.`;
        const gate = await permit(folders, context, call, {
          folders: [folder],
          why: input.why,
          body: `${exists ? say(w("Replaces", "Ersetzt"), lang()) : say(w("New file in", "Neue Datei in"), lang())} ${where(folder, input.path)}${exists ? ` ${trashLine()}` : ""}\n\n${preview}`,
          files: 1,
          bytes: bytes.byteLength,
        });
        if (gate !== true) return gate;
        roomFor(full, bytes.byteLength);
        const kept = exists ? folders.trash.keep(full) : undefined;
        await folders.write(folder, input.path, bytes);
        folders.noted(context, folder, {
          action: exists ? "replace" : "write",
          path: input.path,
          bytes: bytes.byteLength,
          ...(kept ? { kept } : {}),
        });
        return `${input.path} in ${folder.name} is written.`;
      },
    }),
    defineTool({
      name: "folder_edit",
      description:
        "Change a passage of a text file in a folder connected for changes: `old` is replaced by `new`. `old` must stand in the file exactly once, as you read it. Asks the person unless they said “Always allow” for the folder.",
      input: z.object({
        folder: z.string().optional().describe("The folder's name; your own folder without one."),
        path: z.string(),
        old: z.string().min(1).describe("The passage as it stands in the file now."),
        new: z.string().describe("What it becomes."),
        why: z.string().describe("One sentence for the person: what this changes."),
      }),
      label: (input) => `Changing ${String(input.path ?? "a file")}`,
      asks: true,
      run: async (input, call) => {
        const folder = folders.named(input.folder);
        const full = folders.writable(folder, input.path);
        const stat = statSync(full, { throwIfNoEntry: false });
        if (!stat?.isFile()) return `There is no file ${input.path} in ${folder.name}.`;
        if (stat.size > WRITE_BYTES) return `${input.path} is too large to change here.`;
        const bytes = readFileSync(full);
        if (!isText(bytes)) return `${input.path} is not a text file.`;
        const text = bytes.toString("utf8");
        const times = text.split(input.old).length - 1;
        if (times !== 1)
          return times
            ? `The passage stands ${times} times in ${input.path}. Give a longer one that stands once.`
            : `The passage is not in ${input.path} as it is now. Read the file again.`;
        const changed = text.replace(input.old, () => input.new);
        const gate = await permit(folders, context, call, {
          folders: [folder],
          why: input.why,
          body: `${say(w("Changes", "Ändert"), lang())} ${where(folder, input.path)} ${trashLine()}\n\n\`\`\`diff\n${input.old
            .slice(0, SHOWN / 2)
            .split("\n")
            .map((line) => `- ${line}`)
            .join("\n")}\n${input.new
            .slice(0, SHOWN / 2)
            .split("\n")
            .map((line) => `+ ${line}`)
            .join("\n")}\n\`\`\``,
          files: 1,
          bytes: Buffer.byteLength(changed),
        });
        if (gate !== true) return gate;
        const kept = folders.trash.keep(full);
        await folders.disk(folder).writeFile(folders.relative(input.path), changed, {
          expectedMtime: stat.mtime,
        });
        folders.noted(context, folder, {
          action: "edit",
          path: input.path,
          bytes: Buffer.byteLength(changed),
          kept,
        });
        return `${input.path} in ${folder.name} is changed.`;
      },
    }),
    defineTool({
      name: "folder_move",
      description: `Move or rename files and folders, up to ${BATCH} in one call: inside a folder connected for changes, or into another one with \`toFolder\`. Each new place must not be there yet. One card for the whole list, unless the person said “Always allow” for the folders.`,
      input: z.object({
        folder: z.string().describe("The folder the files are in."),
        moves: z
          .array(z.object({ from: z.string(), to: z.string() }))
          .min(1)
          .max(BATCH)
          .describe('E.g. [{"from": "scan1.pdf", "to": "2026/Q1/scan1.pdf"}].'),
        toFolder: z.string().optional().describe("Another connected folder to move into."),
        why: z.string().describe("One sentence for the person: what this sorts or renames."),
      }),
      label: (input) => {
        const moves = Array.isArray(input.moves) ? input.moves : [];
        return moves.length === 1 ? "Moving a file" : `Moving ${moves.length} files`;
      },
      asks: true,
      run: async (input, call) => {
        const source = folders.named(input.folder);
        const target = input.toFolder ? folders.named(input.toFolder) : source;
        const planned: { from: string; to: string; move: { from: string; to: string } }[] = [];
        const taken = new Set<string>();
        let files = 0;
        let bytes = 0;
        for (const move of input.moves) {
          const from = folders.locate(source, move.from);
          const to = folders.writable(target, move.to);
          if (from === source.path) return "The connected folder itself is not moved.";
          if (!existsSync(from)) return `There is nothing at ${move.from} in ${source.name}.`;
          if (existsSync(to) || taken.has(to))
            return `There is something at ${move.to} in ${target.name} already.`;
          if (to === from || to.startsWith(`${from}/`))
            return `${move.from} cannot go into itself.`;
          taken.add(to);
          const size = sizeOf(from);
          files += size.files;
          bytes += size.bytes;
          planned.push({ from, to, move });
        }
        const same = source.id === target.id;
        const gate = await permit(folders, context, call, {
          folders: same ? [source] : [source, target],
          why: input.why,
          body: listed(
            input.moves.map(
              (move) => `\`${move.from}\` → ${same ? "" : `**${target.name}** · `}\`${move.to}\``,
            ),
          ),
          files,
          bytes,
        });
        if (gate !== true) return gate;
        for (const { from, to, move } of planned) {
          if (same) {
            const rel = folders.relative(move.to);
            const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
            if (parent) await folders.disk(source).mkdir(parent, { recursive: true });
            await folders.disk(source).moveFile(folders.relative(move.from), rel, {
              overwrite: false,
            });
          } else moveTo(from, to);
          folders.noted(context, target, {
            action: "move",
            path: move.to,
            from: `${source.name}/${move.from}`,
          });
        }
        const [first] = input.moves;
        return planned.length === 1 && first
          ? `${first.from} is now ${first.to} in ${target.name}.`
          : `${planned.length} files and folders are moved to ${target.name}.`;
      },
    }),
    defineTool({
      name: "folder_delete",
      description: `Move files or folders of a folder connected for changes to the Trash, up to ${BATCH} in one call. Always asks the person, with one card for the whole list.`,
      input: z.object({
        folder: z.string(),
        paths: z.array(z.string()).min(1).max(BATCH),
        why: z.string().describe("One sentence for the person: why these go."),
      }),
      label: (input) => {
        const paths = Array.isArray(input.paths) ? input.paths : [];
        return paths.length === 1
          ? `Deleting ${String(paths[0])}`
          : `Deleting ${paths.length} files`;
      },
      asks: true,
      run: async (input, call) => {
        const folder = folders.named(input.folder);
        const fulls: string[] = [];
        let files = 0;
        for (const path of input.paths) {
          const full = folders.locate(folder, path);
          if (full === folder.path)
            return "The connected folder itself is not deleted. Disconnect it instead.";
          if (!existsSync(full)) return `There is nothing at ${path} in ${folder.name}.`;
          files += sizeOf(full).files;
          fulls.push(full);
        }
        const gate = await permit(folders, context, call, {
          folders: [folder],
          why: input.why,
          deletes: true,
          body: `${say(w("To the Trash, from", "In den Papierkorb, aus"), lang())} **${folder.name}**:\n\n${listed(input.paths.map((path) => `\`${path}\``))}`,
          files,
          bytes: 0,
        });
        if (gate !== true) return gate;
        input.paths.forEach((path, index) => {
          const kept = folders.trash.put(fulls[index] as string);
          folders.noted(context, folder, { action: "delete", path, kept });
        });
        const [first] = input.paths;
        return input.paths.length === 1
          ? `${first} went to the Trash.`
          : `${input.paths.length} files and folders went to the Trash.`;
      },
    }),
  ];
}
