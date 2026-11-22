// While a document is read: over selected text, mark it, comment on it or ask the agent about
// it; over a marked passage, its comment and removing the mark. The editor does not track the
// selection while it can't be edited, so the bar reads the page's selection itself.

import type { Editor } from "@tiptap/core";
import { ArrowUp, Highlighter, MessageSquareText, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../lib/i18n";
import { type Anchor, anchorOf, type Drawn } from "./marks";

/** What the reader can do with a passage. */
export interface Reading {
  marks: Drawn[];
  /** Who answers a question about a passage. */
  agentName: string;
  onMark: (anchor: Anchor) => void;
  onComment: (anchor: Anchor, comment: string) => void;
  onAsk: (quote: string, question: string) => void;
  onRemove: (id: string) => void;
}

type Open =
  | { kind: "selection"; anchor: Anchor; range: Range }
  | { kind: "mark"; mark: Drawn; element: Element };

/** The bar's place: above what it is about, below it near the upper edge, inside the window. */
function place(rect: DOMRect): React.CSSProperties {
  const above = rect.top > 64;
  const left = Math.min(Math.max(rect.left + rect.width / 2, 160), window.innerWidth - 160);
  return above
    ? { left, top: rect.top - 8, transform: "translate(-50%, -100%)" }
    : { left, top: rect.bottom + 8, transform: "translateX(-50%)" };
}

export function ReadBar({ editor, reading }: { editor: Editor; reading: Reading }) {
  const [open, setOpen] = useState<Open | null>(null);
  const [writing, setWriting] = useState<"comment" | "ask" | null>(null);
  const [text, setText] = useState("");
  const [, redraw] = useState(0);
  const writingRef = useRef(writing);
  writingRef.current = writing;
  const live = useRef(reading);
  live.current = reading;

  const close = useCallback(() => {
    setOpen(null);
    setWriting(null);
    setText("");
  }, []);

  // A selection inside the text opens the bar; an empty one closes it, unless something is
  // being written in it.
  useEffect(() => {
    const dom = editor.view.dom;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      const selection = window.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      if (!range || range.collapsed || !dom.contains(range.commonAncestorContainer)) {
        if (!writingRef.current) {
          setOpen((now) => (now?.kind === "selection" ? null : now));
        }
        return;
      }
      try {
        const a = editor.view.posAtDOM(range.startContainer, range.startOffset);
        const b = editor.view.posAtDOM(range.endContainer, range.endOffset);
        const anchor = anchorOf(editor.state.doc, Math.min(a, b), Math.max(a, b));
        if (anchor) {
          setWriting(null);
          setText("");
          setOpen({ kind: "selection", anchor, range: range.cloneRange() });
        }
      } catch {
        // The selection ends outside the text the editor knows.
      }
    };
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(read, 120);
    };
    document.addEventListener("selectionchange", soon);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("selectionchange", soon);
    };
  }, [editor]);

  // A click on a marked passage, with nothing selected, opens its comment.
  useEffect(() => {
    const dom = editor.view.dom;
    const onClick = (e: MouseEvent) => {
      const element = (e.target as Element).closest("[data-mark]");
      const id = element?.getAttribute("data-mark");
      const mark = live.current.marks.find((m) => m.id === id);
      if (element && mark && window.getSelection()?.isCollapsed !== false) {
        setWriting(null);
        setOpen({ kind: "mark", mark, element });
      }
    };
    dom.addEventListener("click", onClick);
    return () => dom.removeEventListener("click", onClick);
  }, [editor]);

  // The bar follows its passage when the text scrolls or the window changes.
  useEffect(() => {
    if (!open) {
      return;
    }
    const move = () => redraw((n) => n + 1);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
      }
    };
    window.addEventListener("scroll", move, true);
    window.addEventListener("resize", move);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", move, true);
      window.removeEventListener("resize", move);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  if (!open) {
    return null;
  }
  const rect =
    open.kind === "selection"
      ? open.range.getBoundingClientRect()
      : open.element.getBoundingClientRect();
  if (!rect.width && !rect.height) {
    return null;
  }

  const done = () => {
    window.getSelection()?.removeAllRanges();
    close();
  };
  const send = () => {
    const value = text.trim();
    if (!value || open.kind !== "selection") {
      return;
    }
    if (writing === "comment") {
      reading.onComment(open.anchor, value);
    } else {
      reading.onAsk(open.anchor.quote, value);
    }
    done();
  };
  const button = (label: string, icon: React.ReactNode, run: () => void, wide = false) => (
    <button
      type="button"
      className="block-tool gap-1.5"
      title={label}
      aria-label={wide ? undefined : label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={run}
    >
      {icon}
      {wide ? label : null}
    </button>
  );
  const ic = "size-3.5";

  return createPortal(
    <div
      className="block-bubble read-bar enter-pop"
      role="toolbar"
      aria-label={t("doc.passage")}
      style={{ position: "fixed", ...place(rect) }}
    >
      {open.kind === "mark" ? (
        <>
          <p className="read-bar-comment">{open.mark.comment || t("doc.marked")}</p>
          {button(t("doc.removeMark"), <Trash2 className={ic} />, () => {
            reading.onRemove(open.mark.id);
            close();
          })}
        </>
      ) : writing ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <input
            // biome-ignore lint/a11y/noAutofocus: the field opens because the person asked for it
            autoFocus
            className="block-bubble-input"
            aria-label={
              writing === "ask" ? t("doc.ask", { name: reading.agentName }) : t("doc.comment")
            }
            placeholder={
              writing === "ask"
                ? t("doc.askPlaceholder", { name: reading.agentName })
                : t("doc.commentPlaceholder")
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          {button(
            writing === "ask" ? t("doc.send") : t("doc.save"),
            <ArrowUp className={ic} />,
            send,
          )}
        </form>
      ) : (
        <>
          {button(
            t("doc.mark"),
            <Highlighter className={ic} />,
            () => {
              reading.onMark(open.anchor);
              done();
            },
            true,
          )}
          {button(
            t("doc.comment"),
            <MessageSquareText className={ic} />,
            () => setWriting("comment"),
            true,
          )}
          {button(
            t("doc.ask", { name: reading.agentName }),
            <Sparkles className={ic} />,
            () => setWriting("ask"),
            true,
          )}
        </>
      )}
    </div>,
    document.body,
  );
}
