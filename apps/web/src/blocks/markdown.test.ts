// From engenty wizards, apps/web/src/studio/space/blocks/markdown.test.ts, with documents of its
// own under fixtures/. The block editor's round trip: every document there is opened the way the
// block editor opens it and written back.
// - unchanged: a save without edits gives the same text, byte for byte;
// - edited: a word typed into a block changes only the lines of that block.
import { getSchema } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { type Json, parseMarkdown, toMarkdown } from "./markdown";
import { blockExtensions } from "./schema";

const schema = getSchema(blockExtensions());

/** The document as the editor holds it: parsed, then through the schema. */
function open(text: string) {
  const parsed = parseMarkdown(text);
  const nodes: Json[] = [];
  schema.nodeFromJSON(parsed.doc).forEach((n) => {
    nodes.push(n.toJSON() as Json);
  });
  return { parsed, nodes, source: { parsed, keys: nodes.map((n) => JSON.stringify(n)) } };
}

/** Lines that differ once the lines both texts start and end with are taken off. */
function changedLines(a: string, b: string): number {
  const x = a.split("\n");
  const y = b.split("\n");
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) {
    start++;
  }
  let end = 0;
  while (
    end < x.length - start &&
    end < y.length - start &&
    x[x.length - 1 - end] === y[y.length - 1 - end]
  ) {
    end++;
  }
  return x.length - start - end + (y.length - start - end);
}

/** " edited" after the first text outside code and links; null for a block with none. */
function typeInto(node: Json): Json | null {
  if (node.type === "rawMarkdown" || node.type === "codeBlock") {
    return null;
  }
  let done = false;
  const walk = (n: Json): Json => {
    if (done) {
      return n;
    }
    if (n.type === "text" && !n.marks?.some((m) => m.type === "code" || m.type === "link")) {
      done = true;
      return { ...n, text: `${n.text} edited` };
    }
    return n.content ? { ...n, content: n.content.map(walk) } : n;
  };
  const out = walk(node);
  return done ? schema.nodeFromJSON(out).toJSON() : null;
}

function roundTrip(text: string) {
  const { parsed, nodes, source } = open(text);
  let raw = 0;
  let worst = 0;
  nodes.forEach((node, i) => {
    const src = parsed.blocks[i]?.raw ?? "";
    if (node.type === "rawMarkdown") {
      raw++;
      return;
    }
    const edited = typeInto(node);
    if (edited) {
      const next = toMarkdown(
        nodes.map((n, j) => (j === i ? edited : n)),
        source,
      );
      // An edited block may be written in the editor's style: its own lines change, no others.
      worst = Math.max(worst, changedLines(text, next) - 2 * src.split("\n").length);
    }
  });
  return { saved: toMarkdown(nodes, source), raw, worst };
}

const fixtures = Object.entries(
  import.meta.glob<string>("./fixtures/*.md", { query: "?raw", import: "default", eager: true }),
);

describe("the block editor's round trip", () => {
  it.each(fixtures)("%s", (_, text) => {
    const r = roundTrip(text);
    expect(r.saved).toBe(text);
    // Every block shows as a block; an edit changes no line outside its block.
    expect(r.raw).toBe(0);
    expect(r.worst).toBeLessThanOrEqual(0);
  });

  it("reads the documents under fixtures/ as the blocks they are", () => {
    const kinds = new Set(fixtures.flatMap(([, text]) => open(text).nodes.map((n) => n.type)));
    expect([...kinds].sort()).toEqual([
      "blockquote",
      "bulletList",
      "codeBlock",
      "heading",
      "horizontalRule",
      "orderedList",
      "paragraph",
      "table",
      "taskList",
    ]);
  });

  it("keeps Windows line breaks and the blank lines between blocks", () => {
    const text = "# Title\r\n\r\n\r\nText\r\n- a\r\n- b\r\n";
    expect(roundTrip(text).saved).toBe(text);
  });

  it("keeps what it can't show as Markdown blocks", () => {
    const text =
      "---\ntitle: x\n---\n\n<div>html</div>\n\n- [ ] task\n- item\n\nText[^1]\n\n[^1]: note\n";
    const { nodes } = open(text);
    expect(nodes.map((n) => n.type)).toEqual([
      "rawMarkdown",
      "rawMarkdown",
      "rawMarkdown",
      "paragraph",
      "rawMarkdown",
    ]);
    expect(roundTrip(text).saved).toBe(text);
  });

  it("changes only the edited line of a hard-wrapped paragraph", () => {
    const text = "One line\nand another\nand a third.\n\nNext.\n";
    const { nodes, source } = open(text);
    const p = nodes[0] as Json;
    const content = (p.content ?? []).map((n, i) => (i === 2 ? { ...n, text: "and one more" } : n));
    const next = toMarkdown([{ ...p, content }, ...nodes.slice(1)], source);
    expect(next).toBe("One line\nand one more\nand a third.\n\nNext.\n");
  });

  it("writes a new block in the editor's style between untouched ones", () => {
    const text = "* a\n* b\n\nText\n";
    const { nodes, source } = open(text);
    const added: Json = {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableHeader",
              content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }],
            },
          ],
        },
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }],
            },
          ],
        },
      ],
    };
    const next = toMarkdown(
      [nodes[0] as Json, schema.nodeFromJSON(added).toJSON(), nodes[1] as Json],
      source,
    );
    expect(next).toBe("* a\n* b\n\n| A |\n| --- |\n| 1 |\n\nText\n");
  });

  it("keeps a link's title, a picture and an address written bare", () => {
    const text =
      'See [the notes](https://example.org/notes "Notes") and ![a map](map.png).\n\nWrite to https://example.org/reviews today.\n';
    const { nodes } = open(text);
    const first = nodes[0]?.content ?? [];
    expect(first[1]?.marks?.[0]).toEqual({
      type: "link",
      attrs: expect.objectContaining({ href: "https://example.org/notes", title: "Notes" }),
    });
    expect(first[3]).toMatchObject({ type: "image", attrs: { src: "map.png", alt: "a map" } });
    expect(roundTrip(text).saved).toBe(text);
  });
});
