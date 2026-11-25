import type { ClientId, ClientSetupStatus, ServerStatus } from "@engenty/model-setup";
import {
  ClientPanel,
  ModelTest,
  OwnKeys,
  SETUP_ON_THEME,
  type SetupChoice,
  Stages,
  useCall,
  useClientChoices,
  useClientStage,
  useServerChoices,
  useText,
} from "@engenty/model-setup/react";
import { useQueryClient } from "@tanstack/react-query";
import type { ModelSource, Models, Setup, SetupCheck } from "@wizards-bot/protocol";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { Engenty } from "../engenty/Engenty";
import { api } from "../lib/api";
import { lang, t } from "../lib/i18n";
import { keys } from "../lib/keys";
import {
  elsewhere,
  modelInUse,
  orderWithFirst,
  ownId,
  placeOf,
  type SourceRow,
  sourceRows,
  testResult,
  works,
} from "../lib/sources";
import { when } from "../lib/time";
import { CheckList, labelOf } from "../setup/Checks";
import {
  clientHint,
  FIGURES,
  Host,
  LOCAL,
  PROVIDERS,
  ServerPanel,
  useFound,
  usePick,
  useServer,
} from "../setup/ModelStep";
import { Button, Chip, cn, IconButton, Input } from "../ui";

// The models in the settings: the sources with what answers first, and one level down the parts
// of the setup for each (@engenty/model-setup).

/** What sets a server's address, or the folder of its models, where the Bot Server starts. */
const SET_WITH: Record<ServerStatus["id"], string> = {
  ollama: "OLLAMA_HOST",
  lmstudio: "LMSTUDIO_URL",
  mlx: "MLX_MODELS",
};

/** The choice that stands for every key of the person's own. */
const OWN = "own";

const modelName = (model: { id: string; label: string }) =>
  model.id === "default" ? t("models.default") : model.label;

/** A model ref as the person reads it. */
function refName(models: Models, ref: string): string {
  const source = models.sources.find((entry) => ref.startsWith(`${entry.id}:`));
  const model = source?.models.find((entry) => `${source.id}:${entry.id}` === ref);
  return model ? modelName(model) : ref.slice(ref.indexOf(":") + 1);
}

/**
 * The page "Models": the list, or the details of one source. `detail` is kept by the settings,
 * whose bar on a phone leads back from it.
 */
export function ModelSettings({
  models,
  setup,
  detail,
  onDetail,
  onProblem,
}: {
  models: Models;
  setup: Setup;
  detail: SourceRow | null;
  onDetail: (row: SourceRow | null) => void;
  onProblem: (text: string | null) => void;
}) {
  const client = useQueryClient();
  const id = detail?.id;
  const post = useCallback(
    async <T,>(path: string, body?: unknown): Promise<T> => {
      // The setup tests what is picked; here it is the source that is open.
      if (path === "/models/test" && id) {
        const started = Date.now();
        const next = await api.post<Setup>("/v1/setup/test", { source: id });
        client.setQueryData(keys.setup(), next);
        return testResult(next, id, Date.now() - started) as T;
      }
      // A key joins what answers already.
      const query = path.startsWith("/keys/") ? "?add" : "";
      return api.post<T>(`${LOCAL}${path}${query}`, body ?? {});
    },
    [client, id],
  );
  return (
    <Host post={post}>
      <Pages
        models={models}
        setup={setup}
        detail={detail}
        onDetail={onDetail}
        onProblem={onProblem}
      />
    </Host>
  );
}

function Pages({
  models,
  setup,
  detail,
  onDetail,
  onProblem,
}: Parameters<typeof ModelSettings>[0]) {
  // A hosted Bot Server has no computer to look at.
  const found = useFound(!setup.hosted);
  const clients = found.data?.clients ?? [];
  const servers = found.data?.servers ?? [];
  const clientChoices = useClientChoices(clients);
  const serverChoices = useServerChoices(servers);
  const choices: SetupChoice[] = setup.hosted
    ? []
    : [
        ...clientChoices,
        ...serverChoices,
        { id: OWN, title: t("setup.own.title"), description: t("setup.own.desc") },
      ];
  const rows = sourceRows(models, choices);
  // Kept while a source is open.
  const [more, setMore] = useState(false);
  // What the row says now: it may have come or gone since it was opened.
  const row = detail && [...rows.first, ...rows.rest].find((entry) => entry.id === detail.id);
  return row ? (
    <Details
      row={row}
      models={models}
      setup={setup}
      client={clients.find((entry) => entry.id === row.id)}
      server={servers.find((entry) => entry.id === row.id)}
      onBack={() => onDetail(null)}
    />
  ) : (
    <List
      models={models}
      rows={rows}
      more={more}
      onMore={setMore}
      onDetail={onDetail}
      onProblem={onProblem}
    />
  );
}

function List({
  models,
  rows,
  more,
  onMore,
  onDetail,
  onProblem,
}: {
  models: Models;
  rows: { first: SourceRow[]; rest: SourceRow[] };
  more: boolean;
  onMore: (more: boolean) => void;
  onDetail: (row: SourceRow) => void;
  onProblem: (text: string | null) => void;
}) {
  const client = useQueryClient();
  const said = useText();
  /** Puts a source first on its own model: the next message goes there, the rest stay behind it. */
  const choose = (source: ModelSource) => {
    const order = orderWithFirst(models, source);
    if (!order) {
      return;
    }
    onProblem(null);
    api.put<Models>("/v1/models/order", { order }).then(
      (view) => client.setQueryData(keys.models(), view),
      (err: Error) => onProblem(err.message),
    );
  };
  return (
    <>
      <fieldset className="flex min-w-0 flex-col gap-1">
        <legend className="sr-only">{t("models.choose")}</legend>
        {(more ? [...rows.first, ...rows.rest] : rows.first).map((row) => (
          <Row
            key={row.id}
            row={row}
            models={models}
            onChoose={choose}
            onOpen={() => onDetail(row)}
          />
        ))}
      </fieldset>
      {rows.rest.length ? (
        <div className="mt-1 flex justify-center">
          <Button variant="ghost" size="sm" aria-expanded={more} onClick={() => onMore(!more)}>
            <ChevronDown className={cn("size-3.5 transition-transform", more && "rotate-180")} />
            {said(more ? "setup.less" : "setup.more")}
          </Button>
        </div>
      ) : null}
      <p className="mt-2 text-[0.8125rem] text-ink-3 leading-relaxed">{t("models.chooseHint")}</p>
    </>
  );
}

/** A source: the radio puts it first, the arrow opens its details. */
function Row({
  row,
  models,
  onChoose,
  onOpen,
}: {
  row: SourceRow;
  models: Models;
  onChoose: (source: ModelSource) => void;
  onOpen: () => void;
}) {
  const { source, choice } = row;
  const on = Boolean(source && models.current?.startsWith(`${source.id}:`));
  const used = modelInUse(models, row.id);
  // Installed and signed out, it cannot answer.
  const ready = source?.online && !choice?.more;
  const state = source
    ? ready
      ? t("models.ready")
      : (source.online && choice?.note) || t("models.away")
    : choice?.note;
  const text = (
    <span className="min-w-0 flex-1">
      <span className="block truncate">
        <span className="font-medium">{row.name}</span>
        {source ? <span className="text-ink-3"> · {source.where}</span> : null}
      </span>
      <span className="block truncate text-[0.75rem] text-ink-3">
        {source && used
          ? refName(models, `${source.id}:${used}`)
          : source
            ? t("models.place.none")
            : choice?.description}
      </span>
    </span>
  );
  return (
    <div
      className={cn(
        "-mx-2 flex items-center rounded-xl pr-1 text-[0.875rem] transition hover:bg-accent/60",
        on && "bg-accent",
      )}
    >
      {source ? (
        <label
          className={cn(
            "flex min-w-0 flex-1 items-center gap-3 py-2 pl-2",
            source.online ? "cursor-pointer" : "opacity-60",
          )}
        >
          <input
            type="radio"
            name="model-source"
            checked={on}
            disabled={!source.online}
            onChange={() => onChoose(source)}
            className="size-4 shrink-0 accent-ember"
          />
          {text}
        </label>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-2 pl-2 text-left"
        >
          <span className="size-4 shrink-0" />
          {text}
        </button>
      )}
      <span className="mr-1 ml-2 shrink-0">
        {state ? <Chip tone={ready ? "live" : "neutral"}>{state}</Chip> : null}
      </span>
      <IconButton label={t("models.details", { name: row.name })} onClick={onOpen}>
        <ChevronRight className="size-4" />
      </IconButton>
    </div>
  );
}

/** One source: where it stands, its model, and what the setup shows of its kind. */
function Details({
  row,
  models,
  setup,
  client,
  server,
  onBack,
}: {
  row: SourceRow;
  models: Models;
  setup: Setup;
  client?: ClientSetupStatus<ClientId>;
  server?: ServerStatus;
  onBack: () => void;
}) {
  const said = useText();
  const check = setup.models.find((entry) => entry.id === row.id);
  const ready = works(check);
  const stand = useClientStage(client, ready);
  const away = elsewhere(row.id);
  const place = placeOf(models, row.id);
  const heading = ready
    ? stand.heading
    : row.id === OWN
      ? t("setup.own.heading")
      : server
        ? said(place < 0 ? "server.heading" : "setup.h.test")
        : stand.heading;
  return (
    <div style={SETUP_ON_THEME}>
      <button
        type="button"
        onClick={onBack}
        className="-ml-1.5 mb-3 inline-flex items-center gap-1 rounded-full py-1 pr-2 pl-1 text-[0.8125rem] text-ink-2 transition hover:bg-accent hover:text-ink max-sm:hidden"
      >
        <ChevronLeft className="size-4" />
        {t("models.title")}
      </button>
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          {away || row.id === OWN ? null : (
            <Stages
              name={row.name}
              at={ready ? 2 : client ? stand.stage : place < 0 && server ? 0 : 1}
              done={ready}
            />
          )}
          <h3
            className={cn(
              "font-display font-semibold text-[1.375rem] leading-tight tracking-[-0.02em]",
              !(away || row.id === OWN) && "mt-1.5",
            )}
          >
            {away ? row.name : heading}
          </h3>
          {row.source ? (
            <p className="mt-1 text-[0.8125rem] text-ink-3">
              {[
                row.source.where,
                t(
                  place < 0
                    ? "models.place.none"
                    : place === 0
                      ? "models.place.first"
                      : "models.place.then",
                ),
              ].join(" · ")}
            </p>
          ) : null}
        </div>
        <Engenty kind={FIGURES[figureOf(row)] ?? "round"} size={64} />
      </div>
      <div className="mt-5 flex flex-col gap-6">
        {check ? <LastTest check={check} /> : null}
        {away && row.source ? (
          <>
            <p className="text-[0.875rem] text-ink-2 leading-relaxed">
              {t("models.elsewhere", { where: row.source.where })}
            </p>
            <ModelChoice source={row.source} models={models} />
          </>
        ) : client ? (
          <>
            {row.source ? <ModelChoice source={row.source} models={models} /> : null}
            <ClientPanel key={client.id} client={client} hint={clientHint(client)} />
          </>
        ) : server ? (
          <Server server={server} models={models} />
        ) : row.id === OWN ? (
          <Keys models={models} hint={t("setup.own.hint")} />
        ) : row.source ? (
          <Gateway source={row.source} models={models} hosted={Boolean(setup.hosted)} />
        ) : null}
      </div>
    </div>
  );
}

/** The figure of a source: the setup's, also for one of a linked computer; a key's for a gateway. */
const figureOf = (row: SourceRow) => (row.source?.kind === "gateway" ? OWN : ownId(row.id));

function Part({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h4 className="text-[0.75rem] text-ink-3">{title}</h4>
      {children}
    </section>
  );
}

/** Chooses the model of a source: the source and the others keep their places. */
function useChooseModel(sourceId: string) {
  const client = useQueryClient();
  return async (model: string) => {
    const view = await api.put<Models>("/v1/models/source", { source: sourceId, model });
    client.setQueryData(keys.models(), view);
    await client.invalidateQueries({ queryKey: keys.setup() });
  };
}

/** The models of a source, the one that answers marked. `more`: another one can be named. */
function ModelChoice({
  source,
  models,
  more = false,
}: {
  source: ModelSource;
  models: Models;
  more?: boolean;
}) {
  const said = useText();
  const choose = useCall(useChooseModel(source.id));
  const [other, setOther] = useState("");
  const used = modelInUse(models, source.id);
  return (
    <Part title={t("models.model")}>
      <fieldset
        disabled={choose.busy || !source.online}
        className="flex min-w-0 flex-col divide-y divide-border-soft rounded-xl border border-border-soft disabled:opacity-60"
      >
        <legend className="sr-only">{t("models.model")}</legend>
        {source.models.map((model) => (
          <label
            key={model.id}
            className="flex cursor-pointer items-center gap-3 px-3 py-2.5 text-[0.875rem]"
          >
            <input
              type="radio"
              name={`model-of-${source.id}`}
              checked={model.id === used}
              onChange={() => void choose.run(model.id)}
              className="size-4 shrink-0 accent-ember"
            />
            <span className="min-w-0 flex-1 truncate">{modelName(model)}</span>
          </label>
        ))}
      </fieldset>
      {used ? null : <p className="text-[0.8125rem] text-ink-3">{t("models.joins")}</p>}
      {more ? (
        <form
          className="mt-1 flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void choose.run(other.trim()).then(() => setOther(""));
          }}
        >
          <Input
            value={other}
            aria-label={t("models.other", { name: source.label })}
            placeholder={t("models.other", { name: source.label })}
            onChange={(event) => setOther(event.target.value)}
            className="min-w-0 flex-1 font-mono text-[0.8125rem]"
          />
          <Button type="submit" variant="secondary" busy={choose.busy} disabled={!other.trim()}>
            {said("models.local.use")}
          </Button>
        </form>
      ) : null}
      {choose.error ? (
        <p role="alert" className="text-[0.8125rem] text-rose">
          {choose.error}
        </p>
      ) : null}
    </Part>
  );
}

/** A server for open models: the setup's panel, and where the server answers. */
function Server({ server, models }: { server: ServerStatus; models: Models }) {
  const state = useServer(server.id);
  const choose = useChooseModel(server.id);
  const url = state.data?.server.url;
  return (
    <>
      <ServerPanel
        server={server}
        model={modelInUse(models, server.id) ?? null}
        testFirst
        onChoose={choose}
      />
      {url ? (
        <Part title={t(server.id === "mlx" ? "models.folder" : "models.address")}>
          <p className="break-all font-mono text-[0.8125rem] text-ink-2">{url}</p>
          <p className="text-[0.75rem] text-ink-3">
            {t("models.fixed", { name: SET_WITH[server.id] })}
          </p>
        </Part>
      ) : null}
    </>
  );
}

/** The keys of the person's own, of every provider or of one. */
function Keys({ models, only, hint }: { models: Models; only?: string; hint: string }) {
  const pick = usePick();
  return (
    <OwnKeys
      providers={PROVIDERS.filter((provider) => !only || provider.id === only).map((provider) => ({
        ...provider,
        stored: Boolean(pick.data?.keys[provider.id]),
      }))}
      isOf={(ref, provider) => ref.startsWith(`${provider}:`)}
      modelName={(ref) => refName(models, ref)}
      onRemove={(provider) => api.put(`${LOCAL}/models`, { keys: { [provider]: "" } })}
      hint={hint}
    />
  );
}

/** A gateway or the account: its model, and its key where the setup takes it. */
function Gateway({
  source,
  models,
  hosted,
}: {
  source: ModelSource;
  models: Models;
  hosted: boolean;
}) {
  const account = source.id === "wizards";
  const key = !hosted && PROVIDERS.some((provider) => provider.id === source.id);
  return (
    <>
      <ModelChoice source={source} models={models} more={!account} />
      {key ? (
        <Keys models={models} only={source.id} hint={t("models.keyHint")} />
      ) : (
        <>
          {account ? null : <p className="text-[0.8125rem] text-ink-3">{t("models.keyInChat")}</p>}
          <ModelTest key={modelInUse(models, source.id)} />
        </>
      )}
    </>
  );
}

/** What the last test call came to, as the status page shows it. */
function LastTest({ check }: { check: SetupCheck }) {
  // One that was never tested has none; an Ollama in use can be put out of use.
  if (!(check.at || check.on || check.state === "testing")) {
    return null;
  }
  const title = check.at
    ? t("status.tested", { time: when(check.at, new Date(), lang) })
    : labelOf(check);
  return (
    <Part title={title}>
      <CheckList checks={[check]} />
    </Part>
  );
}
