// The wording follows engenty wizards' MountDialog (apps/web/src/studio/space/Dateien.tsx).

import { useQueryClient } from "@tanstack/react-query";
import type { Folder } from "@wizards-bot/protocol";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { keys } from "../lib/keys";
import { Button, Dialog } from "../ui";
import { FolderPicker } from "./FolderPicker";

/**
 * Connects a folder of the home's computer: the folder, picked as on an agent's folder card,
 * and whether the agents only read it or also change it.
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
  const [path, setPath] = useState<string | undefined>();
  const [access, setAccess] = useState<Folder["access"]>("read");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Opened again, it starts anew.
  useEffect(() => {
    if (open) {
      setPath(undefined);
      setAccess("read");
      setError(null);
    }
  }, [open]);

  const connect = async (chosen: string) => {
    setBusy(true);
    setError(null);
    try {
      const folder = await api.post<Folder>("/v1/folders", {
        path: chosen,
        access,
        conversationId,
      });
      client.setQueryData<Folder[]>(keys.folders(), (folders) =>
        folders ? [...folders.filter((f) => f.id !== folder.id), folder] : folders,
      );
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t("composer.folder")}>
      <div className="flex flex-1 flex-col gap-4">
        <p className="text-[0.875rem] text-ink-2 leading-relaxed">{t("folder.lead")}</p>
        <FolderPicker value={path} onChange={setPath} />
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
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button busy={busy} disabled={!path} onClick={() => path && void connect(path)}>
            {t("folder.connect")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
