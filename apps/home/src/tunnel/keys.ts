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
import { oid, pem, sequence, tlv } from "../der.ts";

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

// ── The certificate request for the name ────────────────────────────────────

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
  return pem("CERTIFICATE REQUEST", der);
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
