import { useQueryClient } from "@tanstack/react-query";
import type { Folder, ModelService, ModelSource, Models, SecretEntry } from "@wizards-bot/protocol";
import {
  Activity,
  Folder as FolderIcon,
  FolderPlus,
  KeyRound,
  Palette,
  ShieldCheck,
  Sparkles,
  Unplug,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { keys } from "../lib/keys";
import { useFolders, useModels, useSecrets, useSetup } from "../lib/queries";
import { SetupStatus } from "../setup/Checks";
import { LangSwitch, ThemeSwitch } from "../setup/Frame";
import { Button, Chip, cn, Dialog, IconButton, Select } from "../ui";
import { PrivacyDialog, serviceLine } from "./ConsentDialog";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6 first:mt-0">
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
 * A secret of the home: what uses it and when it was set, never its value. It is changed in the
 * chat: the button hands the main agent the request, and the agent asks for a new key in a card
 * or removes what uses it.
 */
function SecretRow({
  secret,
  asker,
  onProblem,
}: {
  secret: SecretEntry;
  asker?: Asker;
  onProblem: (text: string) => void;
}) {
  const kind = t(`secrets.kind.${secret.kind}`);
  return (
    <li className="flex flex-wrap items-center gap-2 py-2.5">
      <span className="min-w-0 flex-1 text-[0.875rem]">
        <span className="block truncate font-medium">{secret.label}</span>
        <span className="block text-[0.75rem] text-ink-3">
          {kind} · {t("secrets.set", { date: new Date(secret.setAt).toLocaleDateString() })}
        </span>
      </span>
      {asker ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            asker
              .ask(t("secrets.changeAsk", { kind, label: secret.label }))
              .catch((err: Error) => onProblem(err.message))
          }
        >
          {t("secrets.change", { agent: asker.name })}
        </Button>
      ) : null}
    </li>
  );
}

/** The main agent, to hand a request from the settings to. */
export interface Asker {
  name: string;
  /** Says the text to the main agent in its chat, then shows that chat. */
  ask(text: string): Promise<void>;
}

/** The pages of the settings. */
type Page = "models" | "status" | "folders" | "secrets" | "look" | "privacy";

/**
 * What the home has around the agents: the connected folders and the models. Who the person is
 * and signing out are in the menu of their avatar.
 */
export function SettingsDialog({
  open,
  onFolder,
  asker,
  onClose,
}: {
  open: boolean;
  onFolder: () => void;
  asker?: Asker;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const folders = useFolders();
  const models = useModels();
  const setup = useSetup();
  const [problem, setProblem] = useState<string | null>(null);
  const [reads, setReads] = useState(false);
  const [page, setPage] = useState<Page>("models");
  const secrets = useSecrets(open && page === "secrets");
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
  const pages: { id: Page; icon: typeof Sparkles; label: string }[] = [
    { id: "models", icon: Sparkles, label: t("models.title") },
    { id: "status", icon: Activity, label: t("status.title") },
    { id: "folders", icon: FolderIcon, label: t("folders.title") },
    { id: "secrets", icon: KeyRound, label: t("settings.secrets") },
    { id: "look", icon: Palette, label: t("settings.look") },
    { id: "privacy", icon: ShieldCheck, label: t("settings.privacy") },
  ];
  return (
    <Dialog open={open} onClose={onClose} title={t("settings.title")} wide="settings">
      {/* Two columns: the pages at the left, the page at the right; on a phone the pages are a
          row of tabs above it. */}
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav
          aria-label={t("settings.title")}
          className="flex shrink-0 gap-0.5 overflow-x-auto p-2 sm:w-48 sm:flex-col sm:overflow-visible"
        >
          {pages.map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              type="button"
              aria-current={page === id ? "page" : undefined}
              onClick={() => setPage(id)}
              className={cn(
                "flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[0.875rem] transition",
                page === id ? "bg-accent font-medium text-ink" : "text-ink-2 hover:bg-accent/60",
              )}
            >
              <Icon className="size-4 shrink-0 text-ink-3" />
              {label}
            </button>
          ))}
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-3">
          {page === "models" ? (
            models.data?.sources.length ? (
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
            ) : null
          ) : page === "status" ? (
            setup.data ? (
              <Section title={t("status.title")}>
                <SetupStatus setup={setup.data} />
              </Section>
            ) : null
          ) : page === "folders" ? (
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
          ) : page === "secrets" ? (
            <Section title={t("settings.secrets")}>
              <p className="mb-2 text-[0.8125rem] text-ink-2 leading-relaxed">
                {t("secrets.intro")}
              </p>
              {secrets.data?.length ? (
                <ul className="divide-y divide-border-soft">
                  {secrets.data.map((secret) => (
                    <SecretRow
                      key={secret.name}
                      secret={secret}
                      asker={asker}
                      onProblem={setProblem}
                    />
                  ))}
                </ul>
              ) : secrets.data ? (
                <p className="text-[0.875rem] text-ink-2 leading-relaxed">{t("secrets.none")}</p>
              ) : null}
              {asker && secrets.data?.length ? (
                <p className="mt-2 text-[0.8125rem] text-ink-3 leading-relaxed">
                  {t("secrets.how", { agent: asker.name })}
                </p>
              ) : null}
              <p className="mt-3 text-[0.8125rem] text-ink-3 leading-relaxed">
                {t("secrets.personKey")}
              </p>
            </Section>
          ) : page === "look" ? (
            <Section title={t("settings.look")}>
              <div className="flex items-center justify-between gap-3 py-2">
                <span className="text-[0.875rem]">{t("theme.label")}</span>
                <ThemeSwitch />
              </div>
              <div className="flex items-center justify-between gap-3 py-2">
                <span className="text-[0.875rem]">{t("lang.label")}</span>
                <LangSwitch />
              </div>
            </Section>
          ) : (
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
          )}
          {(problem ?? folders.error ?? secrets.error) ? (
            <p role="alert" className="mt-3 text-[0.8125rem] text-rose">
              {problem ?? folders.error?.message ?? secrets.error?.message}
            </p>
          ) : null}
        </div>
      </div>
      <PrivacyDialog open={reads} onClose={() => setReads(false)} />
    </Dialog>
  );
}
