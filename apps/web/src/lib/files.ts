// From engenty wizards: `formatBytes` (packages/shared/src/numbers.ts), `kindOf` and `typeLabel`
// (apps/web/src/ui/file-preview.tsx), `pastedName` (apps/web/src/ui/composer.tsx).

import { FILE_LIMIT, FILES_PER_MESSAGE } from "@wizards-bot/protocol/limits";

export { FILE_LIMIT, FILES_PER_MESSAGE };
/** The limit as the home's documents name it. */
export const FILE_LIMIT_LABEL = `${FILE_LIMIT / 1024 / 1024} MB`;

/** What is known of a file wherever it is shown: attached and not yet sent, or in a message. */
export interface ShownFile {
  name: string;
  mime: string;
  size?: number;
  /** Where its bytes open from; without one the file shows as a tile but does not open. */
  url?: string;
}

type FileKind = "image" | "pdf" | "video" | "audio" | "text" | "other";

const TEXT_EXT = /\.(md|markdown|txt|csv|tsv|json|ya?ml|xml|log|html?|css|js|ts|tsx|sql)$/i;

/** Pictures every browser shows. A phone's HEIC is not one: the home keeps it as a JPEG. */
const SHOWN_PICTURES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
  "image/bmp",
]);

/** How a file opens: by its type, else by its name's ending. */
export function kindOf({ mime, name }: { mime: string; name: string }): FileKind {
  if (SHOWN_PICTURES.has(mime)) {
    return "image";
  }
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) {
    return "pdf";
  }
  if (mime.startsWith("video/")) {
    return "video";
  }
  if (mime.startsWith("audio/")) {
    return "audio";
  }
  if (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    TEXT_EXT.test(name)
  ) {
    return "text";
  }
  return "other";
}

/** The types a message shows as the picture itself; every other file is a row with its name. */
export function isPicture(mime: string): boolean {
  return /^image\/(png|jpeg|webp|gif)$/.test(mime);
}

/** "PDF", "DOCX", "PNG": the name's ending, or else the type's. */
export function typeLabel({ mime, name }: { mime: string; name: string }): string {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1) : mime.split("/").pop();
  return (ext ?? "").slice(0, 5).toUpperCase();
}

/**
 * A file's size in decimal units, as the operating systems show them: `1 KB` for anything below
 * a kilobyte but nothing (`0 KB`), `340 KB`, `2.4 MB`, `1.2 GB`.
 */
export function formatBytes(bytes: number): string {
  if (!(bytes > 0)) {
    return "0 KB";
  }
  if (bytes < 999_500) {
    return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  }
  if (bytes < 999_950_000) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

/** A clipboard picture is always "image.png"; give each its own name so two pastes both stay. */
export function pastedName(file: File, index: number): File {
  if (file.name && file.name !== "image.png") {
    return file;
  }
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
  return new File([file], `paste-${stamp}${index ? `-${index + 1}` : ""}.${ext}`, {
    type: file.type,
  });
}

/** How many of `offered` files a message still takes when it has `attached` already. */
export function roomFor(attached: number, offered: number): number {
  return Math.max(0, Math.min(offered, FILES_PER_MESSAGE - attached));
}

/** Hands a file to the browser to keep, under its own name. */
export function saveFile(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
