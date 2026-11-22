// The palette after engenty wizards' search of Wissen (apps/web/src/studio/space/KnowledgePalette.tsx):
// the field on top, the rows under it, the keys at the foot.
import { useQuery } from "@tanstack/react-query";
import type { Agent, SearchHit } from "@wizards-bot/protocol";
import {
  CornerDownLeft,
  FileText,
  type LucideIcon,
  MessageCircle,
  MessageSquare,
  Search,
  Shapes,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { cn, Dialog, IconButton } from "../ui";

const ICONS: Record<SearchHit["kind"], LucideIcon> = {
  agent: Sparkles,
  message: MessageSquare,
  document: FileText,
  artifact: Shapes,
};
const GROUPS = ["agent", "message", "document", "artifact"] as const;
const GROUP_LABEL = {
  agent: "search.agents",
  message: "search.messages",
  document: "search.documents",
  artifact: "search.artifacts",
} as const;

/** ⌘ on a Mac, Ctrl elsewhere. */
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

/** One row of the palette: a hit, a Wizard, or the question for the main Wizard. */
interface Row {
  key: string;
  icon: LucideIcon;
  title: string;
  text?: string;
  ask?: boolean;
  open: () => void;
}

/**
 * Finds what the Bot Server keeps: Wizards, the person's messages, documents and artifacts. Before
 * anything is typed it lists the Wizards. Enter opens a row; ⌘Enter hands the words to the main
 * Wizard as a question.
 */
export function SearchDialog({
  open,
  onClose,
  onOpen,
  agents,
  asker,
}: {
  open: boolean;
  onClose: () => void;
  onOpen: (hit: SearchHit) => void;
  agents: Agent[];
  /** The main Wizard, to ask in its chat. */
  asker?: { name: string; ask: (text: string) => Promise<void> };
}) {
  return (
    <Dialog open={open} onClose={onClose} wide="palette" bare>
      {open ? <Palette onClose={onClose} onOpen={onOpen} agents={agents} asker={asker} /> : null}
    </Dialog>
  );
}

function Palette({
  onClose,
  onOpen,
  agents,
  asker,
}: {
  onClose: () => void;
  onOpen: (hit: SearchHit) => void;
  agents: Agent[];
  asker?: { name: string; ask: (text: string) => Promise<void> };
}) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  // A short pause after typing, so the Bot Server is asked once per word, not per letter.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(text.trim());
      setAt(0);
    }, 160);
    return () => clearTimeout(timer);
  }, [text]);
  const found = useQuery({
    queryKey: ["search", query],
    enabled: query.length >= 2,
    queryFn: ({ signal }) =>
      api
        .get<{ hits: SearchHit[] }>(`/v1/search?q=${encodeURIComponent(query)}`, signal)
        .then((r) => r.hits),
    staleTime: 10_000,
  });
  const go = (hit: SearchHit) => () => {
    onOpen(hit);
    onClose();
  };
  const ask = () => {
    if (asker && text.trim()) {
      void asker.ask(text.trim());
      onClose();
    }
  };
  const askRow: Row | null =
    asker && text.trim()
      ? {
          key: "ask",
          icon: MessageCircle,
          title: t("search.ask", { name: asker.name }),
          ask: true,
          open: ask,
        }
      : null;
  const searching = query.length >= 2;
  const groups: { label: string; rows: Row[] }[] = searching
    ? GROUPS.map((kind) => ({
        label: t(GROUP_LABEL[kind]),
        rows: (found.data ?? [])
          .filter((hit) => hit.kind === kind)
          .map((hit) => ({
            key: `${hit.kind}-${hit.id}`,
            icon: ICONS[hit.kind],
            title: hit.title,
            text: hit.snippet || undefined,
            open: go(hit),
          })),
      })).filter((group) => group.rows.length)
    : [
        {
          label: t("search.agents"),
          rows: agents.map((agent) => ({
            key: `agent-${agent.id}`,
            icon: Sparkles,
            title: agent.name,
            text: agent.about || undefined,
            open: go({
              kind: "agent",
              id: agent.id,
              agentId: agent.id,
              title: agent.name,
              snippet: "",
              at: "",
            }),
          })),
        },
      ];
  const rows = [...(askRow ? [askRow] : []), ...groups.flatMap((group) => group.rows)];
  const none = searching && found.data !== undefined && groups.length === 0;
  return (
    <div
      role="dialog"
      aria-label={t("search.label")}
      className="mx-auto flex h-[min(36rem,calc(100dvh-6rem))] w-full max-w-2xl flex-col rounded-2xl bg-card shadow-overlay ring-1 ring-border-soft max-sm:h-dvh max-sm:max-w-none max-sm:rounded-none"
    >
      <label className="flex items-center gap-3 border-border-soft border-b px-4 py-3.5">
        <Search className="size-[18px] shrink-0 text-ink-3" />
        <input
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setAt((i) => Math.min(i + 1, Math.max(0, rows.length - 1)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setAt((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              ask();
            } else if (e.key === "Enter") {
              e.preventDefault();
              rows[at]?.open();
            }
          }}
          placeholder={t("search.placeholder")}
          aria-label={t("search.label")}
          className="min-w-0 flex-1 bg-transparent text-[1.0625rem] text-ink outline-none placeholder:text-ink-4"
        />
        <kbd className="shrink-0 rounded-md px-1.5 font-mono text-[0.6875rem] text-ink-4 ring-1 ring-border-soft max-sm:hidden">
          esc
        </kbd>
        <IconButton label={t("common.close")} onClick={onClose} className="-mr-2 sm:hidden">
          <X className="size-4" />
        </IconButton>
      </label>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {askRow ? (
          <RowButton row={askRow} on={at === 0} onHover={() => setAt(0)}>
            <kbd className="shrink-0 font-mono text-[0.6875rem] text-ink-4 max-sm:hidden">
              {MAC ? "⌘↵" : "Ctrl ↵"}
            </kbd>
          </RowButton>
        ) : null}
        {none ? (
          <p className="px-3 py-6 text-center text-[0.875rem] text-ink-3">{t("search.none")}</p>
        ) : null}
        {groups.map((group) => (
          <section key={group.label}>
            <p className="px-3 pt-3 pb-1 text-[0.75rem] text-ink-3">{group.label}</p>
            {group.rows.map((row) => {
              const index = rows.indexOf(row);
              return (
                <RowButton key={row.key} row={row} on={index === at} onHover={() => setAt(index)} />
              );
            })}
          </section>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-b-2xl border-border-soft border-t bg-paper-2 px-4 py-2.5 text-[0.75rem] text-ink-3 max-sm:rounded-none">
        <span className="max-sm:hidden">↑ ↓ {t("search.choose")}</span>
        <span className="inline-flex items-center gap-1 max-sm:hidden">
          <CornerDownLeft className="size-3" /> {t("search.open")}
        </span>
      </div>
    </div>
  );
}

function RowButton({
  row,
  on,
  onHover,
  children,
}: {
  row: Row;
  on: boolean;
  onHover: () => void;
  children?: React.ReactNode;
}) {
  const Icon = row.icon;
  return (
    <button
      type="button"
      onMouseEnter={onHover}
      onClick={row.open}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left",
        on ? "bg-accent" : "hover:bg-accent/60",
      )}
    >
      <Icon className={cn("size-4 shrink-0", row.ask ? "text-ember" : "text-ink-3")} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[0.9375rem]">{row.title}</span>
        {row.text ? (
          <span className="block truncate text-[0.8125rem] text-ink-3">{row.text}</span>
        ) : null}
      </span>
      {children}
    </button>
  );
}
