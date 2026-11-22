import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { now } from "./ids.ts";
import type { Db } from "./store/db.ts";

/** The home's Ed25519 key. Other homes know this home by its public half. */
export class Identity {
  readonly publicKey: string;
  private readonly privateKey: KeyObject;

  constructor(dataDir: string) {
    const file = join(dataDir, "home.key");
    if (!existsSync(file)) {
      const pair = generateKeyPairSync("ed25519");
      writeFileSync(file, pair.privateKey.export({ type: "pkcs8", format: "pem" }), {
        mode: 0o600,
      });
    }
    this.privateKey = createPrivateKey(readFileSync(file));
    const jwk = createPublicKey(this.privateKey).export({ format: "jwk" });
    this.publicKey = jwk.x as string;
  }

  sign(data: string): string {
    return sign(null, Buffer.from(data), this.privateKey).toString("base64url");
  }

  static verify(publicKey: string, data: string, signature: string): boolean {
    try {
      const key = createPublicKey({
        key: { kty: "OKP", crv: "Ed25519", x: publicKey },
        format: "jwk",
      });
      return verify(null, Buffer.from(data), key, Buffer.from(signature, "base64url"));
    } catch {
      return false;
    }
  }
}

export const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * Keys, tokens and passwords the person gave the home. They are encrypted with a key that
 * lives beside the database and are handed to connectors and channels, never to a model.
 */
export class Secrets {
  private readonly key: Buffer;
  private readonly db: Db;

  constructor(db: Db, dataDir: string) {
    this.db = db;
    const file = join(dataDir, "secrets.key");
    if (dataDir !== ":memory:" && !existsSync(file))
      writeFileSync(file, randomBytes(32), { mode: 0o600 });
    this.key = dataDir === ":memory:" ? randomBytes(32) : readFileSync(file);
  }

  set(name: string, value: string): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const blob = Buffer.concat([iv, cipher.getAuthTag(), body]);
    this.db.run(
      "insert into secret (name, value, updated_at) values (?, ?, ?) on conflict(name) do update set value = excluded.value, updated_at = excluded.updated_at",
      name,
      blob,
      now(),
    );
  }

  get(name: string): string | undefined {
    const row = this.db.get<{ value: Uint8Array }>("select value from secret where name = ?", name);
    if (!row) return undefined;
    const blob = Buffer.from(row.value);
    const decipher = createDecipheriv("aes-256-gcm", this.key, blob.subarray(0, 12));
    decipher.setAuthTag(blob.subarray(12, 28));
    return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString("utf8");
  }

  has(name: string): boolean {
    return this.db.get("select 1 from secret where name = ?", name) !== undefined;
  }

  delete(name: string): void {
    this.db.run("delete from secret where name = ?", name);
  }
}
