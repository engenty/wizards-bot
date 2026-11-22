// From engenty wizards, apps/web/src/ui/file-preview.tsx.
import {
  ChevronLeft,
  ChevronRight,
  Download,
  File as FileIcon,
  FileText,
  Film,
  Music,
  X,
} from "lucide-react";
import { type KeyboardEvent, useEffect, useState } from "react";
import { formatBytes, kindOf, type ShownFile, typeLabel } from "../lib/files";
import { t } from "../lib/i18n";
import { cn, Dialog, IconButton, Spinner } from "./index";

const metaOf = (file: ShownFile) =>
  [typeLabel(file), file.size === undefined ? null : formatBytes(file.size)]
    .filter(Boolean)
    .join(" · ");

const ICONS = { pdf: FileText, text: FileText, video: Film, audio: Music, other: FileIcon };

/** The badge a file that is no picture carries: its type, on a colour of its kind. */
function TypeBadge({ file, large }: { file: ShownFile; large?: boolean }) {
  const kind = kindOf(file);
  const Icon = ICONS[kind === "image" ? "other" : kind];
  return (
    <span
      className={cn(
        "flex shrink-0 flex-col items-center justify-center gap-0.5 rounded-lg",
        large ? "size-12" : "size-10",
        kind === "pdf" ? "bg-rose/15 text-rose" : "bg-paper-2 text-ink-3",
      )}
    >
      <Icon className="size-4" />
      <span className="font-semibold text-[0.5625rem] leading-none tracking-wide">
        {typeLabel(file)}
      </span>
    </span>
  );
}

/**
 * A file as a tile: a picture as itself, any other with its type, name and size. `onOpen` is
 * what a click does, `label` says it; with `onRemove` the cross on its corner takes it out
 * again. `large`: in a sent message, where a picture keeps its shape. `state`: on its way to
 * the home, or refused by it.
 */
export function FileTile({
  file,
  label,
  onOpen,
  onRemove,
  large,
  state,
}: {
  file: ShownFile;
  label: string;
  onOpen?: () => void;
  onRemove?: () => void;
  large?: boolean;
  state?: "uploading" | "failed";
}) {
  const image = kindOf(file) === "image" && file.url;
  return (
    <li className="relative max-w-full list-none" title={file.name}>
      <button
        type="button"
        disabled={!onOpen}
        onClick={onOpen}
        aria-label={label}
        className={cn(
          "block overflow-hidden text-left ring-1 transition enabled:hover:ring-ink-4",
          state === "failed" ? "ring-rose" : "ring-border",
          image
            ? cn("enabled:cursor-zoom-in", large ? "max-w-xs rounded-xl" : "size-16 rounded-lg")
            : cn(
                "flex h-16 items-center gap-2.5 rounded-xl bg-card p-2 pr-3 enabled:hover:bg-paper-2",
                large ? "w-64 max-w-full" : "w-56",
              ),
        )}
      >
        {image ? (
          <img
            src={file.url}
            alt={file.name}
            className={cn(
              "bg-paper-2",
              large ? "h-auto max-h-60 w-auto max-w-full object-contain" : "size-16 object-cover",
            )}
          />
        ) : (
          <>
            <TypeBadge file={file} large={large} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium text-[0.8125rem] text-ink">{file.name}</span>
              <span className="truncate text-[0.75rem] text-ink-3">{metaOf(file)}</span>
            </span>
          </>
        )}
      </button>
      {state === "uploading" ? (
        <span
          role="status"
          aria-label={t("files.uploading", { name: file.name })}
          className="pointer-events-none absolute inset-0 grid place-items-center rounded-lg bg-card/70 text-ink-2"
        >
          <Spinner className="size-4" />
        </span>
      ) : null}
      {onRemove ? (
        <button
          type="button"
          aria-label={t("files.remove", { name: file.name })}
          onClick={onRemove}
          className="-top-1.5 -right-1.5 absolute flex size-5 items-center justify-center rounded-full bg-ink text-paper shadow-soft coarse:size-7"
        >
          <X className="size-3" />
        </button>
      ) : null}
    </li>
  );
}

/** Text files show up to this many characters. */
const TEXT_LIMIT = 200_000;

function TextBody({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    setText(null);
    fetch(url)
      .then((r) => r.text())
      .then((all) => !gone && setText(all.slice(0, TEXT_LIMIT)))
      .catch(() => !gone && setText(""));
    return () => {
      gone = true;
    };
  }, [url]);
  if (text === null) {
    return (
      <div className="grid h-full place-items-center text-ink-3">
        <Spinner />
      </div>
    );
  }
  return (
    <pre className="h-full overflow-auto whitespace-pre-wrap break-words p-5 font-mono text-[0.8125rem] text-ink-2 leading-relaxed">
      {text}
    </pre>
  );
}

function Body({ file }: { file: ShownFile & { url: string } }) {
  const kind = kindOf(file);
  if (kind === "image") {
    return (
      <div className="grid h-full place-items-center overflow-auto p-4">
        <img src={file.url} alt={file.name} className="max-h-full max-w-full object-contain" />
      </div>
    );
  }
  if (kind === "pdf") {
    return <iframe src={file.url} title={file.name} className="size-full bg-paper-2" />;
  }
  if (kind === "video") {
    return (
      <div className="grid h-full place-items-center bg-black">
        {/* biome-ignore lint/a11y/useMediaCaption: a file someone attached */}
        <video src={file.url} controls className="max-h-full max-w-full" />
      </div>
    );
  }
  if (kind === "audio") {
    return (
      <div className="grid h-full place-items-center p-8">
        {/* biome-ignore lint/a11y/useMediaCaption: a file someone attached */}
        <audio src={file.url} controls className="w-full max-w-md" />
      </div>
    );
  }
  if (kind === "text") {
    return <TextBody url={file.url} />;
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-ink-3">
      <TypeBadge file={file} large />
      <p className="text-[0.875rem]">{t("files.noPreview")}</p>
    </div>
  );
}

/**
 * Files opened large, one at a time: a picture, a PDF, a clip, a recording or a text file in the
 * window itself, any other with its name alone. With several, ← and → go through them.
 */
export function FilePreview({
  files,
  at,
  onAt,
}: {
  files: ShownFile[];
  /** The one shown; null: closed. */
  at: number | null;
  /** Another file, or null to close. */
  onAt: (at: number | null) => void;
}) {
  const openable = files.flatMap((f, i) => (f.url ? [i] : []));
  const file = at === null ? undefined : files[at];
  const index = at === null ? -1 : openable.indexOf(at);
  const step = (by: number) =>
    onAt(openable[(index + by + openable.length) % openable.length] ?? null);
  const many = openable.length > 1;
  const onClose = () => onAt(null);
  return (
    <Dialog open={Boolean(file?.url)} onClose={onClose} wide="full" bare>
      {file?.url ? (
        <div
          role="document"
          onKeyDown={(e: KeyboardEvent) => {
            if (many && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
              e.preventDefault();
              step(e.key === "ArrowLeft" ? -1 : 1);
            }
          }}
          className="flex h-[calc(100dvh-48px)] flex-col overflow-hidden rounded-2xl bg-card shadow-overlay max-sm:h-dvh max-sm:rounded-none max-sm:pt-[env(safe-area-inset-top)]"
        >
          <div className="flex items-center gap-2 border-border-soft border-b py-2 pr-2 pl-4">
            <div className="flex min-w-0 flex-1 flex-col">
              <h2 className="truncate font-medium text-[0.9375rem]">{file.name}</h2>
              <span className="text-[0.75rem] text-ink-3">
                {many ? `${index + 1} / ${openable.length} · ` : ""}
                {metaOf(file)}
              </span>
            </div>
            {many ? (
              <>
                <IconButton label={t("files.previous")} onClick={() => step(-1)}>
                  <ChevronLeft className="size-4" />
                </IconButton>
                <IconButton label={t("files.next")} onClick={() => step(1)}>
                  <ChevronRight className="size-4" />
                </IconButton>
              </>
            ) : null}
            <a
              href={file.url}
              download={file.name}
              aria-label={t("files.download")}
              title={t("files.download")}
              className="inline-flex size-9 items-center justify-center rounded-full text-ink-3 transition hover:bg-accent hover:text-ink coarse:size-11"
            >
              <Download className="size-4" />
            </a>
            <IconButton label={t("common.close")} onClick={onClose}>
              <X className="size-4" />
            </IconButton>
          </div>
          <div className="min-h-0 flex-1">
            <Body key={file.url} file={{ ...file, url: file.url }} />
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
