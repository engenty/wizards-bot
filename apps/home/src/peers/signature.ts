import { createHash, randomBytes } from "node:crypto";
import { Identity } from "../identity.ts";

// Requests between homes are signed the way RFC 9421 (HTTP Message Signatures) describes,
// with Ed25519 over the method, the path, the body's digest and the handle of the home the
// request is for. The `keyid` is the sender's handle; the receiver knows its key. Each
// request carries a `nonce` of its own: a home hears a signed request once (`Peers.verified`),
// so a request someone recorded cannot be sent again while its time still counts.

const COMPONENTS = '("@method" "@path" "content-digest" "x-wizards-to")';
const MAX_SKEW_SECONDS = 300;
/** How long a signed request counts, and so how long a home remembers that it heard it. */
export const SIGNATURE_LASTS_MS = MAX_SKEW_SECONDS * 1000;
const NONCE = /;nonce="([A-Za-z0-9_-]{16,64})"/;

export interface SignedHeaders {
  "content-digest": string;
  "x-wizards-to": string;
  "signature-input": string;
  signature: string;
}

const digest = (body: string): string =>
  `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;

function base(
  method: string,
  path: string,
  contentDigest: string,
  to: string,
  params: string,
): string {
  return [
    `"@method": ${method.toUpperCase()}`,
    `"@path": ${path}`,
    `"content-digest": ${contentDigest}`,
    `"x-wizards-to": ${to}`,
    `"@signature-params": ${params}`,
  ].join("\n");
}

export function signRequest(input: {
  identity: Identity;
  from: string;
  to: string;
  method: string;
  path: string;
  body: string;
  now?: number;
}): SignedHeaders {
  const created = Math.floor((input.now ?? Date.now()) / 1000);
  const nonce = randomBytes(12).toString("base64url");
  const params = `${COMPONENTS};created=${created};keyid="${input.from}";alg="ed25519";nonce="${nonce}"`;
  const contentDigest = digest(input.body);
  const signature = input.identity.sign(
    base(input.method, input.path, contentDigest, input.to, params),
  );
  return {
    "content-digest": contentDigest,
    "x-wizards-to": input.to,
    "signature-input": `sig1=${params}`,
    signature: `sig1=:${Buffer.from(signature, "base64url").toString("base64")}:`,
  };
}

/** The handle a request claims to come from, before its signature is checked. */
export function signer(headers: Headers): string | undefined {
  return /keyid="([^"]+)"/.exec(headers.get("signature-input") ?? "")?.[1];
}

/** What makes a signed request this one and no other, before its signature is checked. */
export function nonceOf(headers: Headers): string | undefined {
  return NONCE.exec(headers.get("signature-input") ?? "")?.[1];
}

/** Whether the request was signed by the holder of `publicKey`, for this home, just now. */
export function verifyRequest(input: {
  headers: Headers;
  publicKey: string;
  to: string;
  method: string;
  path: string;
  body: string;
  now?: number;
}): boolean {
  const signatureInput = input.headers.get("signature-input") ?? "";
  const params = signatureInput.startsWith("sig1=") ? signatureInput.slice(5) : "";
  const signature = /^sig1=:([A-Za-z0-9+/=]+):$/.exec(input.headers.get("signature") ?? "")?.[1];
  const created = Number(/;created=(\d+)/.exec(params)?.[1]);
  if (!params.startsWith(COMPONENTS) || !signature || !created || !NONCE.test(params)) return false;
  if (Math.abs((input.now ?? Date.now()) / 1000 - created) > MAX_SKEW_SECONDS) return false;
  if (input.headers.get("x-wizards-to") !== input.to) return false;
  const contentDigest = digest(input.body);
  if (input.headers.get("content-digest") !== contentDigest) return false;
  return Identity.verify(
    input.publicKey,
    base(input.method, input.path, contentDigest, input.to, params),
    Buffer.from(signature, "base64").toString("base64url"),
  );
}
