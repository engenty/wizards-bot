import { getSchema } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./markdown";
import { anchorOf, findAnchor, textIndex } from "./marks";
import { blockExtensions } from "./schema";

const schema = getSchema(blockExtensions());
const open = (text: string) => schema.nodeFromJSON(parseMarkdown(text).doc);

describe("a marked passage", () => {
  const doc = open("# Packing\n\n- socks and **warm** socks\n- a book\n");

  it("is read as text, blocks joined by a line break", () => {
    expect(textIndex(doc).text).toBe("Packing\nsocks and warm socks\na book");
  });

  it("keeps its text and what stands around it", () => {
    const index = textIndex(doc);
    const start = index.text.lastIndexOf("socks");
    const from = index.at[start] as number;
    const anchor = anchorOf(doc, from, from + 5);
    expect(anchor).toEqual({
      quote: "socks",
      before: "Packing\nsocks and warm ",
      after: "\na book",
    });
  });

  it("is found where it stands, not at the first place with the same words", () => {
    const index = textIndex(doc);
    const range = findAnchor(index, { quote: "socks", before: "warm ", after: "" });
    expect(doc.textBetween(range?.from ?? 0, range?.to ?? 0)).toBe("socks");
    expect(range?.from).toBe(index.at[index.text.lastIndexOf("socks")]);
  });

  it("is found at its first place when the text around it changed, and not at all when gone", () => {
    const changed = open("# Packing\n\n- socks\n- two books\n");
    const index = textIndex(changed);
    expect(findAnchor(index, { quote: "socks", before: "warm ", after: "\na book" })?.from).toBe(
      index.at[index.text.indexOf("socks")],
    );
    expect(findAnchor(index, { quote: "a book", before: "", after: "" })).toBeNull();
  });

  it("may reach over two blocks", () => {
    const index = textIndex(doc);
    const from = index.at[index.text.indexOf("socks\na")] as number;
    const to = (index.at[index.text.indexOf("a book")] as number) + 1;
    expect(anchorOf(doc, from, to)?.quote).toBe("socks\na");
  });
});
