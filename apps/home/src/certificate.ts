import { createHash, createPrivateKey, createPublicKey, randomBytes, sign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { oid, pem, sequence, tlv } from "./der.ts";
import { makeKey, writeAtomic } from "./tunnel/keys.ts";

// The home's own certificate, for https on the person's network. It is made on this computer the
// first time and signed by no one: a device trusts it because the print of its key came with the
// pairing code, from the person's own screen (docs/protocol.md, "Pairing").
//
// In the data folder's `certificate/`:
//   key.pem    its EC P-256 private key (0600). It never leaves the computer.
//   cert.pem   the certificate, made again from the same key when it is missing

/** The home's key and certificate for https, and the print devices know it by. */
export interface OwnCertificate {
  key: string;
  cert: string;
  print: string;
}

/** The print of a key: SHA-256 of its public half (SPKI, DER), base64url without padding. */
export const printOf = (keyPem: string): string =>
  createHash("sha256")
    .update(createPublicKey(createPrivateKey(keyPem)).export({ type: "spki", format: "der" }))
    .digest("base64url");

/** The certificate in `dir`, made the first time. */
export function ownCertificate(dir: string): OwnCertificate {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyFile = join(dir, "key.pem");
  const certFile = join(dir, "cert.pem");
  if (!existsSync(keyFile)) writeAtomic(keyFile, makeKey(), true);
  const key = readFileSync(keyFile, "utf8");
  if (!existsSync(certFile)) writeAtomic(certFile, selfSigned(key));
  return { key, cert: readFileSync(certFile, "utf8"), print: printOf(key) };
}

/** `YYMMDDHHMMSSZ`, as a certificate's UTCTime. */
const utcTime = (date: Date): Buffer =>
  tlv(0x17, Buffer.from(`${date.toISOString().slice(2, 19).replace(/[-T:]/g, "")}Z`));

/**
 * A certificate signed with its own key. It ends at 9999-12-31, which RFC 5280 gives a
 * certificate with no end: a device checks the key's print, not the date or a name.
 */
export function selfSigned(keyPem: string, now = new Date()): string {
  const key = createPrivateKey(keyPem);
  const spki = createPublicKey(key).export({ type: "spki", format: "der" });
  const name = sequence(
    tlv(0x31, sequence(oid("2.5.4.3"), tlv(0x0c, Buffer.from("wizards.bot Bot Server")))),
  );
  const serial = randomBytes(16);
  serial[0] = (serial[0] as number) & 0x7f;
  const ecdsaSha256 = sequence(oid("1.2.840.10045.4.3.2"));
  const extension = (id: string, value: Buffer, critical = false) =>
    sequence(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value));
  const extensions = sequence(
    // Not a certificate authority.
    extension("2.5.29.19", sequence(), true),
    // Signs the handshake, for a server.
    extension("2.5.29.15", tlv(0x03, Buffer.from([0x07, 0x80])), true),
    extension("2.5.29.37", sequence(oid("1.3.6.1.5.5.7.3.1"))),
  );
  const info = sequence(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    ecdsaSha256,
    name,
    sequence(
      utcTime(new Date(now.getTime() - 24 * 3600_000)),
      tlv(0x18, Buffer.from("99991231235959Z")),
    ),
    name,
    spki,
    tlv(0xa3, extensions),
  );
  const signature = sign("sha256", info, { key, dsaEncoding: "der" });
  return pem("CERTIFICATE", sequence(info, ecdsaSha256, tlv(0x03, Buffer.from([0]), signature)));
}
