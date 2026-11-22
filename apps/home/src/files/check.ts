import { FILE_LIMIT } from "@wizards-bot/protocol";

// What the home does with a file before it keeps it: a clean name, a size limit, and the
// type read from the bytes. A file that is not what its name and type say is refused.

export class FileRefused extends Error {
  readonly code: "too_large" | "not_its_type" | "empty";
  constructor(code: FileRefused["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** Pictures a model and a device can show. */
export const PICTURES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** A name without folders, control characters or direction overrides, at most 120 characters. */
export function cleanName(name: string): string {
  const base =
    name
      .split(/[\\/]/)
      .pop()
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
      ?.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "")
      .trim() ?? "";
  if (!base || base === "." || base === "..") return "file";
  if (base.length <= 120) return base;
  const dot = base.lastIndexOf(".");
  const ending = dot > 0 && base.length - dot <= 12 ? base.slice(dot) : "";
  return base.slice(0, 120 - ending.length) + ending;
}

const starts = (bytes: Uint8Array, ...signature: number[]): boolean =>
  signature.every((byte, at) => bytes[at] === byte);
const ascii = (bytes: Uint8Array, from: number, to: number): string =>
  String.fromCharCode(...bytes.subarray(from, to));

/** The type the bytes show, for the kinds the home knows by their first bytes. */
export function sniff(bytes: Uint8Array): string | undefined {
  if (starts(bytes, 0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(bytes, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(bytes, 0, 4) === "GIF8") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WAVE") return "audio/wav";
  if (ascii(bytes, 0, 5) === "%PDF-") return "application/pdf";
  if (starts(bytes, 0x50, 0x4b, 0x03, 0x04)) return "application/zip";
  if (ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (/^(heic|heix|mif1|msf1)/.test(brand)) return "image/heic";
    if (brand.startsWith("avif")) return "image/avif";
    if (brand.startsWith("qt")) return "video/quicktime";
    if (brand.startsWith("M4A")) return "audio/mp4";
    return "video/mp4";
  }
  if (ascii(bytes, 0, 3) === "ID3" || starts(bytes, 0xff, 0xfb)) return "audio/mpeg";
  if (ascii(bytes, 0, 4) === "OggS") return "audio/ogg";
  if (starts(bytes, 0x1a, 0x45, 0xdf, 0xa3)) return "video/webm";
  return undefined;
}

/** Whether the bytes read as text: valid UTF-8 without a zero byte. */
export function isText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 64 * 1024);
  if (head.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(
      head.length === bytes.length ? head : head.subarray(0, head.length - 4),
    );
    return true;
  } catch {
    return false;
  }
}

/** Office documents are zip files; their type is taken from the name. */
const ZIPPED: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  epub: "application/epub+zip",
};

/**
 * Checks a file a device sent. Returns the name and the type the home keeps: the type the
 * bytes show wins over the type the device named.
 */
export function checkFile(input: { name: string; mime: string; bytes: Uint8Array }): {
  name: string;
  mime: string;
} {
  const name = cleanName(input.name);
  if (!input.bytes.length) throw new FileRefused("empty", `“${name}” is empty.`);
  if (input.bytes.length > FILE_LIMIT) {
    throw new FileRefused(
      "too_large",
      `“${name}” is larger than ${Math.round(FILE_LIMIT / 1024 / 1024)} MB.`,
    );
  }
  const declared = input.mime.split(";")[0]?.trim().toLowerCase() ?? "";
  const found = sniff(input.bytes);
  const text = !found && isText(input.bytes);
  const group = (mime: string): string => mime.split("/")[0] ?? "";
  if (["image", "audio", "video"].includes(group(declared)) && declared !== "image/svg+xml") {
    if (!found || group(found) !== group(declared)) {
      throw new FileRefused(
        "not_its_type",
        `“${name}” is not the ${group(declared) === "image" ? "picture" : group(declared)} its name says.`,
      );
    }
  }
  if (declared === "application/pdf" && found !== "application/pdf") {
    throw new FileRefused("not_its_type", `“${name}” is not the PDF its name says.`);
  }
  if (found === "application/zip") {
    const ending = name.split(".").pop()?.toLowerCase() ?? "";
    return { name, mime: ZIPPED[ending] ?? found };
  }
  if (found) return { name, mime: found };
  if (text) {
    const known =
      declared.startsWith("text/") || /(json|xml|yaml|csv|markdown|javascript|svg)/.test(declared);
    return { name, mime: known ? declared : "text/plain" };
  }
  return { name, mime: "application/octet-stream" };
}
