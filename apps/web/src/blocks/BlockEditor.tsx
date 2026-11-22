// From engenty wizards, apps/web/src/studio/space/blocks/BlockEditor.tsx.
// The block editor for a document's Markdown: blocks (headings, lists, tables, …) that look like
// the text read, a `/` menu, a handle per block and a bubble over selected text. The text stays
// Markdown: see markdown.ts for how a small edit stays a small change.

import type { Editor } from "@tiptap/core";
import { Placeholder } from "@tiptap/extensions";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
import { BubbleMenu } from "@tiptap/react/menus";
import {
  Bold,
  Check,
  Code,
  Divide,
  ExternalLink,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link,
  List,
  ListChecks,
  ListOrdered,
  Pilcrow,
  Quote,
  Strikethrough,
  Table,
  X,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";
import { BlockGutter } from "./gutter";
import { opens } from "./link";
import { type Json, markdownToNodes, type Parsed, parseMarkdown, toMarkdown } from "./markdown";
import { DocumentMarks, showMarks } from "./marks";
import { ReadBar, type Reading } from "./ReadBar";
import { blockExtensions } from "./schema";
import { SlashCommands, type SlashItem } from "./slash";
import "./blocks.css";

/** Follows a link in a tab of its own, if it is one a document may open. */
function follow(href: string) {
  const address = opens(href);
  if (address) {
    window.open(address, "_blank", "noopener,noreferrer");
  }
}

/**
 * The editor's doc becomes `doc`: only the blocks between the first and the last that differ are
 * replaced, so the caret stays where it was and undo leaves a change from elsewhere alone.
 */
function replaceChanged(editor: Editor, doc: Json) {
  const next = editor.schema.nodeFromJSON(doc);
  const now = editor.state.doc;
  const start = now.content.findDiffStart(next.content);
  if (start === null || start === undefined) {
    return;
  }
  const end = now.content.findDiffEnd(next.content);
  let a = end?.a ?? now.content.size;
  let b = end?.b ?? next.content.size;
  const overlap = start - Math.min(a, b);
  if (overlap > 0) {
    a += overlap;
    b += overlap;
  }
  const tr = editor.state.tr.replace(start, a, next.slice(start, b));
  tr.setMeta("addToHistory", false).setMeta(externalKey, true);
  editor.view.dispatch(tr);
}

const externalKey = "documentFromElsewhere";

const looksLikeMarkdown = (text: string) =>
  /^(#{1,6} |[-*+] |\d+[.)] |> |```|\|.*\|\s*$)/m.test(text) ||
  /\[[^\]\n]+\]\([^)\n]+\)|\*\*[^*\n]+\*\*/.test(text);

const icon = (I: typeof Bold) => <I className="size-3.5" />;

/** What the `/` menu offers. */
function slashItems(): SlashItem[] {
  return [
    {
      title: t("blocks.text"),
      hint: t("blocks.textHint"),
      icon: icon(Pilcrow),
      keywords: ["paragraph", "text"],
      run: (e) => e.chain().focus().setParagraph().run(),
    },
    {
      title: t("blocks.h1"),
      hint: t("blocks.h1Hint"),
      icon: icon(Heading1),
      keywords: ["h1", "title", "heading"],
      run: (e) => e.chain().focus().setHeading({ level: 1 }).run(),
    },
    {
      title: t("blocks.h2"),
      hint: t("blocks.h2Hint"),
      icon: icon(Heading2),
      keywords: ["h2", "heading"],
      run: (e) => e.chain().focus().setHeading({ level: 2 }).run(),
    },
    {
      title: t("blocks.h3"),
      hint: t("blocks.h3Hint"),
      icon: icon(Heading3),
      keywords: ["h3", "heading"],
      run: (e) => e.chain().focus().setHeading({ level: 3 }).run(),
    },
    {
      title: t("blocks.bullets"),
      hint: "- …",
      icon: icon(List),
      keywords: ["ul", "list"],
      run: (e) => e.chain().focus().toggleBulletList().run(),
    },
    {
      title: t("blocks.numbered"),
      hint: "1. …",
      icon: icon(ListOrdered),
      keywords: ["ol", "ordered", "list"],
      run: (e) => e.chain().focus().toggleOrderedList().run(),
    },
    {
      title: t("blocks.tasks"),
      hint: "- [ ] …",
      icon: icon(ListChecks),
      keywords: ["todo", "task", "check"],
      run: (e) => e.chain().focus().toggleTaskList().run(),
    },
    {
      title: t("blocks.quote"),
      hint: "> …",
      icon: icon(Quote),
      keywords: ["blockquote", "quote"],
      run: (e) => e.chain().focus().setBlockquote().run(),
    },
    {
      title: t("blocks.code"),
      hint: t("blocks.codeHint"),
      icon: icon(Code),
      keywords: ["pre", "fence", "code"],
      run: (e) => e.chain().focus().setCodeBlock().run(),
    },
    {
      title: t("blocks.table"),
      hint: t("blocks.tableHint"),
      icon: icon(Table),
      keywords: ["grid", "table"],
      run: (e) => e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    },
    {
      title: t("blocks.divider"),
      hint: "---",
      icon: icon(Divide),
      keywords: ["hr", "rule", "line"],
      run: (e) => e.chain().focus().setHorizontalRule().run(),
    },
  ];
}

function tool(title: string, label: ReactNode, run: () => void, on = false) {
  return (
    <button
      className={`block-tool${on ? " on" : ""}`}
      key={title}
      onClick={run}
      onMouseDown={(e) => e.preventDefault()}
      title={title}
      aria-label={title}
      aria-pressed={on}
      type="button"
    >
      {label}
    </button>
  );
}

/**
 * `text` is the document as it is outside the editor. A text the editor did not hand out itself
 * is a change from elsewhere (the agent wrote): the blocks it touched are replaced, the caret
 * and what is in view stay. Not `editable`, the text is read: what is marked is drawn, and
 * `reading` says what can be done with a passage.
 */
export function BlockEditor({
  text,
  onChange,
  label,
  editable = true,
  reading,
}: {
  text: string;
  onChange: (text: string) => void;
  /** What a screen reader calls the text. */
  label: string;
  editable?: boolean;
  reading?: Reading;
}) {
  const live = useRef(onChange);
  live.current = onChange;

  // The text as it was opened (or last came from elsewhere): blocks the editor leaves alone are
  // written back from it. `keys` are its blocks as the editor held them then.
  const parsed = useRef<Parsed | null>(null);
  if (!parsed.current) {
    parsed.current = parseMarkdown(text);
  }
  const keys = useRef<string[]>([]);
  /** The text this editor last handed out or took in: anything else is a change from elsewhere. */
  const known = useRef(text);
  const json = useRef(new WeakMap<PMNode, { json: Json; key: string }>());
  const of = (node: PMNode) => {
    let entry = json.current.get(node);
    if (!entry) {
      const j = node.toJSON() as Json;
      entry = { json: j, key: JSON.stringify(j) };
      json.current.set(node, entry);
    }
    return entry;
  };
  const topLevel = (doc: PMNode) => {
    const nodes: PMNode[] = [];
    doc.forEach((n) => {
      nodes.push(n);
    });
    return nodes;
  };
  const markdownOf = (doc: PMNode) => {
    const nodes = topLevel(doc);
    return toMarkdown(
      nodes.map((n) => of(n).json),
      { parsed: parsed.current as Parsed, keys: keys.current },
      (_, i) => of(nodes[i] as PMNode).key,
    );
  };
  const takeKeys = (doc: PMNode) => {
    keys.current = topLevel(doc)
      .slice(0, parsed.current?.blocks.length ?? 0)
      .map((n) => of(n).key);
  };

  const editor = useEditor({
    extensions: [
      ...blockExtensions(),
      Placeholder.configure({ placeholder: t("blocks.placeholder") }),
      SlashCommands.configure({ items: slashItems }),
      DocumentMarks,
    ],
    content: parsed.current.doc,
    editable,
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: { class: "prose-zen block-doc", "aria-label": label },
      // A click in the text places the caret; Cmd/Ctrl+click follows the link.
      handleClick(_view, _pos, event) {
        const href = (event.target as HTMLElement).closest("a")?.getAttribute("href");
        if (!href || !(event.metaKey || event.ctrlKey)) {
          return false;
        }
        event.preventDefault();
        follow(href);
        return true;
      },
      handlePaste(view, event) {
        const plain = event.clipboardData?.getData("text/plain") ?? "";
        const inCode = view.state.selection.$from.parent.type.spec.code;
        if (!inCode && !event.clipboardData?.getData("text/html") && looksLikeMarkdown(plain)) {
          editor?.chain().focus().insertContent(markdownToNodes(plain)).run();
          return true;
        }
        return false;
      },
    },
    onCreate: ({ editor: e }) => takeKeys(e.state.doc),
    onUpdate: ({ editor: e, transaction }: { editor: Editor; transaction: Transaction }) => {
      if (transaction.getMeta(externalKey)) {
        return;
      }
      const next = markdownOf(e.state.doc);
      known.current = next;
      live.current(next);
    },
  });

  // A change from elsewhere: the blocks it touched are replaced, the rest stay as they are.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the text is the only input
  useEffect(() => {
    if (!editor || editor.isDestroyed || text === known.current) {
      return;
    }
    known.current = text;
    parsed.current = parseMarkdown(text);
    replaceChanged(editor, parsed.current.doc);
    takeKeys(editor.state.doc);
  }, [text, editor]);

  useEffect(() => {
    if (editor && !editor.isDestroyed && editor.isEditable !== editable) {
      editor.setEditable(editable);
    }
  }, [editor, editable]);

  // The view exists once EditorContent has mounted it; the handle and the bubble need it.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    if (!editor) {
      return;
    }
    const on = () => setMounted(true);
    const off = () => setMounted(false);
    try {
      if (editor.view.dom.isConnected) {
        on();
      }
    } catch {
      // Not mounted yet: the event comes.
    }
    editor.on("mount", on);
    editor.on("unmount", off);
    return () => {
      editor.off("mount", on);
      editor.off("unmount", off);
    };
  }, [editor]);

  // Marks are drawn while the text is read; editing shows the text as it is.
  const marks = editable ? undefined : reading?.marks;
  useEffect(() => {
    if (editor && mounted && !editor.isDestroyed) {
      showMarks(editor.view, marks ?? []);
    }
  }, [editor, mounted, marks]);

  if (!editor) {
    return null;
  }

  const c = () => editor.chain().focus();
  return (
    <div className="block-editor">
      {/* With the caret in a table: its rows and columns, at the upper edge of what is in view. */}
      {editable && editor.isActive("table") ? (
        <div className="block-table-tools">
          <span className="enter-fade">
            {tool(t("blocks.rowBelow"), t("blocks.row"), () => c().addRowAfter().run())}
            {tool(t("blocks.columnRight"), t("blocks.column"), () => c().addColumnAfter().run())}
            {tool(t("blocks.deleteRow"), `− ${t("blocks.rowWord")}`, () => c().deleteRow().run())}
            {tool(t("blocks.deleteColumn"), `− ${t("blocks.columnWord")}`, () =>
              c().deleteColumn().run(),
            )}
            {tool(t("blocks.deleteTable"), <X className="size-3.5" />, () =>
              c().deleteTable().run(),
            )}
          </span>
        </div>
      ) : null}
      <div className="block-page">
        <EditorContent editor={editor} />
        {mounted && editable ? (
          <>
            <BlockGutter editor={editor} />
            <LinkBubble editor={editor} />
          </>
        ) : null}
        {mounted && !editable && reading ? <ReadBar editor={editor} reading={reading} /> : null}
      </div>
    </div>
  );
}

const bubbleOptions = { placement: "top", offset: 8 } as const;

/** Over selected text: bold, italic, strike, code, link. In a link: its address. */
function LinkBubble({ editor }: { editor: Editor }) {
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const [href, setHref] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const current = String(editor.getAttributes("link").href ?? "");

  useEffect(() => {
    const onSel = () => setEditing(false);
    editor.on("selectionUpdate", onSel);
    return () => {
      editor.off("selectionUpdate", onSel);
    };
  }, [editor]);

  // Stays the same function: the menu dispatches a transaction when it changes.
  const shouldShow = useCallback(
    ({ editor: e, state }: { editor: Editor; state: Editor["state"] }) => {
      const { selection } = state;
      if (selection.$from.parent.type.spec.code || "node" in selection) {
        return false;
      }
      return editingRef.current || !selection.empty || e.isActive("link");
    },
    [],
  );

  const apply = () => {
    const chain = editor.chain().focus().extendMarkRange("link");
    if (href.trim()) {
      chain.setLink({ href: href.trim() }).run();
    } else {
      chain.unsetLink().run();
    }
    setEditing(false);
  };
  const ic = "size-3.5";

  return (
    <BubbleMenu
      className="block-bubble"
      editor={editor}
      options={bubbleOptions}
      shouldShow={shouldShow}
    >
      {editing ? (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <input
            className="block-bubble-input"
            aria-label={t("blocks.linkAddress")}
            onChange={(e) => setHref(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setEditing(false);
                editor.commands.focus();
              }
            }}
            placeholder={t("blocks.linkAddress")}
            ref={input}
            value={href}
          />
          {tool(t("blocks.apply"), <Check className={ic} />, apply)}
        </form>
      ) : (
        <>
          {editor.state.selection.empty ? null : (
            <>
              {tool(
                t("blocks.bold"),
                <Bold className={ic} />,
                () => editor.chain().focus().toggleBold().run(),
                editor.isActive("bold"),
              )}
              {tool(
                t("blocks.italic"),
                <Italic className={ic} />,
                () => editor.chain().focus().toggleItalic().run(),
                editor.isActive("italic"),
              )}
              {tool(
                t("blocks.strike"),
                <Strikethrough className={ic} />,
                () => editor.chain().focus().toggleStrike().run(),
                editor.isActive("strike"),
              )}
              {tool(
                t("blocks.inlineCode"),
                <Code className={ic} />,
                () => editor.chain().focus().toggleCode().run(),
                editor.isActive("code"),
              )}
            </>
          )}
          {tool(
            t("blocks.link"),
            <Link className={ic} />,
            () => {
              setHref(current);
              setEditing(true);
              setTimeout(() => input.current?.focus());
            },
            editor.isActive("link"),
          )}
          {current ? (
            <>
              <span className="block-bubble-href" title={current}>
                {current}
              </span>
              {opens(current)
                ? tool(t("blocks.openLink"), <ExternalLink className={ic} />, () => follow(current))
                : null}
              {tool(t("blocks.removeLink"), <X className={ic} />, () =>
                editor.chain().focus().extendMarkRange("link").unsetLink().run(),
              )}
            </>
          ) : null}
        </>
      )}
    </BubbleMenu>
  );
}
