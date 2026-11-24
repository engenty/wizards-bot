import { useQueryClient } from "@tanstack/react-query";
import type { Folder, Setup } from "@wizards-bot/protocol";
import { Folder as FolderIcon, Plus, X } from "lucide-react";
import { useState } from "react";
import { FolderPicker, useFolderHome } from "../chat/FolderPicker";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { keys } from "../lib/keys";
import { tilde } from "../lib/paths";
import { useFolders } from "../lib/queries";
import { Button, IconButton, Select } from "../ui";

/**
 * The folders step of the first start: the agents' own folder, where they keep what they make
 * (`~/wizards` unless the person picks another; it is connected when the person goes on), and
 * any folders they may read or change. Those are connected at once, as everywhere else.
 */
export function FoldersStep({
  setup,
  own,
  onOwn,
  onProblem,
}: {
  setup: Setup;
  /** The path the agents' own folder gets when the person goes on. */
  own: string;
  onOwn: (path: string) => void;
  onProblem: (text: string) => void;
}) {
  const suggested = setup.ownFolder;
  const client = useQueryClient();
  const folders = useFolders();
  const home = useFolderHome().data?.home;
  const [adding, setAdding] = useState(false);
  const others = (folders.data ?? []).filter((folder) => !folder.own && folder.path !== own);
  const unmade = suggested && own === suggested.path && !suggested.exists;
  return (
    <>
      <h1 className="font-display font-semibold text-[1.375rem] leading-tight">
        {t("setup.folders.title")}
      </h1>
      <p className="mt-1 text-[0.9375rem] text-ink-3">{t("setup.folders.subtitle")}</p>

      <section className="mt-5">
        <h3 className="pl-0.5 text-[0.75rem] text-ink-3">{t("setup.folders.own")}</h3>
        <p className="mb-1.5 pl-0.5 text-[0.8125rem] text-ink-3">{t("setup.folders.ownHint")}</p>
        <FolderPicker
          value={own}
          onChange={(path) => path && onOwn(path)}
          changeLabel={t("setup.folders.other")}
          hint={unmade ? t("setup.folders.made") : undefined}
        />
      </section>

      <section className="mt-5">
        <h3 className="mb-1.5 pl-0.5 text-[0.75rem] text-ink-3">{t("setup.folders.more")}</h3>
        {others.length ? (
          <ul className="divide-y divide-border-soft rounded-xl bg-card px-3.5">
            {others.map((folder) => (
              <Row key={folder.id} folder={folder} home={home} onProblem={onProblem} />
            ))}
          </ul>
        ) : adding ? null : (
          <p className="mb-2 pl-0.5 text-[0.8125rem] text-ink-3">{t("setup.folders.none")}</p>
        )}
        {adding ? (
          <div className="mt-2">
            <FolderPicker
              value={undefined}
              startOpen
              onCancel={() => setAdding(false)}
              onChange={(path) => {
                setAdding(false);
                if (path) {
                  void connect(path);
                }
              }}
            />
          </div>
        ) : (
          <Button variant="secondary" size="sm" className="mt-2" onClick={() => setAdding(true)}>
            <Plus className="size-4" />
            {t("setup.folders.add")}
          </Button>
        )}
      </section>
    </>
  );

  function connect(path: string) {
    return api.post<Folder>("/v1/folders", { path, access: "read" }).then(
      (folder) =>
        client.setQueryData<Folder[]>(keys.folders(), (list) => [
          ...(list ?? []).filter((each) => each.id !== folder.id),
          folder,
        ]),
      (err: Error) => onProblem(err.message),
    );
  }
}

/** A connected folder: its name and path from `~`, what the agents may do, and the way out. */
function Row({
  folder,
  home,
  onProblem,
}: {
  folder: Folder;
  home: string | undefined;
  onProblem: (text: string) => void;
}) {
  const client = useQueryClient();
  const listed = () => client.getQueryData<Folder[]>(keys.folders()) ?? [];
  const setAccess = (access: Folder["access"]) =>
    api.patch<Folder>(`/v1/folders/${folder.id}`, { access }).then(
      (changed) =>
        client.setQueryData(
          keys.folders(),
          listed().map((f) => (f.id === changed.id ? changed : f)),
        ),
      (err: Error) => onProblem(err.message),
    );
  const remove = () =>
    api.del(`/v1/folders/${folder.id}`).then(
      () =>
        client.setQueryData(
          keys.folders(),
          listed().filter((f) => f.id !== folder.id),
        ),
      (err: Error) => onProblem(err.message),
    );
  return (
    <li className="flex items-center gap-3 py-2.5">
      <FolderIcon className="size-5 shrink-0 text-ember" aria-hidden="true" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-[0.9375rem] leading-snug">{folder.name}</span>
        <span className="truncate text-[0.8125rem] text-ink-3 leading-snug" title={folder.path}>
          {tilde(folder.path, home)}
        </span>
      </span>
      <Select
        className="w-48 shrink-0"
        label={t("folders.access", { name: folder.name })}
        value={folder.access}
        onChange={(access) => void setAccess(access as Folder["access"])}
        options={[
          { value: "read", label: t("folder.read") },
          { value: "write", label: t("folder.write") },
        ]}
      />
      <IconButton
        label={`${t("setup.folders.remove")}: ${folder.name}`}
        onClick={() => void remove()}
      >
        <X className="size-4" />
      </IconButton>
    </li>
  );
}
