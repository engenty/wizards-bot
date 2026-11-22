import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { PICTURES } from "./check.ts";

// A picture as a model takes it: PNG, JPEG, WebP or GIF, not larger than it needs to be.
// A photo from a phone (HEIC, AVIF, 12 megapixels) is turned into a JPEG with its longest side
// at SIDE, by the tool the computer has: `sips` on a Mac, ImageMagick elsewhere.

const run = promisify(execFile);

/** The longest side a picture keeps: a larger one costs a model more and shows it no more. */
export const SIDE = 1568;
/** A picture a model takes as it is, when nothing on this computer can make it smaller. */
const AS_IS_BYTES = 5 * 1024 * 1024;
/** Smaller than this, a picture a model takes is passed on unchanged. */
const SMALL_BYTES = 1024 * 1024;

export interface Picture {
  name: string;
  mime: string;
  base64: string;
}

type Converter = (input: string, output: string, side: number) => Promise<unknown>;

function onPath(bin: string): boolean {
  return (process.env.PATH ?? "").split(delimiter).some((dir) => dir && existsSync(join(dir, bin)));
}

let found: Converter | null | undefined;

/** How this computer turns a picture into a smaller JPEG; null when it has no tool for it. */
function converter(): Converter | null {
  if (found !== undefined) return found;
  const timeout = 60_000;
  if (process.platform === "darwin" && existsSync("/usr/bin/sips")) {
    found = (input, output, side) =>
      run(
        "/usr/bin/sips",
        [
          "-s",
          "format",
          "jpeg",
          "-s",
          "formatOptions",
          "82",
          "-Z",
          String(side),
          input,
          "--out",
          output,
        ],
        { timeout },
      );
  } else if (onPath("magick")) {
    found = (input, output, side) =>
      run(
        "magick",
        [input, "-auto-orient", "-resize", `${side}x${side}>`, "-quality", "82", output],
        {
          timeout,
        },
      );
  } else {
    found = null;
  }
  return found;
}

/**
 * A picture as a JPEG with its longest side at most `side`, or nothing when this computer has
 * no tool for it or the tool could not read the picture.
 */
export async function asJpeg(
  bytes: Uint8Array,
  mime: string,
  side = SIDE,
): Promise<Buffer | undefined> {
  const convert = converter();
  if (!convert) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "wizards-bot-picture-"));
  try {
    const input = join(dir, `in.${mime.split("/")[1] ?? "bin"}`);
    const output = join(dir, "out.jpg");
    writeFileSync(input, bytes, { mode: 0o600 });
    await convert(input, output, side);
    return readFileSync(output);
  } catch {
    return undefined;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The picture a model is shown of a file, or why there is none. `mime` is the type read from
 * the bytes.
 */
export async function forModel(
  name: string,
  mime: string,
  bytes: Uint8Array,
): Promise<Picture | string> {
  const takes = PICTURES.includes(mime);
  if (takes && bytes.length <= SMALL_BYTES) {
    return { name, mime, base64: Buffer.from(bytes).toString("base64") };
  }
  const jpeg = await asJpeg(bytes, mime);
  if (jpeg) return { name, mime: "image/jpeg", base64: jpeg.toString("base64") };
  if (takes && bytes.length <= AS_IS_BYTES) {
    return { name, mime, base64: Buffer.from(bytes).toString("base64") };
  }
  if (!converter() && !takes)
    return `${name} is a ${mime} picture, and this computer has nothing to turn it into one a model can look at.`;
  return takes
    ? `${name} is too large to look at (${Math.round(bytes.length / 1024 / 1024)} MB), and this computer has nothing to make it smaller.`
    : `${name} could not be turned into a picture a model can look at.`;
}
