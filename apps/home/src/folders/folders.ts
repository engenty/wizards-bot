import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type ConnectFolder,
  FOLDER_PREVIEW_LIMIT,
  type Folder,
  type FolderListing,
  type FolderPreview,
  type MakeFolder,
} from "@wizards-bot/protocol";
import { z } from "zod";
import { defineTool, type Tool } from "../agent/tool.ts";
import type { TurnContext } from "../agent/turns.ts";
import { isText, sniff } from "../files/check.ts";
import { forModel, type Picture } from "../files/pictures.ts";
import type { Home } from "../home.ts";
import { newId, now } from "../ids.ts";
import { langOf, say, w } from "../setup/words.ts";
import { documentKind, documentText, piece } from "../skills/office/read.ts";

// Folders of the home's computer that agents may use. The files stay where they are: the
// home reads them in place when an agent asks, and copies nothing. An agent changes a file
// only in a folder connected for that, and only after the person said yes to that change.

const ENDS_TURN =
  "The card is in the chat. End your turn now with at most one short sentence. The answer arrives as the next message.";
/** Folders no home connects: the whole disk and what the system keeps there. */
const SYSTEM = [
  "/",
  "/System",
  "/Library",
  "/usr",
  "/bin",
  "/sbin",
  "/etc",
  "/var",
  "/private",
  "/dev",
  "/proc",
  "/sys",
  "/boot",
  "/opt",
  "/Applications",
  "/Volumes",
];
/** Names that are passed over everywhere: hidden files, and folders that hold no one's own work. */
const SKIPPED = new Set([
  "node_modules",
  "__pycache__",
  "$RECYCLE.BIN",
  "System Volume Information",
]);
/** The meta key that names the agents' own folder by its id. */
const OWN = "folders.own";
/** The name of the agents' own folder the setup suggests in the person's home folder. */
const OWN_NAME = "wizards";
const READ_LIMIT = 60_000;
const READ_BYTES = 2 * 1024 * 1024;
/** A Word, Excel or PowerPoint file or a PDF may be larger: its text is a small part of it. */
const DOCUMENT_BYTES = 20 * 1024 * 1024;
/** A picture may be a large photo: it is made smaller before a model sees it. */
const PICTURE_BYTES = 40 * 1024 * 1024;
/** Pictures one look shows at most. */
const LOOK_LIMIT = 8;
const LIST_LIMIT = 300;
const SEARCH_FILES = 4000;
const SEARCH_HITS = 40;

export class FolderRefused extends Error {
  readonly code: "not_found" | "invalid";
  constructor(code: FolderRefused["code"], message: string) {
    super(message);
    this.code = code;
  }
}

interface Row {
  id: string;
  name: string;
  path: string;
  access: string;
  created_at: string;
}

const visible = (name: string): boolean =>
  !name.startsWith(".") && !name.startsWith("~$") && !SKIPPED.has(name);

/**
 * A folder the picker may show: the person's home folder `top` or one inside it, with no
 * hidden folder on the way.
 */
function inHome(top: string, real: string): string {
  const inside = relative(top, real);
  if (inside.startsWith("..") || isAbsolute(inside))
    throw new FolderRefused("invalid", "Only folders in your home folder are shown here.");
  if (inside.split(sep).some((part) => part && !visible(part)))
    throw new FolderRefused("invalid", "A hidden folder is not shown here.");
  return real;
}

/** `~` and `~/…` as the person's home folder. */
const expand = (path: string): string =>
  path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

export class Folders {
  private readonly home: Home;

  constructor(home: Home) {
    this.home = home;
    home.addTools((context) => this.tools(context));
    this.registerCards();
  }

  list(): Folder[] {
    const own = this.home.db.meta(OWN);
    return this.home.db
      .all<Row>("select * from folder order by name")
      .map((row) => ({ ...toFolder(row), ...(row.id === own ? { own: true } : {}) }));
  }

  /** The agents' own folder, where they keep what they make for the person. */
  own(): Folder | undefined {
    return this.list().find((folder) => folder.own);
  }

  /**
   * Where the agents' own folder is, or would be: the one connected, else `~/wizards`, which
   * the setup suggests.
   */
  ownPlace(): { path: string; connected: boolean; exists: boolean } {
    const own = this.own();
    const path = own?.path ?? join(realpathSync(homedir()), OWN_NAME);
    return {
      path,
      connected: Boolean(own),
      exists: existsSync(path) && statSync(path).isDirectory(),
    };
  }

  byName(name: string): Folder | undefined {
    const row = this.home.db.get<Row>(
      "select * from folder where name = ? collate nocase",
      name.trim(),
    );
    return row ? toFolder(row) : undefined;
  }

  /**
   * The folders inside a folder, for the folder picker. Only the person's home folder and what
   * is in it, only folders, nothing hidden; without a path it starts at the home folder. A path
   * whose last part is not a folder yet (a half-typed name) lists its parent.
   */
  browse(path?: string): FolderListing {
    const top = realpathSync(homedir());
    const wanted = resolve(top, expand(path?.trim() || top));
    const at = existsSync(wanted) && statSync(wanted).isDirectory() ? wanted : dirname(wanted);
    if (!existsSync(at) || !statSync(at).isDirectory())
      throw new FolderRefused("not_found", "There is no such folder on the Bot Server’s computer.");
    const real = inHome(top, realpathSync(at));
    const folders = safeEntries(real)
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: join(real, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, LIST_LIMIT);
    return { path: real, parent: real === top ? null : dirname(real), home: top, folders };
  }

  /** Makes a new folder in a folder of the person's home folder, and lists it. */
  makeFolder(input: MakeFolder): FolderListing {
    const wanted = resolve(realpathSync(homedir()), expand(input.parent.trim()));
    if (!existsSync(wanted) || !statSync(wanted).isDirectory())
      throw new FolderRefused("not_found", "There is no such folder on the Bot Server’s computer.");
    const parent = this.browse(wanted);
    const name = input.name.trim();
    if (/[/\\:]/.test(name) || !visible(name))
      throw new FolderRefused("invalid", "A folder’s name cannot start with a dot or hold / or :.");
    const target = join(parent.path, name);
    if (existsSync(target))
      throw new FolderRefused("invalid", `There is a folder or file named “${name}” already.`);
    mkdirSync(target);
    return this.browse(target);
  }

  /** What a folder holds, counted up to a limit. Throws `FolderRefused` for a folder no home connects. */
  preview(path: string): FolderPreview {
    const root = this.allowed(path);
    let files = 0;
    let folders = 0;
    let bytes = 0;
    let more = false;
    const walk = (dir: string): void => {
      for (const entry of safeEntries(dir)) {
        if (files >= FOLDER_PREVIEW_LIMIT) {
          more = true;
          return;
        }
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          folders++;
          walk(full);
        } else if (entry.isFile()) {
          files++;
          bytes += statSync(full, { throwIfNoEntry: false })?.size ?? 0;
        }
      }
    };
    walk(root);
    return { path: root, name: basename(root), files, folders, bytes, more };
  }

  connect(input: ConnectFolder): Folder {
    if (input.own) return this.connectOwn(input.path);
    const path = this.allowed(input.path);
    const existing = this.list().find((folder) => folder.path === path);
    if (existing) return this.setAccess(existing.id, input.access) as Folder;
    let name = basename(path);
    for (let n = 2; this.byName(name); n++) name = `${basename(path)} ${n}`;
    const id = newId("fld");
    this.home.db.run(
      "insert into folder (id, name, path, access, created_at) values (?, ?, ?, ?, ?)",
      id,
      name,
      path,
      input.access,
      now(),
    );
    this.changed();
    return this.list().find((folder) => folder.id === id) as Folder;
  }

  /**
   * Makes a folder the agents' own: connected for changes, the one before it stays connected as
   * it was. A folder that is not there yet is made, inside the person's home folder only.
   */
  private connectOwn(path: string): Folder {
    const top = realpathSync(homedir());
    const wanted = resolve(top, expand(path.trim()));
    if (!existsSync(wanted)) {
      if (!existsSync(dirname(wanted)))
        throw new FolderRefused(
          "not_found",
          "There is no such folder on the Bot Server’s computer.",
        );
      inHome(top, join(realpathSync(dirname(wanted)), basename(wanted)));
      mkdirSync(wanted);
    }
    const folder = this.connect({ path: wanted, access: "write" });
    this.home.db.setMeta(OWN, folder.id);
    this.changed();
    return this.list().find((each) => each.id === folder.id) as Folder;
  }

  setAccess(id: string, access: Folder["access"]): Folder | undefined {
    this.home.db.run("update folder set access = ? where id = ?", access, id);
    this.changed();
    return this.list().find((folder) => folder.id === id);
  }

  disconnect(id: string): void {
    this.home.db.run("delete from folder where id = ?", id);
    if (this.home.db.meta(OWN) === id) this.home.db.setMeta(OWN, "");
    this.changed();
  }

  /** A path inside a connected folder as a path on the disk. Nothing outside the folder is ever reached. */
  locate(folder: Folder, path: string): string {
    const parts = path.split(/[\\/]+/).filter((part) => part && part !== ".");
    if (parts.some((part) => part === ".." || !visible(part))) {
      throw new FolderRefused("invalid", `“${path}” is not a path inside ${folder.name}.`);
    }
    const full = join(folder.path, ...parts);
    // A link inside the folder may point out of it: the place it really leads to decides.
    let known = full;
    while (!existsSync(known)) known = dirname(known);
    const real = realpathSync(known);
    if (real !== folder.path && !real.startsWith(folder.path + sep)) {
      throw new FolderRefused("invalid", `“${path}” leads out of ${folder.name}.`);
    }
    return full;
  }

  /**
   * The files a connected folder holds, or `path` inside it, each with a stamp that changes
   * when the file does. Nothing hidden and no link is among them. Nothing when the place is
   * not there; `more` when there are more files than `limit`.
   */
  files(
    folder: Folder,
    path = "",
    limit = SEARCH_FILES,
  ): { files: Map<string, string>; more: boolean } | undefined {
    const root = this.locate(folder, path);
    if (!existsSync(root) || !statSync(root).isDirectory()) return undefined;
    const files = new Map<string, string>();
    let more = false;
    const walk = (dir: string, prefix: string): void => {
      for (const entry of safeEntries(dir)) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(join(dir, entry.name), relative);
        else if (entry.isFile()) {
          if (files.size >= limit) {
            more = true;
            return;
          }
          const stat = statSync(join(dir, entry.name), { throwIfNoEntry: false });
          if (stat) files.set(relative, `${Math.round(stat.mtimeMs)}:${stat.size}`);
        }
      }
    };
    walk(root, "");
    return { files, more };
  }

  /** The folder's real path, when a home may connect it. */
  private allowed(path: string): string {
    const wanted = resolve(expand(path.trim()));
    if (!existsSync(wanted) || !statSync(wanted).isDirectory()) {
      throw new FolderRefused("not_found", "There is no such folder on the Bot Server’s computer.");
    }
    const real = realpathSync(wanted);
    const data = realpathSync(this.home.config.dataDir);
    if (
      SYSTEM.includes(real) ||
      real === realpathSync(homedir()) ||
      real === dirname(realpathSync(homedir()))
    ) {
      throw new FolderRefused(
        "invalid",
        "Choose a folder with your own files in it, not the whole disk or your whole home folder.",
      );
    }
    if (real === data || real.startsWith(data + sep) || data.startsWith(real + sep)) {
      throw new FolderRefused(
        "invalid",
        "This folder holds the Bot Server’s own data. Choose another one.",
      );
    }
    if (real.split(sep).some((part) => part.startsWith("."))) {
      throw new FolderRefused("invalid", "A hidden folder cannot be connected.");
    }
    return real;
  }

  private changed(): void {
    this.home.events.emit({ type: "folders.updated", folders: this.list() });
  }

  // ── What the agents can do ────────────────────────────────────────────────

  private tools(context: TurnContext): Tool[] {
    const { home, agent, conversationId, draft } = context;
    const where = { agentId: agent.id, conversationId, messageId: draft.id };
    const named = (name: string): Folder => {
      const folder = this.byName(name);
      if (!folder) {
        const known = this.list().map((each) => each.name);
        throw new Error(
          known.length
            ? `There is no connected folder ${name}. Connected: ${known.join(", ")}.`
            : "No folder is connected.",
        );
      }
      return folder;
    };
    const use: Tool[] = [
      defineTool({
        name: "folder_list",
        description:
          "List what a connected folder of the person's computer holds, or one of its subfolders.",
        input: z.object({
          folder: z.string().describe("The folder's name."),
          path: z.string().optional().describe("A subfolder, e.g. 2026/invoices."),
        }),
        label: (input) => `Looking into ${String(input.folder ?? "a folder")}`,
        run: async (input) => {
          const folder = named(input.folder);
          const dir = this.locate(folder, input.path ?? "");
          if (!existsSync(dir) || !statSync(dir).isDirectory())
            return `There is no folder ${input.path} in ${folder.name}.`;
          const entries = safeEntries(dir).sort(
            (a, b) =>
              Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
          );
          const lines = entries.slice(0, LIST_LIMIT).map((entry) => {
            if (entry.isDirectory()) return `${entry.name}/`;
            const size = statSync(join(dir, entry.name), { throwIfNoEntry: false })?.size ?? 0;
            return `${entry.name} (${Math.max(1, Math.round(size / 1024))} KB)`;
          });
          const cut = entries.length > LIST_LIMIT ? `\n[${entries.length - LIST_LIMIT} more]` : "";
          return lines.length ? lines.join("\n") + cut : "This folder is empty.";
        },
      }),
      defineTool({
        name: "folder_read",
        description:
          "Read a file in a connected folder: a text file, or the text of a Word, Excel or PowerPoint file or a PDF.",
        input: z.object({
          folder: z.string(),
          path: z.string().describe("The file, e.g. notes/plan.md."),
          from: z
            .number()
            .int()
            .min(0)
            .optional()
            .describe("In a long document: the character to read on from."),
        }),
        label: (input) => `Reading ${String(input.path ?? "a file")}`,
        run: async (input) => {
          const folder = named(input.folder);
          const file = this.locate(folder, input.path);
          const stat = statSync(file, { throwIfNoEntry: false });
          if (!stat?.isFile()) return `There is no file ${input.path} in ${folder.name}.`;
          const document = documentKind(input.path) !== undefined;
          if (stat.size > (document ? DOCUMENT_BYTES : READ_BYTES))
            return `${input.path} is too large to read here (${Math.round(stat.size / 1024 / 1024)} MB).`;
          const bytes = readFileSync(file);
          if (document) {
            try {
              const text = (await documentText(input.path, bytes)) ?? "";
              return piece(text, input.from ?? 0, READ_LIMIT, "read on with `from`") || "(no text)";
            } catch (error) {
              return (error as Error).message;
            }
          }
          if (sniff(bytes)?.startsWith("image/"))
            return `${input.path} is a picture. Look at it with \`folder_look\`.`;
          if (!isText(bytes)) return `${input.path} is not a text file and not a picture.`;
          const text = bytes.toString("utf8");
          return text.length > READ_LIMIT
            ? `${text.slice(0, READ_LIMIT)}\n[cut: ${text.length} characters in all]`
            : text;
        },
      }),
      defineTool({
        name: "folder_look",
        description: `Look at pictures in a connected folder: photos (also HEIC from a phone), scans, screenshots. Up to ${LOOK_LIMIT} at a time; you see them after the text.`,
        input: z.object({
          folder: z.string(),
          paths: z
            .array(z.string())
            .min(1)
            .max(LOOK_LIMIT)
            .describe('The pictures, e.g. ["IMG_7159.HEIC"].'),
        }),
        label: (input) => {
          const paths = Array.isArray(input.paths) ? input.paths : [];
          return paths.length === 1
            ? `Looking at ${String(paths[0])}`
            : `Looking at ${paths.length} pictures`;
        },
        run: async (input) => {
          const folder = named(input.folder);
          const pictures: Picture[] = [];
          const lines: string[] = [];
          for (const path of input.paths) {
            const file = this.locate(folder, path);
            const stat = statSync(file, { throwIfNoEntry: false });
            if (!stat?.isFile()) {
              lines.push(`There is no file ${path} in ${folder.name}.`);
              continue;
            }
            if (stat.size > PICTURE_BYTES) {
              lines.push(
                `${path} is too large to look at (${Math.round(stat.size / 1024 / 1024)} MB).`,
              );
              continue;
            }
            const bytes = readFileSync(file);
            const mime = sniff(bytes);
            if (!mime?.startsWith("image/")) {
              lines.push(`${path} is not a picture.`);
              continue;
            }
            const picture = await forModel(path, mime, bytes);
            if (typeof picture === "string") lines.push(picture);
            else {
              pictures.push(picture);
              lines.push(`Picture ${pictures.length}: ${path}`);
            }
          }
          return pictures.length ? { text: lines.join("\n"), pictures } : lines.join("\n");
        },
      }),
      defineTool({
        name: "folder_search",
        description:
          "Find files in the connected folders by a word in their name or in their text.",
        input: z.object({
          query: z.string().min(2),
          folder: z.string().optional().describe("Only this folder."),
        }),
        label: (input) => `Searching the folders for ${String(input.query ?? "")}`,
        run: async (input) => {
          const folders = input.folder ? [named(input.folder)] : this.list();
          if (!folders.length) return "No folder is connected.";
          const needle = input.query.toLowerCase();
          const hits: string[] = [];
          let seen = 0;
          const walk = (folder: Folder, dir: string, prefix: string): void => {
            for (const entry of safeEntries(dir)) {
              if (hits.length >= SEARCH_HITS || seen >= SEARCH_FILES) return;
              const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
              const full = join(dir, entry.name);
              if (entry.isDirectory()) {
                walk(folder, full, relative);
                continue;
              }
              if (!entry.isFile()) continue;
              seen++;
              if (entry.name.toLowerCase().includes(needle))
                hits.push(`${folder.name}: ${relative}`);
              const stat = statSync(full, { throwIfNoEntry: false });
              if (!stat || stat.size > READ_BYTES) continue;
              const bytes = readFileSync(full);
              if (!isText(bytes)) continue;
              for (const [at, line] of bytes.toString("utf8").split("\n").entries()) {
                if (hits.length >= SEARCH_HITS) break;
                if (line.toLowerCase().includes(needle))
                  hits.push(`${folder.name}: ${relative}:${at + 1}: ${line.trim().slice(0, 200)}`);
              }
            }
          };
          for (const folder of folders) walk(folder, folder.path, "");
          return hits.length ? hits.join("\n") : `Nothing found for “${input.query}”.`;
        },
      }),
      defineTool({
        name: "folder_write",
        description:
          "Write a text file in a connected folder: a new file, or the new full text of one that exists. Only in a folder the person connected for changes. Without `folder`, your own folder, where new files for the person go. Asks the person first. Ends your turn.",
        input: z.object({
          folder: z.string().optional().describe("The folder's name; your own folder without one."),
          path: z.string(),
          content: z.string().describe("The file's full text."),
          why: z.string().describe("One sentence for the person: what this changes."),
        }),
        label: (input) => `Asking to change ${String(input.path ?? "a file")}`,
        run: async (input) => {
          const own = this.own();
          if (!input.folder && !own)
            return "You have no folder of your own. Name a connected folder.";
          const folder = input.folder ? named(input.folder) : (own as Folder);
          if (folder.access !== "write")
            return `${folder.name} is connected for reading only. The person can allow changes in the list of folders.`;
          const file = this.locate(folder, input.path);
          const exists = existsSync(file);
          if (exists && !statSync(file).isFile()) return `${input.path} is a folder.`;
          const card = home.store.createCard(
            {
              kind: "approval",
              level: "needs_you",
              title: input.why,
              body: `${exists ? "Changes" : "New file"} in **${folder.name}**: \`${input.path}\`\n\n\`\`\`\n${input.content.slice(0, 1200)}${input.content.length > 1200 ? "\n…" : ""}\n\`\`\``,
              actions: [
                { id: "write", label: exists ? "Change file" : "Write file", style: "primary" },
                { id: "keep", label: "Don’t", style: "plain" },
              ],
              payload: {
                type: "folder_write",
                folderId: folder.id,
                path: input.path,
                content: input.content,
              },
            },
            where,
          );
          draft.add({ type: "card", card });
          return ENDS_TURN;
        },
      }),
    ];
    if (!agent.main) return this.list().length ? use : [];
    return [
      ...(this.list().length ? use : []),
      defineTool({
        name: "folder_connect",
        description:
          "Connect a folder of the Bot Server's computer, so agents can read its files (`read`) or also change them after asking (`write`). Shows the person a card where they pick the folder and say yes in one go. Leave out `path` unless the person wrote the exact path: never ask for a path, in a question or otherwise. Ends your turn.",
        input: z.object({
          purpose: z
            .string()
            .describe(
              "One short line in the person's language: what the folder is for, e.g. “A folder for the legal texts Lex keeps”.",
            ),
          access: z.enum(["read", "write"]),
          path: z
            .string()
            .optional()
            .describe("Only a path the person wrote. The card then starts with that folder."),
        }),
        label: () => "Asking to connect a folder",
        asks: true,
        run: async (input, call) => {
          if (call.answer) {
            const picked = call.answer.values.folder;
            if (call.answer.action !== "connect" || typeof picked !== "string" || !picked)
              return "The person did not connect a folder. Do not ask for its path.";
            const chosen = call.answer.values.access;
            const folder = this.connect({
              path: picked,
              access: chosen === "read" || chosen === "write" ? chosen : input.access,
            });
            return `The folder ${folder.name} is connected (${folder.access === "write" ? "read and change after asking" : "read only"}). Go on with what the person wanted.`;
          }
          let start: string | undefined;
          if (input.path) {
            try {
              start = this.preview(input.path).path;
            } catch (error) {
              return `${(error as Error).message} Call \`folder_connect\` again without \`path\`: the person picks the folder.`;
            }
          }
          const lang = langOf(home.db);
          return call.ask({
            kind: "question",
            level: "needs_you",
            title: input.purpose,
            body: say(
              w("The files stay where they are.", "Die Dateien bleiben, wo sie sind."),
              lang,
            ),
            fields: [
              {
                id: "folder",
                label: say(w("Folder", "Ordner"), lang),
                type: "folder",
                required: true,
                ...(start ? { value: start } : {}),
              },
              {
                id: "access",
                label: say(
                  w("What may your agents do in it?", "Was dürfen deine Agenten darin?"),
                  lang,
                ),
                type: "choice",
                required: true,
                value: input.access,
                options: [
                  { id: "read", label: say(w("Read only", "Nur lesen"), lang) },
                  {
                    id: "write",
                    label: say(
                      w("Read and change, after asking", "Lesen und ändern, nach Rückfrage"),
                      lang,
                    ),
                  },
                ],
              },
            ],
            actions: [
              { id: "connect", label: say(w("Connect", "Verbinden"), lang), style: "primary" },
              { id: "keep", label: say(w("Don’t", "Nicht verbinden"), lang), style: "plain" },
            ],
          });
        },
      }),
      defineTool({
        name: "folder_disconnect",
        description: "Disconnect a folder. Nothing on the disk changes.",
        input: z.object({ folder: z.string() }),
        label: (input) => `Disconnecting ${String(input.folder ?? "a folder")}`,
        run: async (input) => {
          const folder = named(input.folder);
          this.disconnect(folder.id);
          return `${folder.name} is disconnected.`;
        },
      }),
    ];
  }

  private registerCards(): void {
    const { home } = this;
    home.onCard("folder_write", ({ card, action, payload }) => {
      const folder = this.list().find((each) => each.id === payload.folderId);
      const path = String(payload.path);
      if (action !== "write")
        return home.tell(
          card.conversationId,
          `The person said no to changing ${path}. Do not try it another way.`,
        );
      if (folder?.access !== "write")
        return home.tell(card.conversationId, `The folder is not connected for changes any more.`);
      const file = this.locate(folder, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, String(payload.content));
      home.tell(
        card.conversationId,
        `${path} in ${folder.name} is written. Say so in one sentence.`,
      );
    });
  }
}

/**
 * A folder's visible files and folders. Links are left out: where one leads is not part of
 * the folder. A folder that cannot be read holds nothing.
 */
function safeEntries(dir: string) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter(
      (entry) => visible(entry.name) && !entry.isSymbolicLink(),
    );
  } catch {
    return [];
  }
}

function toFolder(row: Row): Folder {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    access: row.access as Folder["access"],
    createdAt: row.created_at,
  };
}
