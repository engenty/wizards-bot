import { useQueryClient } from "@tanstack/react-query";
import type {
  Folder,
  ModelService,
  ModelSource,
  Models,
  Plugin,
  PluginsView,
  SecretEntry,
} from "@wizards-bot/protocol";
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  Folder as FolderIcon,
  FolderPlus,
  KeyRound,
  LockKeyhole,
  Palette,
  Puzzle,
  ShieldCheck,
  Sparkles,
  Unplug,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { keys } from "../lib/keys";
import { useFolders, useModels, usePlugins, useSecrets, useSetup } from "../lib/queries";
import { SetupStatus } from "../setup/Checks";
import { LangSwitch, ThemeSwitch } from "../setup/Frame";
import { Button, Chip, cn, Dialog, IconButton, Select } from "../ui";
import { PrivacyDialog, serviceLine } from "./ConsentDialog";
import { VaultSettings } from "./Vault";

/** A page of the settings. Its name is in the list of pages (on a phone, in the bar above). */
function Section({ children }: { children: ReactNode }) {
  return <section>{children}</section>;
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
export function SecretRow({
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

/** A plugin: what it brings, and its switch. Switching it on starts its tools' process. */
function PluginRow({ plugin, onProblem }: { plugin: Plugin; onProblem: (text: string) => void }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const toggle = (on: boolean) => {
    setBusy(true);
    api
      .patch<PluginsView>(`/v1/plugins/${plugin.id}`, { on })
      .then(
        (view) => client.setQueryData(keys.plugins(), view),
        (err: Error) => onProblem(err.message),
      )
      .finally(() => setBusy(false));
  };
  const names = (list: { name: string }[]) => list.map((each) => each.name).join(", ");
  return (
    <li className="py-2.5">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-[0.9375rem]">
          <span className="font-medium">{plugin.name}</span>
          <span className="text-ink-3"> · {plugin.version}</span>
        </p>
        {plugin.on ? (
          <Chip tone={plugin.state === "ready" ? "live" : "neutral"}>
            {t(`plugins.${plugin.state === "off" ? "ready" : plugin.state}`)}
          </Chip>
        ) : null}
        <input
          type="checkbox"
          role="switch"
          aria-checked={plugin.on}
          aria-label={t("plugins.on", { name: plugin.name })}
          checked={plugin.on}
          disabled={busy}
          onChange={(event) => toggle(event.target.checked)}
          className="size-4 shrink-0 cursor-pointer accent-ember"
        />
      </div>
      {plugin.description ? (
        <p className="mt-1 text-[0.8125rem] text-ink-2 leading-snug">{plugin.description}</p>
      ) : null}
      {plugin.problem ? (
        <p className="mt-1 text-[0.75rem] text-rose leading-snug">{plugin.problem}</p>
      ) : null}
      {plugin.skills.length ? (
        <p className="mt-1 text-[0.75rem] text-ink-3 leading-snug">
          {t("plugins.skills", { names: names(plugin.skills) })}
        </p>
      ) : null}
      {plugin.tools.length ? (
        <p className="mt-0.5 text-[0.75rem] text-ink-3 leading-snug">
          {t("plugins.tools", {
            names: plugin.tools
              .map((tool) => (tool.readOnly ? tool.name : `${tool.name} (${t("plugins.asks")})`))
              .join(", "),
          })}
        </p>
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
type Page = "models" | "status" | "folders" | "vault" | "secrets" | "plugins" | "look" | "privacy";

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
  const plugins = usePlugins();
  const models = useModels();
  const setup = useSetup();
  const [problem, setProblem] = useState<string | null>(null);
  const [reads, setReads] = useState(false);
  const [page, setPage] = useState<Page>("models");
  /** On a phone: whether a page is open, one level below the list of pages. */
  const [inside, setInside] = useState(false);
  // Opened again, a phone starts at the list of pages.
  useEffect(() => {
    if (open) setInside(false);
  }, [open]);
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
    { id: "vault", icon: LockKeyhole, label: t("vault.title") },
    { id: "secrets", icon: KeyRound, label: t("settings.secrets") },
    { id: "plugins", icon: Puzzle, label: t("plugins.title") },
    { id: "look", icon: Palette, label: t("settings.look") },
    { id: "privacy", icon: ShieldCheck, label: t("settings.privacy") },
  ];
  const here = pages.find((p) => p.id === page);
  // On a phone the settings are a menu: a page slides in one level down, with the way back and
  // its name in the bar; beside it, from the width of a tablet, the list stays at the left.
  const title = (
    <span className="flex min-w-0 items-center gap-1">
      {inside ? (
        <IconButton
          label={t("common.back")}
          onClick={() => setInside(false)}
          className="size-8 sm:hidden coarse:size-9"
        >
          <ChevronLeft className="size-4" />
        </IconButton>
      ) : null}
      <span className={cn("truncate", inside && "max-sm:hidden")}>{t("settings.title")}</span>
      {inside ? <span className="truncate sm:hidden">{here?.label}</span> : null}
    </span>
  );
  return (
    <Dialog open={open} onClose={onClose} title={title} wide="settings">
      <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
        <nav
          aria-label={t("settings.title")}
          className={cn(
            "flex shrink-0 flex-col gap-0.5 overflow-y-auto p-2 sm:w-48",
            inside ? "max-sm:hidden" : "enter-back max-sm:flex-1",
          )}
        >
          {pages.map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              type="button"
              aria-current={page === id ? "page" : undefined}
              onClick={() => {
                setPage(id);
                setInside(true);
              }}
              className={cn(
                "flex shrink-0 items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[0.875rem] transition max-sm:py-2.5 max-sm:text-[0.9375rem]",
                page === id
                  ? "text-ink sm:bg-accent sm:font-medium"
                  : "text-ink-2 hover:bg-accent/60",
              )}
            >
              <Icon className="size-4 shrink-0 text-ink-3" />
              <span className="flex-1">{label}</span>
              <ChevronRight className="size-4 shrink-0 text-ink-4 sm:hidden" />
            </button>
          ))}
        </nav>
        <div
          key={page}
          className={cn(
            "min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-3",
            inside ? "enter-deeper" : "max-sm:hidden",
          )}
        >
          {page === "models" ? (
            models.data?.sources.length ? (
              <Section>
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
              <Section>
                <SetupStatus setup={setup.data} />
              </Section>
            ) : null
          ) : page === "folders" ? (
            <Section>
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
          ) : page === "vault" ? (
            <Section>
              <VaultSettings />
            </Section>
          ) : page === "secrets" ? (
            <Section>
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
          ) : page === "plugins" ? (
            <Section>
              {plugins.data ? (
                <>
                  <p className="text-[0.8125rem] text-ink-2 leading-relaxed">{t("plugins.lead")}</p>
                  <p className="mt-1 break-all font-mono text-[0.75rem] text-ink-3">
                    {plugins.data.folder}
                  </p>
                  {plugins.data.plugins.length ? (
                    <ul className="mt-2 divide-y divide-border-soft">
                      {plugins.data.plugins.map((plugin) => (
                        <PluginRow key={plugin.id} plugin={plugin} onProblem={setProblem} />
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-3 text-[0.875rem] text-ink-2">{t("plugins.none")}</p>
                  )}
                  <p className="mt-3 text-[0.8125rem] text-ink-3 leading-relaxed">
                    {t("plugins.rights")}
                  </p>
                  {plugins.data.problems.length ? (
                    <>
                      <h4 className="mt-4 mb-1 font-medium text-[0.8125rem] text-ink-3">
                        {t("plugins.notPlugins")}
                      </h4>
                      <ul className="flex flex-col gap-1">
                        {plugins.data.problems.map((problem) => (
                          <li key={problem.path} className="text-[0.75rem] text-ink-3 leading-snug">
                            <span className="break-all">{problem.path}</span>: {problem.message}
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </>
              ) : null}
            </Section>
          ) : page === "look" ? (
            <Section>
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
            <Section>
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
          {(problem ?? folders.error ?? secrets.error ?? plugins.error) ? (
            <p role="alert" className="mt-3 text-[0.8125rem] text-rose">
              {problem ??
                folders.error?.message ??
                secrets.error?.message ??
                plugins.error?.message}
            </p>
          ) : null}
        </div>
      </div>
      <PrivacyDialog open={reads} onClose={() => setReads(false)} />
    </Dialog>
  );
}
