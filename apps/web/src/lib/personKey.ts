// The person's own key on this device. It signs the record that says which homes speak for
// them, and it never goes to a home: the browser keeps it where no page can read it out, and
// the home gets signatures only. The recovery code is the key itself, written so that a person
// can copy it down; it is shown once, when the key is made.

const DB = "wizards-person";
const STORE = "key";
const ID = "person";

/** What stands before the 32 bytes of an Ed25519 key in the form browsers import (PKCS #8). */
const PKCS8 = [
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];
/** Letters and digits that are not mistaken for each other when written down. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const KEY_BYTES = 32;

/** One byte that changes when a character of the code is wrong or two are swapped. */
function check(seed: Uint8Array): number {
  let sum = 0;
  seed.forEach((byte, index) => {
    sum = (sum + byte * (index + 1)) % 256;
  });
  return sum;
}

/** The key as a code to write down: groups of four, `7K2M-…`. */
export function codeOf(seed: Uint8Array): string {
  const bytes = [...seed, check(seed)];
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  let code = "";
  for (let at = 0; at < bits.length; at += 5) {
    code += ALPHABET[Number.parseInt(bits.slice(at, at + 5).padEnd(5, "0"), 2)];
  }
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

/** The key a code stands for; nothing when the code is not one, or was copied wrongly. */
export function seedOf(code: string): Uint8Array | undefined {
  const typed = code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  let bits = "";
  for (const char of typed) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) return undefined;
    bits += value.toString(2).padStart(5, "0");
  }
  if (bits.length < (KEY_BYTES + 1) * 8 || bits.length >= (KEY_BYTES + 1) * 8 + 5) return undefined;
  const bytes = new Uint8Array(KEY_BYTES + 1);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2);
  }
  const seed = bytes.slice(0, KEY_BYTES);
  return check(seed) === bytes[KEY_BYTES] ? seed : undefined;
}

/** Whether this browser can keep a key: it needs a page reached over https, or on this computer. */
export const canKeepKey = (): boolean =>
  typeof crypto !== "undefined" && crypto.subtle !== undefined && typeof indexedDB !== "undefined";

interface Held {
  id: string;
  key: CryptoKey;
  publicKey: string;
}

function store<T>(mode: IDBTransactionMode, work: (held: IDBObjectStore) => IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    const opening = indexedDB.open(DB, 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore(STORE, { keyPath: "id" });
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const request = work(opening.result.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    };
  });
}

/** The key in the form the browser signs with, which cannot be read out again, and its public half. */
export async function keyFrom(seed: Uint8Array): Promise<{ key: CryptoKey; publicKey: string }> {
  const pkcs8 = new Uint8Array([...PKCS8, ...seed]);
  const readable = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, [
    "sign",
  ]);
  const { x } = await crypto.subtle.exportKey("jwk", readable);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  return { key, publicKey: x as string };
}

const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** A signature over a text, as a home checks it. */
export async function signText(key: CryptoKey, text: string): Promise<string> {
  const signature = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(text));
  return base64url(new Uint8Array(signature));
}

/** Makes the person's key and keeps it here. The code is returned this once. */
export async function makeKey(): Promise<{ publicKey: string; code: string }> {
  const seed = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const made = await keyFrom(seed);
  await store("readwrite", (held) => held.put({ id: ID, ...made } satisfies Held));
  return { publicKey: made.publicKey, code: codeOf(seed) };
}

/** Brings a key back from its recovery code and keeps it here. Nothing for a wrong code. */
export async function bringBack(code: string): Promise<string | undefined> {
  const seed = seedOf(code);
  if (!seed) return undefined;
  const made = await keyFrom(seed);
  await store("readwrite", (held) => held.put({ id: ID, ...made } satisfies Held));
  return made.publicKey;
}

/** The public half of the key this device holds. */
export async function heldKey(): Promise<string | undefined> {
  const held = await store<Held | undefined>("readonly", (keys) => keys.get(ID));
  return held?.publicKey;
}

/** Signs a version of the record with the key this device holds. */
export async function signWith(payload: string): Promise<string> {
  const held = await store<Held | undefined>("readonly", (keys) => keys.get(ID));
  if (!held) throw new Error("no key");
  return signText(held.key, payload);
}
