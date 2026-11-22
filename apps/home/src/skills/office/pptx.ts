import { coreProperties, type TextChange } from "./docx.ts";
import { type Block, type Inline, parseMarkdown, plainText } from "./markdown.ts";
import { attr, esc, relationships, replaceInParagraphs, resolve, walk, XML_HEAD } from "./xml.ts";
import { Zip } from "./zip.ts";

// PowerPoint decks: made from a Markdown outline, read back as one, and changed in place. A
// made deck has a title slide and slides with a title, points and tables; it carries no
// speaker notes and no pictures.

const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const RELS = "http://schemas.openxmlformats.org/package/2006/relationships";
const NAMESPACES = `xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"`;
const SLIDE_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
/** A 16:9 slide, in the unit the format counts in (914400 to the inch). */
const WIDE = { cx: 12192000, cy: 6858000 };

export const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

interface Slide {
  title: Inline[];
  /** Points and plain lines, in order. */
  lines: { level: number; bullet: boolean; inlines: Inline[] }[];
  tables: Inline[][][][];
}

/** A Markdown outline as slides: every heading starts one. */
function outline(markdown: string): { slides: Slide[]; levels: number[] } {
  const slides: Slide[] = [];
  const levels: number[] = [];
  let current: Slide | undefined;
  const slide = (): Slide => {
    if (!current) {
      current = { title: [], lines: [], tables: [] };
      slides.push(current);
      levels.push(2);
    }
    return current;
  };
  for (const block of parseMarkdown(markdown) as Block[]) {
    if (block.type === "heading") {
      current = { title: block.inlines, lines: [], tables: [] };
      slides.push(current);
      levels.push(block.level);
    } else if (block.type === "list") {
      for (const item of block.items)
        slide().lines.push({ level: item.level, bullet: true, inlines: item.inlines });
    } else if (block.type === "paragraph" || block.type === "quote") {
      slide().lines.push({ level: 0, bullet: false, inlines: block.inlines });
    } else if (block.type === "code") {
      for (const line of block.text.split("\n"))
        slide().lines.push({ level: 0, bullet: false, inlines: [{ text: line, code: true }] });
    } else if (block.type === "table") {
      slide().tables.push(block.rows);
    }
  }
  return { slides, levels };
}

const GROUP =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

function textRuns(parts: Inline[]): string {
  return parts
    .map((inline) => {
      const properties = `<a:rPr lang="en-GB"${inline.bold ? ' b="1"' : ""}${inline.italic ? ' i="1"' : ""} dirty="0"${
        inline.code
          ? '><a:latin typeface="Courier New"/><a:cs typeface="Courier New"/></a:rPr>'
          : "/>"
      }`;
      return inline.text
        .split("\n")
        .map(
          (piece, index) =>
            `${index ? "<a:br/>" : ""}${piece ? `<a:r>${properties}<a:t>${esc(piece)}</a:t></a:r>` : ""}`,
        )
        .join("");
    })
    .join("");
}

/** A placeholder of a slide: `ph` is what ties it to the layout's one, e.g. `type="title"`. */
function placeholder(id: number, name: string, ph: string, paragraphs: string): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${ph}/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs || "<a:p/>"}</p:txBody></p:sp>`;
}

const LINE = '<a:solidFill><a:srgbClr val="BFBFBF"/></a:solidFill>';

function tableFrame(
  id: number,
  rows: Inline[][][],
  box: { x: number; y: number; cx: number },
): string {
  const columns = Math.max(1, rows[0]?.length ?? 1);
  const width = Math.floor(box.cx / columns);
  const height = 370840;
  const body = rows
    .map((row, index) => {
      const cells = row
        .map((cell) => {
          const bold = index === 0 ? cell.map((inline) => ({ ...inline, bold: true })) : cell;
          const fill =
            index === 0 ? '<a:solidFill><a:srgbClr val="F2F2F2"/></a:solidFill>' : "<a:noFill/>";
          return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${textRuns(bold)}</a:p></a:txBody><a:tcPr><a:lnL w="6350">${LINE}</a:lnL><a:lnR w="6350">${LINE}</a:lnR><a:lnT w="6350">${LINE}</a:lnT><a:lnB w="6350">${LINE}</a:lnB>${fill}</a:tcPr></a:tc>`;
        })
        .join("");
      return `<a:tr h="${height}">${cells}</a:tr>`;
    })
    .join("");
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${width * columns}" cy="${height * rows.length}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid>${`<a:gridCol w="${width}"/>`.repeat(columns)}</a:tblGrid>${body}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

/**
 * One slide. `body` is the layout's placeholder for the text, as the slide names it;
 * `size` is the deck's slide size, which places a table.
 */
function slideXml(slide: Slide, body: string, size: { cx: number; cy: number }): string {
  const lines = slide.lines
    .map((line) => {
      const properties = line.bullet
        ? line.level
          ? `<a:pPr lvl="${line.level}"/>`
          : ""
        : '<a:pPr marL="0" indent="0"><a:buNone/></a:pPr>';
      return `<a:p>${properties}${textRuns(line.inlines)}</a:p>`;
    })
    .join("");
  const shapes = [placeholder(2, "Title", 'type="title"', `<a:p>${textRuns(slide.title)}</a:p>`)];
  if (lines) shapes.push(placeholder(3, "Content", body, lines));
  const margin = Math.round(size.cx * 0.06875);
  let y = Math.round(size.cy * (lines ? 0.56 : 0.2662));
  for (const [index, rows] of slide.tables.entries()) {
    shapes.push(tableFrame(4 + index, rows, { x: margin, y, cx: size.cx - 2 * margin }));
    y += 370840 * rows.length + 228600;
  }
  return `${XML_HEAD}<p:sld ${NAMESPACES}><p:cSld><p:spTree>${GROUP}${shapes.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

const slideRels = (layout: string): string =>
  `${XML_HEAD}<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${R}/slideLayout" Target="${layout}"/></Relationships>`;

// ── Making a deck ───────────────────────────────────────────────────────────

const TEXT_COLOR = '<a:solidFill><a:schemeClr val="tx1"/></a:solidFill>';
const FONT = (which: "mj" | "mn"): string =>
  `<a:latin typeface="+${which}-lt"/><a:ea typeface="+${which}-ea"/><a:cs typeface="+${which}-cs"/>`;

function theme(): string {
  const color = (name: string, value: string): string =>
    `<a:${name}><a:srgbClr val="${value}"/></a:${name}>`;
  const font = '<a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/>';
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const line = (width: number): string =>
    `<a:ln w="${width}" cap="flat" cmpd="sng" algn="ctr">${fill}<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`;
  return `${XML_HEAD}<a:theme xmlns:a="${A}" name="Home"><a:themeElements><a:clrScheme name="Home">${color("dk1", "111827")}${color("lt1", "FFFFFF")}${color("dk2", "1F2937")}${color("lt2", "F3F4F6")}${color("accent1", "2563EB")}${color("accent2", "0D9488")}${color("accent3", "D97706")}${color("accent4", "7C3AED")}${color("accent5", "DC2626")}${color("accent6", "4B5563")}${color("hlink", "2563EB")}${color("folHlink", "7C3AED")}</a:clrScheme><a:fontScheme name="Home"><a:majorFont>${font}</a:majorFont><a:minorFont>${font}</a:minorFont></a:fontScheme><a:fmtScheme name="Home"><a:fillStyleLst>${fill.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${line(6350)}${line(12700)}${line(19050)}</a:lnStyleLst><a:effectStyleLst>${"<a:effectStyle><a:effectLst/></a:effectStyle>".repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${fill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
}

/** A placeholder of the master or a layout, with where it stands. */
function frame(
  id: number,
  name: string,
  ph: string,
  box: { x: number; y: number; cx: number; cy: number } | undefined,
  bodyPr: string,
  prompt: string,
): string {
  const where = box
    ? `<p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>`
    : "<p:spPr/>";
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph ${ph}/></p:nvPr></p:nvSpPr>${where}<p:txBody>${bodyPr}<a:lstStyle/><a:p><a:r><a:rPr lang="en-GB"/><a:t>${prompt}</a:t></a:r></a:p></p:txBody></p:sp>`;
}

function master(): string {
  const level = (index: number, size: number): string =>
    `<a:lvl${index}pPr marL="${285750 + (index - 1) * 457200}" indent="-285750" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="100000"/></a:lnSpc><a:spcBef><a:spcPts val="${index === 1 ? 1000 : 500}"/></a:spcBef><a:buFont typeface="Arial"/><a:buChar char="${index === 2 ? "–" : "•"}"/><a:defRPr sz="${size}" kern="1200">${TEXT_COLOR}${FONT("mn")}</a:defRPr></a:lvl${index}pPr>`;
  const title = frame(
    2,
    "Title",
    'type="title"',
    { x: 838200, y: 457200, cx: 10515600, cy: 1143000 },
    '<a:bodyPr vert="horz" lIns="0" tIns="45720" rIns="0" bIns="45720" rtlCol="0" anchor="b"><a:normAutofit/></a:bodyPr>',
    "Title",
  );
  const text = frame(
    3,
    "Content",
    'type="body" idx="1"',
    { x: 838200, y: 1825625, cx: 10515600, cy: 4351338 },
    '<a:bodyPr vert="horz" lIns="0" tIns="45720" rIns="0" bIns="45720" rtlCol="0"><a:normAutofit/></a:bodyPr>',
    "Text",
  );
  return `${XML_HEAD}<p:sldMaster ${NAMESPACES}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP}${title}${text}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/><p:sldLayoutId id="2147483650" r:id="rId2"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/><a:defRPr sz="3600" b="1" kern="1200">${TEXT_COLOR}${FONT("mj")}</a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle>${level(1, 2400)}${level(2, 2000)}${level(3, 1800)}</p:bodyStyle><p:otherStyle><a:defPPr><a:defRPr lang="en-GB"/></a:defPPr><a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200">${TEXT_COLOR}${FONT("mn")}</a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;
}

function layout(kind: "title" | "content"): string {
  const shapes =
    kind === "title"
      ? frame(
          2,
          "Title",
          'type="ctrTitle"',
          { x: 838200, y: 2130425, cx: 10515600, cy: 1470025 },
          '<a:bodyPr anchor="b"><a:normAutofit/></a:bodyPr>',
          "Title",
        ) +
        frame(
          3,
          "Subtitle",
          'type="subTitle" idx="1"',
          { x: 838200, y: 3733800, cx: 10515600, cy: 1200150 },
          "<a:bodyPr><a:normAutofit/></a:bodyPr>",
          "Subtitle",
        )
      : frame(2, "Title", 'type="title"', undefined, "<a:bodyPr/>", "Title") +
        frame(3, "Content", 'idx="1"', undefined, "<a:bodyPr/>", "Text");
  // On the title slide the title is larger, and the line under it stands without a bullet, in grey.
  const subtitle =
    kind === "title"
      ? shapes
          .replace(
            /(<p:ph type="ctrTitle"\/>[\s\S]*?<a:lstStyle)\/>/,
            '$1><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></a:lstStyle>',
          )
          .replace(
            /(<p:ph type="subTitle" idx="1"\/>[\s\S]*?<a:lstStyle)\/>/,
            '$1><a:lvl1pPr marL="0" indent="0"><a:buNone/><a:defRPr sz="2400"><a:solidFill><a:schemeClr val="accent6"/></a:solidFill></a:defRPr></a:lvl1pPr></a:lstStyle>',
          )
      : shapes;
  return `${XML_HEAD}<p:sldLayout ${NAMESPACES} type="${kind === "title" ? "title" : "obj"}" preserve="1"><p:cSld name="${kind === "title" ? "Title Slide" : "Title and Content"}"><p:spTree>${GROUP}${subtitle}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
}

/**
 * A deck from a Markdown outline. `# Title` with a line under it is the title slide when
 * the other headings are deeper; every other heading starts a slide.
 */
export function makePptx(input: { title: string; subtitle?: string; content: string }): Uint8Array {
  const { slides, levels } = outline(input.content);
  let title: Inline[] = [{ text: input.title }];
  let subtitle: Inline[] = input.subtitle ? [{ text: input.subtitle }] : [];
  // A first `# ` heading above deeper ones is the deck's title, not a slide of its own.
  const first = slides[0];
  if (
    first &&
    levels[0] === 1 &&
    levels.slice(1).every((level) => level > 1) &&
    !first.tables.length
  ) {
    title = first.title;
    if (first.lines.length)
      subtitle = first.lines.flatMap((line, index) => [
        ...(index ? [{ text: "\n" }] : []),
        ...line.inlines,
      ]);
    slides.shift();
  }
  const zip = new Zip();
  const count = slides.length + 1;
  const numbers = Array.from({ length: count }, (_, index) => index + 1);
  zip.set(
    "[Content_Types].xml",
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/slideLayouts/slideLayout2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${numbers
      .map(
        (number) =>
          `<Override PartName="/ppt/slides/slide${number}.xml" ContentType="${SLIDE_TYPE}"/>`,
      )
      .join(
        "",
      )}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
  );
  zip.set(
    "_rels/.rels",
    `${XML_HEAD}<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
  );
  zip.set(
    "ppt/presentation.xml",
    `${XML_HEAD}<p:presentation ${NAMESPACES} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${numbers
      .map((number) => `<p:sldId id="${255 + number}" r:id="rId${number + 2}"/>`)
      .join(
        "",
      )}</p:sldIdLst><p:sldSz cx="${WIDE.cx}" cy="${WIDE.cy}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
  );
  zip.set(
    "ppt/_rels/presentation.xml.rels",
    `${XML_HEAD}<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${R}/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="${R}/theme" Target="theme/theme1.xml"/>${numbers
      .map(
        (number) =>
          `<Relationship Id="rId${number + 2}" Type="${R}/slide" Target="slides/slide${number}.xml"/>`,
      )
      .join("")}</Relationships>`,
  );
  zip.set("ppt/theme/theme1.xml", theme());
  zip.set("ppt/slideMasters/slideMaster1.xml", master());
  zip.set(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    `${XML_HEAD}<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${R}/slideLayout" Target="../slideLayouts/slideLayout2.xml"/><Relationship Id="rId3" Type="${R}/theme" Target="../theme/theme1.xml"/></Relationships>`,
  );
  for (const [index, kind] of (["title", "content"] as const).entries()) {
    zip.set(`ppt/slideLayouts/slideLayout${index + 1}.xml`, layout(kind));
    zip.set(
      `ppt/slideLayouts/_rels/slideLayout${index + 1}.xml.rels`,
      `${XML_HEAD}<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${R}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`,
    );
  }
  const titleSlide = `${XML_HEAD}<p:sld ${NAMESPACES}><p:cSld><p:spTree>${GROUP}${placeholder(2, "Title", 'type="ctrTitle"', `<a:p>${textRuns(title)}</a:p>`)}${
    subtitle.length
      ? placeholder(3, "Subtitle", 'type="subTitle" idx="1"', `<a:p>${textRuns(subtitle)}</a:p>`)
      : ""
  }</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
  zip.set("ppt/slides/slide1.xml", titleSlide);
  zip.set("ppt/slides/_rels/slide1.xml.rels", slideRels("../slideLayouts/slideLayout1.xml"));
  for (const [index, slide] of slides.entries()) {
    zip.set(`ppt/slides/slide${index + 2}.xml`, slideXml(slide, 'idx="1"', WIDE));
    zip.set(
      `ppt/slides/_rels/slide${index + 2}.xml.rels`,
      slideRels("../slideLayouts/slideLayout2.xml"),
    );
  }
  zip.set("docProps/core.xml", coreProperties(plainText(title)));
  return zip.build();
}

// ── Reading a deck ──────────────────────────────────────────────────────────

interface SlidePart {
  /** The slide's id in the deck's list. */
  id: string;
  relId: string;
  path: string;
}

function slideParts(zip: Zip): SlidePart[] {
  const presentation = zip.text("ppt/presentation.xml");
  if (!presentation) throw new Error("This is not a PowerPoint deck.");
  const rels = relationships(zip.text("ppt/_rels/presentation.xml.rels"));
  const parts: SlidePart[] = [];
  walk(presentation, {
    open(name, attributes) {
      if (name !== "p:sldId") return;
      const relId = attr(attributes, "r:id") ?? "";
      const target = rels.get(relId)?.target;
      if (target)
        parts.push({ id: attr(attributes, "id") ?? "", relId, path: resolve("ppt", target) });
    },
  });
  return parts;
}

const relsPath = (part: string): string => {
  const slash = part.lastIndexOf("/");
  return `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`;
};
const folderOf = (part: string): string => part.slice(0, part.lastIndexOf("/"));

/** The text of a slide or a notes page: its title, then its lines and tables. */
function slideText(xml: string, only?: string): { title: string; lines: string[] } {
  let title = "";
  const lines: string[] = [];
  let kind = "";
  let paragraph: { text: string; level: number } | undefined;
  let inText = false;
  let row: string[] | undefined;
  let cell: string[] | undefined;
  walk(xml, {
    open(name, attributes) {
      if (name === "p:sp" || name === "p:graphicFrame") kind = "";
      else if (name === "p:ph") kind = attr(attributes, "type") ?? "body";
      else if (name === "a:tr") row = [];
      else if (name === "a:tc") cell = [];
      else if (name === "a:p") paragraph = { text: "", level: 0 };
      else if (name === "a:pPr" && paragraph)
        paragraph.level = Number(attr(attributes, "lvl") ?? 0);
      else if (name === "a:t") inText = true;
      else if (name === "a:br" && paragraph) paragraph.text += " ";
    },
    close(name) {
      if (name === "a:t") inText = false;
      else if (name === "a:tc" && row && cell) {
        row.push(cell.join(" / ").replace(/\|/g, "\\|"));
        cell = undefined;
      } else if (name === "a:tr" && row) {
        lines.push(`| ${row.join(" | ")} |`);
        row = undefined;
      } else if (name === "a:p" && paragraph) {
        const text = paragraph.text.trim();
        const level = paragraph.level;
        paragraph = undefined;
        if (!text) return;
        if (cell) cell.push(text);
        else if (only && kind !== only) return;
        else if (kind === "sldNum" || kind === "dt" || kind === "ftr" || kind === "sldImg") return;
        else if ((kind === "title" || kind === "ctrTitle") && !title) title = text;
        else lines.push(`${"  ".repeat(level)}- ${text}`);
      }
    },
    text(text) {
      if (paragraph && inText) paragraph.text += text;
    },
  });
  return { title, lines };
}

/** A deck as an outline: `## Slide 2: Title`, its points, and the speaker's notes. */
export function readPptx(bytes: Uint8Array): string {
  const zip = Zip.read(bytes);
  const out: string[] = [];
  for (const [index, part] of slideParts(zip).entries()) {
    const xml = zip.text(part.path);
    if (!xml) continue;
    const { title, lines } = slideText(xml);
    out.push(`## Slide ${index + 1}${title ? `: ${title}` : ""}`, ...lines);
    const notes = [...relationships(zip.text(relsPath(part.path))).values()].find((rel) =>
      rel.type.endsWith("/notesSlide"),
    );
    const notesXml = notes && zip.text(resolve(folderOf(part.path), notes.target));
    if (notesXml) {
      const said = slideText(notesXml, "body").lines.map((line) => line.replace(/^\s*- /, ""));
      if (said.length) out.push(`Notes: ${said.join(" ")}`);
    }
    out.push("");
  }
  return out.join("\n").trim();
}

// ── Changing a deck ─────────────────────────────────────────────────────────

export interface PptxEdit {
  changes?: TextChange[];
  /** Slide numbers to take out, as the deck counts them before the change. */
  remove?: number[];
  /** A Markdown outline of new slides, put after slide `after` or at the end. */
  add?: { content: string; after?: number };
}

/** The layout new slides of a deck use: one with a title and a place for text. */
function contentLayout(zip: Zip): { path: string; body: string } {
  const layouts = zip
    .names()
    .filter((name) => /^ppt\/slideLayouts\/[^/]+\.xml$/.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  let fallback: { path: string; body: string } | undefined;
  for (const path of layouts) {
    const xml = zip.text(path) ?? "";
    let body: string | undefined;
    walk(xml, {
      open(name, attributes) {
        if (name !== "p:ph" || body) return;
        const type = attr(attributes, "type");
        if (type && type !== "body" && type !== "obj") return;
        body = ["type", "idx", "sz", "orient"]
          .map((key) => [key, attr(attributes, key)] as const)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => `${key}="${esc(value as string)}"`)
          .join(" ");
      },
    });
    if (!body || !/<p:ph\b[^>]*type="title"/.test(xml)) continue;
    const found = { path, body };
    if (/<p:sldLayout\b[^>]*\stype="obj"/.test(xml)) return found;
    fallback ??= found;
  }
  if (fallback) return fallback;
  if (!layouts[0]) throw new Error("This deck has no layout a new slide could use.");
  return { path: layouts[0], body: 'idx="1"' };
}

/** Changes a deck. Returns the new file and one line per change, for the agent. */
export function editPptx(
  bytes: Uint8Array,
  edit: PptxEdit,
): { bytes: Uint8Array; notes: string[] } {
  const zip = Zip.read(bytes);
  let parts = slideParts(zip);
  const notes: string[] = [];

  for (const change of edit.changes ?? []) {
    let count = 0;
    for (const part of parts) {
      const replaced = replaceInParagraphs(
        zip.text(part.path) ?? "",
        { paragraph: "a:p", text: "a:t" },
        change.find,
        change.replace,
      );
      if (!replaced.count) continue;
      count += replaced.count;
      zip.set(part.path, replaced.xml);
    }
    notes.push(
      count
        ? `"${change.find}" replaced ${count === 1 ? "once" : `${count} times`}.`
        : `"${change.find}" is not on a slide as one piece of a line. Nothing changed for it; read the deck and use its exact words.`,
    );
  }

  const types = (): string => zip.text("[Content_Types].xml") as string;
  const dropType = (part: string): void =>
    zip.set(
      "[Content_Types].xml",
      types().replace(
        new RegExp(
          `<Override\\b[^>]*PartName="/${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*/>`,
        ),
        "",
      ),
    );

  const gone = [...new Set(edit.remove ?? [])].filter((number) => parts[number - 1]);
  for (const number of (edit.remove ?? []).filter((each) => !parts[each - 1]))
    notes.push(`There is no slide ${number}.`);
  if (gone.length) {
    let presentation = zip.text("ppt/presentation.xml") as string;
    let rels = zip.text("ppt/_rels/presentation.xml.rels") as string;
    for (const number of gone) {
      const part = parts[number - 1] as SlidePart;
      presentation = presentation
        .replace(new RegExp(`<p:sldId\\b[^>]*r:id="${part.relId}"[^>]*/>`), "")
        // A section of the deck may list the slide by its id.
        .replace(new RegExp(`<p14:sldId\\b[^>]*id="${part.id}"[^>]*/>`, "g"), "");
      rels = rels.replace(new RegExp(`<Relationship\\b[^>]*Id="${part.relId}"[^>]*/>`), "");
      const notesRel = [...relationships(zip.text(relsPath(part.path))).values()].find((rel) =>
        rel.type.endsWith("/notesSlide"),
      );
      const owned = [part.path];
      if (notesRel) owned.push(resolve(folderOf(part.path), notesRel.target));
      for (const path of owned) {
        zip.delete(path);
        zip.delete(relsPath(path));
        dropType(path);
      }
    }
    zip.set("ppt/presentation.xml", presentation);
    zip.set("ppt/_rels/presentation.xml.rels", rels);
    notes.push(`${gone.length === 1 ? `Slide ${gone[0]}` : `Slides ${gone.join(", ")}`} removed.`);
  }

  if (edit.add?.content.trim()) {
    const { slides } = outline(edit.add.content);
    const target = contentLayout(zip);
    let presentation = zip.text("ppt/presentation.xml") as string;
    let rels = zip.text("ppt/_rels/presentation.xml.rels") as string;
    const size = {
      cx: Number(/<p:sldSz\b[^>]*\scx="(\d+)"/.exec(presentation)?.[1] ?? WIDE.cx),
      cy: Number(/<p:sldSz\b[^>]*\scy="(\d+)"/.exec(presentation)?.[1] ?? WIDE.cy),
    };
    // Where the new slides go: after a slide that is still there, or at the end.
    const remaining = parts.filter((_, index) => !gone.includes(index + 1));
    const anchor = edit.add.after ? parts[edit.add.after - 1] : undefined;
    let after = anchor && remaining.includes(anchor) ? anchor.relId : remaining.at(-1)?.relId;
    let slideId = Math.max(255, ...parts.map((part) => Number(part.id) || 0));
    let relNumber = Math.max(
      0,
      ...[...relationships(rels).keys()].map((id) => Number(/\d+$/.exec(id)?.[0] ?? 0)),
    );
    let fileNumber = Math.max(
      0,
      ...zip.names().map((name) => Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(name)?.[1] ?? 0)),
    );
    const layoutTarget = `../slideLayouts/${target.path.slice(target.path.lastIndexOf("/") + 1)}`;
    for (const slide of slides) {
      const path = `ppt/slides/slide${++fileNumber}.xml`;
      const relId = `rId${++relNumber}`;
      zip.set(path, slideXml(slide, target.body, size));
      zip.set(relsPath(path), slideRels(layoutTarget));
      zip.set(
        "[Content_Types].xml",
        types().replace(
          "</Types>",
          `<Override PartName="/${path}" ContentType="${SLIDE_TYPE}"/></Types>`,
        ),
      );
      rels = rels.replace(
        "</Relationships>",
        `<Relationship Id="${relId}" Type="${R}/slide" Target="slides/slide${fileNumber}.xml"/></Relationships>`,
      );
      const entry = `<p:sldId id="${++slideId}" r:id="${relId}"/>`;
      const before = after
        ? new RegExp(`<p:sldId\\b[^>]*r:id="${after}"[^>]*/>`).exec(presentation)
        : undefined;
      if (before) {
        const end = before.index + before[0].length;
        presentation = presentation.slice(0, end) + entry + presentation.slice(end);
      } else if (presentation.includes("</p:sldIdLst>")) {
        presentation = presentation.replace("</p:sldIdLst>", `${entry}</p:sldIdLst>`);
      } else {
        // A deck without slides has no list yet; its place is after the masters.
        presentation = presentation
          .replace(/<p:sldIdLst\s*\/>/, "")
          .replace("</p:sldMasterIdLst>", `</p:sldMasterIdLst><p:sldIdLst>${entry}</p:sldIdLst>`);
      }
      after = relId;
    }
    zip.set("ppt/presentation.xml", presentation);
    zip.set("ppt/_rels/presentation.xml.rels", rels);
    notes.push(`${slides.length === 1 ? "1 slide" : `${slides.length} slides`} added.`);
  }
  parts = slideParts(zip);
  notes.push(`The deck has ${parts.length === 1 ? "1 slide" : `${parts.length} slides`} now.`);
  return { bytes: zip.build(), notes };
}
