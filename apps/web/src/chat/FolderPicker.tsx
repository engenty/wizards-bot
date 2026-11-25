import { useQuery } from "@tanstack/react-query";
import type { FolderListing, FolderPreview } from "@wizards-bot/protocol";
import { ChevronRight, Folder, FolderPlus, HardDrive, House } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { formatBytes } from "../lib/files";
import { t } from "../lib/i18n";
import { keys } from "../lib/keys";
import { pickFolderOnMac } from "../lib/mac";
import { completions, crumbs, nameOf, separatorOf, tilde, trimmedPath } from "../lib/paths";
import { Button, cn, Input } from "../ui";

/** The person's home folder on the Bot Server's computer and what is in it, where the picker starts. */
export function useFolderHome() {
  return useQuery({
    queryKey: keys.folderHome(),
    queryFn: () => api.get<FolderListing>("/v1/folders/browse"),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * Picks a folder of the Bot Server's computer; the person never has to type a path. In the Mac
 * app, when the Bot Server runs on that Mac, "Choose folder…" opens the Mac's own folder panel.
 * Everywhere else it opens a folder browser the Bot Server serves over its computer: the
 * person's home folder and the folders in it, one level at a time, with a new folder where
 * one is missing. Typing the path stays as a way for whoever prefers it.
 *
 * The chosen folder shows as a chip with its name, its path from `~` and what it holds; a folder
 * the Bot Server would not connect says why there.
 */
export function FolderPicker({
  value,
  onChange,
  hint,
  changeLabel,
  startOpen,
  onCancel,
}: {
  /** The chosen folder's path. */
  value: string | undefined;
  onChange: (path: string | undefined) => void;
  /** A line under the chip instead of what the folder holds, e.g. for one not made yet. */
  hint?: string;
  /** What the chip's button says; "Change" otherwise. */
  changeLabel?: string;
  /** Opens the picker as soon as it is shown. */
  startOpen?: boolean;
  /** The person closed the picker without a folder. */
  onCancel?: () => void;
}) {
  const start = useFolderHome();
  const home = start.data?.home;
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [typing, setTyping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const open = (path?: string) =>
    run(async () => {
      const query = path ? `?path=${encodeURIComponent(path)}` : "";
      setListing(await api.get<FolderListing>(`/v1/folders/browse${query}`));
    });
  const choose = () =>
    run(async () => {
      setTyping(false);
      const onMac = await pickFolderOnMac();
      if (onMac !== undefined) {
        if (onMac) {
          onChange(onMac);
        } else {
          onCancel?.();
        }
        return;
      }
      // The browser starts where the chosen folder is, or at the home folder.
      const from = value ? value.slice(0, value.length - nameOf(value).length) : undefined;
      const query = from ? `?path=${encodeURIComponent(from)}` : "";
      setListing(
        await api
          .get<FolderListing>(`/v1/folders/browse${query}`)
          .catch(() => api.get<FolderListing>("/v1/folders/browse")),
      );
    });

  // Asked to open at once: the picker shows as the person asked for it.
  const opened = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, when it is first shown
  useEffect(() => {
    if (startOpen && !opened.current) {
      opened.current = true;
      void choose();
    }
  }, []);

  if (listing) {
    return (
      <Browser
        listing={listing}
        busy={busy}
        problem={problem}
        onOpen={(path) => void open(path)}
        onMade={setListing}
        onPick={(path) => {
          setListing(null);
          onChange(path);
        }}
        onCancel={() => {
          setListing(null);
          setProblem(null);
          onCancel?.();
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {value ? (
        <Chip
          path={value}
          home={home}
          hint={hint}
          changeLabel={changeLabel}
          onChange={() => void choose()}
          busy={busy}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" busy={busy} onClick={() => void choose()}>
            <Folder className="size-4" />
            {t("folder.choose")}
          </Button>
          {typing ? null : (
            <Button variant="ghost" size="sm" onClick={() => setTyping(true)}>
              {t("folder.type")}
            </Button>
          )}
        </div>
      )}
      {typing && !value ? (
        <PathField
          start={start.data?.path}
          onUse={(path) => {
            setTyping(false);
            onChange(path);
          }}
        />
      ) : null}
      {problem ? (
        <p role="alert" className="text-[0.8125rem] text-rose">
          {problem}
        </p>
      ) : null}
    </div>
  );
}

/** The chosen folder: its name, its path from `~`, and what it holds or why it cannot be. */
function Chip({
  path,
  home,
  hint,
  changeLabel,
  busy,
  onChange,
}: {
  path: string;
  home: string | undefined;
  hint?: string;
  changeLabel?: string;
  busy: boolean;
  onChange: () => void;
}) {
  const [found, setFound] = useState<FolderPreview | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    setFound(null);
    setRefused(null);
    if (hint) {
      return;
    }
    api.post<FolderPreview>("/v1/folders/preview", { path }).then(
      (preview) => current && setFound(preview),
      (err: Error) => current && setRefused(err.message),
    );
    return () => {
      current = false;
    };
  }, [path, hint]);
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={cn(
          "flex items-center gap-3 rounded-xl border bg-card px-3 py-2.5",
          refused ? "border-rose" : "border-input",
        )}
      >
        <Folder className="size-5 shrink-0 text-ember" aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-[0.9375rem] leading-snug">{nameOf(path)}</span>
          <span className="truncate text-[0.8125rem] text-ink-3 leading-snug" title={path}>
            {tilde(path, home)}
          </span>
        </span>
        <Button variant="ghost" size="sm" busy={busy} onClick={onChange}>
          {changeLabel ?? t("folder.change")}
        </Button>
      </div>
      {hint ? (
        <p className="text-[0.8125rem] text-ink-3">{hint}</p>
      ) : refused ? (
        <p role="alert" className="text-[0.8125rem] text-rose">
          {refused}
        </p>
      ) : found ? (
        <p className="text-[0.8125rem] text-ink-3">
          {t("folder.files", { n: found.files })}
          {found.folders ? ` ${t("folder.inFolders", { n: found.folders })}` : null}
          {" · "}
          {formatBytes(found.bytes)}
          {found.more ? ` ${t("folder.more")}` : null}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The folders of one folder, with the way back to the home folder above them. A folder is
 * opened with a click; the folder shown is chosen with the button below.
 */
function Browser({
  listing,
  busy,
  problem,
  onOpen,
  onMade,
  onPick,
  onCancel,
}: {
  listing: FolderListing;
  busy: boolean;
  problem: string | null;
  onOpen: (path: string) => void;
  onMade: (listing: FolderListing) => void;
  onPick: (path: string) => void;
  onCancel: () => void;
}) {
  const [making, setMaking] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const atHome = listing.path === listing.home;
  // At a place the picker starts, the others are a click away: the home folder and the disks.
  const places =
    listing.parent === null && listing.disks.length
      ? [{ name: nameOf(listing.home), path: listing.home, disk: false }].concat(
          listing.disks.map((disk) => ({ ...disk, disk: true })),
        )
      : [];
  const make = async (e: FormEvent) => {
    e.preventDefault();
    if (!making?.trim()) {
      return;
    }
    setRefused(null);
    try {
      onMade(
        await api.post<FolderListing>("/v1/folders/new", {
          parent: listing.path,
          name: making.trim(),
        }),
      );
      setMaking(null);
    } catch (err) {
      setRefused((err as Error).message);
    }
  };
  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-input bg-card">
      <nav
        aria-label={t("folder.where")}
        className="flex flex-wrap items-center gap-0.5 border-border-soft border-b px-2 py-1.5 text-[0.8125rem]"
      >
        {crumbs(listing.path, listing.root).map((step, index, all) => (
          <span key={step.path} className="flex min-w-0 items-center gap-0.5">
            {index ? <ChevronRight className="size-3.5 shrink-0 text-ink-4" /> : null}
            <button
              type="button"
              disabled={index === all.length - 1}
              onClick={() => onOpen(step.path)}
              className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-ink-2 hover:bg-accent disabled:font-medium disabled:text-ink coarse:py-2"
            >
              {index ? null : listing.root === listing.home ? (
                <House className="size-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <HardDrive className="size-3.5 shrink-0" aria-hidden="true" />
              )}
              <span className="truncate">{step.name}</span>
            </button>
          </span>
        ))}
      </nav>
      {places.length ? (
        <nav
          aria-label={t("folder.places")}
          className="flex flex-wrap gap-1 border-border-soft border-b px-2 py-1.5"
        >
          {places.map((place) => (
            <button
              key={place.path}
              type="button"
              aria-pressed={place.path === listing.root}
              onClick={() => onOpen(place.path)}
              className="flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-[0.8125rem] text-ink-2 hover:bg-accent aria-pressed:bg-ember-tint aria-pressed:text-ink coarse:py-2"
            >
              {place.disk ? (
                <HardDrive className="size-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <House className="size-3.5 shrink-0" aria-hidden="true" />
              )}
              <span className="truncate">{place.name}</span>
            </button>
          ))}
        </nav>
      ) : null}
      <ul className="max-h-56 overflow-y-auto p-1">
        {listing.folders.map((folder) => (
          <li key={folder.path}>
            <button
              type="button"
              onClick={() => onOpen(folder.path)}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[0.875rem] hover:bg-accent coarse:py-2.5"
            >
              <Folder className="size-4 shrink-0 text-ink-3" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{folder.name}</span>
              <ChevronRight className="size-4 shrink-0 text-ink-4" aria-hidden="true" />
            </button>
          </li>
        ))}
        {listing.folders.length ? null : (
          <li className="px-2.5 py-2 text-[0.8125rem] text-ink-3">{t("folder.empty")}</li>
        )}
      </ul>
      {making === null ? null : (
        <form onSubmit={(e) => void make(e)} className="flex gap-2 border-border-soft border-t p-2">
          <Input
            aria-label={t("folder.newName")}
            placeholder={t("folder.newName")}
            value={making}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            className="h-9"
            onChange={(e) => setMaking(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={!making.trim()}>
            {t("folder.make")}
          </Button>
        </form>
      )}
      {problem || refused ? (
        <p role="alert" className="px-3 pb-2 text-[0.8125rem] text-rose">
          {refused ?? problem}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 border-border-soft border-t p-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setRefused(null);
            setMaking(making === null ? "" : null);
          }}
        >
          <FolderPlus className="size-4" />
          {t("folder.new")}
        </Button>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button
          size="sm"
          busy={busy}
          disabled={atHome}
          title={atHome ? t("folder.notHome") : undefined}
          onClick={() => onPick(listing.path)}
        >
          {atHome ? t("folder.pickOne") : t("folder.pickThis", { name: nameOf(listing.path) })}
        </Button>
      </div>
    </div>
  );
}

/** The path typed out, for whoever prefers it; it completes folders as one types. */
function PathField({ start, onUse }: { start?: string; onUse: (path: string) => void }) {
  const [path, setPath] = useState(start ? `${start}${separatorOf(start)}` : "");
  const [suggest, setSuggest] = useState<FolderListing["folders"]>([]);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!path.trim()) {
      setSuggest([]);
      return;
    }
    const timer = setTimeout(() => {
      api.get<FolderListing>(`/v1/folders/browse?path=${encodeURIComponent(path)}`).then(
        (listing) => setSuggest(completions(listing, path)),
        () => setSuggest([]),
      );
    }, 200);
    return () => clearTimeout(timer);
  }, [path]);
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (path.trim()) {
          onUse(trimmedPath(path));
        }
      }}
    >
      <div className="flex gap-2">
        <Input
          ref={field}
          aria-label={t("folder.path")}
          placeholder={t("folder.path")}
          value={path}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          onChange={(e) => setPath(e.target.value)}
        />
        <Button type="submit" variant="secondary" disabled={!path.trim()}>
          {t("folder.use")}
        </Button>
      </div>
      {suggest.length ? (
        <ul className="max-h-40 overflow-y-auto rounded-lg bg-paper-2 p-1">
          {suggest.map((folder) => (
            <li key={folder.path}>
              <button
                type="button"
                onClick={() => {
                  setPath(`${folder.path}${separatorOf(folder.path)}`);
                  field.current?.focus();
                }}
                className="w-full truncate rounded-md px-2 py-1.5 text-left text-[0.8125rem] hover:bg-accent coarse:py-2.5"
              >
                {folder.path}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </form>
  );
}
