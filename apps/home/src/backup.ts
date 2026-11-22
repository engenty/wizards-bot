import { execFileSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";

// The export of a home: its whole data folder as one file, encrypted with a passphrase of the
// person. Whoever keeps the file (the person, the operator of a hosted home, a backup) reads
// nothing in it without the passphrase, and the home keeps no copy of it.
//
// The file: "WBX1", the cost of the key derivation as a power of two (1 byte), the salt (16),
// the nonce (12), the data folder as a tar encrypted with AES-256-GCM, its tag (16). The key is
// scrypt of the passphrase and the salt. A wrong passphrase or a changed byte fails the tag,
// and nothing is unpacked before the tag holds.

const MAGIC = Buffer.from("WBX1");
const HEAD = MAGIC.length + 1 + 16 + 12;
const TAG = 16;
/** scrypt's N = 2^16 with r = 8 takes 64 MB and about a fifth of a second. */
const COST = 16;

/** A passphrase that is too short to keep a home's data. */
export const MIN_PASSPHRASE = 12;

const keyOf = (passphrase: string, salt: Buffer, cost: number): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    scrypt(
      passphrase.normalize("NFC"),
      salt,
      32,
      { N: 2 ** cost, r: 8, p: 1, maxmem: 256 * 8 * 2 ** cost },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );

/** What lies in a data folder and is not part of the home: SQLite's files beside a database. */
const transient = (name: string) => /-(wal|shm|journal)$/.test(name);

/**
 * Copies a data folder as it is now. A database is copied with `VACUUM INTO`, so a home that
 * runs meanwhile leaves a whole and consistent copy.
 */
function snapshot(from: string, to: string): void {
  mkdirSync(to, { recursive: true, mode: 0o700 });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) snapshot(source, target);
    else if (!entry.isFile() || transient(entry.name)) continue;
    else if (entry.name.endsWith(".db")) {
      const db = new DatabaseSync(source, { readOnly: true });
      try {
        db.exec(`vacuum into '${target.replaceAll("'", "''")}'`);
      } finally {
        db.close();
      }
    } else copyFileSync(source, target);
  }
}

/** Writes the data folder, encrypted, to `file`. */
export async function exportData(dataDir: string, file: string, passphrase: string): Promise<void> {
  if (passphrase.length < MIN_PASSPHRASE)
    throw new Error(`The passphrase needs at least ${MIN_PASSPHRASE} characters.`);
  if (!existsSync(join(dataDir, "home.db"))) throw new Error(`${dataDir} holds no home.`);
  const work = mkdtempSync(join(tmpdir(), "wizards-bot-export-"));
  try {
    snapshot(dataDir, join(work, "data"));
    const tar = join(work, "data.tar");
    execFileSync("tar", ["-cf", tar, "-C", join(work, "data"), "."]);
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", await keyOf(passphrase, salt, COST), iv);
    mkdirSync(dirname(file), { recursive: true });
    const part = `${file}.part`;
    writeFileSync(part, Buffer.concat([MAGIC, Buffer.from([COST]), salt, iv]), { mode: 0o600 });
    await pipeline(createReadStream(tar), cipher, createWriteStream(part, { flags: "a" }));
    writeFileSync(part, cipher.getAuthTag(), { flag: "a" });
    renameSync(part, file);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Unpacks an export into a data folder that holds no home yet. Nothing is written there until
 * the passphrase and every byte of the file are proven right.
 */
export async function importData(file: string, dataDir: string, passphrase: string): Promise<void> {
  if (existsSync(join(dataDir, "home.db")))
    throw new Error(`${dataDir} holds a home already. Import into an empty data folder.`);
  const size = statSync(file).size;
  if (size < HEAD + TAG) throw new Error("That file is not an export of a home.");
  const fd = openSync(file, "r");
  const head = Buffer.alloc(HEAD);
  const tag = Buffer.alloc(TAG);
  try {
    readSync(fd, head, 0, HEAD, 0);
    readSync(fd, tag, 0, TAG, size - TAG);
  } finally {
    closeSync(fd);
  }
  if (!head.subarray(0, MAGIC.length).equals(MAGIC))
    throw new Error("That file is not an export of a home.");
  const cost = head[MAGIC.length] as number;
  if (cost < 10 || cost > 22) throw new Error("That file is not an export of a home.");
  const salt = head.subarray(MAGIC.length + 1, MAGIC.length + 17);
  const iv = head.subarray(MAGIC.length + 17, HEAD);
  const decipher = createDecipheriv("aes-256-gcm", await keyOf(passphrase, salt, cost), iv);
  decipher.setAuthTag(tag);
  const work = mkdtempSync(join(tmpdir(), "wizards-bot-import-"));
  try {
    const tar = join(work, "data.tar");
    try {
      await pipeline(
        createReadStream(file, { start: HEAD, end: size - TAG - 1 }),
        decipher,
        createWriteStream(tar, { mode: 0o600 }),
      );
    } catch {
      throw new Error("The passphrase is wrong, or the file was changed.");
    }
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    execFileSync("tar", ["-xf", tar, "-C", dataDir]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
