// Passages the person marked in a document, drawn over the text while it is read. A mark is
// found again by its text (the passage and a little before and after it), not by a position: it
// stays with the passage when text around it changes, and is not drawn while the passage is gone.

import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/** How many characters before and after a passage tell which one it is. */
export const CONTEXT = 32;

/** A passage as read, without Markdown. */
export interface Anchor {
  quote: string;
  before: string;
  after: string;
}

/** A mark to draw: its passage, and whether it carries a comment. */
export interface Drawn extends Anchor {
  id: string;
  comment: string;
}

/**
 * The text of the document as read, with the position of each character in it. Blocks are
 * joined by "\n", which has no position (-1).
 */
export function textIndex(doc: PMNode): { text: string; at: number[] } {
  let text = "";
  const at: number[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock && text.length) {
      text += "\n";
      at.push(-1);
    }
    if (node.isText) {
      const value = node.text ?? "";
      for (let i = 0; i < value.length; i += 1) {
        at.push(pos + i);
      }
      text += value;
    }
    return true;
  });
  return { text, at };
}

/** The passage between two positions, with what stands around it; null when it holds no text. */
export function anchorOf(doc: PMNode, from: number, to: number): Anchor | null {
  const { text, at } = textIndex(doc);
  const start = at.findIndex((pos) => pos >= from);
  const last = at.findLastIndex((pos) => pos >= 0 && pos < to);
  if (start < 0 || last < start) {
    return null;
  }
  const quote = text.slice(start, last + 1);
  if (!quote.trim()) {
    return null;
  }
  return {
    quote,
    before: text.slice(Math.max(0, start - CONTEXT), start),
    after: text.slice(last + 1, last + 1 + CONTEXT),
  };
}

/** Where a passage is now: where it stands with the same text around it, else its first place. */
export function findAnchor(
  index: { text: string; at: number[] },
  anchor: Anchor,
): { from: number; to: number } | null {
  const whole = index.text.indexOf(anchor.before + anchor.quote + anchor.after);
  const start = whole >= 0 ? whole + anchor.before.length : index.text.indexOf(anchor.quote);
  if (start < 0 || !anchor.quote) {
    return null;
  }
  const from = index.at[start] ?? -1;
  const to = index.at[start + anchor.quote.length - 1] ?? -1;
  return from >= 0 && to >= 0 ? { from, to: to + 1 } : null;
}

const key = new PluginKey<{ marks: Drawn[]; set: DecorationSet }>("documentMarks");

function draw(state: EditorState["doc"], marks: Drawn[]): DecorationSet {
  if (!marks.length) {
    return DecorationSet.empty;
  }
  const index = textIndex(state);
  const found: Decoration[] = [];
  for (const mark of marks) {
    const range = findAnchor(index, mark);
    if (range) {
      found.push(
        Decoration.inline(range.from, range.to, {
          class: mark.comment ? "doc-mark has-comment" : "doc-mark",
          "data-mark": mark.id,
        }),
      );
    }
  }
  return DecorationSet.create(state, found);
}

/** Draws the marks set with `showMarks`. */
export const DocumentMarks = Extension.create({
  name: "documentMarks",
  addProseMirrorPlugins: () => [
    new Plugin({
      key,
      state: {
        init: (): { marks: Drawn[]; set: DecorationSet } => ({
          marks: [],
          set: DecorationSet.empty,
        }),
        apply(tr, old) {
          const marks = tr.getMeta(key) as Drawn[] | undefined;
          if (marks) {
            return { marks, set: draw(tr.doc, marks) };
          }
          return tr.docChanged ? { marks: old.marks, set: draw(tr.doc, old.marks) } : old;
        },
      },
      props: {
        decorations: (state) => key.getState(state)?.set,
      },
    }),
  ],
});

/** The marks to draw from now on. */
export function showMarks(
  view: { state: EditorState; dispatch: (tr: EditorState["tr"]) => void },
  marks: Drawn[],
) {
  view.dispatch(view.state.tr.setMeta(key, marks).setMeta("addToHistory", false));
}
