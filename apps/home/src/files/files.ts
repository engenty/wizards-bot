import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FileRef } from "@wizards-bot/protocol";
import type { Home } from "../home.ts";
import { newId, now } from "../ids.ts";
import { documentKind, documentText, piece } from "../skills/office/read.ts";
import { checkFile, PICTURES } from "./check.ts";
import { asJpeg, forModel } from "./pictures.ts";

/** Text of an attached file an agent reads in the message, at most. */
const TEXT_LIMIT = 20_000;
/** Pictures a browser does not show, kept as a JPEG instead. */
const SHOWN_AS_JPEG = ["image/heic", "image/avif"];
/** The longest side of a picture kept as a JPEG: enough to read a page of notes. */
const KEPT_SIDE = 3024;

interface Row {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/** What a model gets of a message's files: text to read and pictures to look at. */
export interface ForModel {
  text: string;
  pictures: { name: string; mime: string; base64: string }[];
}

/** The files people gave the home, kept in its data folder under their ids. */
export class Files {
  private readonly dir: string;
  private readonly home: Home;

  constructor(home: Home) {
    this.home = home;
    this.dir = join(home.config.dataDir, "files");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  /** Checks and keeps a file. Throws `FileRefused` when it is not what it says. */
  add(input: { name: string; mime: string; bytes: Uint8Array }): FileRef {
    const { name, mime } = checkFile(input);
    return this.keep(name, mime, input.bytes);
  }

  /**
   * A file the person gave: checked and kept as `add` does, but a picture browsers do not show
   * (HEIC, AVIF from a phone) is kept as a JPEG, when this computer can make one.
   */
  async addGiven(input: { name: string; mime: string; bytes: Uint8Array }): Promise<FileRef> {
    const { name, mime } = checkFile(input);
    if (SHOWN_AS_JPEG.includes(mime)) {
      const jpeg = await asJpeg(input.bytes, mime, KEPT_SIDE);
      if (jpeg) return this.keep(`${name.replace(/\.[^.]+$/, "")}.jpg`, "image/jpeg", jpeg);
    }
    return this.keep(name, mime, input.bytes);
  }

  private keep(name: string, mime: string, bytes: Uint8Array): FileRef {
    const id = newId("fil");
    writeFileSync(join(this.dir, id), bytes, { mode: 0o600 });
    this.home.db.run(
      "insert into file (id, name, mime, size, created_at) values (?, ?, ?, ?, ?)",
      id,
      name,
      mime,
      bytes.length,
      now(),
    );
    return { id, name, mime, size: bytes.length };
  }

  get(id: string): FileRef | undefined {
    const row = this.home.db.get<Row>("select id, name, mime, size from file where id = ?", id);
    return row ? { id: row.id, name: row.name, mime: row.mime, size: row.size } : undefined;
  }

  bytes(id: string): Buffer | undefined {
    const path = join(this.dir, id);
    return /^fil_[a-z0-9]+$/.test(id) && existsSync(path) ? readFileSync(path) : undefined;
  }

  remove(id: string): void {
    if (!/^fil_[a-z0-9]+$/.test(id)) return;
    rmSync(join(this.dir, id), { force: true });
    this.home.db.run("delete from file where id = ?", id);
  }

  /**
   * A message's files as a model takes them: a picture as a picture, a text file as its
   * text, a Word, Excel or PowerPoint file or a PDF as the text read from it, any other
   * file by its name.
   */
  async forModel(files: FileRef[]): Promise<ForModel> {
    const lines: string[] = [];
    const pictures: ForModel["pictures"] = [];
    for (const file of files) {
      const bytes = this.bytes(file.id);
      if (!bytes) continue;
      if (PICTURES.includes(file.mime) || SHOWN_AS_JPEG.includes(file.mime)) {
        const picture = await forModel(file.name, file.mime, bytes);
        if (typeof picture === "string") lines.push(`Attached picture: ${picture}`);
        else {
          pictures.push(picture);
          lines.push(`Attached picture: ${file.name}`);
        }
      } else if (documentKind(file.name)) {
        try {
          const text = (await documentText(file.name, bytes)) ?? "";
          const cut = piece(text, 0, TEXT_LIMIT, `read on with \`file_read\``);
          lines.push(`Attached file ${file.name} (${file.id}), its text:\n\`\`\`\n${cut}\n\`\`\``);
        } catch (error) {
          lines.push(`Attached file: ${file.name} (${file.id}). ${(error as Error).message}`);
        }
      } else if (
        file.mime.startsWith("text/") ||
        /(json|xml|yaml|csv|javascript)/.test(file.mime)
      ) {
        const text = bytes.toString("utf8");
        const cut =
          text.length > TEXT_LIMIT
            ? `${text.slice(0, TEXT_LIMIT)}\n[cut: ${text.length} characters in all]`
            : text;
        lines.push(`Attached file ${file.name}:\n\`\`\`\n${cut}\n\`\`\``);
      } else {
        lines.push(
          `Attached file: ${file.name} (${file.mime}, ${Math.ceil(file.size / 1024)} KB). You cannot read this kind of file here.`,
        );
      }
    }
    return { text: lines.join("\n\n"), pictures };
  }
}
