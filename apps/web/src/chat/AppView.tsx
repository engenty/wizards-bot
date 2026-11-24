import { ChevronRight, Shapes } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { pageOpens } from "../lib/artifact";
import { t } from "../lib/i18n";
import { useArtifact } from "../lib/queries";

/** The artifact open beside the chat: a view there is not run twice. */
export const OpenArtifact = createContext<string | null>(null);

/** How tall a view may stand in the chat; taller, it opens beside it. */
const MAX_INLINE = 420;
const FIRST_HEIGHT = 240;

/**
 * What the host page of a connection's view tells the frame around it (apps/web/src/app-host):
 * a link to open, its height. Only messages of this frame count.
 */
export function useHostMessages(
  frame: React.RefObject<HTMLIFrameElement | null>,
  on: { size?: (height: number) => void; pane?: () => void },
) {
  useEffect(() => {
    const listen = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as { source?: string; type?: string; url?: string; height?: number };
      if (data?.source !== "wizards-app") return;
      if (data.type === "size" && typeof data.height === "number") on.size?.(data.height);
      if (data.type === "open-link" && data.url === "wizards-app:pane") on.pane?.();
      else if (data.type === "open-link" && data.url && /^https?:\/\//i.test(data.url))
        window.open(data.url, "_blank", "noopener,noreferrer");
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, [frame, on]);
}

/**
 * An artifact in the chat. An agent's page is a line that opens it beside the chat; a
 * connection's view (format `app`) stands in the chat itself, at most 420 pixels tall, and as
 * its summary while it is open beside the chat.
 */
export function ArtifactPart({
  id,
  title,
  onOpen,
}: {
  id: string;
  title: string;
  onOpen: (id: string) => void;
}) {
  const artifact = useArtifact(id);
  const open = useContext(OpenArtifact) === id;
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(FIRST_HEIGHT);
  const [page, setPage] = useState<string | null>(null);
  const current = artifact.data;
  const app = current?.format === "app";
  // The address is taken once: reading the artifact again must not load the view anew.
  useEffect(() => {
    if (app && current && !page && pageOpens(current.page, Date.now())) {
      setPage(`${current.page}&mode=inline`);
    }
  }, [app, current, page]);
  const [on] = useState(() => ({
    size: (h: number) => setHeight(Math.max(80, Math.min(MAX_INLINE, Math.ceil(h)))),
    pane: () => onOpen(id),
  }));
  useHostMessages(frame, on);

  const line = (
    <button
      type="button"
      onClick={() => onOpen(id)}
      className="flex w-full max-w-sm items-center gap-2.5 rounded-xl bg-card px-3.5 py-3 text-left text-[0.9375rem] shadow-soft ring-1 ring-border-soft transition hover:ring-ink-4"
    >
      <Shapes className="size-4 shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
      <ChevronRight className="size-4 shrink-0 text-ink-4" />
    </button>
  );
  if (!app) return line;
  if (open || !page) {
    return (
      <div className="w-full max-w-xl rounded-xl bg-card px-3.5 py-3 shadow-soft ring-1 ring-border-soft">
        <div className="flex items-center gap-2.5">
          <Shapes className="size-4 shrink-0 text-ink-3" />
          <span className="min-w-0 flex-1 truncate font-medium text-[0.9375rem]">{title}</span>
          {open ? null : (
            <button
              type="button"
              onClick={() => onOpen(id)}
              className="text-[0.8125rem] text-ink-3 hover:text-ink"
            >
              {t("app.open")}
            </button>
          )}
        </div>
        <p className="mt-1.5 line-clamp-4 whitespace-pre-line text-[0.8125rem] text-ink-3">
          {open ? t("app.shownBeside") : current?.summary}
        </p>
      </div>
    );
  }
  return (
    <div className="w-full max-w-xl overflow-hidden rounded-xl bg-card shadow-soft ring-1 ring-border-soft">
      <div className="flex items-center gap-2.5 px-3.5 py-2">
        <Shapes className="size-4 shrink-0 text-ink-3" />
        <span className="min-w-0 flex-1 truncate font-medium text-[0.9375rem]">{title}</span>
        <button
          type="button"
          onClick={() => onOpen(id)}
          className="text-[0.8125rem] text-ink-3 hover:text-ink"
        >
          {t("app.open")}
        </button>
      </div>
      <iframe
        ref={frame}
        title={title}
        src={page}
        // As an agent's page: the home serves the host closed off, with an origin of its own.
        sandbox="allow-scripts allow-forms allow-same-origin"
        referrerPolicy="no-referrer"
        style={{ height }}
        className="block w-full border-0"
      />
    </div>
  );
}
