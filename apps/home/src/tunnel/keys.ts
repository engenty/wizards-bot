import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
  X509Certificate,
} from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

// The keys of a home's address at wizards.host: the claim key, which the name is made from, and
// the key of the name's certificate. Both are made on this computer and never leave it.

/** Renew a certificate this long before it ends. */
export const RENEW_BEFORE = 30 * 24 * 3600_000;

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lower case, without padding. */
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** The label a claim key gets: the first 10 characters of base32(sha256(raw public key)). */
export const labelOf = (publicKeyRaw: Uint8Array): string =>
  base32(createHash("sha256").update(publicKeyRaw).digest()).slice(0, 10);

/** Writes a file in one move; readable only by the computer's account where `secret`. */
export function writeAtomic(file: string, text: string, secret = false): void {
  const next = `${file}.next`;
  writeFileSync(next, text, { mode: secret ? 0o600 : 0o644 });
  if (secret) chmodSync(next, 0o600);
  renameSync(next, file);
}

/** The Ed25519 claim key in `file`, made the first time. Losing it loses the name. */
export function claimKey(file: string): KeyObject {
  if (!existsSync(file)) {
    const { privateKey } = generateKeyPairSync("ed25519");
    writeAtomic(file, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), true);
  }
  return createPrivateKey(readFileSync(file, "utf8"));
}

/** A key's raw 32-byte public half, base64url without padding. */
export const publicKeyOf = (key: KeyObject): string =>
  String(createPublicKey(key).export({ format: "jwk" }).x);

/** The name a claim key claims at wizards.host. */
export const nameOf = (key: KeyObject, domain = "wizards.host"): string =>
  `${labelOf(Buffer.from(publicKeyOf(key), "base64url"))}.${domain}`;

/** What a claim signs: the relay's domain, so a claim for one relay is none for another. */
export const claimText = (publicKey: string, timestamp: number, domain = "wizards.host"): string =>
  `${domain} claim ${publicKey} ${timestamp}`;

/** The body of `POST /v1/tunnels/claim`: the public key, the time, and the signature over both. */
export function claimBody(
  key: KeyObject,
  now = Date.now(),
  domain = "wizards.host",
): { publicKey: string; timestamp: number; signature: string } {
  const publicKey = publicKeyOf(key);
  const signature = sign(null, Buffer.from(claimText(publicKey, now, domain)), key).toString(
    "base64url",
  );
  return { publicKey, timestamp: now, signature };
}

/** A new EC P-256 private key for a certificate, as PEM. */
export const makeKey = (): string =>
  generateKeyPairSync("ec", { namedCurve: "P-256" })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();

// ── A certificate request, in DER by hand: Node has no API for one ──────────

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

function oid(text: string): Buffer {
  const [a = 0, b = 0, ...rest] = text.split(".").map(Number);
  const bytes = [a * 40 + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

const sequence = (...parts: Buffer[]) => tlv(0x30, ...parts);

/**
 * A PKCS#10 certificate request for one name, signed with an EC P-256 key: the name as the
 * subject's common name and as the only DNS name.
 */
export function csrFor(name: string, keyPem: string): string {
  const key = createPrivateKey(keyPem);
  const spki = createPublicKey(key).export({ type: "spki", format: "der" });
  const subject = sequence(tlv(0x31, sequence(oid("2.5.4.3"), tlv(0x0c, Buffer.from(name)))));
  const san = sequence(tlv(0x82, Buffer.from(name, "ascii")));
  const extensions = sequence(sequence(oid("2.5.29.17"), tlv(0x04, san)));
  const attributes = tlv(0xa0, sequence(oid("1.2.840.113549.1.9.14"), tlv(0x31, extensions)));
  const info = sequence(tlv(0x02, Buffer.from([0])), subject, spki, attributes);
  const signature = sign("sha256", info, { key, dsaEncoding: "der" });
  const der = sequence(
    info,
    sequence(oid("1.2.840.10045.4.3.2")),
    tlv(0x03, Buffer.from([0]), signature),
  );
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE REQUEST-----\n${lines.join("\n")}\n-----END CERTIFICATE REQUEST-----\n`;
}

/** When a certificate ends, or undefined when the text is not one. */
export function notAfter(certPem: string): Date | undefined {
  try {
    return new Date(new X509Certificate(certPem).validTo);
  } catch {
    return undefined;
  }
}

/** Whether a certificate is missing, unreadable, or ends within RENEW_BEFORE. */
export function needsRenewal(certPem: string | undefined, now = Date.now()): boolean {
  const end = certPem ? notAfter(certPem) : undefined;
  return !end || end.getTime() - now < RENEW_BEFORE;
}
