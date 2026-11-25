import { useQueryClient } from "@tanstack/react-query";
import type { Folder, Setup } from "@wizards-bot/protocol";
import { Eye, Folder as FolderIcon, Pencil, Plus, X } from "lucide-react";
import { useState } from "react";
import { FolderPicker, useFolderHome } from "../chat/FolderPicker";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { keys } from "../lib/keys";
import { tilde } from "../lib/paths";
import { useFolders } from "../lib/queries";
import { Button, cn, IconButton } from "../ui";

const HEADLINE = "font-display font-semibold text-[1.0625rem] leading-snug";

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

      <section className="mt-7">
        <h2 className={HEADLINE}>{t("setup.folders.own")}</h2>
        <p className="mt-0.5 mb-2.5 text-[0.8125rem] text-ink-3">{t("setup.folders.ownHint")}</p>
        <FolderPicker
          value={own}
          onChange={(path) => path && onOwn(path)}
          changeLabel={t("setup.folders.other")}
          hint={unmade ? t("setup.folders.made") : undefined}
        />
      </section>

      <section className="mt-7">
        <h2 className={HEADLINE}>{t("setup.folders.more")}</h2>
        {others.length ? (
          <ul className="mt-2.5 divide-y divide-border-soft rounded-xl bg-card px-3.5">
            {others.map((folder) => (
              <Row key={folder.id} folder={folder} home={home} onProblem={onProblem} />
            ))}
          </ul>
        ) : adding ? null : (
          <p className="mt-0.5 mb-2.5 text-[0.8125rem] text-ink-3">{t("setup.folders.none")}</p>
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

const ACCESS = [
  { access: "read", icon: Eye },
  { access: "write", icon: Pencil },
] as const satisfies readonly { access: Folder["access"]; icon: typeof Eye }[];

/** What the agents may do in a folder: two buttons side by side, a thumb slides to the pick. */
function AccessSwitch({
  folder,
  onPick,
}: {
  folder: Folder;
  onPick: (access: Folder["access"]) => void;
}) {
  return (
    <fieldset className="relative grid w-full grid-cols-2 rounded-full border-0 bg-paper p-0.5 sm:w-84">
      <legend className="sr-only">{t("folders.access", { name: folder.name })}</legend>
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-0.5 bottom-0.5 left-0.5 w-[calc(50%-0.125rem)] rounded-full bg-paper-2 shadow-sm transition-transform duration-200 motion-reduce:transition-none",
          folder.access === "write" && "translate-x-full",
        )}
      />
      {ACCESS.map(({ access, icon: Icon }) => (
        <label
          key={access}
          className={cn(
            "relative flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-full px-2 font-medium text-[0.8125rem] outline-focus transition-colors has-focus-visible:outline-2 coarse:h-11",
            access === folder.access ? "text-ink" : "text-ink-3 hover:text-ink",
          )}
        >
          <input
            type="radio"
            name={`access-${folder.id}`}
            className="sr-only"
            checked={access === folder.access}
            onChange={() => onPick(access)}
          />
          <Icon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{t(`folder.${access}`)}</span>
        </label>
      ))}
    </fieldset>
  );
}

/** A connected folder: its name and path from `~`, the way out, and what the agents may do. */
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
  const show = (changed: Folder) =>
    client.setQueryData(
      keys.folders(),
      listed().map((f) => (f.id === changed.id ? changed : f)),
    );
  // The pick shows at once; it goes back when the home does not take it.
  const setAccess = (access: Folder["access"]) => {
    show({ ...folder, access });
    api.patch<Folder>(`/v1/folders/${folder.id}`, { access }).then(show, (err: Error) => {
      show(folder);
      onProblem(err.message);
    });
  };
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
    <li className="py-3">
      <div className="flex items-center gap-3">
        <FolderIcon className="size-5 shrink-0 text-ember" aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium text-[0.9375rem] leading-snug">{folder.name}</span>
          <span className="truncate text-[0.8125rem] text-ink-3 leading-snug" title={folder.path}>
            {tilde(folder.path, home)}
          </span>
        </span>
        <IconButton
          label={`${t("setup.folders.remove")}: ${folder.name}`}
          className="-mr-2"
          onClick={() => void remove()}
        >
          <X className="size-4" />
        </IconButton>
      </div>
      <div className="mt-2.5 sm:pl-8">
        <AccessSwitch folder={folder} onPick={setAccess} />
        <p className="mt-1.5 text-[0.8125rem] text-ink-3 leading-snug">
          {t(`folder.${folder.access}Note`)}
        </p>
      </div>
    </li>
  );
}
