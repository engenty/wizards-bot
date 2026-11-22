import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";

// Word, Excel and PowerPoint files are zip files of XML parts. This reads one, lets parts be
// changed, added and removed, and writes it again. A part that was not touched is written back
// as it was packed.

/** All parts of one file unpacked, at most. A zip that claims more is refused. */
const UNPACKED_LIMIT = 200 * 1024 * 1024;

interface Entry {
  /** 0: stored, 8: deflated. */
  method: number;
  crc: number;
  size: number;
  /** The part as it is packed. */
  packed: Uint8Array;
}

const utf8 = new TextDecoder();

export class ZipRefused extends Error {}

export class Zip {
  private readonly entries = new Map<string, Entry>();

  /** Reads a zip file. Throws `ZipRefused` when the bytes are not one this home reads. */
  static read(bytes: Uint8Array): Zip {
    const zip = new Zip();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // The directory's end record is at the end of the file, before an optional comment.
    let end = bytes.length - 22;
    const first = Math.max(0, bytes.length - 22 - 0xffff);
    while (end >= first && view.getUint32(end, true) !== 0x06054b50) end--;
    if (end < first || end < 0) throw new ZipRefused("This is not a zip file.");
    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    if (count === 0xffff || at === 0xffffffff) throw new ZipRefused("This file is too large.");
    let total = 0;
    for (let index = 0; index < count; index++) {
      if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50)
        throw new ZipRefused("This zip file is damaged.");
      const flags = view.getUint16(at + 8, true);
      const method = view.getUint16(at + 10, true);
      const crc = view.getUint32(at + 16, true);
      const packedSize = view.getUint32(at + 20, true);
      const size = view.getUint32(at + 24, true);
      const nameLength = view.getUint16(at + 28, true);
      const extraLength = view.getUint16(at + 30, true);
      const commentLength = view.getUint16(at + 32, true);
      const local = view.getUint32(at + 42, true);
      const name = utf8.decode(bytes.subarray(at + 46, at + 46 + nameLength));
      at += 46 + nameLength + extraLength + commentLength;
      if (flags & 1) throw new ZipRefused("This file is protected with a password.");
      if (method !== 0 && method !== 8)
        throw new ZipRefused("This zip file is packed in a way this home does not read.");
      if (local + 30 > bytes.length || view.getUint32(local, true) !== 0x04034b50)
        throw new ZipRefused("This zip file is damaged.");
      const start =
        local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      if (start + packedSize > bytes.length) throw new ZipRefused("This zip file is damaged.");
      total += size;
      if (total > UNPACKED_LIMIT) throw new ZipRefused("This file is too large.");
      if (name.endsWith("/")) continue;
      zip.entries.set(name, {
        method,
        crc,
        size,
        packed: bytes.subarray(start, start + packedSize),
      });
    }
    return zip;
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  bytes(name: string): Uint8Array | undefined {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    if (entry.method === 0) return entry.packed;
    try {
      // The size the directory names is the most the part may unpack to.
      return inflateRawSync(entry.packed, { maxOutputLength: Math.max(entry.size, 1) });
    } catch {
      throw new ZipRefused("This zip file is damaged.");
    }
  }

  /** A part as text, or `undefined` when the file has no such part. */
  text(name: string): string | undefined {
    const bytes = this.bytes(name);
    return bytes ? utf8.decode(bytes) : undefined;
  }

  set(name: string, content: string | Uint8Array): void {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    this.entries.set(name, {
      method: 8,
      crc: crc32(bytes),
      size: bytes.length,
      packed: deflateRawSync(bytes),
    });
  }

  delete(name: string): void {
    this.entries.delete(name);
  }

  /** The zip file. */
  build(): Uint8Array {
    const chunks: Uint8Array[] = [];
    const directory: Uint8Array[] = [];
    let offset = 0;
    // 1980-01-01 00:00: the files carry no time of their own.
    const time = 0;
    const date = 0x21;
    for (const [name, entry] of this.entries) {
      const encoded = new TextEncoder().encode(name);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      // Bit 11: the name is UTF-8.
      local.setUint16(6, 0x0800, true);
      local.setUint16(8, entry.method, true);
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, entry.crc, true);
      local.setUint32(18, entry.packed.length, true);
      local.setUint32(22, entry.size, true);
      local.setUint16(26, encoded.length, true);
      chunks.push(new Uint8Array(local.buffer), encoded, entry.packed);

      const central = new DataView(new ArrayBuffer(46));
      central.setUint32(0, 0x02014b50, true);
      central.setUint16(4, 20, true);
      central.setUint16(6, 20, true);
      central.setUint16(8, 0x0800, true);
      central.setUint16(10, entry.method, true);
      central.setUint16(12, time, true);
      central.setUint16(14, date, true);
      central.setUint32(16, entry.crc, true);
      central.setUint32(20, entry.packed.length, true);
      central.setUint32(24, entry.size, true);
      central.setUint16(28, encoded.length, true);
      central.setUint32(42, offset, true);
      directory.push(new Uint8Array(central.buffer), encoded);
      offset += 30 + encoded.length + entry.packed.length;
    }
    const directorySize = directory.reduce((sum, chunk) => sum + chunk.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.entries.size, true);
    end.setUint16(10, this.entries.size, true);
    end.setUint32(12, directorySize, true);
    end.setUint32(16, offset, true);
    const all = [...chunks, ...directory, new Uint8Array(end.buffer)];
    const out = new Uint8Array(offset + directorySize + 22);
    let at = 0;
    for (const chunk of all) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}
