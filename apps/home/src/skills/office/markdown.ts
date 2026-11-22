// The Markdown an agent writes, as the blocks a Word document is built from: headings,
// paragraphs, lists, tables, quotes and code.

export interface Inline {
  /** `\n` is a line break. */
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: string;
}

export interface ListItem {
  /** 0 to 2. */
  level: number;
  ordered: boolean;
  inlines: Inline[];
}

export type Block =
  | { type: "heading"; level: number; inlines: Inline[] }
  | { type: "paragraph"; inlines: Inline[] }
  | { type: "list"; items: ListItem[] }
  /** The first row is the header. */
  | { type: "table"; rows: Inline[][][] }
  | { type: "quote"; inlines: Inline[] }
  | { type: "code"; text: string }
  | { type: "rule" };

const SPAN =
  /(\*\*\*|___)(?=\S)(.+?)(?<=\S)\1|(\*\*|__)(?=\S)(.+?)(?<=\S)\3|\*(?=\S)(.+?)(?<=\S)\*|(?<![\w\\])_(?=\S)(.+?)(?<=\S)_(?!\w)|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** A line's text with its bold, italic, code and links. */
export function inlines(text: string, style: Omit<Inline, "text"> = {}): Inline[] {
  const out: Inline[] = [];
  const plain = (part: string) => {
    if (part) out.push({ ...style, text: part.replace(/\\([\\`*_[\]()#+\-.!|>])/g, "$1") });
  };
  let from = 0;
  for (const found of text.matchAll(SPAN)) {
    plain(text.slice(from, found.index));
    from = found.index + found[0].length;
    if (found[2] !== undefined)
      out.push(...inlines(found[2], { ...style, bold: true, italic: true }));
    else if (found[4] !== undefined) out.push(...inlines(found[4], { ...style, bold: true }));
    else if (found[5] !== undefined) out.push(...inlines(found[5], { ...style, italic: true }));
    else if (found[6] !== undefined) out.push(...inlines(found[6], { ...style, italic: true }));
    else if (found[7] !== undefined) out.push({ ...style, code: true, text: found[7] });
    else if (found[8] !== undefined) {
      const link = /^(https?:\/\/|mailto:)/i.test(found[9] ?? "") ? found[9] : undefined;
      out.push(...inlines(found[8], { ...style, link }));
    }
  }
  plain(text.slice(from));
  return out;
}

/** The plain text of inlines. */
export const plainText = (parts: Inline[]): string => parts.map((part) => part.text).join("");

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const FENCE = /^\s*(```|~~~)/;

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));

/** Lines of one paragraph as one text: a line that ends in two spaces or `\` breaks there. */
const joinLines = (lines: string[]): string =>
  lines
    .map((line, index) =>
      index === lines.length - 1
        ? line.trim()
        : / {2,}$|\\$/.test(line)
          ? `${line.replace(/( {2,}|\\)$/, "").trim()}\n`
          : `${line.trim()} `,
    )
    .join("");

export function parseMarkdown(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let at = 0;
  const line = (): string => lines[at] ?? "";
  const startsBlock = (text: string): boolean =>
    HEADING.test(text) ||
    ITEM.test(text) ||
    RULE.test(text) ||
    FENCE.test(text) ||
    text.startsWith(">");
  while (at < lines.length) {
    const text = line();
    if (!text.trim()) {
      at++;
      continue;
    }
    const fence = FENCE.exec(text);
    if (fence) {
      const body: string[] = [];
      at++;
      while (
        at < lines.length &&
        !line()
          .trim()
          .startsWith(fence[1] as string)
      )
        body.push(lines[at++] as string);
      at++;
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(text);
    if (heading) {
      blocks.push({
        type: "heading",
        level: (heading[1] as string).length,
        inlines: inlines(heading[2] ?? ""),
      });
      at++;
      continue;
    }
    if (RULE.test(text)) {
      blocks.push({ type: "rule" });
      at++;
      continue;
    }
    if (
      text.includes("|") &&
      TABLE_RULE.test(lines[at + 1] ?? "") &&
      (lines[at + 1] ?? "").includes("-")
    ) {
      const rows: Inline[][][] = [cells(text).map((cell) => inlines(cell))];
      at += 2;
      while (at < lines.length && line().includes("|") && line().trim()) {
        rows.push(cells(line()).map((cell) => inlines(cell)));
        at++;
      }
      const width = Math.max(...rows.map((row) => row.length));
      for (const row of rows) while (row.length < width) row.push([]);
      blocks.push({ type: "table", rows });
      continue;
    }
    if (ITEM.test(text)) {
      const items: ListItem[] = [];
      /** The indents of the levels that are open. */
      const indents: number[] = [];
      while (at < lines.length) {
        const item = ITEM.exec(line());
        if (item) {
          const indent = (item[1] ?? "").replace(/\t/g, "    ").length;
          while (indents.length && indent < (indents.at(-1) as number)) indents.pop();
          if (!indents.length || indent > (indents.at(-1) as number)) indents.push(indent);
          const box = /^\[([ xX])\]\s+(.*)$/.exec(item[3] ?? "");
          const ordered = /\d/.test(item[2] ?? "");
          // Points after numbers, or numbers after points, are a list of their own.
          if (items.length && indents.length === 1 && ordered !== items[0]?.ordered) break;
          items.push({
            level: Math.min(indents.length - 1, 2),
            ordered,
            inlines: inlines(box ? `${box[1] === " " ? "☐" : "☑"} ${box[2]}` : (item[3] ?? "")),
          });
          at++;
        } else if (line().trim() && /^\s+/.test(line()) && items.length) {
          // An indented line goes on with the item above it.
          (items.at(-1) as ListItem).inlines.push(...inlines(` ${line().trim()}`));
          at++;
        } else if (!line().trim() && ITEM.test(lines[at + 1] ?? "")) {
          at++;
        } else {
          break;
        }
      }
      blocks.push({ type: "list", items });
      continue;
    }
    if (text.startsWith(">")) {
      const body: string[] = [];
      while (at < lines.length && line().startsWith(">"))
        body.push((lines[at++] as string).replace(/^>\s?/, ""));
      blocks.push({ type: "quote", inlines: inlines(joinLines(body)) });
      continue;
    }
    const body: string[] = [];
    while (at < lines.length && line().trim() && !(body.length && startsBlock(line()))) {
      body.push(lines[at++] as string);
    }
    blocks.push({ type: "paragraph", inlines: inlines(joinLines(body)) });
  }
  return blocks;
}
