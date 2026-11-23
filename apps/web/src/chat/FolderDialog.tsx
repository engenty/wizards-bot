// The steps and their wording follow engenty wizards' MountDialog
// (apps/web/src/studio/space/Dateien.tsx).

import { useQueryClient } from "@tanstack/react-query";
import type { Folder, FolderListing, FolderPreview } from "@wizards-bot/protocol";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { formatBytes } from "../lib/files";
import { t } from "../lib/i18n";
import { keys } from "../lib/keys";
import { pickFolderOnMac } from "../lib/mac";
import { completions, separatorOf, trimmedPath } from "../lib/paths";
import { Button, Dialog, Input } from "../ui";

/**
 * Connects a folder of the home's computer in three steps: which folder (the folder dialog of
 * that computer, or its path where no dialog opens), what it holds, and whether the agents
 * only read it or also change it.
 */
export function FolderDialog({
  open,
  conversationId,
  onClose,
}: {
  open: boolean;
  /** The chat it is opened from: its agent is told when the folder is connected. */
  conversationId?: string;
  onClose: () => void;
}) {
  const client = useQueryClient();
  /** The path field is shown: no folder dialog opens, or the person would rather type. */
  const [typing, setTyping] = useState<"asked" | "noDialog" | null>(null);
  const [path, setPath] = useState("");
  const [suggest, setSuggest] = useState<FolderListing["folders"]>([]);
  const [found, setFound] = useState<FolderPreview | null>(null);
  const [access, setAccess] = useState<Folder["access"]>("read");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Ends the wait for the folder dialog when this dialog closes first. */
  const picking = useRef<AbortController | null>(null);
  const field = useRef<HTMLInputElement>(null);

  // Opened again, it starts anew.
  useEffect(() => {
    if (open) {
      setTyping(null);
      setPath("");
      setFound(null);
      setAccess("read");
      setError(null);
    }
    return () => picking.current?.abort();
  }, [open]);

  // Typing starts in the path field as soon as it is shown.
  const shown = Boolean(typing) && !found;
  useEffect(() => {
    if (shown) {
      field.current?.focus();
    }
  }, [shown]);

  // The path field completes folders as one types.
  useEffect(() => {
    if (!typing || found || !path.trim()) {
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
  }, [path, typing, found]);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const review = async (chosen: string) => {
    setFound(await api.post<FolderPreview>("/v1/folders/preview", { path: chosen }));
  };
  // The field starts at the person's home folder on that computer. Asked for while the folder
  // dialog is awaited (the person is not at that computer), it ends the wait.
  const type = async (why: "asked" | "noDialog") => {
    picking.current?.abort();
    setTyping(why);
    const start = await api.get<FolderListing>("/v1/folders/browse").catch(() => null);
    if (start) {
      setPath((typed) => typed || `${start.path}${separatorOf(start.path)}`);
    }
  };
  const choose = () =>
    run(async () => {
      const onMac = await pickFolderOnMac();
      if (onMac !== undefined) {
        if (onMac) {
          setPath(onMac);
          await review(onMac);
        }
        return;
      }
      const wait = new AbortController();
      picking.current = wait;
      const picked = await api
        .post<{ path: string | null; dialog: boolean }>("/v1/folders/pick", undefined, wait.signal)
        .catch((err: unknown) => {
          if (wait.signal.aborted) {
            return { path: null, dialog: true };
          }
          throw err;
        });
      if (!picked.dialog) {
        await type("noDialog");
      } else if (picked.path) {
        setPath(picked.path);
        await review(picked.path);
      }
    });
  const connect = (chosen: string) =>
    run(async () => {
      const folder = await api.post<Folder>("/v1/folders", {
        path: chosen,
        access,
        conversationId,
      });
      client.setQueryData<Folder[]>(keys.folders(), (folders) =>
        folders ? [...folders.filter((f) => f.id !== folder.id), folder] : folders,
      );
      onClose();
    });

  return (
    <Dialog open={open} onClose={onClose} title={t("composer.folder")}>
      {found ? (
        <div className="flex flex-1 flex-col gap-4">
          <div className="flex flex-col gap-1 text-[0.875rem] text-ink-2">
            <span className="truncate text-ink-3" title={found.path}>
              {found.path}
            </span>
            <span>
              {t("folder.files", { n: found.files })}
              {found.folders ? ` ${t("folder.inFolders", { n: found.folders })}` : null}
              {" · "}
              {formatBytes(found.bytes)}
              {found.more ? ` ${t("folder.more")}` : null}
            </span>
            <span>{t("folder.stays")}</span>
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 font-medium text-[0.875rem]">{t("folder.ask")}</legend>
            {(["read", "write"] as const).map((option) => (
              <label
                key={option}
                className="flex items-start gap-3 rounded-xl border border-input bg-card px-3.5 py-3 has-checked:border-ember has-checked:bg-ember-tint"
              >
                <input
                  type="radio"
                  name="folder-access"
                  className="mt-1 accent-(--ember)"
                  checked={access === option}
                  onChange={() => setAccess(option)}
                />
                <span className="flex flex-col">
                  <span className="font-medium text-[0.875rem] leading-snug">
                    {t(`folder.${option}`)}
                  </span>
                  <span className="text-[0.8125rem] text-ink-3 leading-snug">
                    {t(`folder.${option}Note`)}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          {error ? (
            <p role="alert" className="text-[0.875rem] text-rose">
              {error}
            </p>
          ) : null}
          <div className="mt-auto flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setFound(null)}>
              {t("common.back")}
            </Button>
            <Button busy={busy} onClick={() => void connect(found.path)}>
              {t("folder.connect")}
            </Button>
          </div>
        </div>
      ) : typing ? (
        <form
          className="flex flex-1 flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (path.trim()) {
              void run(() => review(trimmedPath(path)));
            }
          }}
        >
          {typing === "noDialog" ? (
            <p className="text-[0.875rem] text-ink-2 leading-relaxed">{t("folder.noDialog")}</p>
          ) : null}
          <div>
            <label htmlFor="folder-path" className="mb-1.5 block font-medium text-[0.875rem]">
              {t("folder.path")}
            </label>
            <Input
              id="folder-path"
              ref={field}
              value={path}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setPath(e.target.value)}
            />
            {suggest.length ? (
              <ul className="mt-1.5 max-h-48 overflow-y-auto rounded-lg bg-paper-2 p-1">
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
          </div>
          {error ? (
            <p role="alert" className="text-[0.875rem] text-rose">
              {error}
            </p>
          ) : null}
          <div className="mt-auto flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setTyping(null)}>
              {t("common.back")}
            </Button>
            <Button type="submit" busy={busy} disabled={!path.trim()}>
              {t("common.next")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-1 flex-col gap-4">
          <p className="text-[0.875rem] text-ink-2 leading-relaxed">{t("folder.lead")}</p>
          {busy ? (
            <p role="status" className="text-[0.875rem] text-ink-3">
              {t("folder.waiting")}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="text-[0.875rem] text-rose">
              {error}
            </p>
          ) : null}
          <div className="mt-auto flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => void type("asked")}>
              {t("folder.type")}
            </Button>
            <Button busy={busy} onClick={() => void choose()}>
              {t("folder.choose")}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
