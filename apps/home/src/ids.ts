import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

function random(length: number, alphabet = ALPHABET): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

export type IdPrefix =
  | "agt"
  | "fac"
  | "cnv"
  | "msg"
  | "crd"
  | "doc"
  | "art"
  | "dev"
  | "con"
  | "sch"
  | "shr"
  | "clr"
  | "lnk"
  | "fil"
  | "fld"
  | "mrk"
  | "hnd"
  | "rom"
  | "inv"
  | "vlt"
  | "vac";

export const newId = (prefix: IdPrefix): string => `${prefix}_${random(16)}`;

/** A device token. Only its hash is stored. */
export const newToken = (): string => randomBytes(32).toString("base64url");

/** A pairing code a person can read aloud and type: `K7QM-2RXD`. */
export function newPairingCode(): string {
  const raw = random(8, "23456789ABCDEFGHJKMNPQRSTVWXYZ");
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export const now = (): string => new Date().toISOString();
