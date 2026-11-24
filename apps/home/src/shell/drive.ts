import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rmdir,
  stat,
  truncate,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { basename, posix } from "node:path";
import type { Folder } from "@wizards-bot/protocol";
import { executable, sharedFile, visible } from "../folders/rules.ts";

// A connected folder as the light shell sees it. Every path a program in the shell uses goes
// through the folder rules of the folder tools (`Folders.locate`): nothing hidden, no `..`,
// no link that leads out. Links are not listed and not followed; a file with more than one
// hard link is not changed, as that would change a file somewhere else too, and no program is
// written. Writing works
// only for a command the person allowed to change this folder; each change is noted.

/** The shape of agentOS's `VirtualStat`. */
export interface DriveStat {
  mode: number;
  size: number;
  blocks: number;
  dev: number;
  rdev: number;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  ino: number;
  nlink: number;
  uid: number;
  gid: number;
}

export interface DriveEntry {
  name: string;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

const fail = (code: "EACCES" | "EROFS" | "ENOENT", message: string): Error =>
  Object.assign(new Error(`${code}: ${message}`), { code });

const toStat = (s: Stats): DriveStat => ({
  mode: s.mode,
  size: s.size,
  blocks: s.blocks,
  dev: s.dev,
  rdev: s.rdev,
  isDirectory: s.isDirectory(),
  isSymbolicLink: s.isSymbolicLink(),
  // The shell's side takes whole milliseconds only.
  atimeMs: Math.floor(s.atimeMs),
  mtimeMs: Math.floor(s.mtimeMs),
  ctimeMs: Math.floor(s.ctimeMs),
  birthtimeMs: Math.floor(s.birthtimeMs),
  ino: s.ino,
  nlink: s.nlink,
  uid: s.uid,
  gid: s.gid,
});

/**
 * A time the shell hands over, as seconds. Programs give seconds, milliseconds or nanoseconds,
 * and "now" as the largest number there is.
 */
export function seconds(time: number): number {
  if (!Number.isFinite(time) || time >= 4e18) return Date.now() / 1000;
  if (time > 1e15) return time / 1e9;
  if (time > 1e11) return time / 1e3;
  return time;
}

/** agentOS's `VirtualFileSystem`, on one connected folder. */
export class FolderDrive {
  readonly folder: Folder;
  readonly writable: boolean;
  /** What a command changed, as "wrote <folder>/<path>". */
  readonly changes: string[] = [];
  private readonly locate: (folder: Folder, path: string) => string;

  constructor(folder: Folder, writable: boolean, locate: (folder: Folder, path: string) => string) {
    this.folder = folder;
    this.writable = writable && folder.access === "write";
    this.locate = locate;
  }

  // ── Where a path leads ────────────────────────────────────────────────────

  /** The path on the disk, after the folder rules. */
  private place(path: string): string {
    try {
      return this.locate(this.folder, path);
    } catch (error) {
      throw fail("EACCES", (error as Error).message);
    }
  }

  /** The path on the disk of something that is there and is not a link. */
  private async existing(path: string): Promise<{ full: string; stats: Stats }> {
    const full = this.place(path);
    let stats: Stats;
    try {
      stats = await lstat(full);
    } catch {
      throw fail("ENOENT", `${path} is not there`);
    }
    if (stats.isSymbolicLink()) throw fail("EACCES", `${path} is a link`);
    return { full, stats };
  }

  /** The path on the disk to change: allowed for this command, and not a link or hard link. */
  private async changeable(path: string): Promise<string> {
    if (!this.writable) throw fail("EROFS", `${this.folder.name} is read-only for this command`);
    const full = this.place(path);
    const stats = await lstat(full).catch(() => undefined);
    if (stats?.isSymbolicLink()) throw fail("EACCES", `${path} is a link`);
    if (sharedFile(full))
      throw fail("EACCES", `${path} is also somewhere else on the disk (a hard link)`);
    if (executable(basename(full)))
      throw fail("EACCES", `${path} would be a program; none is written into a connected folder`);
    return full;
  }

  private note(action: string, path: string): void {
    const shown = `${this.folder.name}${posix.normalize(`/${path}`)}`;
    const line = `${action} ${shown}`;
    if (this.changes.at(-1) !== line) this.changes.push(line);
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  async readFile(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile((await this.existing(path)).full));
  }

  async readTextFile(path: string): Promise<string> {
    return readFile((await this.existing(path)).full, "utf8");
  }

  async readDir(path: string): Promise<string[]> {
    return (await this.readDirWithTypes(path)).map((entry) => entry.name);
  }

  async readDirWithTypes(path: string): Promise<DriveEntry[]> {
    const { full } = await this.existing(path);
    const entries = await readdir(full, { withFileTypes: true });
    return entries
      .filter((entry) => visible(entry.name) && !entry.isSymbolicLink())
      .map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isSymbolicLink: false,
      }));
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.existing(path);
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<DriveStat> {
    return toStat(await stat((await this.existing(path)).full));
  }

  async lstat(path: string): Promise<DriveStat> {
    return toStat((await this.existing(path)).stats);
  }

  async realpath(path: string): Promise<string> {
    await this.existing(path);
    return posix.normalize(`/${path}`);
  }

  async pread(path: string, offset: number, length: number): Promise<Uint8Array> {
    const handle = await open((await this.existing(path)).full, "r");
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return new Uint8Array(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }

  // ── Changing ──────────────────────────────────────────────────────────────

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await writeFile(await this.changeable(path), content);
    this.note("wrote", path);
  }

  async pwrite(path: string, offset: number, data: Uint8Array): Promise<void> {
    const handle = await open(await this.changeable(path), "r+");
    try {
      await handle.write(data, 0, data.length, offset);
    } finally {
      await handle.close();
    }
    this.note("wrote", path);
  }

  async truncate(path: string, length: number): Promise<void> {
    await truncate(await this.changeable(path), length);
    this.note("wrote", path);
  }

  async createDir(path: string): Promise<void> {
    await mkdir(await this.changeable(path));
    this.note("made", path);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await mkdir(await this.changeable(path), { recursive: options?.recursive });
    this.note("made", path);
  }

  async removeFile(path: string): Promise<void> {
    await unlink(await this.changeable(path));
    this.note("deleted", path);
  }

  async removeDir(path: string): Promise<void> {
    await rmdir(await this.changeable(path));
    this.note("deleted", path);
  }

  async rename(from: string, to: string): Promise<void> {
    await rename(await this.changeable(from), await this.changeable(to));
    this.note("moved", `${from} → ${to}`);
  }

  async utimes(path: string, atime: number, mtime: number): Promise<void> {
    await utimes(await this.changeable(path), seconds(atime), seconds(mtime));
  }

  // Links are never made, and a file's owner and mode stay as the person's computer has them.
  async symlink(): Promise<void> {
    throw fail("EACCES", "links are not made in a connected folder");
  }

  async link(): Promise<void> {
    throw fail("EACCES", "links are not made in a connected folder");
  }

  async readlink(): Promise<string> {
    throw fail("EACCES", "links are not followed in a connected folder");
  }

  async chmod(): Promise<void> {}

  async chown(): Promise<void> {}
}
