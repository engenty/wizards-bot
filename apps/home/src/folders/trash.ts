import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";

// What an agent deletes or replaces goes to the Trash, never away: the person takes it back
// from there, or the file browser does with "Take back".

/** How long the home keeps what it put into its own trash, on a server. */
const KEPT_DAYS = 30;

/**
 * Where deleted files go: the Mac's Trash, the freedesktop Trash on Linux, and on a server (or
 * anywhere else) a `trash` folder in the home's data folder.
 */
export function trashFolder(dataDir: string, server: boolean): { files: string; info?: string } {
  if (!server && process.platform === "darwin") return { files: join(homedir(), ".Trash") };
  if (!server && process.platform === "linux") {
    const base = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "Trash");
    return { files: join(base, "files"), info: join(base, "info") };
  }
  return { files: join(dataDir, "trash") };
}

/** A name in `dir` that is free: the name itself, else with the time it was put there. */
function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  for (let n = 1; ; n++) {
    const candidate = `${stem} ${stamp}${n > 1 ? ` ${n}` : ""}${ext}`;
    if (!existsSync(join(dir, candidate))) return candidate;
  }
}

export class Trash {
  private readonly dataDir: string;
  private readonly server: boolean;

  constructor(dataDir: string, server: boolean) {
    this.dataDir = dataDir;
    this.server = server;
    this.prune();
  }

  private place(full: string): { dir: string; name: string; info?: string } {
    const { files, info } = trashFolder(this.dataDir, this.server);
    mkdirSync(files, { recursive: true });
    if (info) mkdirSync(info, { recursive: true });
    return { dir: files, name: freeName(files, basename(full)), info };
  }

  /** The freedesktop note beside a file in the Trash, so a file manager can put it back. */
  private note(info: string | undefined, name: string, from: string): void {
    if (!info) return;
    const at = new Date().toISOString().slice(0, 19);
    writeFileSync(
      join(info, `${name}.trashinfo`),
      `[Trash Info]\nPath=${encodeURI(from)}\nDeletionDate=${at}\n`,
    );
  }

  /** Moves a file or folder to the Trash and says where it is now. */
  put(full: string): string {
    const { dir, name, info } = this.place(full);
    const target = join(dir, name);
    try {
      renameSync(full, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      // Another disk: copied over, then removed here.
      cpSync(full, target, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
      rmSync(full, { recursive: true });
    }
    this.note(info, name, full);
    this.stamp(target);
    return target;
  }

  /** In the home's own trash the time a file was put there is its time: what prunes it. */
  private stamp(target: string): void {
    if (trashFolder(this.dataDir, this.server).files !== join(this.dataDir, "trash")) return;
    const now = new Date();
    utimesSync(target, now, now);
  }

  /** Puts a copy of a file into the Trash before it is replaced, and says where it is. */
  keep(full: string): string {
    const { dir, name, info } = this.place(full);
    const target = join(dir, name);
    cpSync(full, target, { errorOnExist: true });
    this.note(info, name, full);
    this.stamp(target);
    return target;
  }

  /** Takes a file back from the Trash to where it was, when that place is free. */
  restore(from: string, to: string): void {
    if (existsSync(to)) throw new Error(`There is something at ${basename(to)} again.`);
    try {
      renameSync(from, to);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      cpSync(from, to, { recursive: true, errorOnExist: true, verbatimSymlinks: true });
      rmSync(from, { recursive: true });
    }
  }

  /** Empties what the home's own trash holds longer than it keeps it. The system Trash is the person's. */
  private prune(): void {
    const { files, info } = trashFolder(this.dataDir, this.server);
    if (info || files !== join(this.dataDir, "trash") || !existsSync(files)) return;
    const before = Date.now() - KEPT_DAYS * 24 * 60 * 60 * 1000;
    for (const name of readdirSync(files)) {
      const full = join(files, name);
      const stat = statSync(full, { throwIfNoEntry: false });
      if (stat && stat.mtimeMs < before) rmSync(full, { recursive: true, force: true });
    }
  }
}
