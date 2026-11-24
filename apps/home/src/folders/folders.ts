import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { LocalFilesystem } from "@mastra/core/workspace";
import {
  type ConnectFolder,
  FOLDER_PREVIEW_LIMIT,
  type Folder,
  type FolderActivity,
  type FolderEdit,
  type FolderEntries,
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
import { changeTools } from "./changes.ts";
import {
  badPart,
  executable,
  inside,
  noLinks,
  refusedFolder,
  sharedFile,
  visible,
} from "./rules.ts";
import { Trash } from "./trash.ts";

// Folders of the home's computer that agents may use. The files stay where they are: the
// home reads them in place when an agent asks, and copies nothing. An agent changes a file
// only in a folder connected for that, and only after the person said yes to that change.

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

/** One change in a folder's activity: what was done where, and where the old one went. */
export interface FolderChange {
  action: "make" | "write" | "replace" | "edit" | "copy" | "move" | "delete";
  path: string;
  /** A copy's or a move's source: its folder's id and its path there. */
  fromFolder?: string;
  from?: string;
  bytes?: number;
  /** Where the old version or the deleted file is now, in the Trash. */
  kept?: string;
  at?: string;
}

interface ActivityRow {
  id: string;
  folder_id: string;
  agent_id: string | null;
  conversation_id: string | null;
  read: number;
  changes: string;
  undone: string;
  at: string;
}

/** Activity rows the file browser gets at once, and how long they are kept. */
const ACTIVITY_SHOWN = 100;
const ACTIVITY_DAYS = 90;
/** Entries of one place the file browser lists. */
const ENTRIES_SHOWN = 500;

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
  allow: string;
  created_at: string;
}

/** A place the picker starts at: the person's home folder or a disk. */
interface Place {
  name: string;
  path: string;
}

/**
 * The disks besides the computer's own, where the person keeps files too: `/Volumes/*` on a
 * Mac (without the link to the computer's own disk), `/media/<user>/*` and `/mnt/*` on Linux.
 */
function attachedDisks(): Place[] {
  const found: Place[] = [];
  const look = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!visible(name)) continue;
      try {
        const real = realpathSync(join(dir, name));
        if (real !== "/" && statSync(real).isDirectory()) found.push({ name, path: real });
      } catch {
        // A disk that went away while it was looked at.
      }
    }
  };
  if (process.platform === "darwin") look("/Volumes");
  if (process.platform === "linux") {
    look(join("/media", userInfo().username));
    look("/mnt");
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

export class Folders {
  private readonly home: Home;
  private readonly disks = new Map<string, LocalFilesystem>();
  /** Where what agents replace or delete goes: the computer's Trash, on a server the home's own. */
  readonly trash: Trash;

  constructor(home: Home) {
    this.home = home;
    this.trash = new Trash(home.config.dataDir, Boolean(home.config.filesDir));
    home.db.run(
      "delete from folder_activity where at < ?",
      new Date(Date.now() - ACTIVITY_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    );
    home.addTools((context) => this.tools(context));
    // On a server the folder of files is the agents' own from the start.
    if (home.config.filesDir && !this.own())
      this.connect({ path: this.places().home, access: "write", own: true });
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
    const { home } = this.places();
    const path = own?.path ?? (this.home.config.filesDir ? home : join(home, OWN_NAME));
    return {
      path,
      connected: Boolean(own),
      exists: existsSync(path) && statSync(path).isDirectory(),
    };
  }

  /**
   * Where folders are picked, made and connected: the person's home folder and their disks, or
   * on a server the one folder of files.
   */
  places(): { home: string; disks: Place[] } {
    const files = this.home.config.filesDir;
    if (files) {
      mkdirSync(files, { recursive: true });
      return { home: realpathSync(files), disks: [] };
    }
    return { home: realpathSync(homedir()), disks: attachedDisks() };
  }

  /** `~` and `~/…` as the home folder of `places()`; a path without a `/` before it is inside it. */
  private expand(path: string): string {
    const { home } = this.places();
    const typed = path.trim();
    if (typed === "~") return home;
    return resolve(home, typed.startsWith("~/") ? typed.slice(2) : typed);
  }

  /**
   * The place a real path is in, when the picker may show it: inside the home folder or a disk,
   * with no hidden folder on the way.
   */
  private placeOf(real: string): string {
    const { home, disks } = this.places();
    const root = [home, ...disks.map((disk) => disk.path)].find((place) => inside(place, real));
    if (!root)
      throw new FolderRefused(
        "invalid",
        this.home.config.filesDir
          ? "Only folders in the Bot Server’s folder of files are shown here."
          : "Only folders in your home folder or on your disks are shown here.",
      );
    if (
      relative(root, real)
        .split(sep)
        .some((part) => part && !visible(part))
    )
      throw new FolderRefused("invalid", "A hidden folder is not shown here.");
    return root;
  }

  /**
   * A folder that is not there yet, as the full path it would get, when the home may make it:
   * the nearest folder that is there is one the picker shows, the rest are plain names, and the
   * folder could then be connected.
   */
  planned(path: string): string {
    let known = this.expand(path);
    const missing: string[] = [];
    while (!existsSync(known)) {
      missing.unshift(basename(known));
      known = dirname(known);
    }
    if (!statSync(known).isDirectory())
      throw new FolderRefused("not_found", "There is no such folder on the Bot Server’s computer.");
    const real = realpathSync(known);
    this.placeOf(real);
    if (missing.some((name) => /[/\\:]/.test(name) || !visible(name)))
      throw new FolderRefused("invalid", "A folder’s name cannot start with a dot or hold / or :.");
    const full = join(real, ...missing);
    this.refuse(full);
    return full;
  }

  /** Makes a folder `planned` allows, with the folders on the way, and returns its real path. */
  make(path: string): string {
    const full = this.planned(path);
    mkdirSync(full, { recursive: true });
    return realpathSync(full);
  }

  byId(id: string): Folder | undefined {
    return this.list().find((folder) => folder.id === id);
  }

  /** A connected folder by its name, or the agents' own folder without one. Throws for none. */
  named(name?: string): Folder {
    if (!name) {
      const own = this.own();
      if (!own) throw new Error("You have no folder of your own. Name a connected folder.");
      return own;
    }
    const folder = this.byName(name);
    if (!folder) {
      const known = this.list().map((each) => each.name);
      throw new Error(
        known.length
          ? `There is no connected folder ${name}. Connected: ${known.join(", ")}.`
          : "No folder is connected.",
      );
    }
    return this.byId(folder.id) as Folder;
  }

  byName(name: string): Folder | undefined {
    const row = this.home.db.get<Row>(
      "select * from folder where name = ? collate nocase",
      name.trim(),
    );
    return row ? toFolder(row) : undefined;
  }

  /**
   * The folders inside a folder, for the folder picker. Only the person's home folder, their
   * disks and what is in them, only folders, nothing hidden; without a path it starts at the
   * home folder. A path whose last part is not a folder yet (a half-typed name) lists its parent.
   */
  browse(path?: string): FolderListing {
    const { home, disks } = this.places();
    const wanted = this.expand(path?.trim() || home);
    const at = existsSync(wanted) && statSync(wanted).isDirectory() ? wanted : dirname(wanted);
    if (!existsSync(at) || !statSync(at).isDirectory())
      throw new FolderRefused("not_found", "There is no such folder on the Bot Server’s computer.");
    const real = realpathSync(at);
    const root = this.placeOf(real);
    const folders = safeEntries(real)
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: join(real, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, LIST_LIMIT);
    return { path: real, parent: real === root ? null : dirname(real), home, root, disks, folders };
  }

  /** Makes a new folder in a folder the picker shows, and lists it. */
  makeFolder(input: MakeFolder): FolderListing {
    const wanted = this.expand(input.parent);
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
    const wanted = this.expand(path);
    if (!existsSync(wanted)) {
      if (!existsSync(dirname(wanted)))
        throw new FolderRefused(
          "not_found",
          "There is no such folder on the Bot Server’s computer.",
        );
      this.make(wanted);
    }
    const folder = this.connect({ path: wanted, access: "write" });
    this.home.db.setMeta(OWN, folder.id);
    this.changed();
    return this.list().find((each) => each.id === folder.id) as Folder;
  }

  /** "Always allow": agents change files in the folder without a card, except deleting. */
  setAllow(id: string, allow: Folder["allow"]): Folder | undefined {
    this.home.db.run("update folder set allow = ? where id = ?", allow, id);
    this.changed();
    return this.byId(id);
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
    const parts = this.parts(path);
    const bad = badPart(parts);
    if (bad === "secret")
      throw new FolderRefused(
        "invalid",
        `“${path}” holds keys or passwords by its name and stays closed. Do not try it another way.`,
      );
    if (bad) throw new FolderRefused("invalid", `“${path}” is not a path inside ${folder.name}.`);
    const full = join(folder.path, ...parts);
    // A link may lead anywhere, also to a place that is not there yet: none is followed.
    if (!noLinks(folder.path, full))
      throw new FolderRefused("invalid", `“${path}” leads out of ${folder.name}.`);
    let known = full;
    while (!existsSync(known)) known = dirname(known);
    const real = realpathSync(known);
    if (real !== folder.path && !real.startsWith(folder.path + sep)) {
      throw new FolderRefused("invalid", `“${path}” leads out of ${folder.name}.`);
    }
    return full;
  }

  /** A path inside a folder as its parts, the way the agents and the file browser write it. */
  private parts(path: string): string[] {
    return path.split(/[\\/]+/).filter((part) => part && part !== ".");
  }

  /** A path inside a folder as Mastra's filesystem takes it: relative, with `/`. */
  relative(path: string): string {
    return this.parts(path).join("/") || ".";
  }

  /**
   * Mastra's filesystem for a connected folder: it checks every path again, link by link, as it
   * reads or writes, and refuses every write in a folder connected for reading.
   */
  disk(folder: Folder): LocalFilesystem {
    const key = `${folder.id}:${folder.path}:${folder.access}`;
    let disk = this.disks.get(key);
    if (!disk) {
      disk = new LocalFilesystem({
        id: folder.id,
        basePath: folder.path,
        contained: true,
        readOnly: folder.access !== "write",
      });
      this.disks.set(key, disk);
    }
    return disk;
  }

  /**
   * A path an agent may write: inside the folder, no program, no file with a second name
   * elsewhere. Throws otherwise; the full path on the disk when it may.
   */
  writable(folder: Folder, path: string): string {
    const full = this.locate(folder, path);
    if (executable(basename(full)))
      throw new FolderRefused("invalid", `${path} would be a program. No agent writes one.`);
    if (sharedFile(full))
      throw new FolderRefused(
        "invalid",
        `${path} has a second name in another place: changing it would change that one too.`,
      );
    return full;
  }

  /**
   * Writes a file in a folder connected for changes, after the home's own checks: no file that
   * runs when it is opened, no file with a second name elsewhere. Missing folders on the way
   * are made.
   */
  async write(folder: Folder, path: string, content: string | Uint8Array): Promise<void> {
    this.writable(folder, path);
    await this.disk(folder).writeFile(this.parts(path).join("/"), content, { recursive: true });
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
    const wanted = this.expand(path);
    if (!existsSync(wanted) || !statSync(wanted).isDirectory()) {
      throw new FolderRefused("not_found", "There is no such folder on the Bot Server’s computer.");
    }
    const real = realpathSync(wanted);
    this.refuse(real);
    return real;
  }

  /** Throws when a home connects no folder at this real path, also one not made yet. */
  private refuse(real: string): void {
    const files = this.home.config.filesDir;
    if (files) {
      // On a server there is one folder of files: it and what is inside it, nothing else.
      if (!inside(this.places().home, real))
        throw new FolderRefused(
          "invalid",
          "On this Bot Server, folders are inside its folder of files only.",
        );
      if (
        relative(this.places().home, real)
          .split(sep)
          .some((part) => part.startsWith("."))
      )
        throw new FolderRefused("invalid", "A hidden folder cannot be connected.");
      return;
    }
    const refused = refusedFolder(real, this.home.config.dataDir);
    if (refused === "whole")
      throw new FolderRefused(
        "invalid",
        "Choose a folder with your own files in it, not the whole disk or your whole home folder.",
      );
    if (refused === "system")
      throw new FolderRefused(
        "invalid",
        "This folder belongs to the computer’s system or its apps. Choose a folder with your own files in it.",
      );
    if (refused === "data")
      throw new FolderRefused(
        "invalid",
        "This folder holds the Bot Server’s own data. Choose another one.",
      );
    if (refused === "hidden")
      throw new FolderRefused("invalid", "A hidden folder cannot be connected.");
  }

  /**
   * Notes what a turn did in a folder: one row per turn and folder, with how many files it read
   * and each change, so a change can be taken back.
   */
  noted(context: TurnContext, folder: Folder, change?: FolderChange, read = 0): void {
    this.note(
      { turn: context.draft.id, agentId: context.agent.id, conversationId: context.conversationId },
      folder,
      change,
      read,
    );
  }

  private note(
    by: { turn: string; agentId?: string; conversationId?: string },
    folder: Folder,
    change?: FolderChange,
    read = 0,
  ): void {
    const row = this.home.db.get<{ id: string; read: number; changes: string }>(
      "select id, read, changes from folder_activity where folder_id = ? and turn = ?",
      folder.id,
      by.turn,
    );
    const changes = [...(row ? (JSON.parse(row.changes) as FolderChange[]) : [])];
    if (change) changes.push({ ...change, at: now() });
    if (row)
      this.home.db.run(
        "update folder_activity set read = ?, changes = ?, at = ? where id = ?",
        row.read + read,
        JSON.stringify(changes),
        now(),
        row.id,
      );
    else
      this.home.db.run(
        "insert into folder_activity (id, folder_id, agent_id, conversation_id, turn, read, changes, at) values (?, ?, ?, ?, ?, ?, ?, ?)",
        newId("fac"),
        folder.id,
        by.agentId ?? null,
        by.conversationId ?? null,
        by.turn,
        read,
        JSON.stringify(changes),
        now(),
      );
    this.home.events.emit({ type: "folder.activity", folderId: folder.id });
  }

  /** What agents and the person did in a folder, newest first. */
  activity(folderId: string, limit = ACTIVITY_SHOWN): FolderActivity[] {
    const rows = this.home.db.all<ActivityRow>(
      "select * from folder_activity where folder_id = ? order by at desc limit ?",
      folderId,
      limit,
    );
    return rows.map((row) => {
      const undone = new Set(JSON.parse(row.undone) as number[]);
      const agent = row.agent_id ? this.home.store.agent(row.agent_id) : undefined;
      return {
        id: row.id,
        folderId: row.folder_id,
        ...(row.agent_id ? { agentId: row.agent_id } : {}),
        ...(agent ? { agentName: agent.name } : {}),
        ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
        read: row.read,
        changes: (JSON.parse(row.changes) as FolderChange[]).map((change, index) => ({
          action: change.action,
          path: change.path,
          ...(change.fromFolder ? { fromFolder: change.fromFolder } : {}),
          ...(change.from ? { from: change.from } : {}),
          ...(change.bytes !== undefined ? { bytes: change.bytes } : {}),
          ...(change.kept ? { kept: true } : {}),
          ...(undone.has(index) ? { undone: true } : {}),
          at: change.at ?? row.at,
        })),
        at: row.at,
      };
    });
  }

  /**
   * Takes back one change: a new file, folder or copy goes to the Trash, a replaced or deleted
   * one comes back from it, a moved one goes back where it was. Throws when that cannot be.
   */
  undo(folderId: string, activityId: string, index: number): void {
    const row = this.home.db.get<ActivityRow>(
      "select * from folder_activity where id = ? and folder_id = ?",
      activityId,
      folderId,
    );
    const change = row && (JSON.parse(row.changes) as FolderChange[])[index];
    if (!row || !change) throw new FolderRefused("not_found", "There is no such change.");
    const undone = JSON.parse(row.undone) as number[];
    if (undone.includes(index)) throw new FolderRefused("invalid", "It was taken back already.");
    const folder = this.byId(folderId);
    if (!folder) throw new FolderRefused("not_found", "The folder is not connected any more.");
    if (folder.access !== "write")
      throw new FolderRefused("invalid", "The folder is connected for reading only.");
    const full = this.locate(folder, change.path);
    const gone = (what: string) =>
      new FolderRefused("invalid", `${what} is not where the change left it any more.`);
    switch (change.action) {
      case "write":
      case "copy":
        if (!existsSync(full)) throw gone(change.path);
        this.trash.put(full);
        break;
      case "make":
        if (!existsSync(full)) throw gone(change.path);
        if (readdirSync(full).length) this.trash.put(full);
        else rmdirSync(full);
        break;
      case "replace":
      case "edit":
        if (!change.kept || !existsSync(change.kept)) throw gone("The old version");
        if (existsSync(full)) this.trash.put(full);
        this.trash.restore(change.kept, full);
        break;
      case "delete":
        if (!change.kept || !existsSync(change.kept)) throw gone(change.path);
        this.trash.restore(change.kept, full);
        break;
      case "move": {
        const source = change.fromFolder ? this.byId(change.fromFolder) : undefined;
        if (!source || !change.from)
          throw new FolderRefused("invalid", "Where it came from is not connected any more.");
        if (!existsSync(full)) throw gone(change.path);
        const back = this.writable(source, change.from);
        if (existsSync(back))
          throw new FolderRefused("invalid", `There is something at ${change.from} again.`);
        mkdirSync(dirname(back), { recursive: true });
        renameSync(full, back);
        break;
      }
    }
    this.home.db.run(
      "update folder_activity set undone = ? where id = ?",
      JSON.stringify([...undone, index]),
      row.id,
    );
    this.home.events.emit({ type: "folder.activity", folderId });
  }

  /** What a place in a connected folder holds, for the file browser: what the agents reach. */
  entries(folder: Folder, path = ""): FolderEntries {
    const full = this.locate(folder, path);
    if (!existsSync(full) || !statSync(full).isDirectory())
      throw new FolderRefused("not_found", `There is no folder ${path} in ${folder.name}.`);
    const inside = this.parts(path).join("/");
    const all = safeEntries(full);
    const entries = all
      .flatMap((entry) => {
        const stat = statSync(join(full, entry.name), { throwIfNoEntry: false });
        if (!stat || !(entry.isDirectory() || entry.isFile())) return [];
        return [
          {
            name: entry.name,
            path: inside ? `${inside}/${entry.name}` : entry.name,
            kind: entry.isDirectory() ? ("folder" as const) : ("file" as const),
            size: entry.isDirectory() ? 0 : stat.size,
            changedAt: stat.mtime.toISOString(),
          },
        ];
      })
      .sort(
        (a, b) =>
          Number(b.kind === "folder") - Number(a.kind === "folder") || a.name.localeCompare(b.name),
      )
      .slice(0, ENTRIES_SHOWN);
    const parent = inside ? inside.split("/").slice(0, -1).join("/") : null;
    return { folder, path: inside, parent, entries, more: all.length > ENTRIES_SHOWN };
  }

  /** A file of a connected folder, for showing or saving: where it is and how large. */
  fileOf(folder: Folder, path: string): { full: string; size: number; name: string } {
    const full = this.locate(folder, path);
    const stat = statSync(full, { throwIfNoEntry: false });
    if (!stat?.isFile())
      throw new FolderRefused("not_found", `There is no file ${path} in ${folder.name}.`);
    return { full, size: stat.size, name: basename(full) };
  }

  /** What the person does in the file browser, in a folder connected for changes. */
  async edit(folder: Folder, edit: FolderEdit): Promise<void> {
    if (folder.access !== "write")
      throw new FolderRefused("invalid", "The folder is connected for reading only.");
    const by = { turn: newId("fac") };
    if (edit.action === "make") {
      const full = this.writable(folder, edit.path);
      if (existsSync(full))
        throw new FolderRefused("invalid", `There is something at ${edit.path} already.`);
      await this.disk(folder).mkdir(this.relative(edit.path), { recursive: true });
      this.note(by, folder, { action: "make", path: edit.path });
    } else if (edit.action === "move") {
      const from = this.locate(folder, edit.from);
      const to = this.writable(folder, edit.to);
      if (!existsSync(from))
        throw new FolderRefused("not_found", `There is nothing at ${edit.from}.`);
      if (existsSync(to))
        throw new FolderRefused("invalid", `There is something at ${edit.to} already.`);
      if (from === folder.path)
        throw new FolderRefused("invalid", "The connected folder itself stays.");
      const rel = this.relative(edit.to);
      if (rel.includes("/"))
        await this.disk(folder).mkdir(rel.slice(0, rel.lastIndexOf("/")), { recursive: true });
      await this.disk(folder).moveFile(this.relative(edit.from), rel, { overwrite: false });
      this.note(by, folder, {
        action: "move",
        path: edit.to,
        fromFolder: folder.id,
        from: edit.from,
      });
    } else {
      const fulls = edit.paths.map((path) => {
        const full = this.locate(folder, path);
        if (full === folder.path)
          throw new FolderRefused("invalid", "The connected folder itself stays.");
        if (!existsSync(full)) throw new FolderRefused("not_found", `There is nothing at ${path}.`);
        return full;
      });
      edit.paths.forEach((path, index) => {
        const kept = this.trash.put(fulls[index] as string);
        this.note(by, folder, { action: "delete", path, kept });
      });
    }
  }

  /** A file the person dropped into the file browser: a new one, or a new version of one. */
  async put(folder: Folder, path: string, bytes: Uint8Array): Promise<void> {
    if (folder.access !== "write")
      throw new FolderRefused("invalid", "The folder is connected for reading only.");
    const full = this.writable(folder, path);
    if (existsSync(full) && !statSync(full).isFile())
      throw new FolderRefused("invalid", `${path} is a folder.`);
    const kept = existsSync(full) ? this.trash.keep(full) : undefined;
    await this.disk(folder).writeFile(this.relative(path), bytes, { recursive: true });
    this.note({ turn: newId("fac") }, folder, {
      action: kept ? "replace" : "write",
      path,
      bytes: bytes.byteLength,
      ...(kept ? { kept } : {}),
    });
  }

  private changed(): void {
    this.home.events.emit({ type: "folders.updated", folders: this.list() });
  }

  // ── What the agents can do ────────────────────────────────────────────────

  private tools(context: TurnContext): Tool[] {
    const { home } = context;
    const named = (name: string): Folder => this.named(name);
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
          this.noted(context, folder, undefined, 1);
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
            this.noted(context, folder, undefined, 1);
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
      ...changeTools(this, context),
    ];
    return [
      ...(this.list().length ? use : []),
      defineTool({
        name: "folder_connect",
        description:
          "Connect a folder of the Bot Server's computer, so agents can read its files (`read`) or also change them after asking (`write`). Shows the person a card where they pick the folder and say yes in one go. Leave out `path` unless the person wrote the exact path, or you propose a new folder with `create`: never ask for a path, in a question or otherwise, and never ask the person to make a folder. Ends your turn.",
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
            .describe(
              "A path the person wrote, or with `create` the new folder you propose, e.g. ~/code/wizards/data. The card then starts with that folder.",
            ),
          create: z
            .boolean()
            .optional()
            .describe(
              "`path` is not there yet: the Bot Server makes it, with the folders on the way, when the person says yes.",
            ),
        }),
        label: () => "Asking to connect a folder",
        asks: true,
        run: async (input, call) => {
          if (call.answer) {
            const picked = call.answer.values.folder;
            if (call.answer.action !== "connect" || typeof picked !== "string" || !picked)
              return "The person did not connect a folder. Do not ask for its path.";
            const chosen = call.answer.values.access;
            // The folder the card proposed is made now; one the person picked is there already.
            const made = call.answer.kept === picked ? this.make(picked) : undefined;
            const folder = this.connect({
              path: made ?? picked,
              access: chosen === "read" || chosen === "write" ? chosen : input.access,
            });
            return `The folder ${folder.name} is connected (${folder.access === "write" ? "read and change after asking" : "read only"}). Go on with what the person wanted.`;
          }
          let start: string | undefined;
          let planned: string | undefined;
          const lang = langOf(home.db);
          if (input.path) {
            try {
              if (input.create && !existsSync(this.expand(input.path)))
                start = planned = this.planned(input.path);
              else start = this.preview(input.path).path;
            } catch (error) {
              return `${(error as Error).message} Call \`folder_connect\` again without \`path\`: the person picks the folder.`;
            }
          }
          return call.ask(
            {
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
                  ...(planned
                    ? {
                        placeholder: say(
                          w(
                            "Your Bot Server makes this folder when you connect it.",
                            "Dein Bot Server legt diesen Ordner an, wenn du ihn verbindest.",
                          ),
                          lang,
                        ),
                      }
                    : {}),
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
            },
            planned,
          );
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
    allow: row.allow === "always" ? "always" : "ask",
    createdAt: row.created_at,
  };
}
