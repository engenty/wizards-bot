import { useQueryClient } from "@tanstack/react-query";
import type {
  Folder,
  FolderActivity,
  FolderChange,
  FolderEntries,
  FolderEntry,
} from "@wizards-bot/protocol";
import {
  ChevronRight,
  Download,
  File as FileIcon,
  Folder as FolderIcon,
  FolderPlus,
  MessageSquarePlus,
  Pencil,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { type DragEvent, type FormEvent, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { formatBytes, type ShownFile } from "../lib/files";
import { lang, t } from "../lib/i18n";
import { keys } from "../lib/keys";
import { useFolderActivity, useFolderEntries, useFolders } from "../lib/queries";
import { Button, cn, IconButton, Input, Spinner } from "../ui";
import { FilePreview } from "../ui/FilePreview";

type Tab = "files" | "activity";

const when = (at: string): string =>
  new Date(at).toLocaleString(lang, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

const join = (path: string, name: string) => (path ? `${path}/${name}` : name);

/**
 * A connected folder beside the chat: what it holds, one place at a time, and what agents and
 * the person did in it, with a way to take a change back. It shows what the agents reach and
 * nothing else. In a folder connected for changes the person drops files in, makes folders,
 * renames and moves to the Trash here, without a card.
 */
export function FolderPane({
  id,
  start,
  show,
  over,
  leaving,
  onAsk,
  onClose,
}: {
  id: string;
  /** The place inside the folder it opens at. */
  start: string;
  /** A file there that is shown at once, each time it is asked for. */
  show?: { path: string; at: number };
  over: boolean;
  leaving: boolean;
  /** Names a file in the message being written, for the agent of this chat. */
  onAsk: (reference: string) => void;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const folders = useFolders();
  const folder = folders.data?.find((each) => each.id === id);
  const [path, setPath] = useState(start);
  const [tab, setTab] = useState<Tab>("files");
  const [problem, setProblem] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a file that is shown again starts there again
  useEffect(() => {
    setPath(start);
    setTab("files");
  }, [start, show?.at]);

  const run = async (work: () => Promise<unknown>) => {
    setProblem(null);
    try {
      await work();
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      void client.invalidateQueries({ queryKey: keys.folder(id) });
    }
  };

  const title = folder?.name ?? t("folders.title");
  return (
    <aside
      aria-label={title}
      className={cn(
        "flex h-full min-w-0 flex-col bg-background",
        over ? "pane-over fixed inset-0 z-30" : "border-border-soft border-l",
      )}
      data-leaving={leaving || undefined}
    >
      <header className="flex items-center gap-2 px-3 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))]">
        <FolderIcon className="size-4 shrink-0 text-ember" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate font-display font-semibold">{title}</span>
        <IconButton label={t("common.close")} onClick={onClose}>
          <X className="size-4" />
        </IconButton>
      </header>
      {folder ? (
        <>
          <nav
            aria-label={t("browser.tabs")}
            className="flex gap-1 border-border-soft border-b px-3 pb-2"
          >
            {(["files", "activity"] as const).map((each) => (
              <button
                key={each}
                type="button"
                aria-pressed={tab === each}
                onClick={() => setTab(each)}
                className="rounded-md px-2.5 py-1 text-[0.8125rem] text-ink-2 hover:bg-accent aria-pressed:bg-ember-tint aria-pressed:text-ink coarse:py-2"
              >
                {t(each === "files" ? "browser.files" : "browser.activity")}
              </button>
            ))}
          </nav>
          {problem ? (
            <p role="alert" className="px-4 pt-2 text-[0.8125rem] text-rose">
              {problem}
            </p>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === "files" ? (
              <Files
                folder={folder}
                path={path}
                show={show}
                onPath={setPath}
                run={run}
                onAsk={onAsk}
              />
            ) : (
              <Activity folder={folder} run={run} />
            )}
          </div>
          <Access folder={folder} run={run} />
        </>
      ) : (
        <p className="px-4 py-6 text-[0.875rem] text-ink-3">{t("browser.gone")}</p>
      )}
    </aside>
  );
}

/** What a place in the folder holds, with its way back up and, for changes, what the person does. */
function Files({
  folder,
  path,
  show,
  onPath,
  run,
  onAsk,
}: {
  folder: Folder;
  path: string;
  show?: { path: string; at: number };
  onPath: (path: string) => void;
  run: (work: () => Promise<unknown>) => Promise<void>;
  onAsk: (reference: string) => void;
}) {
  const listing = useFolderEntries(folder.id, path);
  const writes = folder.access === "write";
  const [making, setMaking] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ entry: FolderEntry; name: string } | null>(null);
  const [shown, setShown] = useState<ShownFile | null>(null);
  const [drag, setDrag] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const depth = useRef(0);

  // A shown file's bytes are the page's own while it shows.
  useEffect(() => {
    const url = shown?.url;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [shown?.url]);

  const open = (entry: FolderEntry) =>
    run(async () => {
      const res = await api.open(
        `/v1/folders/${folder.id}/file?path=${encodeURIComponent(entry.path)}`,
      );
      const blob = await res.blob();
      setShown({
        name: entry.name,
        mime: blob.type,
        size: entry.size,
        url: URL.createObjectURL(blob),
      });
    });
  // The file that was asked for, once its place is listed. One that is gone leaves the place.
  const showed = useRef<number>(undefined);
  const wanted = show && listing.data?.entries.find((entry) => entry.path === show.path);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the request and its entry say when
  useEffect(() => {
    if (show && wanted?.kind === "file" && showed.current !== show.at) {
      showed.current = show.at;
      void open(wanted);
    }
  }, [show?.at, wanted?.path]);
  const save = (entry: FolderEntry) =>
    run(async () => {
      const res = await api.open(
        `/v1/folders/${folder.id}/file?path=${encodeURIComponent(entry.path)}&download`,
      );
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = entry.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  const edit = (body: unknown) => run(() => api.post(`/v1/folders/${folder.id}/edit`, body));
  const put = (files: File[]) =>
    run(async () => {
      for (const file of files) {
        await api.open(
          `/v1/folders/${folder.id}/file?path=${encodeURIComponent(join(path, file.name))}`,
          {
            method: "PUT",
            headers: { "content-type": "application/octet-stream" },
            body: file,
          },
        );
      }
    });
  const make = (e: FormEvent) => {
    e.preventDefault();
    const name = making?.trim();
    if (!name) return;
    setMaking(null);
    void edit({ action: "make", path: join(path, name) });
  };
  const rename = (e: FormEvent) => {
    e.preventDefault();
    if (!renaming) return;
    const name = renaming.name.trim();
    const { entry } = renaming;
    setRenaming(null);
    if (name && name !== entry.name)
      void edit({ action: "move", from: entry.path, to: join(path, name) });
  };
  const takes = (e: DragEvent) => writes && e.dataTransfer.types.includes("Files");

  const data: FolderEntries | undefined = listing.data;
  const steps = path ? path.split("/") : [];
  return (
    <section
      aria-label={t("browser.files")}
      className={cn("flex min-h-full flex-col", drag && "bg-ember-tint")}
      onDragEnter={(e) => {
        if (!takes(e)) return;
        depth.current += 1;
        setDrag(true);
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setDrag(false);
      }}
      onDragOver={(e) => {
        if (takes(e)) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!takes(e)) return;
        e.preventDefault();
        depth.current = 0;
        setDrag(false);
        void put(Array.from(e.dataTransfer.files));
      }}
    >
      <nav
        aria-label={t("folder.where")}
        className="flex flex-wrap items-center gap-0.5 px-2 py-1.5 text-[0.8125rem]"
      >
        {[folder.name, ...steps].map((name, index, all) => (
          <span
            key={[folder.name, ...steps].slice(0, index + 1).join("/")}
            className="flex min-w-0 items-center gap-0.5"
          >
            {index ? <ChevronRight className="size-3.5 shrink-0 text-ink-4" /> : null}
            <button
              type="button"
              disabled={index === all.length - 1}
              onClick={() => onPath(steps.slice(0, index).join("/"))}
              className="min-w-0 truncate rounded-md px-1.5 py-1 text-ink-2 hover:bg-accent disabled:font-medium disabled:text-ink coarse:py-2"
            >
              {name}
            </button>
          </span>
        ))}
      </nav>
      {writes ? (
        <div className="flex flex-wrap gap-1 px-2 pb-1.5">
          <Button variant="ghost" size="sm" onClick={() => setMaking(making === null ? "" : null)}>
            <FolderPlus className="size-4" />
            {t("folder.new")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => picker.current?.click()}>
            <Upload className="size-4" />
            {t("browser.add")}
          </Button>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              void put(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
        </div>
      ) : null}
      {making === null ? null : (
        <form onSubmit={make} className="flex gap-2 px-3 pb-2">
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
      {listing.isPending ? (
        <div className="flex justify-center py-8">
          <Spinner className="size-5" />
        </div>
      ) : listing.isError ? (
        <p role="alert" className="px-4 py-3 text-[0.8125rem] text-rose">
          {(listing.error as Error).message}
        </p>
      ) : (
        <ul className="px-1 pb-4">
          {data?.entries.map((entry) => (
            <li
              key={entry.path}
              className="group flex items-center gap-1 rounded-lg hover:bg-accent"
            >
              {renaming?.entry.path === entry.path ? (
                <form onSubmit={rename} className="flex flex-1 gap-2 px-2 py-1">
                  <Input
                    aria-label={t("browser.newName")}
                    value={renaming.name}
                    autoFocus
                    className="h-8"
                    onChange={(e) => setRenaming({ entry, name: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setRenaming(null);
                    }}
                  />
                  <Button type="submit" size="sm">
                    {t("browser.rename")}
                  </Button>
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => (entry.kind === "folder" ? onPath(entry.path) : void open(entry))}
                  className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1.5 text-left coarse:py-2.5"
                >
                  {entry.kind === "folder" ? (
                    <FolderIcon className="size-4 shrink-0 text-ink-3" aria-hidden="true" />
                  ) : (
                    <FileIcon className="size-4 shrink-0 text-ink-3" aria-hidden="true" />
                  )}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[0.875rem]">{entry.name}</span>
                    <span className="truncate text-[0.75rem] text-ink-3">
                      {entry.kind === "file" ? `${formatBytes(entry.size)} · ` : ""}
                      {when(entry.changedAt)}
                    </span>
                  </span>
                  {entry.kind === "folder" ? (
                    <ChevronRight className="size-4 shrink-0 text-ink-4" aria-hidden="true" />
                  ) : null}
                </button>
              )}
              {renaming?.entry.path === entry.path ? null : (
                <span className="flex shrink-0 items-center pr-1 opacity-0 focus-within:opacity-100 group-hover:opacity-100 coarse:opacity-100">
                  <IconButton
                    label={t("browser.ask", { name: entry.name })}
                    onClick={() => onAsk(`${folder.name}/${entry.path}`)}
                  >
                    <MessageSquarePlus className="size-4" />
                  </IconButton>
                  {entry.kind === "file" ? (
                    <IconButton label={t("browser.save")} onClick={() => void save(entry)}>
                      <Download className="size-4" />
                    </IconButton>
                  ) : null}
                  {writes ? (
                    <>
                      <IconButton
                        label={t("browser.rename")}
                        onClick={() => setRenaming({ entry, name: entry.name })}
                      >
                        <Pencil className="size-4" />
                      </IconButton>
                      <IconButton
                        label={t("browser.trash", { name: entry.name })}
                        onClick={() => {
                          if (window.confirm(t("browser.trashAsk", { name: entry.name })))
                            void edit({ action: "trash", paths: [entry.path] });
                        }}
                      >
                        <Trash2 className="size-4" />
                      </IconButton>
                    </>
                  ) : null}
                </span>
              )}
            </li>
          ))}
          {data && !data.entries.length ? (
            <li className="px-3 py-3 text-[0.8125rem] text-ink-3">
              {writes ? t("browser.emptyDrop") : t("folder.empty")}
            </li>
          ) : null}
          {data?.more ? (
            <li className="px-3 py-2 text-[0.8125rem] text-ink-3">{t("browser.more")}</li>
          ) : null}
        </ul>
      )}
      <FilePreview
        files={shown ? [shown] : []}
        at={shown ? 0 : null}
        onAt={(at) => {
          if (at === null) setShown(null);
        }}
      />
    </section>
  );
}

/** One change on a line: what was done to which file. */
function changeLine(change: FolderChange): string {
  const what = t(`browser.change.${change.action}` as Parameters<typeof t>[0]);
  return change.action === "move" && change.from
    ? `${what} ${change.from} → ${change.path}`
    : `${what} ${change.path}`;
}

/** What agents and the person did here, per turn, with a way to take a change back. */
function Activity({
  folder,
  run,
}: {
  folder: Folder;
  run: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const activity = useFolderActivity(folder.id, true);
  if (activity.isPending)
    return (
      <div className="flex justify-center py-8">
        <Spinner className="size-5" />
      </div>
    );
  const rows: FolderActivity[] = activity.data ?? [];
  if (!rows.length)
    return <p className="px-4 py-4 text-[0.8125rem] text-ink-3">{t("browser.nothingYet")}</p>;
  return (
    <ol className="flex flex-col gap-3 px-4 py-3">
      {rows.map((row) => (
        <li key={row.id} className="flex flex-col gap-1">
          <p className="text-[0.75rem] text-ink-3">
            {row.agentName ?? t("browser.you")} · {when(row.at)}
            {row.read ? ` · ${t("browser.read", { n: row.read })}` : ""}
          </p>
          {row.changes.map((change, index) => (
            <div
              key={`${row.id}-${change.at}-${change.path}`}
              className={cn(
                "flex items-center gap-2 text-[0.875rem]",
                change.undone && "text-ink-3 line-through",
              )}
            >
              <span className="min-w-0 flex-1 truncate" title={changeLine(change)}>
                {changeLine(change)}
              </span>
              {change.undone || folder.access !== "write" ? null : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    void run(() =>
                      api.post(`/v1/folders/${folder.id}/undo`, {
                        activityId: row.id,
                        index,
                      }),
                    )
                  }
                >
                  <RotateCcw className="size-3.5" />
                  {t("browser.takeBack")}
                </Button>
              )}
            </div>
          ))}
        </li>
      ))}
    </ol>
  );
}

/** What the agents may do here, and the "Always allow" the person gave on a card. */
function Access({
  folder,
  run,
}: {
  folder: Folder;
  run: (work: () => Promise<unknown>) => Promise<void>;
}) {
  const client = useQueryClient();
  const set = (body: Partial<Pick<Folder, "access" | "allow">>) =>
    run(async () => {
      const changed = await api.patch<Folder>(`/v1/folders/${folder.id}`, body);
      client.setQueryData<Folder[]>(keys.folders(), (all) =>
        (all ?? []).map((each) => (each.id === changed.id ? changed : each)),
      );
    });
  return (
    <footer className="flex flex-col gap-2 border-border-soft border-t px-4 py-3 text-[0.8125rem]">
      <label className="flex items-center gap-2.5">
        <input
          type="checkbox"
          checked={folder.access === "write"}
          onChange={(e) => void set({ access: e.target.checked ? "write" : "read" })}
        />
        <span>{t("browser.mayChange")}</span>
      </label>
      {folder.access === "write" ? (
        <label className="flex items-center gap-2.5">
          <input
            type="checkbox"
            checked={folder.allow === "always"}
            onChange={(e) => void set({ allow: e.target.checked ? "always" : "ask" })}
          />
          <span className="flex flex-col">
            <span>{t("browser.always")}</span>
            <span className="text-ink-3">{t("browser.alwaysHint")}</span>
          </span>
        </label>
      ) : null}
    </footer>
  );
}
