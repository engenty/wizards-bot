// From engenty wizards, apps/web/src/studio/space/blocks/gutter.tsx.
// The handle beside each block: + adds a paragraph below, ⋮⋮ drags the block or opens its menu
// (turn into, duplicate, delete). A block is a top-level node (a whole list or table), and "turn
// into" goes through the editor's commands so lists convert too. Under a finger there is no
// hover and no drag: the handle stands at the block the caret is in, as one larger button, and
// its menu also adds a block and moves this one up or down.

import { computePosition, flip, offset, shift } from "@floating-ui/dom";
import type { Editor } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { ArrowDown, ArrowUp, Copy, Plus, Trash2 } from "lucide-react";
import type { DragEvent as ReactDragEvent, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { isTouch } from "../lib/device";
import { t } from "../lib/i18n";

interface BlockRange {
  from: number;
  to: number;
  node: PMNode;
}

/** The top-level block at `pos`. */
function blockAt(doc: PMNode, pos: number): BlockRange | null {
  if (doc.content.size <= 0) {
    return null;
  }
  const $pos = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
  if ($pos.depth === 0) {
    const node = $pos.nodeAfter ?? $pos.nodeBefore;
    if (!node) {
      return null;
    }
    const from = $pos.nodeAfter ? $pos.pos : $pos.pos - node.nodeSize;
    return { from, to: from + node.nodeSize, node };
  }
  return { from: $pos.before(1), to: $pos.after(1), node: $pos.node(1) };
}

const DRAG_MIME = "application/x-wizards-block";

const same = (a: BlockRange | null, b: BlockRange | null) =>
  a === b || (a !== null && b !== null && a.from === b.from && a.node === b.node);

/** The editor's element, or null while the view is not mounted (React remounts it in dev). */
const domOf = (editor: Editor) => {
  try {
    return editor.view.dom;
  } catch {
    return null;
  }
};

/** Where the block that starts at `pos` is drawn, if `pos` is the start of a block. */
function rectOf(editor: Editor, pos: number): DOMRect | null {
  const el = pos <= editor.state.doc.content.size ? editor.view.nodeDOM(pos) : null;
  return el instanceof HTMLElement ? el.getBoundingClientRect() : null;
}

const TURN_INTO = [
  { id: "paragraph", label: "blocks.text", glyph: "¶" },
  { id: "h1", label: "blocks.h1", glyph: "H1" },
  { id: "h2", label: "blocks.h2", glyph: "H2" },
  { id: "h3", label: "blocks.h3", glyph: "H3" },
  { id: "bulletList", label: "blocks.bullets", glyph: "•" },
  { id: "orderedList", label: "blocks.numbered", glyph: "1." },
  { id: "taskList", label: "blocks.tasks", glyph: "☑" },
  { id: "blockquote", label: "blocks.quote", glyph: "❝" },
  { id: "codeBlock", label: "blocks.code", glyph: "<>" },
] as const;

type TurnInto = (typeof TURN_INTO)[number]["id"];

/** Blocks whose text can become another kind of block. */
const TEXT_BLOCKS = new Set([
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "taskList",
  "blockquote",
  "codeBlock",
]);

function turnInto(editor: Editor, block: BlockRange, id: TurnInto) {
  const chain = editor
    .chain()
    .focus()
    .command(({ tr }) => {
      tr.setSelection(TextSelection.between(tr.doc.resolve(block.from), tr.doc.resolve(block.to)));
      return true;
    })
    .clearNodes();
  switch (id) {
    case "paragraph":
      return chain.run();
    case "h1":
    case "h2":
    case "h3":
      return chain.setHeading({ level: Number(id[1]) as 1 | 2 | 3 }).run();
    case "bulletList":
      return chain.toggleBulletList().run();
    case "orderedList":
      return chain.toggleOrderedList().run();
    case "taskList":
      return chain.toggleTaskList().run();
    case "blockquote":
      return chain.setBlockquote().run();
    case "codeBlock":
      return chain.setCodeBlock().run();
  }
}

function moveBlock(editor: Editor, from: number, to: number, insertPos: number) {
  const { state, dispatch } = editor.view;
  if (insertPos >= from && insertPos <= to) {
    return;
  }
  const slice = state.doc.slice(from, to);
  const tr = state.tr.delete(from, to);
  const at = tr.mapping.map(insertPos);
  tr.insert(at, slice.content);
  // The caret goes along, so the handle stays with the block that moved.
  tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1)));
  dispatch(tr);
}

function addBelow(editor: Editor, block: BlockRange) {
  editor
    .chain()
    .insertContentAt(block.to, { type: "paragraph" })
    .setTextSelection(block.to + 1)
    .focus()
    .run();
}

export function BlockGutter({ editor }: { editor: Editor }) {
  const wrap = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const gripDown = useRef<{ x: number; y: number } | null>(null);
  /** Hover tracking pauses while text is being selected. */
  const selecting = useRef(false);
  /** Set between dragstart and dragend (Safari hides custom types during dragover). */
  const dragging = useRef(false);
  const dropAt = useRef<number | null>(null);
  const [hovered, setHoveredRaw] = useState<BlockRange | null>(null);
  const [atCursor, setAtCursorRaw] = useState<BlockRange | null>(null);
  const setHovered = useCallback(
    (b: BlockRange | null) => setHoveredRaw((prev) => (same(prev, b) ? prev : b)),
    [],
  );
  const setAtCursor = useCallback(
    (b: BlockRange | null) => setAtCursorRaw((prev) => (same(prev, b) ? prev : b)),
    [],
  );
  const [menu, setMenu] = useState(false);
  const [top, setTop] = useState(0);
  const [indicator, setIndicator] = useState<number | null>(null);

  const active = hovered ?? atCursor;

  const syncCursor = useCallback(
    () => setAtCursor(blockAt(editor.state.doc, editor.state.selection.from)),
    [editor, setAtCursor],
  );

  useEffect(() => {
    // After a change of the doc the block under the pointer is no longer where it was: it is
    // found again with the next move of the pointer.
    const onChange = ({ transaction }: { transaction: Transaction }) => {
      if (transaction.docChanged) {
        setHovered(null);
      }
      syncCursor();
    };
    syncCursor();
    editor.on("selectionUpdate", syncCursor);
    editor.on("transaction", onChange);
    return () => {
      editor.off("selectionUpdate", syncCursor);
      editor.off("transaction", onChange);
    };
  }, [editor, syncCursor, setHovered]);

  useEffect(() => {
    const dom = domOf(editor);
    if (!dom) {
      return;
    }
    /** The strip left of the text that still counts as the block: where the handle sits. */
    const PAD = 48;
    const onDown = (e: MouseEvent) => {
      if (e.button === 0) {
        selecting.current = true;
      }
    };
    const onUp = () => {
      selecting.current = false;
    };
    const onMove = (e: MouseEvent) => {
      if (menu || selecting.current) {
        return;
      }
      const r = dom.getBoundingClientRect();
      if (
        e.clientX < r.left - PAD ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      ) {
        setHovered(null);
        return;
      }
      const at = editor.view.posAtCoords({ left: Math.max(e.clientX, r.left + 8), top: e.clientY });
      setHovered(at ? blockAt(editor.state.doc, at.inside >= 0 ? at.inside : at.pos) : null);
    };
    dom.addEventListener("mousedown", onDown);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      dom.removeEventListener("mousedown", onDown);
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, [editor, menu, setHovered]);

  useEffect(() => {
    const dom = domOf(editor);
    if (!dom) {
      return;
    }
    const snap = (x: number, y: number) => {
      const at = editor.view.posAtCoords({ left: x, top: y });
      const block = at ? blockAt(editor.state.doc, at.inside >= 0 ? at.inside : at.pos) : null;
      if (!block) {
        return null;
      }
      const rect = rectOf(editor, block.from);
      if (!rect) {
        return null;
      }
      const above = y < (rect.top + rect.bottom) / 2;
      return { pos: above ? block.from : block.to, y: above ? rect.top : rect.bottom };
    };
    const onOver = (e: DragEvent) => {
      if (!dragging.current) {
        return;
      }
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = "move";
      }
      const s = snap(e.clientX, e.clientY);
      dropAt.current = s?.pos ?? null;
      const box = wrap.current?.parentElement?.getBoundingClientRect();
      setIndicator(s && box ? s.y - box.top : null);
    };
    const onDrop = (e: DragEvent) => {
      if (!dragging.current) {
        return;
      }
      e.preventDefault();
      const raw = e.dataTransfer?.getData(DRAG_MIME);
      const target = dropAt.current ?? snap(e.clientX, e.clientY)?.pos ?? null;
      dragging.current = false;
      dropAt.current = null;
      setIndicator(null);
      if (raw && target !== null) {
        const { from, to } = JSON.parse(raw) as { from: number; to: number };
        moveBlock(editor, from, to, target);
      }
    };
    dom.addEventListener("dragenter", onOver);
    dom.addEventListener("dragover", onOver);
    dom.addEventListener("drop", onDrop);
    return () => {
      dom.removeEventListener("dragenter", onOver);
      dom.removeEventListener("dragover", onOver);
      dom.removeEventListener("drop", onDrop);
    };
  }, [editor]);

  useEffect(() => {
    if (!menu) {
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMenu(false);
      }
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !wrap.current?.contains(t)) {
        setMenu(false);
      }
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [menu]);

  // The menu opens under the handle, or above it where the window ends below.
  useLayoutEffect(() => {
    const anchor = wrap.current;
    const el = menuRef.current;
    if (!menu || !anchor || !el) {
      return;
    }
    void computePosition(anchor, el, {
      placement: "bottom-start",
      strategy: "fixed",
      middleware: [offset(4), flip(), shift({ padding: 8 })],
    }).then(({ x, y }) => Object.assign(el.style, { left: `${x}px`, top: `${y}px` }));
  }, [menu]);

  // The block moves with every change of the doc.
  useEffect(() => {
    const box = wrap.current?.parentElement;
    if (!active || !box || !domOf(editor)) {
      return;
    }
    // Centred on the block's first line, so it lines up with headings and paragraphs alike.
    const size = editor.state.doc.content.size;
    const first = editor.view.coordsAtPos(Math.min(active.from + 1, active.to, size));
    const lineTop = active.node.isTextblock
      ? first.top
      : (rectOf(editor, active.from)?.top ?? first.top);
    const lineBottom = active.node.isTextblock ? first.bottom : lineTop + 24;
    const height = wrap.current?.offsetHeight ?? 24;
    setTop((lineTop + lineBottom) / 2 - box.getBoundingClientRect().top - height / 2);
  }, [active, editor, editor.state]);

  const onDragStart = (e: ReactDragEvent<HTMLButtonElement>) => {
    if (!active) {
      return;
    }
    dragging.current = true;
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ from: active.from, to: active.to }));
    e.dataTransfer.effectAllowed = "move";
    // A small label to the right of the pointer rather than the whole block.
    const preview = document.createElement("div");
    preview.className = "block-drag-preview";
    preview.textContent = active.node.textContent.trim().slice(0, 60) || active.node.type.name;
    document.body.appendChild(preview);
    e.dataTransfer.setDragImage(preview, 0, preview.getBoundingClientRect().height / 2);
    requestAnimationFrame(() => preview.remove());
  };

  const block = active;
  const canTurn = block ? TEXT_BLOCKS.has(block.node.type.name) : false;
  const item = (label: string, glyph: ReactNode, run: () => void, danger = false) => (
    <button
      className={`block-menu-item${danger ? " danger" : ""}`}
      key={label}
      onClick={() => {
        run();
        setMenu(false);
      }}
      role="menuitem"
      type="button"
    >
      <span className="block-menu-glyph">{glyph}</span>
      {label}
    </button>
  );
  const before = block ? blockAt(editor.state.doc, block.from - 1) : null;
  const after = block && block.to < editor.state.doc.content.size ? block.to : null;

  return (
    <>
      <div className={`block-gutter${active ? " on" : ""}`} ref={wrap} style={{ top }}>
        {isTouch ? null : (
          <button
            className="block-gutter-btn"
            onClick={() => {
              if (active) {
                addBelow(editor, active);
              }
            }}
            onMouseDown={(e) => e.preventDefault()}
            title={t("blocks.addBelow")}
            aria-label={t("blocks.addBelow")}
            type="button"
          >
            <Plus className="size-3.5" />
          </button>
        )}
        <button
          className="block-gutter-btn grip"
          draggable={!isTouch}
          onClick={(e) => {
            const p = gripDown.current;
            if (p && (Math.abs(e.clientX - p.x) > 6 || Math.abs(e.clientY - p.y) > 6)) {
              return;
            }
            if (active) {
              setAtCursor(active);
              setMenu(true);
            }
          }}
          onDragEnd={() => {
            dragging.current = false;
            dropAt.current = null;
            setIndicator(null);
          }}
          onDragStart={onDragStart}
          onPointerDown={(e) => {
            gripDown.current = { x: e.clientX, y: e.clientY };
          }}
          title={t(isTouch ? "blocks.menu" : "blocks.grip")}
          aria-label={t(isTouch ? "blocks.menu" : "blocks.grip")}
          aria-haspopup="menu"
          aria-expanded={menu}
          type="button"
        >
          <svg aria-hidden="true" height="14" viewBox="0 0 10 14" width="10">
            <circle cx="2.5" cy="2.5" fill="currentColor" r="1.25" />
            <circle cx="7.5" cy="2.5" fill="currentColor" r="1.25" />
            <circle cx="2.5" cy="7" fill="currentColor" r="1.25" />
            <circle cx="7.5" cy="7" fill="currentColor" r="1.25" />
            <circle cx="2.5" cy="11.5" fill="currentColor" r="1.25" />
            <circle cx="7.5" cy="11.5" fill="currentColor" r="1.25" />
          </svg>
        </button>
      </div>
      {indicator === null ? null : <div className="block-drop-line" style={{ top: indicator }} />}
      {menu && block ? (
        <div className="block-menu enter-fade" ref={menuRef} role="menu">
          {isTouch ? (
            <>
              {item(t("blocks.addBelow"), <Plus className="size-3.5" />, () =>
                addBelow(editor, block),
              )}
              {before && before.from < block.from
                ? item(t("blocks.moveUp"), <ArrowUp className="size-3.5" />, () =>
                    moveBlock(editor, block.from, block.to, before.from),
                  )
                : null}
              {after === null
                ? null
                : item(t("blocks.moveDown"), <ArrowDown className="size-3.5" />, () => {
                    const next = blockAt(editor.state.doc, after);
                    if (next) {
                      moveBlock(editor, block.from, block.to, next.to);
                    }
                  })}
              <div className="block-menu-sep" />
            </>
          ) : null}
          {canTurn ? (
            <>
              <div className="block-menu-label">{t("blocks.turnInto")}</div>
              {TURN_INTO.map((kind) =>
                item(t(kind.label), kind.glyph, () => turnInto(editor, block, kind.id)),
              )}
              <div className="block-menu-sep" />
            </>
          ) : null}
          {item(t("blocks.duplicate"), <Copy className="size-3.5" />, () =>
            editor.view.dispatch(
              editor.state.tr.insert(
                block.to,
                editor.state.doc.slice(block.from, block.to).content,
              ),
            ),
          )}
          {item(
            t("blocks.delete"),
            <Trash2 className="size-3.5" />,
            () => editor.chain().focus().deleteRange({ from: block.from, to: block.to }).run(),
            true,
          )}
        </div>
      ) : null}
    </>
  );
}
