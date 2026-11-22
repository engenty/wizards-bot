import { Printer, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { pageOpens } from "../lib/artifact";
import { t } from "../lib/i18n";
import { useArtifact } from "../lib/queries";
import { cn, IconButton, Spinner } from "../ui";
import { ShareButton } from "./ShareDialog";

/**
 * An artifact beside the chat: a page an agent wrote, shown where a document is shown. The
 * page is a stranger's page. It is loaded from the home in a frame with an origin of its own,
 * so it reads nothing of this app, and its text is never put into this page.
 */
export function ArtifactPane({
  id,
  over,
  leaving,
  onClose,
}: {
  id: string;
  /** It lies over the chat, as on a phone, instead of standing beside it. */
  over: boolean;
  /** It is on its way out. */
  leaving: boolean;
  onClose: () => void;
}) {
  const artifact = useArtifact(id);
  const frame = useRef<HTMLIFrameElement>(null);
  const current = artifact.data;
  // The page the frame shows changes with the version only. The artifact is read again now
  // and then for an address that still works; that alone must not load the page anew, or what
  // the person turned or picked in it would be lost.
  const [shown, setShown] = useState<{ version: number; page: string } | null>(null);
  const [refused, setRefused] = useState(false);
  useEffect(() => {
    if (
      current &&
      !refused &&
      current.version !== shown?.version &&
      pageOpens(current.page, Date.now())
    ) {
      setShown({ version: current.version, page: current.page });
    }
  }, [current, shown, refused]);

  // The page prints itself: the home gave it the layout for paper.
  const print = () => frame.current?.contentWindow?.postMessage({ type: "artifact.print" }, "*");

  return (
    <aside
      aria-label={current?.title}
      className={cn(
        "flex h-full min-w-0 flex-col bg-background",
        over ? "pane-over fixed inset-0 z-30" : "border-border-soft border-l",
      )}
      data-leaving={leaving || undefined}
    >
      <header className="flex items-center gap-2 px-3 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))]">
        <IconButton label={t("common.close")} onClick={onClose}>
          <X className="size-4" />
        </IconButton>
        <h2 className="min-w-0 flex-1 truncate font-display font-semibold text-[1.0625rem]">
          {current?.title}
        </h2>
        {current ? (
          <ShareButton
            kind="artifact"
            id={id}
            title={current.title}
            version={current.version}
            page={current.page}
            print={shown ? print : undefined}
          />
        ) : null}
        <IconButton label={t("artifact.print")} disabled={!shown} onClick={print}>
          <Printer className="size-4" />
        </IconButton>
      </header>
      {artifact.error || refused ? (
        <p
          role="alert"
          className="mx-4 mb-2 rounded-lg bg-rose-tint px-3 py-2 text-[0.8125rem] text-rose"
        >
          {artifact.error?.message ?? t("artifact.refused")}
        </p>
      ) : null}
      {shown ? (
        <iframe
          ref={frame}
          title={current?.title}
          src={shown.page}
          // The home serves the page with `sandbox` in its policy, and that is what gives the
          // page an origin of its own. The frame adds its own limits (no pop-ups, no forms,
          // no leaving the frame) and leaves the origin to the home: a frame that takes the
          // origin away itself is refused its page by browsers that only load for sites they
          // know, such as the one inside Claude's desktop app.
          sandbox="allow-scripts allow-modals allow-same-origin"
          onLoad={(e) => {
            // A page this app can reach into did not come closed off: it is not shown.
            let open = false;
            try {
              open = e.currentTarget.contentDocument !== null;
            } catch {
              // Closed off, as it must be.
            }
            if (open) {
              setShown(null);
              setRefused(true);
            }
          }}
          referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      ) : artifact.isPending || artifact.isFetching ? (
        <div className="grid flex-1 place-items-center text-ink-4">
          <Spinner />
        </div>
      ) : null}
    </aside>
  );
}
