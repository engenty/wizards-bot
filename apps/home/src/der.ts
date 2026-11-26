// DER by hand, for the few certificate shapes the home writes itself: Node reads certificates
// (X509Certificate) but writes none.

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** One element: its tag, its length and its parts. */
export function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

export function oid(text: string): Buffer {
  const [a = 0, b = 0, ...rest] = text.split(".").map(Number);
  const bytes = [a * 40 + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

export const sequence = (...parts: Buffer[]): Buffer => tlv(0x30, ...parts);

/** DER as PEM, under `label` ("CERTIFICATE", "CERTIFICATE REQUEST"). */
export function pem(label: string, der: Buffer): string {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}
