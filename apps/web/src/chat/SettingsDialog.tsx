import { useQueryClient } from "@tanstack/react-query";
import type { Folder, ModelService, ModelSource, Models } from "@wizards-bot/protocol";
import { FolderPlus, Unplug } from "lucide-react";
import { type ReactNode, useState } from "react";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { keys } from "../lib/keys";
import { useFolders, useModels, useSetup } from "../lib/queries";
import { SetupStatus } from "../setup/Checks";
import { Button, Chip, cn, Dialog, IconButton, Select } from "../ui";
import { PrivacyDialog, serviceLine } from "./ConsentDialog";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h3 className="mb-2 font-medium text-[0.8125rem] text-ink-3">{title}</h3>
      {children}
    </section>
  );
}

/** A connected folder: its name and path, what the agents may do in it, and the way out. */
function FolderRow({ folder, onProblem }: { folder: Folder; onProblem: (text: string) => void }) {
  const client = useQueryClient();
  const [asking, setAsking] = useState(false);
  const change = (call: Promise<Folder[]>) =>
    call.then(
      (folders) => client.setQueryData(keys.folders(), folders),
      (err: Error) => onProblem(err.message),
    );
  const listed = () => client.getQueryData<Folder[]>(keys.folders()) ?? [];
  const setAccess = (access: Folder["access"]) =>
    change(
      api
        .patch<Folder>(`/v1/folders/${folder.id}`, { access })
        .then((changed) => listed().map((f) => (f.id === changed.id ? changed : f))),
    );
  const disconnect = () =>
    change(
      api.del(`/v1/folders/${folder.id}`).then(() => listed().filter((f) => f.id !== folder.id)),
    );
  if (asking) {
    return (
      <li className="flex flex-wrap items-center gap-2 py-2.5">
        <p className="min-w-48 flex-1 text-[0.875rem]">
          {t("folders.disconnectAsk", { name: folder.name })}
        </p>
        <Button variant="ghost" size="sm" onClick={() => setAsking(false)}>
          {t("common.cancel")}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void disconnect()}>
          {t("folders.disconnect")}
        </Button>
      </li>
    );
  }
  return (
    <li className="py-2.5">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate font-medium text-[0.9375rem]">{folder.name}</p>
        <Select
          className="w-40 shrink-0"
          label={t("folders.access", { name: folder.name })}
          value={folder.access}
          onChange={(access) => void setAccess(access as Folder["access"])}
          options={[
            { value: "read", label: t("folder.read") },
            { value: "write", label: t("folder.write") },
          ]}
        />
        <IconButton
          label={`${t("folders.disconnect")}: ${folder.name}`}
          onClick={() => setAsking(true)}
        >
          <Unplug className="size-4" />
        </IconButton>
      </div>
      <p className="mt-1 break-all text-[0.75rem] text-ink-3 leading-snug">{folder.path}</p>
    </li>
  );
}

/** A service the home's models send to: whether the person said yes, and the way to take it back. */
function ServiceRow({
  service,
  onModels,
  onProblem,
}: {
  service: ModelService;
  onModels: (models: Models) => void;
  onProblem: (text: string) => void;
}) {
  const takeBack = () =>
    api.del(`/v1/consent/${service.id}`).then(
      () => api.get<Models>("/v1/models").then(onModels),
      (err: Error) => onProblem(err.message),
    );
  return (
    <li className="flex items-center gap-2 py-2.5">
      <span className="min-w-0 flex-1 text-[0.875rem]">
        <span className="font-medium">{serviceLine(service)}</span>
        <span className="block text-[0.75rem] text-ink-3">
          {service.agreed
            ? t("consent.agreed", {
                device: service.agreed.by,
                date: new Date(service.agreed.at).toLocaleDateString(),
              })
            : t("consent.waiting")}
        </span>
      </span>
      {service.agreed ? (
        <Button variant="ghost" size="sm" onClick={() => void takeBack()}>
          {t("consent.takeBack")}
        </Button>
      ) : null}
    </li>
  );
}

/**
 * What the home has around the agents: the connected folders and the models. Who the person is
 * and signing out are in the menu of their avatar.
 */
export function SettingsDialog({
  open,
  onFolder,
  onClose,
}: {
  open: boolean;
  onFolder: () => void;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const folders = useFolders();
  const models = useModels();
  const setup = useSetup();
  const [problem, setProblem] = useState<string | null>(null);
  const [reads, setReads] = useState(false);
  const current = models.data?.current;
  const setModels = (view: Models) => client.setQueryData(keys.models(), view);
  /** Puts a source first: the next message goes to its first model, the rest stay behind it. */
  const choose = (source: ModelSource) => {
    const first = source.models[0];
    if (!(first && models.data)) {
      return;
    }
    const ref = `${source.id}:${first.id}`;
    const rest = models.data.order.filter((r) => !r.startsWith(`${source.id}:`));
    api.put<Models>("/v1/models/order", { order: [ref, ...rest] }).then(
      (view) => client.setQueryData(keys.models(), view),
      (err: Error) => setProblem(err.message),
    );
  };
  return (
    <Dialog open={open} onClose={onClose} title={t("settings.title")}>
      <Section title={t("folders.title")}>
        {folders.data?.length ? (
          <ul className="divide-y divide-border-soft">
            {folders.data.map((folder) => (
              <FolderRow key={folder.id} folder={folder} onProblem={setProblem} />
            ))}
          </ul>
        ) : folders.data ? (
          <p className="text-[0.875rem] text-ink-2 leading-relaxed">{t("folders.none")}</p>
        ) : null}
        <Button variant="secondary" size="sm" className="mt-3" onClick={onFolder}>
          <FolderPlus className="size-4" />
          {t("composer.folder")}
        </Button>
      </Section>
      {models.data?.sources.length ? (
        <Section title={t("models.title")}>
          <fieldset className="flex flex-col gap-1">
            <legend className="sr-only">{t("models.choose")}</legend>
            {models.data.sources.map((source) => {
              const on = Boolean(current?.startsWith(`${source.id}:`));
              return (
                <label
                  key={source.id}
                  className={cn(
                    "-mx-2 flex items-center gap-3 rounded-xl px-2 py-2 text-[0.875rem] transition",
                    source.online ? "cursor-pointer hover:bg-accent/60" : "opacity-60",
                    on && "bg-accent",
                  )}
                >
                  <input
                    type="radio"
                    name="model-source"
                    checked={on}
                    disabled={!source.online}
                    onChange={() => choose(source)}
                    className="size-4 shrink-0 accent-ember"
                  />
                  <span className="min-w-0 flex-1 truncate">
                    <span className="font-medium">{source.label}</span>
                    <span className="text-ink-3"> · {source.where}</span>
                  </span>
                  <Chip tone={source.online ? "live" : "neutral"}>
                    {t(source.online ? "models.ready" : "models.away")}
                  </Chip>
                </label>
              );
            })}
          </fieldset>
          <p className="mt-2 text-[0.8125rem] text-ink-3 leading-relaxed">
            {t("models.chooseHint")}
          </p>
        </Section>
      ) : null}
      {setup.data ? (
        <Section title={t("status.title")}>
          <SetupStatus setup={setup.data} />
        </Section>
      ) : null}
      <Section title={t("consent.title")}>
        {models.data?.services?.length ? (
          <ul className="divide-y divide-border-soft">
            {models.data.services.map((service) => (
              <ServiceRow
                key={service.id}
                service={service}
                onModels={setModels}
                onProblem={setProblem}
              />
            ))}
          </ul>
        ) : (
          <p className="text-[0.875rem] text-ink-2 leading-relaxed">{t("consent.none")}</p>
        )}
        <Button variant="secondary" size="sm" className="mt-3" onClick={() => setReads(true)}>
          {t("privacy.open")}
        </Button>
      </Section>
      <PrivacyDialog open={reads} onClose={() => setReads(false)} />
      {(problem ?? folders.error) ? (
        <p role="alert" className="mt-3 text-[0.8125rem] text-rose">
          {problem ?? folders.error?.message}
        </p>
      ) : null}
    </Dialog>
  );
}
