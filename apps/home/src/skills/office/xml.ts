// The little XML the Office formats need: text made safe to write, text read back, and a walk
// over a part's tags in order.

/** Text as it stands inside an element or an attribute. Characters XML does not allow are dropped. */
export function esc(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
  );
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Text of an element or an attribute as it was meant. */
export function unesc(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (whole, name: string) => {
    if (name.startsWith("#x")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return NAMED[name] ?? whole;
  });
}

/** One attribute of a tag, from the text between the tag's name and its end. */
export function attr(attributes: string, name: string): string | undefined {
  const found = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attributes);
  return found ? unesc(found[1] ?? found[2] ?? "") : undefined;
}

export interface Walker {
  open?(name: string, attributes: string): void;
  close?(name: string): void;
  text?(text: string): void;
}

/**
 * Calls the walker for every tag and every text of a part, in order. An empty element
 * (`<a/>`) is opened and closed.
 */
export function walk(xml: string, walker: Walker): void {
  const token =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([\w:.-]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g;
  for (let found = token.exec(xml); found; found = token.exec(xml)) {
    if (found[5] !== undefined) {
      walker.text?.(unesc(found[5]));
    } else if (found[2] !== undefined) {
      if (found[1]) {
        walker.close?.(found[2]);
      } else {
        walker.open?.(found[2], found[3] ?? "");
        if (found[4]) walker.close?.(found[2]);
      }
    }
  }
}

/** The relationships of a part: id → target, as its `.rels` part names them. */
export function relationships(
  xml: string | undefined,
): Map<string, { target: string; type: string }> {
  const found = new Map<string, { target: string; type: string }>();
  if (!xml) return found;
  walk(xml, {
    open(name, attributes) {
      if (name !== "Relationship") return;
      const id = attr(attributes, "Id");
      if (id)
        found.set(id, {
          target: attr(attributes, "Target") ?? "",
          type: attr(attributes, "Type") ?? "",
        });
    },
  });
  return found;
}

/** A relationship's target as a part's name in the zip, seen from the folder of the part that names it. */
export function resolve(folder: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = folder.split("/").filter(Boolean);
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== ".") parts.push(part);
  }
  return parts.join("/");
}

export const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/**
 * Replaces text inside the paragraphs of a part and keeps their formatting. A paragraph's
 * text is spread over runs; a match that spans runs goes into the first one. Returns the
 * part and how often `find` was replaced.
 *
 * `paragraph` and `text` are the tag names: `w:p` and `w:t` in Word, `a:p` and `a:t` in
 * PowerPoint.
 */
export function replaceInParagraphs(
  xml: string,
  tags: { paragraph: string; text: string },
  find: string,
  replacement: string,
): { xml: string; count: number } {
  if (!find) return { xml, count: 0 };
  let count = 0;
  // Only paragraphs that hold no other paragraph: a text box's own ones, not the one around it.
  const paragraph = new RegExp(
    `<${tags.paragraph}(?:\\s[^>]*)?>(?:(?!<${tags.paragraph}[\\s>])[\\s\\S])*?</${tags.paragraph}>`,
    "g",
  );
  const node = new RegExp(`<${tags.text}(?:\\s[^>]*)?>([^<]*)</${tags.text}>`, "g");
  const changed = xml.replace(paragraph, (whole) => {
    const nodes = [...whole.matchAll(node)].map((found) => ({
      start: found.index,
      length: found[0].length,
      text: unesc(found[1] ?? ""),
    }));
    const joined = nodes.map((each) => each.text).join("");
    if (!joined.includes(find)) return whole;
    // Where each node's text starts in the joined text.
    const starts: number[] = [];
    let sum = 0;
    for (const each of nodes) {
      starts.push(sum);
      sum += each.text.length;
    }
    const texts = nodes.map((each) => each.text);
    // From the last match to the first, so earlier positions stay valid.
    const matches: number[] = [];
    for (let at = joined.indexOf(find); at >= 0; at = joined.indexOf(find, at + find.length))
      matches.push(at);
    for (const at of matches.reverse()) {
      const last = at + find.length;
      const firstNode = starts.findLastIndex((start) => start <= at);
      const lastNode = starts.findLastIndex((start) => start < last);
      const head = (texts[firstNode] ?? "").slice(0, at - (starts[firstNode] ?? 0));
      const tail = (texts[lastNode] ?? "").slice(last - (starts[lastNode] ?? 0));
      if (firstNode === lastNode) {
        const own = texts[firstNode] ?? "";
        const from = at - (starts[firstNode] ?? 0);
        texts[firstNode] = own.slice(0, from) + replacement + own.slice(from + find.length);
      } else {
        texts[firstNode] = head + replacement;
        for (let between = firstNode + 1; between < lastNode; between++) texts[between] = "";
        texts[lastNode] = tail;
      }
      count++;
    }
    let out = "";
    let from = 0;
    for (const [index, each] of nodes.entries()) {
      out += whole.slice(from, each.start);
      out += `<${tags.text} xml:space="preserve">${esc(texts[index] ?? "")}</${tags.text}>`;
      from = each.start + each.length;
    }
    return out + whole.slice(from);
  });
  return { xml: changed, count };
}
