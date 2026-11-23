import {
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
import {
  fileKeyStore,
  type KeyRing,
  keyCheckHolds,
  keyRing,
  loadOrCreateKey,
  seal,
  sealKeyCheck,
  unseal,
} from "@engenty/vault";
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
 * Keys, tokens and passwords the person gave the home. They are sealed with `@engenty/vault`
 * under the key in `secrets.key`, which lives beside the database, each bound to its name, and
 * handed to connectors and channels, never to a model. A key check in `meta` stops the home at
 * start when `secrets.key` is not the key its secrets were sealed with.
 */
export class Secrets {
  private readonly ring: KeyRing;
  private readonly db: Db;

  constructor(db: Db, dataDir: string) {
    this.db = db;
    const key =
      dataDir === ":memory:"
        ? randomBytes(32)
        : loadOrCreateKey(fileKeyStore(join(dataDir, "secrets.key")));
    this.ring = keyRing({ id: KEY_ID, key });
    this.db.transaction(() => {
      this.sealEarlier(key);
      this.checkKey();
    });
  }

  /**
   * Seals a value another part of the home keeps itself (a login of the Vault), bound to where
   * it belongs: the same value under another binding doesn't open.
   */
  seal(where: string[], value: string): string {
    return seal(this.ring, ["wizards-bot", ...where], value);
  }

  /** Opens what `seal` sealed under the same binding; throws when it doesn't open. */
  unseal(where: string[], sealed: string): string {
    return unseal(this.ring, ["wizards-bot", ...where], sealed);
  }

  set(name: string, value: string): void {
    this.db.run(
      "insert into secret (name, value, updated_at) values (?, ?, ?) on conflict(name) do update set value = excluded.value, updated_at = excluded.updated_at",
      name,
      seal(this.ring, binding(name), value),
      now(),
    );
  }

  get(name: string): string | undefined {
    const row = this.db.get<{ value: string }>("select value from secret where name = ?", name);
    return row ? unseal(this.ring, binding(name), row.value) : undefined;
  }

  /** The names of the secrets and when each was set; never a value. */
  list(): { name: string; updatedAt: string }[] {
    return this.db.all<{ name: string; updatedAt: string }>(
      "select name, updated_at as updatedAt from secret order by name",
    );
  }

  has(name: string): boolean {
    return this.db.get("select 1 from secret where name = ?", name) !== undefined;
  }

  delete(name: string): void {
    this.db.run("delete from secret where name = ?", name);
  }

  private checkKey(): void {
    const row = this.db.get<{ value: string }>("select value from meta where key = ?", KEY_CHECK);
    if (!row) {
      this.db.run(
        "insert into meta (key, value) values (?, ?)",
        KEY_CHECK,
        sealKeyCheck(this.ring, OWNER),
      );
      return;
    }
    if (!keyCheckHolds(this.ring, OWNER, row.value)) {
      throw new Error(
        "secrets.key in the data folder is not the key this home's secrets were sealed with.",
      );
    }
  }

  /**
   * Seals again what a home sealed before it used `@engenty/vault`: nonce, tag and ciphertext as
   * bytes, under the same key, bound to nothing. Runs at start until no such row is left.
   */
  private sealEarlier(key: Buffer): void {
    const rows = this.db.all<{ name: string; value: Uint8Array | string }>(
      "select name, value from secret",
    );
    for (const { name, value } of rows) {
      if (typeof value === "string") continue;
      const blob = Buffer.from(value);
      const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
      decipher.setAuthTag(blob.subarray(12, 28));
      const plain = Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
      this.db.run(
        "update secret set value = ? where name = ?",
        seal(this.ring, binding(name), plain.toString("utf8")),
        name,
      );
    }
  }
}

const KEY_ID = "k1";
const KEY_CHECK = "secrets.key_check";
const OWNER = "home";
const binding = (name: string) => ["wizards-bot", "secret", name];
