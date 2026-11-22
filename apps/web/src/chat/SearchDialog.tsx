import { useQuery } from "@tanstack/react-query";
import type { SearchHit } from "@wizards-bot/protocol";
import { FileText, MessageSquare, Search, Shapes, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { cn, Dialog } from "../ui";

const ICONS = { agent: Sparkles, message: MessageSquare, document: FileText, artifact: Shapes };
const GROUPS = ["agent", "message", "document", "artifact"] as const;
const GROUP_LABEL = {
  agent: "search.agents",
  message: "search.messages",
  document: "search.documents",
  artifact: "search.artifacts",
} as const;

/**
 * Finds what the Bot Server keeps: Wizards, the person's messages, documents and artifacts.
 * Opened with ⌘K (Ctrl+K) or the search button; arrows and Enter pick a hit.
 */
export function SearchDialog({
  open,
  onClose,
  onOpen,
}: {
  open: boolean;
  onClose: () => void;
  onOpen: (hit: SearchHit) => void;
}) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  // A short pause after typing, so the Bot Server is asked once per word, not per letter.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(text.trim());
      setAt(0);
    }, 160);
    return () => clearTimeout(timer);
  }, [text]);
  useEffect(() => {
    if (!open) {
      setText("");
      setQuery("");
    }
  }, [open]);
  const found = useQuery({
    queryKey: ["search", query],
    enabled: open && query.length >= 2,
    queryFn: ({ signal }) =>
      api
        .get<{ hits: SearchHit[] }>(`/v1/search?q=${encodeURIComponent(query)}`, signal)
        .then((r) => r.hits),
    staleTime: 10_000,
  });
  const hits = GROUPS.flatMap((kind) => (found.data ?? []).filter((hit) => hit.kind === kind));
  const pick = (hit: SearchHit | undefined) => {
    if (!hit) return;
    onOpen(hit);
    onClose();
  };
  return (
    <Dialog open={open} onClose={onClose} title={t("search.label")}>
      <label className="flex items-center gap-2 rounded-xl bg-paper-2 px-3 ring-1 ring-border-soft focus-within:ring-ember">
        <Search className="size-4 shrink-0 text-ink-3" />
        <input
          data-autofocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setAt((i) => Math.min(i + 1, Math.max(0, hits.length - 1)));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setAt((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              pick(hits[at]);
            }
          }}
          placeholder={t("search.placeholder")}
          aria-label={t("search.label")}
          className="h-11 min-w-0 flex-1 bg-transparent text-[0.9375rem] outline-none placeholder:text-ink-3"
        />
        <kbd className="shrink-0 rounded-md bg-card px-1.5 py-0.5 text-[0.6875rem] text-ink-3 ring-1 ring-border-soft">
          ⌘K
        </kbd>
      </label>
      <div className="mt-3 min-h-40">
        {query.length >= 2 && found.data && hits.length === 0 ? (
          <p className="px-1 py-6 text-center text-[0.875rem] text-ink-3">{t("search.none")}</p>
        ) : null}
        {GROUPS.map((kind) => {
          const group = hits.filter((hit) => hit.kind === kind);
          if (!group.length) return null;
          const Icon = ICONS[kind];
          return (
            <section key={kind} className="mb-2">
              <h3 className="px-2 pt-1 pb-1 font-medium text-[0.75rem] text-ink-3">
                {t(GROUP_LABEL[kind])}
              </h3>
              <ul>
                {group.map((hit) => {
                  const index = hits.indexOf(hit);
                  return (
                    <li key={`${hit.kind}-${hit.id}`}>
                      <button
                        type="button"
                        onMouseEnter={() => setAt(index)}
                        onClick={() => pick(hit)}
                        className={cn(
                          "flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left",
                          index === at ? "bg-accent" : "hover:bg-accent/60",
                        )}
                      >
                        <Icon className="mt-0.5 size-4 shrink-0 text-ink-3" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[0.875rem]">{hit.title}</span>
                          {hit.snippet ? (
                            <span className="block truncate text-[0.8125rem] text-ink-3">
                              {hit.snippet}
                            </span>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </Dialog>
  );
}
