import { coreProperties } from "./docx.ts";
import { attr, esc, relationships, resolve, walk, XML_HEAD } from "./xml.ts";
import { Zip } from "./zip.ts";

// Excel workbooks: made from rows, read back as rows, and changed cell by cell. The home
// does not calculate: a formula is written as it is and Excel works it out when the file opens.

const MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const RELS = "http://schemas.openxmlformats.org/package/2006/relationships";
const SHEET_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";
/** Rows of one sheet that are read. A longer sheet is cut, and says so. */
const READ_ROWS = 5000;

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** A text that starts with `=` is a formula; one like `2026-11-21` is a date. */
export type CellValue = string | number | boolean | null;

export interface SheetInput {
  name: string;
  /** The first row is the header. */
  rows: CellValue[][];
}

/** Indexes into a workbook's cell formats. */
interface Formats {
  header?: number;
  date?: number;
}

/** `0` → `A`, `27` → `AB`. */
export function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** `B2` → column 1, row 2. */
export function parseCell(cell: string): { column: number; row: number } | undefined {
  const found = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(cell.trim());
  if (!found) return undefined;
  let column = 0;
  for (const letter of (found[1] as string).toUpperCase())
    column = column * 26 + letter.charCodeAt(0) - 64;
  const row = Number(found[2]);
  return row >= 1 ? { column: column - 1, row } : undefined;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Days between Excel's day 0 and 1970-01-01. */
const EPOCH = 25569;

function cellXml(ref: string, value: CellValue, formats: Formats, style?: string): string {
  const s = (index: string | number | undefined) => (index === undefined ? "" : ` s="${index}"`);
  if (value === null || value === "") return style ? `<c r="${ref}"${s(style)}/>` : "";
  if (typeof value === "number")
    return Number.isFinite(value) ? `<c r="${ref}"${s(style)}><v>${value}</v></c>` : "";
  if (typeof value === "boolean")
    return `<c r="${ref}"${s(style)} t="b"><v>${value ? 1 : 0}</v></c>`;
  if (value.startsWith("=") && value.length > 1)
    return `<c r="${ref}"${s(style)}><f>${esc(value.slice(1))}</f></c>`;
  const date = ISO_DATE.exec(value);
  if (date && formats.date !== undefined) {
    const serial = Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3])) / 86_400_000;
    if (Number.isFinite(serial))
      return `<c r="${ref}" s="${formats.date}"><v>${serial + EPOCH}</v></c>`;
  }
  return `<c r="${ref}"${s(style)} t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
}

const shown = (value: CellValue): string => (value === null ? "" : String(value));

function sheetXml(rows: CellValue[][], formats: Formats, first: boolean): string {
  const columns = Math.max(1, ...rows.map((row) => row.length));
  const widths = Array.from({ length: columns }, (_, column) =>
    Math.min(60, Math.max(8, ...rows.map((row) => shown(row[column] ?? null).length + 2))),
  );
  const data = rows
    .map((row, index) => {
      const cells = row
        .map((value, column) =>
          cellXml(
            `${columnName(column)}${index + 1}`,
            value,
            formats,
            index === 0 && formats.header !== undefined ? String(formats.header) : undefined,
          ),
        )
        .join("");
      return `<row r="${index + 1}">${cells}</row>`;
    })
    .join("");
  const frozen =
    rows.length > 1
      ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
      : "";
  return `${XML_HEAD}<worksheet xmlns="${MAIN}" xmlns:r="${R}"><dimension ref="A1:${columnName(columns - 1)}${Math.max(1, rows.length)}"/><sheetViews><sheetView workbookViewId="0"${first ? ' tabSelected="1"' : ""}>${frozen}</sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${widths
    .map(
      (width, column) =>
        `<col min="${column + 1}" max="${column + 1}" width="${width}" customWidth="1"/>`,
    )
    .join("")}</cols><sheetData>${data}</sheetData></worksheet>`;
}

/** A sheet name Excel takes: at most 31 characters, none of `\ / * ? : [ ]`, not used yet. */
function sheetName(wanted: string, taken: string[]): string {
  const clean =
    wanted
      .replace(/[\\/*?:[\]]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^'+|'+$/g, "")
      .trim()
      .slice(0, 31) || "Sheet";
  const used = new Set(taken.map((name) => name.toLowerCase()));
  let name = clean;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${clean.slice(0, 28)} ${n}`;
  return name;
}

/** A workbook with one sheet per entry. The first row of each is its header. */
export function makeXlsx(input: { title: string; sheets: SheetInput[] }): Uint8Array {
  const sheets = input.sheets.length ? input.sheets : [{ name: "Sheet1", rows: [] }];
  const names: string[] = [];
  for (const sheet of sheets) names.push(sheetName(sheet.name, names));
  const formats: Formats = { header: 1, date: 2 };
  const zip = new Zip();
  zip.set(
    "[Content_Types].xml",
    `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets
      .map(
        (_, index) =>
          `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="${SHEET_TYPE}"/>`,
      )
      .join(
        "",
      )}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`,
  );
  zip.set(
    "_rels/.rels",
    `${XML_HEAD}<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`,
  );
  zip.set(
    "xl/workbook.xml",
    `${XML_HEAD}<workbook xmlns="${MAIN}" xmlns:r="${R}"><bookViews><workbookView/></bookViews><sheets>${names
      .map(
        (name, index) =>
          `<sheet name="${esc(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
      )
      .join("")}</sheets><calcPr calcId="0" fullCalcOnLoad="1"/></workbook>`,
  );
  zip.set(
    "xl/_rels/workbook.xml.rels",
    `${XML_HEAD}<Relationships xmlns="${RELS}">${sheets
      .map(
        (_, index) =>
          `<Relationship Id="rId${index + 1}" Type="${R}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
      )
      .join(
        "",
      )}<Relationship Id="rId${sheets.length + 1}" Type="${R}/styles" Target="styles.xml"/></Relationships>`,
  );
  zip.set(
    "xl/styles.xml",
    `${XML_HEAD}<styleSheet xmlns="${MAIN}"><fonts count="2"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
  );
  for (const [index, sheet] of sheets.entries())
    zip.set(`xl/worksheets/sheet${index + 1}.xml`, sheetXml(sheet.rows, formats, index === 0));
  zip.set("docProps/core.xml", coreProperties(input.title));
  return zip.build();
}

// ── Reading a workbook ──────────────────────────────────────────────────────

interface SheetPart {
  name: string;
  path: string;
  sheetId: number;
  relId: string;
}

function sheetParts(zip: Zip): SheetPart[] {
  const workbook = zip.text("xl/workbook.xml");
  if (!workbook) throw new Error("This is not an Excel workbook.");
  const rels = relationships(zip.text("xl/_rels/workbook.xml.rels"));
  const parts: SheetPart[] = [];
  walk(workbook, {
    open(name, attributes) {
      if (name !== "sheet") return;
      const relId = attr(attributes, "r:id") ?? "";
      const target = rels.get(relId)?.target;
      if (!target) return;
      parts.push({
        name: attr(attributes, "name") ?? "",
        path: resolve("xl", target),
        sheetId: Number(attr(attributes, "sheetId") ?? 0),
        relId,
      });
    },
  });
  return parts;
}

function sharedStrings(xml: string | undefined): string[] {
  const strings: string[] = [];
  if (!xml) return strings;
  let current = "";
  let inText = false;
  let phonetic = 0;
  walk(xml, {
    open(name) {
      if (name === "si") current = "";
      else if (name === "rPh") phonetic++;
      else if (name === "t") inText = true;
    },
    close(name) {
      if (name === "si") strings.push(current);
      else if (name === "rPh") phonetic--;
      else if (name === "t") inText = false;
    },
    text(text) {
      if (inText && !phonetic) current += text;
    },
  });
  return strings;
}

/** Which cell formats of a workbook show a number as a date. */
function dateFormats(xml: string | undefined): Set<number> {
  const dates = new Set<number>();
  if (!xml) return dates;
  const custom = new Map<number, string>();
  let inCellXfs = false;
  let index = 0;
  const isDate = (id: number): boolean => {
    if ((id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47)) return true;
    const code = custom.get(id);
    return code !== undefined && /[dmyhs]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]|\\./g, ""));
  };
  walk(xml, {
    open(name, attributes) {
      if (name === "numFmt")
        custom.set(Number(attr(attributes, "numFmtId")), attr(attributes, "formatCode") ?? "");
      else if (name === "cellXfs") inCellXfs = true;
      else if (name === "xf" && inCellXfs) {
        if (isDate(Number(attr(attributes, "numFmtId") ?? 0))) dates.add(index);
        index++;
      }
    },
    close(name) {
      if (name === "cellXfs") inCellXfs = false;
    },
  });
  return dates;
}

function serialToDate(serial: number): string {
  const date = new Date(Math.round((serial - EPOCH) * 86_400_000));
  if (Number.isNaN(date.getTime())) return String(serial);
  const iso = date.toISOString();
  return Number.isInteger(serial) ? iso.slice(0, 10) : iso.slice(0, 16).replace("T", " ");
}

/** A workbook's sheets as rows: `row | A | B | C`. A formula is shown as it was typed. */
export function readXlsx(bytes: Uint8Array): string {
  const zip = Zip.read(bytes);
  const parts = sheetParts(zip);
  const rels = relationships(zip.text("xl/_rels/workbook.xml.rels"));
  const sharedPath = [...rels.values()].find((rel) => rel.type.endsWith("/sharedStrings"))?.target;
  const strings = sharedStrings(zip.text(resolve("xl", sharedPath ?? "sharedStrings.xml")));
  const dates = dateFormats(zip.text("xl/styles.xml"));
  const out: string[] = [];
  for (const part of parts) {
    const xml = zip.text(part.path);
    if (!xml) continue;
    const rows = new Map<number, string[]>();
    let row = 0;
    let column = -1;
    let cell:
      | { type: string; style: number; formula?: string; value: string; text: string }
      | undefined;
    let inside: "f" | "v" | "t" | undefined;
    let width = 0;
    walk(xml, {
      open(name, attributes) {
        if (name === "row") {
          row = Number(attr(attributes, "r") ?? row + 1);
          column = -1;
        } else if (name === "c") {
          const at = parseCell(attr(attributes, "r") ?? "");
          column = at ? at.column : column + 1;
          cell = {
            type: attr(attributes, "t") ?? "n",
            style: Number(attr(attributes, "s") ?? 0),
            value: "",
            text: "",
          };
        } else if (cell && (name === "f" || name === "v" || name === "t")) {
          inside = name;
          if (name === "f") cell.formula = "";
        }
      },
      close(name) {
        if (name === "f" || name === "v" || name === "t") inside = undefined;
        if (name !== "c" || !cell) return;
        let value = cell.value;
        if (cell.type === "s") value = strings[Number(cell.value)] ?? "";
        else if (cell.type === "inlineStr") value = cell.text;
        else if (cell.type === "b") value = cell.value === "1" ? "TRUE" : "FALSE";
        else if (cell.type === "n" && cell.value !== "") {
          const number = Number(cell.value);
          value = dates.has(cell.style)
            ? serialToDate(number)
            : String(Number(number.toPrecision(15)));
        }
        if (cell.formula !== undefined) value = `=${cell.formula}${value ? ` → ${value}` : ""}`;
        cell = undefined;
        if (value === "" || row > READ_ROWS) return;
        const cells = rows.get(row) ?? [];
        cells[column] = value.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
        rows.set(row, cells);
        width = Math.max(width, column + 1);
      },
      text(text) {
        if (!cell || !inside) return;
        if (inside === "f") cell.formula = (cell.formula ?? "") + text;
        else if (inside === "v") cell.value += text;
        else cell.text += text;
      },
    });
    out.push(`## Sheet "${part.name}"`);
    if (!rows.size) {
      out.push("(empty)", "");
      continue;
    }
    out.push(`row | ${Array.from({ length: width }, (_, index) => columnName(index)).join(" | ")}`);
    for (const number of [...rows.keys()].sort((a, b) => a - b)) {
      const cells = rows.get(number) ?? [];
      out.push(`${number} | ${Array.from(cells, (value) => value ?? "").join(" | ")}`);
    }
    if (row > READ_ROWS) out.push(`[cut: ${row} rows in all]`);
    out.push("");
  }
  return out.join("\n").trim();
}

// ── Changing a workbook ─────────────────────────────────────────────────────

export interface XlsxEdit {
  /** The sheet `cells` and `rows` go to. The first one when it is not named. */
  sheet?: string;
  cells?: { cell: string; value: CellValue }[];
  /** Rows added under the last row of the sheet. */
  rows?: CellValue[][];
  addSheet?: SheetInput;
}

const ROW = /<row\b((?:"[^"]*"|[^>"])*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
const CELL = /<c\b((?:"[^"]*"|[^>"])*?)(?:\/>|>([\s\S]*?)<\/c>)/g;

/** Adds a cell format to a workbook's styles and returns the part and the format's index. */
function addFormat(
  stylesXml: string,
  kind: "date" | "header",
): { xml: string; index: number } | undefined {
  const cellXfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
  if (!cellXfs) return undefined;
  const index = (cellXfs[1]?.match(/<xf\b/g) ?? []).length;
  let xml = stylesXml;
  let xf = '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>';
  if (kind === "header") {
    const fonts = /<fonts\b[^>]*>([\s\S]*?)<\/fonts>/.exec(xml);
    if (!fonts) return undefined;
    const fontIndex = (fonts[1]?.match(/<font\b/g) ?? []).length;
    // The workbook's own first font, in bold.
    const first = /<font>([\s\S]*?)<\/font>/.exec(fonts[1] ?? "")?.[1] ?? '<sz val="11"/>';
    const bold = `<font><b/>${first.replace(/<b\b[^>]*\/>/, "")}</font>`;
    xml = xml.replace(fonts[0], () => `<fonts count="${fontIndex + 1}">${fonts[1]}${bold}</fonts>`);
    xf = `<xf numFmtId="0" fontId="${fontIndex}" fillId="0" borderId="0" xfId="0" applyFont="1"/>`;
  }
  const now = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml) as RegExpExecArray;
  return {
    xml: xml.replace(now[0], () => `<cellXfs count="${index + 1}">${now[1]}${xf}</cellXfs>`),
    index,
  };
}

/** A workbook's formulas are worked out anew when it opens: what was stored for them is stale after a change. */
function recalculate(zip: Zip, parts: SheetPart[]): void {
  for (const part of parts) {
    const xml = zip.text(part.path);
    if (!xml?.includes("<f")) continue;
    zip.set(part.path, xml.replace(/(<f\b[^>]*?(?:\/>|>[^<]*<\/f>))\s*<v>[^<]*<\/v>/g, "$1"));
  }
  let workbook = zip.text("xl/workbook.xml") as string;
  if (/<calcPr\b[^>]*\/>/.test(workbook)) {
    workbook = workbook.replace(/<calcPr\b([^>]*)\/>/, (_, attributes: string) => {
      const kept = attributes.replace(/\sfullCalcOnLoad="[^"]*"/, "");
      return `<calcPr${kept} fullCalcOnLoad="1"/>`;
    });
  } else {
    // Its place among the workbook's parts is fixed: before these, after everything else.
    const later =
      /<(oleSize|customWorkbookViews|pivotCaches|smartTagPr|smartTagTypes|webPublishing|fileRecoveryPr|webPublishObjects|extLst)\b|<\/workbook>/.exec(
        workbook,
      );
    if (later)
      workbook = `${workbook.slice(0, later.index)}<calcPr fullCalcOnLoad="1"/>${workbook.slice(later.index)}`;
  }
  zip.set("xl/workbook.xml", workbook);
  // The order formulas were worked out in names cells that may hold none any more. Excel makes it again.
  if (zip.has("xl/calcChain.xml")) {
    zip.delete("xl/calcChain.xml");
    const rels = zip.text("xl/_rels/workbook.xml.rels");
    if (rels)
      zip.set(
        "xl/_rels/workbook.xml.rels",
        rels.replace(/<Relationship\b[^>]*calcChain[^>]*\/>/g, ""),
      );
    const types = zip.text("[Content_Types].xml");
    if (types)
      zip.set("[Content_Types].xml", types.replace(/<Override\b[^>]*calcChain[^>]*\/>/g, ""));
  }
}

/** Changes a workbook. Returns the new file and one line per change, for the agent. */
export function editXlsx(
  bytes: Uint8Array,
  edit: XlsxEdit,
): { bytes: Uint8Array; notes: string[] } {
  const zip = Zip.read(bytes);
  const parts = sheetParts(zip);
  const notes: string[] = [];
  const formats: Formats = {};
  const format = (kind: "date" | "header"): number | undefined => {
    if (formats[kind] !== undefined) return formats[kind];
    const styles = zip.text("xl/styles.xml");
    const added = styles ? addFormat(styles, kind) : undefined;
    if (!added) return undefined;
    zip.set("xl/styles.xml", added.xml);
    formats[kind] = added.index;
    return added.index;
  };
  const needsDate = (values: CellValue[]): boolean =>
    values.some((value) => typeof value === "string" && ISO_DATE.test(value));

  if (edit.cells?.length || edit.rows?.length) {
    const wanted = edit.sheet?.trim().toLowerCase();
    const part = wanted ? parts.find((each) => each.name.toLowerCase() === wanted) : parts[0];
    if (!part) {
      notes.push(
        `There is no sheet "${edit.sheet}". Sheets: ${parts.map((each) => each.name).join(", ")}. Nothing changed in it.`,
      );
    } else {
      if (needsDate([...(edit.cells ?? []).map((cell) => cell.value), ...(edit.rows ?? []).flat()]))
        format("date");
      let xml = zip.text(part.path) as string;
      const data = /<sheetData\s*\/>|<sheetData>([\s\S]*?)<\/sheetData>/.exec(xml);
      if (!data) throw new Error(`The sheet "${part.name}" has no rows part.`);
      const rows = new Map<number, { attributes: string; cells: Map<number, string> }>();
      let rowNumber = 0;
      for (const found of (data[1] ?? "").matchAll(ROW)) {
        rowNumber = Number(attr(found[1] ?? "", "r") ?? rowNumber + 1);
        const cells = new Map<number, string>();
        let column = -1;
        for (const cell of (found[2] ?? "").matchAll(CELL)) {
          const at = parseCell(attr(cell[1] ?? "", "r") ?? "");
          column = at ? at.column : column + 1;
          // Every cell is written with its place, also one that had none.
          cells.set(
            column,
            at ? cell[0] : cell[0].replace(/^<c\b/, `<c r="${columnName(column)}${rowNumber}"`),
          );
        }
        rows.set(rowNumber, {
          attributes: (found[1] ?? "").replace(/\s(r|spans)="[^"]*"/g, ""),
          cells,
        });
      }
      const put = (column: number, row: number, value: CellValue): void => {
        const target = rows.get(row) ?? { attributes: "", cells: new Map<number, string>() };
        const existing = target.cells.get(column);
        const style = existing
          ? attr(/^<c\b((?:"[^"]*"|[^>"])*)/.exec(existing)?.[1] ?? "", "s")
          : undefined;
        const written = cellXml(`${columnName(column)}${row}`, value, formats, style);
        if (written) target.cells.set(column, written);
        else target.cells.delete(column);
        rows.set(row, target);
      };
      let set = 0;
      for (const change of edit.cells ?? []) {
        const at = parseCell(change.cell);
        if (!at) {
          notes.push(`"${change.cell}" is not a cell like B2. Nothing changed for it.`);
          continue;
        }
        const existing = rows.get(at.row)?.cells.get(at.column) ?? "";
        if (/<f\b[^>]*t="shared"[^>]*\sref=/.test(existing)) {
          notes.push(
            `${change.cell.toUpperCase()} starts a formula that other cells share. It was left as it is; this one is changed in Excel.`,
          );
          continue;
        }
        put(at.column, at.row, change.value);
        set++;
      }
      if (set) notes.push(`${set === 1 ? "1 cell" : `${set} cells`} set in "${part.name}".`);
      if (edit.rows?.length) {
        let next = Math.max(0, ...rows.keys()) + 1;
        const start = next;
        for (const row of edit.rows) {
          for (const [column, value] of row.entries()) put(column, next, value);
          next++;
        }
        notes.push(
          `${edit.rows.length === 1 ? "1 row" : `${edit.rows.length} rows`} added to "${part.name}" from row ${start}.`,
        );
      }
      const numbers = [...rows.keys()].sort((a, b) => a - b);
      let lastColumn = 0;
      const body = numbers
        .map((number) => {
          const row = rows.get(number) as { attributes: string; cells: Map<number, string> };
          const columns = [...row.cells.keys()].sort((a, b) => a - b);
          lastColumn = Math.max(lastColumn, columns.at(-1) ?? 0);
          return `<row r="${number}"${row.attributes}>${columns.map((column) => row.cells.get(column)).join("")}</row>`;
        })
        .join("");
      // A function, so that a `$` in a formula is not read as a pattern.
      xml = xml.replace(data[0], () => `<sheetData>${body}</sheetData>`);
      xml = xml.replace(
        /<dimension\b[^>]*\/>/,
        `<dimension ref="A1:${columnName(lastColumn)}${numbers.at(-1) ?? 1}"/>`,
      );
      zip.set(part.path, xml);
    }
  }

  if (edit.addSheet) {
    const name = sheetName(
      edit.addSheet.name,
      parts.map((each) => each.name),
    );
    const used = new Set(zip.names());
    let number = parts.length + 1;
    while (used.has(`xl/worksheets/sheet${number}.xml`)) number++;
    const path = `xl/worksheets/sheet${number}.xml`;
    const rels = zip.text("xl/_rels/workbook.xml.rels") ?? "";
    const ids = [...relationships(rels).keys()].map((id) => Number(/\d+/.exec(id)?.[0] ?? 0));
    const relId = `rId${Math.max(0, ...ids) + 1}`;
    if (needsDate(edit.addSheet.rows.flat())) format("date");
    format("header");
    zip.set(path, sheetXml(edit.addSheet.rows, formats, false));
    zip.set(
      "xl/_rels/workbook.xml.rels",
      rels.replace(
        "</Relationships>",
        `<Relationship Id="${relId}" Type="${R}/worksheet" Target="worksheets/sheet${number}.xml"/></Relationships>`,
      ),
    );
    const sheetId = Math.max(0, ...parts.map((each) => each.sheetId)) + 1;
    zip.set(
      "xl/workbook.xml",
      (zip.text("xl/workbook.xml") as string).replace(
        "</sheets>",
        () => `<sheet name="${esc(name)}" sheetId="${sheetId}" r:id="${relId}"/></sheets>`,
      ),
    );
    zip.set(
      "[Content_Types].xml",
      (zip.text("[Content_Types].xml") as string).replace(
        "</Types>",
        `<Override PartName="/${path}" ContentType="${SHEET_TYPE}"/></Types>`,
      ),
    );
    parts.push({ name, path, sheetId, relId });
    notes.push(`Sheet "${name}" added.`);
  }
  recalculate(zip, parts);
  return { bytes: zip.build(), notes };
}
