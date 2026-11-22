import { type Block, type Inline, parseMarkdown } from "./markdown.ts";
import { attr, esc, replaceInParagraphs, unesc, walk, XML_HEAD } from "./xml.ts";
import { Zip } from "./zip.ts";

// Word documents: made from Markdown, read back as text, and changed in place. A change
// touches the text and leaves everything else of the document as it is.

const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const RELS = "http://schemas.openxmlformats.org/package/2006/relationships";
/** The width of the text on an A4 page with the margins below, in twentieths of a point. */
const TEXT_WIDTH = 9026;

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** How blocks are written: with the styles and numbering of a document this home made, or with none. */
interface Look {
  /** The paragraph properties of a heading: a style of the document, or its look written out. */
  heading(level: number, first: boolean): { paragraph: string; run: string };
  /** Lists by the document's numbering; otherwise the bullet or number is written as text. */
  numbering: boolean;
  /** Links as links; otherwise as their text with the address after it. */
  links: boolean;
  /** Paragraph styles by name; otherwise their look is written out. */
  styles: boolean;
}

interface Written {
  /** The addresses of the links, in the order of their relationships. */
  links: string[];
  /** One per numbered list, so each starts at 1. */
  numberedLists: number;
}

const run = (inline: Inline, properties = ""): string => {
  const rPr = [
    inline.code ? '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>' : "",
    inline.bold ? "<w:b/>" : "",
    inline.italic ? "<w:i/>" : "",
    properties,
  ].join("");
  const pieces = inline.text.split("\n");
  const body = pieces
    .map(
      (piece, index) =>
        `${index ? "<w:br/>" : ""}${piece ? `<w:t xml:space="preserve">${esc(piece)}</w:t>` : ""}`,
    )
    .join("");
  return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}${body}</w:r>`;
};

function runs(parts: Inline[], look: Look, written: Written, properties = ""): string {
  return parts
    .map((inline) => {
      if (!inline.link) return run(inline, properties);
      if (!look.links)
        return run({ ...inline, text: `${inline.text} (${inline.link})` }, properties);
      written.links.push(inline.link);
      return `<w:hyperlink r:id="rIdLink${written.links.length}">${run(inline, `<w:color w:val="1F5FBF"/><w:u w:val="single"/>${properties}`)}</w:hyperlink>`;
    })
    .join("");
}

const paragraph = (properties: string, content: string): string =>
  `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ""}${content}</w:p>`;

const BORDER = 'w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"';

function table(rows: Inline[][][], look: Look, written: Written): string {
  const columns = Math.max(1, rows[0]?.length ?? 1);
  const width = Math.floor(TEXT_WIDTH / columns);
  const grid = `<w:tblGrid>${`<w:gridCol w:w="${width}"/>`.repeat(columns)}</w:tblGrid>`;
  const body = rows
    .map((row, index) => {
      const header = index === 0;
      const tds = row
        .map(
          (cell) =>
            `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : ""}</w:tcPr>${paragraph(
              '<w:spacing w:before="40" w:after="40"/>',
              runs(cell, look, written, header ? "<w:b/>" : ""),
            )}</w:tc>`,
        )
        .join("");
      return `<w:tr>${header ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${tds}</w:tr>`;
    })
    .join("");
  const properties = `<w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders><w:top ${BORDER}/><w:left ${BORDER}/><w:bottom ${BORDER}/><w:right ${BORDER}/><w:insideH ${BORDER}/><w:insideV ${BORDER}/></w:tblBorders><w:tblLayout w:type="autofit"/><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr>`;
  // A paragraph after the table keeps it apart from what follows.
  return `<w:tbl>${properties}${grid}${body}</w:tbl>${paragraph('<w:spacing w:after="0"/>', "")}`;
}

/** Blocks as the paragraphs and tables of a document's body. */
function body(blocks: Block[], look: Look, written: Written): string {
  const out: string[] = [];
  for (const [index, block] of blocks.entries()) {
    if (block.type === "heading") {
      const heading = look.heading(block.level, index === 0);
      out.push(paragraph(heading.paragraph, runs(block.inlines, look, written, heading.run)));
    } else if (block.type === "paragraph") {
      out.push(paragraph("", runs(block.inlines, look, written)));
    } else if (block.type === "quote") {
      out.push(
        paragraph(
          look.styles ? '<w:pStyle w:val="Quote"/>' : '<w:ind w:left="567"/>',
          runs(block.inlines, look, written, look.styles ? "" : "<w:i/>"),
        ),
      );
    } else if (block.type === "code") {
      for (const line of block.text.split("\n")) {
        out.push(
          paragraph(
            look.styles
              ? '<w:pStyle w:val="Code"/>'
              : '<w:shd w:val="clear" w:color="auto" w:fill="F3F3F3"/><w:spacing w:after="0"/>',
            run({ text: line, code: !look.styles }),
          ),
        );
      }
      out.push(paragraph('<w:spacing w:after="0"/>', ""));
    } else if (block.type === "rule") {
      out.push(
        paragraph(
          '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr>',
          "",
        ),
      );
    } else if (block.type === "table") {
      out.push(table(block.rows, look, written));
    } else if (block.type === "list") {
      const numbered = block.items.some((item) => item.ordered);
      if (numbered) written.numberedLists++;
      /** The next number of each level, for lists whose numbers are written as text. */
      const counters = [0, 0, 0];
      for (const item of block.items) {
        if (look.numbering) {
          const id = item.ordered ? written.numberedLists + 1 : 1;
          out.push(
            paragraph(
              `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${item.level}"/><w:numId w:val="${id}"/></w:numPr>`,
              runs(item.inlines, look, written),
            ),
          );
        } else {
          for (let deeper = item.level + 1; deeper < counters.length; deeper++)
            counters[deeper] = 0;
          counters[item.level] = (counters[item.level] ?? 0) + 1;
          const mark = item.ordered ? `${counters[item.level]}.` : item.level === 1 ? "–" : "•";
          out.push(
            paragraph(
              `<w:spacing w:after="60"/><w:ind w:left="${720 * (item.level + 1)}" w:hanging="360"/>`,
              `<w:r><w:t xml:space="preserve">${mark}</w:t><w:tab/></w:r>${runs(item.inlines, look, written)}`,
            ),
          );
        }
      }
    }
  }
  return out.join("");
}

// ── Making a document ───────────────────────────────────────────────────────

const HEADING_SIZES = [32, 26, 24, 22];

function styles(): string {
  const heading = (level: number): string => {
    const size = HEADING_SIZES[level - 1] ?? 22;
    return `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${level === 1 ? 360 : 240}" w:after="${level === 1 ? 120 : 80}"/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="1F2937"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
  };
  return `${XML_HEAD}<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-GB" w:eastAsia="en-GB" w:bidi="ar-SA"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style><w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/><w:unhideWhenUsed/></w:style><w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:uiPriority w:val="99"/><w:semiHidden/><w:unhideWhenUsed/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="10"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:after="240"/><w:contextualSpacing/></w:pPr><w:rPr><w:b/><w:bCs/><w:color w:val="111827"/><w:sz w:val="44"/><w:szCs w:val="44"/></w:rPr></w:style>${[1, 2, 3, 4].map(heading).join("")}<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="34"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/><w:contextualSpacing/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="29"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="BFBFBF"/></w:pBdr><w:ind w:left="284"/></w:pPr><w:rPr><w:i/><w:iCs/><w:color w:val="4B5563"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:uiPriority w:val="40"/><w:qFormat/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F3F3F3"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style></w:styles>`;
}

function numbering(numberedLists: number): string {
  const level = (index: number, format: string, text: string): string =>
    `<w:lvl w:ilvl="${index}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (index + 1)}" w:hanging="360"/></w:pPr></w:lvl>`;
  const bullets = `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${level(0, "bullet", "•")}${level(1, "bullet", "–")}${level(2, "bullet", "•")}</w:abstractNum>`;
  const numbers = `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${level(0, "decimal", "%1.")}${level(1, "lowerLetter", "%2.")}${level(2, "lowerRoman", "%3.")}</w:abstractNum>`;
  const lists = Array.from(
    { length: numberedLists },
    (_, index) =>
      `<w:num w:numId="${index + 2}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`,
  ).join("");
  return `${XML_HEAD}<w:numbering xmlns:w="${W}">${bullets}${numbers}<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>${lists}</w:numbering>`;
}

/** The properties every Office file carries: its title and when it was made. */
export function coreProperties(title: string): string {
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  return `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
}

/** A Word document from Markdown. A first `# ` heading is the document's title. */
export function makeDocx(input: { title: string; content: string }): Uint8Array {
  const written: Written = { links: [], numberedLists: 0 };
  const look: Look = {
    heading: (level, first) => ({
      paragraph: `<w:pStyle w:val="${level === 1 && first ? "Title" : `Heading${Math.min(level, 4)}`}"/>`,
      run: "",
    }),
    numbering: true,
    links: true,
    styles: true,
  };
  const content = body(parseMarkdown(input.content), look, written);
  const section =
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>';
  const zip = new Zip();
  zip.set(
    "[Content_Types].xml",
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
  );
  zip.set(
    "_rels/.rels",
    `${XML_HEAD}<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
  );
  zip.set(
    "word/document.xml",
    `${XML_HEAD}<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${content}${section}</w:body></w:document>`,
  );
  zip.set(
    "word/_rels/document.xml.rels",
    `${XML_HEAD}<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${R}/numbering" Target="numbering.xml"/><Relationship Id="rId3" Type="${R}/settings" Target="settings.xml"/>${written.links
      .map(
        (link, index) =>
          `<Relationship Id="rIdLink${index + 1}" Type="${R}/hyperlink" Target="${esc(link)}" TargetMode="External"/>`,
      )
      .join("")}</Relationships>`,
  );
  zip.set("word/styles.xml", styles());
  zip.set("word/numbering.xml", numbering(written.numberedLists));
  // Without this Word opens the document in its mode for old files.
  zip.set(
    "word/settings.xml",
    `${XML_HEAD}<w:settings xmlns:w="${W}"><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`,
  );
  zip.set("docProps/core.xml", coreProperties(input.title));
  return zip.build();
}

// ── Reading a document ──────────────────────────────────────────────────────

/** Style ids of a document by what they are: a heading's level, or 0 for the title. */
function headingStyles(stylesXml: string | undefined): Map<string, number> {
  const found = new Map<string, number>();
  if (!stylesXml) return found;
  let id: string | undefined;
  walk(stylesXml, {
    open(name, attributes) {
      if (name === "w:style") id = attr(attributes, "w:styleId");
      if (name === "w:name" && id) {
        const styleName = (attr(attributes, "w:val") ?? "").toLowerCase();
        const heading = /^heading (\d)$/.exec(styleName);
        if (heading) found.set(id, Number(heading[1]));
        if (styleName === "title") found.set(id, 0);
      }
    },
    close(name) {
      if (name === "w:style") id = undefined;
    },
  });
  return found;
}

/** Numbering ids of a document whose first level counts (1., a.) instead of a bullet. */
function numberedIds(numberingXml: string | undefined): Set<string> {
  const numbered = new Set<string>();
  if (!numberingXml) return numbered;
  const counting = new Set<string>();
  let abstractId: string | undefined;
  let level: string | undefined;
  let numId: string | undefined;
  walk(numberingXml, {
    open(name, attributes) {
      if (name === "w:abstractNum") abstractId = attr(attributes, "w:abstractNumId");
      if (name === "w:lvl") level = attr(attributes, "w:ilvl");
      if (
        name === "w:numFmt" &&
        abstractId &&
        level === "0" &&
        attr(attributes, "w:val") !== "bullet"
      )
        counting.add(abstractId);
      if (name === "w:num") numId = attr(attributes, "w:numId");
      if (name === "w:abstractNumId" && numId && counting.has(attr(attributes, "w:val") ?? ""))
        numbered.add(numId);
    },
    close(name) {
      if (name === "w:abstractNum") abstractId = undefined;
      if (name === "w:num") numId = undefined;
    },
  });
  return numbered;
}

/** A document's text as light Markdown: headings, lists and tables keep their shape. */
export function readDocx(bytes: Uint8Array): string {
  const zip = Zip.read(bytes);
  const document = zip.text("word/document.xml");
  if (!document) throw new Error("This is not a Word document.");
  const headings = headingStyles(zip.text("word/styles.xml"));
  const numbered = numberedIds(zip.text("word/numbering.xml"));

  interface Paragraph {
    text: string;
    style?: string;
    list?: { level: number; id: string };
  }
  const lines: string[] = [];
  /** Paragraphs that are open: a text box's paragraph stands inside another one. */
  const open: Paragraph[] = [];
  /** Tables that are open, each with its rows of cells. */
  const tables: { rows: string[][]; cell: string[] }[] = [];
  let inText = false;
  let deleted = false;
  /** Inside the copy of a text box that old versions of Word read: it says the same again. */
  let fallback = 0;

  const finish = (paragraph: Paragraph): void => {
    const text = paragraph.text.replace(/\s+$/g, "");
    const table = tables.at(-1);
    if (table) {
      if (text) table.cell.push(text);
      return;
    }
    if (!text) return;
    const level = paragraph.style ? headings.get(paragraph.style) : undefined;
    if (level !== undefined) lines.push(`${"#".repeat(Math.max(1, level))} ${text}`, "");
    else if (paragraph.list)
      lines.push(
        `${"  ".repeat(paragraph.list.level)}${numbered.has(paragraph.list.id) ? "1." : "-"} ${text}`,
      );
    else lines.push(text, "");
  };

  walk(document, {
    open(name, attributes) {
      if (name === "mc:Fallback") fallback++;
      if (fallback) return;
      const current = open.at(-1);
      if (name === "w:p") open.push({ text: "" });
      else if (name === "w:tbl") tables.push({ rows: [], cell: [] });
      else if (name === "w:tr") tables.at(-1)?.rows.push([]);
      else if (name === "w:tc") {
        const table = tables.at(-1);
        if (table) table.cell = [];
      } else if (!current) return;
      else if (name === "w:pStyle") current.style = attr(attributes, "w:val");
      else if (name === "w:ilvl")
        current.list = {
          level: Number(attr(attributes, "w:val") ?? 0),
          id: current.list?.id ?? "",
        };
      else if (name === "w:numId")
        current.list = { level: current.list?.level ?? 0, id: attr(attributes, "w:val") ?? "" };
      else if (name === "w:t") inText = true;
      else if (name === "w:delText") deleted = true;
      else if (name === "w:tab") current.text += "\t";
      else if (name === "w:br" || name === "w:cr") current.text += "\n";
    },
    close(name) {
      if (name === "mc:Fallback") fallback--;
      else if (fallback) return;
      else if (name === "w:t") inText = false;
      else if (name === "w:delText") deleted = false;
      else if (name === "w:p") {
        const paragraph = open.pop();
        if (paragraph) finish(paragraph);
      } else if (name === "w:tc") {
        const table = tables.at(-1);
        table?.rows.at(-1)?.push(table.cell.join(" / ").replace(/\|/g, "\\|").replace(/\n/g, " "));
      } else if (name === "w:tbl") {
        const table = tables.pop();
        if (!table?.rows.length) return;
        const rendered = table.rows.map((row) => `| ${row.join(" | ")} |`);
        const outer = tables.at(-1);
        // A table inside a cell is read as lines of that cell.
        if (outer) outer.cell.push(rendered.join(" "));
        else {
          const [head, ...rest] = rendered;
          lines.push(
            head as string,
            `|${" --- |".repeat(table.rows[0]?.length ?? 1)}`,
            ...rest,
            "",
          );
        }
      }
    },
    text(text) {
      const current = open.at(-1);
      if (current && inText && !deleted && !fallback) current.text += text;
    },
  });
  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Changing a document ─────────────────────────────────────────────────────

export interface TextChange {
  find: string;
  replace: string;
}

export interface DocxEdit {
  changes?: TextChange[];
  /** Markdown put after the paragraph that holds `after`, or at the end. */
  insert?: { content: string; after?: string };
}

/** The parts of a document that hold text a person reads. */
const TEXT_PARTS = /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/;
const INNER_PARAGRAPH = /<w:p(?:\s[^>]*)?>(?:(?!<w:p[\s>])[\s\S])*?<\/w:p>/g;

const paragraphText = (xml: string): string => {
  let text = "";
  for (const found of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)) text += found[1] ?? "";
  return unesc(text);
};

/**
 * Changes a Word document. Returns the new file and one line per change about what
 * happened, for the agent.
 */
export function editDocx(
  bytes: Uint8Array,
  edit: DocxEdit,
): { bytes: Uint8Array; notes: string[] } {
  const zip = Zip.read(bytes);
  if (!zip.has("word/document.xml")) throw new Error("This is not a Word document.");
  const notes: string[] = [];
  const parts = zip.names().filter((name) => TEXT_PARTS.test(name));

  for (const change of edit.changes ?? []) {
    let count = 0;
    for (const name of parts) {
      const replaced = replaceInParagraphs(
        zip.text(name) as string,
        { paragraph: "w:p", text: "w:t" },
        change.find,
        change.replace,
      );
      if (!replaced.count) continue;
      count += replaced.count;
      // A paragraph that was emptied on purpose goes, unless it holds more than text.
      const tidy = change.replace
        ? replaced.xml
        : replaced.xml.replace(INNER_PARAGRAPH, (whole) =>
            !paragraphText(whole) &&
            /<w:t[\s>]/.test(whole) &&
            !/<w:(drawing|pict|object|sectPr)[\s>]/.test(whole)
              ? ""
              : whole,
          );
      zip.set(name, tidy);
    }
    notes.push(
      count
        ? `"${change.find}" replaced ${count === 1 ? "once" : `${count} times`}.`
        : `"${change.find}" is not in the document as one piece of a paragraph. Nothing changed for it; read the document and use its exact words.`,
    );
  }

  if (edit.insert?.content.trim()) {
    const headings = new Map<number, string>();
    for (const [id, level] of headingStyles(zip.text("word/styles.xml"))) {
      if (!headings.has(level)) headings.set(level, id);
    }
    const look: Look = {
      heading: (level) => {
        const id = headings.get(Math.min(level, 4));
        const size = HEADING_SIZES[Math.min(level, 4) - 1] ?? 22;
        return id
          ? { paragraph: `<w:pStyle w:val="${esc(id)}"/>`, run: "" }
          : {
              paragraph: '<w:keepNext/><w:spacing w:before="240" w:after="80"/>',
              run: `<w:b/><w:sz w:val="${size}"/>`,
            };
      },
      numbering: false,
      links: false,
      styles: false,
    };
    const added = body(parseMarkdown(edit.insert.content), look, { links: [], numberedLists: 0 });
    let document = zip.text("word/document.xml") as string;
    let placed = false;
    const after = edit.insert.after?.trim();
    if (after) {
      for (const found of document.matchAll(INNER_PARAGRAPH)) {
        if (!paragraphText(found[0]).includes(after)) continue;
        const end = found.index + found[0].length;
        document = document.slice(0, end) + added + document.slice(end);
        placed = true;
        break;
      }
      if (!placed)
        notes.push(`"${after}" is not in the document, so the new text went to its end.`);
    }
    if (!placed) {
      // The page setup is the last thing in the body; the text goes before it.
      const section = document.lastIndexOf("<w:sectPr");
      const lastBlock = Math.max(document.lastIndexOf("</w:p>"), document.lastIndexOf("</w:tbl>"));
      const end = section > lastBlock ? section : document.lastIndexOf("</w:body>");
      if (end < 0) throw new Error("This Word document has no body.");
      document = document.slice(0, end) + added + document.slice(end);
    }
    zip.set("word/document.xml", document);
    notes.push(placed ? `Text added after "${after}".` : "Text added at the end.");
  }
  return { bytes: zip.build(), notes };
}
