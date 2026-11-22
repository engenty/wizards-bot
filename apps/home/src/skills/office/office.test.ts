import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { editDocx, makeDocx, readDocx } from "./docx.ts";
import { tinyPdf } from "./fixtures.ts";
import { parseMarkdown } from "./markdown.ts";
import { editPptx, makePptx, readPptx } from "./pptx.ts";
import { documentKind, documentText, piece } from "./read.ts";
import { columnName, editXlsx, makeXlsx, parseCell, readXlsx } from "./xlsx.ts";
import { replaceInParagraphs } from "./xml.ts";
import { Zip, ZipRefused } from "./zip.ts";

describe("a zip file", () => {
  test("is written, read again, and keeps the parts that were not touched", () => {
    const zip = new Zip();
    zip.set("a.txt", "alpha ".repeat(500));
    zip.set("dir/b.xml", "<b>ß €</b>");
    const again = Zip.read(zip.build());
    assert.deepEqual(again.names(), ["a.txt", "dir/b.xml"]);
    assert.equal(again.text("dir/b.xml"), "<b>ß €</b>");
    again.set("c.txt", "new");
    again.delete("a.txt");
    const third = Zip.read(again.build());
    assert.deepEqual(third.names(), ["dir/b.xml", "c.txt"]);
    assert.equal(third.text("c.txt"), "new");
    assert.equal(third.text("a.txt"), undefined);
  });

  test("refuses what is not a zip file and what lies about its size", () => {
    assert.throws(() => Zip.read(new TextEncoder().encode("not a zip file at all")), ZipRefused);
    const zip = new Zip();
    zip.set("a.txt", "x".repeat(10_000));
    const bytes = zip.build();
    // The directory names a smaller size than the part unpacks to.
    const view = new DataView(bytes.buffer);
    let at = bytes.length - 22;
    const directory = view.getUint32(at + 16, true);
    at = directory;
    view.setUint32(at + 24, 10, true);
    assert.throws(() => Zip.read(bytes).bytes("a.txt"), ZipRefused);
  });
});

describe("Markdown", () => {
  test("becomes headings, lists with levels, tables and marked text", () => {
    const blocks = parseMarkdown(
      "# Plan\n\nA **bold** and *slanted* line with `code` and a [link](https://example.com).\n\n- one\n  - inner\n- two\n\n1. first\n2. second\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n> said\n\n```\nx = 1\n```",
    );
    assert.deepEqual(
      blocks.map((block) => block.type),
      ["heading", "paragraph", "list", "list", "table", "quote", "code"],
    );
    const paragraph = blocks[1] as Extract<(typeof blocks)[number], { type: "paragraph" }>;
    assert.deepEqual(
      paragraph.inlines.filter(
        (inline) => inline.bold || inline.italic || inline.code || inline.link,
      ),
      [
        { text: "bold", bold: true },
        { text: "slanted", italic: true },
        { text: "code", code: true },
        { text: "link", link: "https://example.com" },
      ],
    );
    const list = blocks[2] as Extract<(typeof blocks)[number], { type: "list" }>;
    assert.deepEqual(
      list.items.map((item) => [item.level, item.ordered]),
      [
        [0, false],
        [1, false],
        [0, false],
      ],
    );
    assert.equal(parseMarkdown("snake_case_name and 2 * 3 * 4")[0]?.type, "paragraph");
    const plain = parseMarkdown("snake_case_name and 2 * 3 * 4")[0] as { inlines: unknown[] };
    assert.equal(plain.inlines.length, 1);
  });
});

describe("a Word document", () => {
  const content =
    "# Offer for Lena\n\nDear Lena, this is the **offer** we talked about.\n\n## Scope\n\n- Design\n  - Logo\n- Build\n\n1. Sign\n2. Start\n\n| Item | Price |\n| --- | --- |\n| Design | 1200 |\n\nSee [our site](https://example.com) & more <soon>.";

  test("is made from Markdown and reads back with its shape", () => {
    const bytes = makeDocx({ title: "Offer", content });
    const zip = Zip.read(bytes);
    assert.ok(zip.has("[Content_Types].xml"));
    assert.match(zip.text("word/document.xml") ?? "", /<w:pStyle w:val="Title"\/>/);
    assert.match(zip.text("word/_rels/document.xml.rels") ?? "", /Target="https:\/\/example.com"/);
    const text = readDocx(bytes);
    assert.match(text, /^# Offer for Lena$/m);
    assert.match(text, /^## Scope$/m);
    assert.match(text, /Dear Lena, this is the offer we talked about\./);
    assert.match(text, /^- Design$/m);
    assert.match(text, /^ {2}- Logo$/m);
    assert.match(text, /^1\. Sign$/m);
    assert.match(text, /^\| Item \| Price \|$/m);
    assert.match(text, /^\| Design \| 1200 \|$/m);
    assert.match(text, /See our site & more <soon>\./);
  });

  test("is changed in place: words replaced across runs, text added", () => {
    const bytes = makeDocx({ title: "Offer", content });
    // "the offer we" spans three runs: plain, bold, plain.
    const edited = editDocx(bytes, {
      changes: [
        { find: "the offer we talked about", replace: "what we agreed on" },
        { find: "not in there", replace: "x" },
      ],
      insert: { content: "## Terms\n\nPayment in **30 days**.\n\n- Net", after: "Design" },
    });
    assert.match(edited.notes[0] ?? "", /replaced once/);
    assert.match(edited.notes[1] ?? "", /is not in the document/);
    assert.match(edited.notes[2] ?? "", /Text added after "Design"/);
    const text = readDocx(edited.bytes);
    assert.match(text, /Dear Lena, this is what we agreed on\./);
    assert.match(text, /^## Terms$/m);
    assert.match(text, /Payment in 30 days\./);
    assert.ok(text.indexOf("## Terms") > text.indexOf("- Design"));
    assert.ok(text.indexOf("## Terms") < text.indexOf("Logo"));
    // The styles and the rest of the file are the same parts as before.
    assert.equal(
      Zip.read(edited.bytes).text("word/styles.xml"),
      Zip.read(bytes).text("word/styles.xml"),
    );

    const end = editDocx(bytes, { insert: { content: "Last line.", after: "nowhere" } });
    assert.match(end.notes.join(" "), /went to its end/);
    assert.match(readDocx(end.bytes), /Last line\.$/);
    assert.match(
      Zip.read(end.bytes).text("word/document.xml") ?? "",
      /Last line\.<\/w:t><\/w:r><\/w:p><w:sectPr>/,
    );
  });

  test("a match that spans runs keeps the text around it", () => {
    const xml =
      '<w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>big</w:t></w:r><w:r><w:t xml:space="preserve"> world, big world</w:t></w:r></w:p>';
    const replaced = replaceInParagraphs(
      xml,
      { paragraph: "w:p", text: "w:t" },
      "big world",
      "moon",
    );
    assert.equal(replaced.count, 2);
    assert.equal(replaced.xml.replace(/<[^>]+>/g, ""), "Hello moon, moon");
    assert.match(replaced.xml, /<w:b\/>/);
  });
});

describe("an Excel workbook", () => {
  const sheets = [
    {
      name: "Budget",
      rows: [
        ["Item", "Cost", "Due", "Paid"],
        ["Rent", 1200.5, "2026-12-01", true],
        ["Power & water", 80, "2026-12-15", false],
        ["Total", "=SUM(B2:B3)", null, null],
      ],
    },
    { name: "Notes: 2026/27", rows: [["Note"], ["Check <prices> in $ and €"]] },
  ];

  test("is made from rows and reads back with numbers, dates and formulas", () => {
    const bytes = makeXlsx({ title: "Budget", sheets });
    const text = readXlsx(bytes);
    assert.match(text, /^## Sheet "Budget"$/m);
    assert.match(text, /^row \| A \| B \| C \| D$/m);
    assert.match(text, /^1 \| Item \| Cost \| Due \| Paid$/m);
    assert.match(text, /^2 \| Rent \| 1200\.5 \| 2026-12-01 \| TRUE$/m);
    assert.match(text, /^3 \| Power & water \| 80 \| 2026-12-15 \| FALSE$/m);
    assert.match(text, /^4 \| Total \| =SUM\(B2:B3\)$/m);
    assert.match(text, /^## Sheet "Notes 2026 27"$/m);
    assert.match(text, /Check <prices> in \$ and €/);
    const sheet = Zip.read(bytes).text("xl/worksheets/sheet1.xml") ?? "";
    assert.match(sheet, /<c r="B2"><v>1200\.5<\/v><\/c>/);
    assert.match(sheet, /<c r="B4"><f>SUM\(B2:B3\)<\/f><\/c>/);
    assert.match(sheet, /state="frozen"/);
  });

  test("is changed in place: cells set, rows and a sheet added", () => {
    const bytes = makeXlsx({ title: "Budget", sheets });
    const edited = editXlsx(bytes, {
      cells: [
        { cell: "B2", value: 1300 },
        { cell: "B4", value: "=SUM($B$2:B3)" },
        { cell: "F1", value: "Note" },
        { cell: "nonsense", value: 1 },
      ],
      rows: [["Phone", 30, "2027-01-05", false]],
      addSheet: {
        name: "Budget",
        rows: [
          ["Month", "Sum"],
          ["Jan", "=Budget!B4"],
        ],
      },
    });
    assert.match(edited.notes.join("\n"), /"nonsense" is not a cell/);
    assert.match(edited.notes.join("\n"), /3 cells set in "Budget"/);
    assert.match(edited.notes.join("\n"), /1 row added to "Budget" from row 5/);
    assert.match(edited.notes.join("\n"), /Sheet "Budget 2" added/);
    const text = readXlsx(edited.bytes);
    assert.match(text, /^1 \| Item \| Cost \| Due \| Paid \| {2}\| Note$/m);
    assert.match(text, /^2 \| Rent \| 1300 \| 2026-12-01 \| TRUE$/m);
    assert.match(text, /^4 \| Total \| =SUM\(\$B\$2:B3\)$/m);
    assert.match(text, /^5 \| Phone \| 30 \| 2027-01-05 \| FALSE$/m);
    assert.match(text, /^## Sheet "Budget 2"$/m);
    assert.match(text, /^2 \| Jan \| =Budget!B4$/m);
    // The header keeps its format, and the workbook is told to calculate when it opens.
    const zip = Zip.read(edited.bytes);
    assert.match(zip.text("xl/worksheets/sheet1.xml") ?? "", /<c r="A1" s="1" t="inlineStr">/);
    assert.match(zip.text("xl/workbook.xml") ?? "", /fullCalcOnLoad="1"/);

    const missing = editXlsx(bytes, { sheet: "Nope", cells: [{ cell: "A1", value: 1 }] });
    assert.match(
      missing.notes.join(" "),
      /There is no sheet "Nope"\. Sheets: Budget, Notes 2026 27/,
    );
  });

  test("a workbook from Excel is read: shared strings, cached results, its own date format", () => {
    const zip = Zip.read(makeXlsx({ title: "x", sheets: [{ name: "S", rows: [["a"]] }] }));
    zip.set(
      "xl/sharedStrings.xml",
      '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>Name</t></si><si><r><t>Ad</t></r><r><t>a</t></r><rPh><t>x</t></rPh></si></sst>',
    );
    zip.set(
      "xl/_rels/workbook.xml.rels",
      (zip.text("xl/_rels/workbook.xml.rels") ?? "").replace(
        "</Relationships>",
        '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/></Relationships>',
      ),
    );
    zip.set("xl/calcChain.xml", "<calcChain/>");
    zip.set(
      "xl/worksheets/sheet1.xml",
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:C2"/><sheetData><row r="1" spans="1:3"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" s="2"><v>46357</v></c><c r="B2"><f>1+1</f><v>2</v></c><c r="C2" t="str"><f>A1&amp;"!"</f><v>Name!</v></c></row></sheetData></worksheet>',
    );
    const text = readXlsx(zip.build());
    assert.match(text, /^1 \| Name \| Ada$/m);
    assert.match(text, /^2 \| 2026-12-01 \| =1\+1 → 2 \| =A1&"!" → Name!$/m);

    const edited = editXlsx(zip.build(), { cells: [{ cell: "B2", value: 5 }] });
    const after = Zip.read(edited.bytes);
    // What was stored for a formula is stale after a change, and so is the order of calculation.
    assert.match(readXlsx(edited.bytes), /^2 \| 2026-12-01 \| 5 \| =A1&"!"$/m);
    assert.equal(after.has("xl/calcChain.xml"), false);
    assert.doesNotMatch(after.text("xl/_rels/workbook.xml.rels") ?? "", /calcChain/);
  });

  test("names cells", () => {
    assert.deepEqual(
      [columnName(0), columnName(25), columnName(26), columnName(701)],
      ["A", "Z", "AA", "ZZ"],
    );
    assert.deepEqual(parseCell("ab12"), { column: 27, row: 12 });
    assert.equal(parseCell("12"), undefined);
  });
});

describe("a PowerPoint deck", () => {
  const content =
    "# Kickoff\nWhat we do in **Q1**\n\n## Goals\n\n- Ship the app\n  - iOS first\n- Find ten users\n\n## Numbers\n\n| Month | Users |\n| --- | --- |\n| Jan | 3 |\n\n## Next\n\nOne plain line & <more>.";

  test("is made from an outline and reads back slide by slide", () => {
    const bytes = makePptx({ title: "Kickoff deck", content });
    const zip = Zip.read(bytes);
    assert.deepEqual(
      zip.names().filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length,
      4,
    );
    const text = readPptx(bytes);
    assert.match(text, /^## Slide 1: Kickoff$/m);
    assert.match(text, /^- What we do in Q1$/m);
    assert.match(text, /^## Slide 2: Goals$/m);
    assert.match(text, /^- Ship the app$/m);
    assert.match(text, /^ {2}- iOS first$/m);
    assert.match(text, /^## Slide 3: Numbers$/m);
    assert.match(text, /^\| Month \| Users \|$/m);
    assert.match(text, /^## Slide 4: Next$/m);
    assert.match(text, /^- One plain line & <more>\.$/m);
  });

  test("without a title heading the deck's name is its title slide", () => {
    const text = readPptx(makePptx({ title: "Roadmap", content: "## One\n- a\n\n## Two\n- b" }));
    assert.match(text, /^## Slide 1: Roadmap$/m);
    assert.match(text, /^## Slide 3: Two$/m);
  });

  test("is changed in place: words replaced, slides removed and added", () => {
    const bytes = makePptx({ title: "Kickoff deck", content });
    const edited = editPptx(bytes, {
      changes: [
        { find: "Find ten users", replace: "Find twenty users" },
        { find: "nowhere", replace: "x" },
      ],
      remove: [3, 9],
      add: { content: "## Risks\n\n- Time\n- Money\n\n## Budget\n\n- 10k", after: 2 },
    });
    const notes = edited.notes.join("\n");
    assert.match(notes, /"Find ten users" replaced once/);
    assert.match(notes, /"nowhere" is not on a slide/);
    assert.match(notes, /There is no slide 9/);
    assert.match(notes, /Slide 3 removed/);
    assert.match(notes, /2 slides added/);
    assert.match(notes, /The deck has 5 slides now/);
    const text = readPptx(edited.bytes);
    assert.deepEqual(
      [...text.matchAll(/^## Slide \d+: (.*)$/gm)].map((found) => found[1]),
      ["Kickoff", "Goals", "Risks", "Budget", "Next"],
    );
    assert.match(text, /^- Find twenty users$/m);
    const zip = Zip.read(edited.bytes);
    assert.equal(zip.has("ppt/slides/slide3.xml"), false);
    assert.doesNotMatch(zip.text("[Content_Types].xml") ?? "", /slide3\.xml/);
    // A new slide uses the deck's own layout for a title and text.
    assert.match(zip.text("ppt/slides/_rels/slide5.xml.rels") ?? "", /slideLayout2\.xml/);
  });
});

describe("reading a document", () => {
  test("knows the kinds by their ending and reads each as text", async () => {
    assert.equal(documentKind("Report.DOCX"), "docx");
    assert.equal(documentKind("notes.txt"), undefined);
    assert.equal(await documentText("notes.txt", new Uint8Array([1])), undefined);
    assert.match(
      (await documentText("a.docx", makeDocx({ title: "a", content: "Hello Word" }))) ?? "",
      /Hello Word/,
    );
    assert.equal(
      await documentText("invoice.pdf", tinyPdf(["Invoice 2026-114", "Total: 1200 EUR"])),
      "Invoice 2026-114\nTotal: 1200 EUR",
    );
    await assert.rejects(
      documentText("broken.xlsx", new TextEncoder().encode("PK nothing here")),
      /broken\.xlsx could not be read as a Excel workbook/,
    );
  });

  test("a long text comes in pieces", () => {
    const text = "0123456789".repeat(5);
    assert.equal(piece(text, 0, 100, "read on"), text);
    assert.equal(
      piece(text, 0, 20, "read on"),
      `${text.slice(0, 20)}\n[cut at 20 of 50 characters; read on from 20]`,
    );
    assert.equal(piece(text, 40, 20, "read on"), "0123456789");
  });
});
