import type { ClientId, ClientSetupStatus } from "@engenty/model-setup";
import {
  ClientPanel,
  type KeyProvider,
  ModelTest,
  OwnKeys,
  SETUP_ON_THEME,
  type SetupChoice,
  SetupColumns,
  type SetupHostApi,
  SetupProvider,
  SetupReady,
  type SourceResult,
  useCall,
  useClientChoices,
  useClientStage,
  useSetupHost,
} from "@engenty/model-setup/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { EngentyKind, Setup, SetupCheck } from "@wizards-bot/protocol";
import { type ReactNode, useMemo, useState } from "react";
import { Engenty } from "../engenty/Engenty";
import { api } from "../lib/api";
import { lang, t, useLang } from "../lib/i18n";
import { keys } from "../lib/keys";
import { Button } from "../ui";
import { Pull } from "./Checks";
import { followTerminal } from "./terminal";

// What the wizards think with, as engenty wizards' studio asks it: the same page
// (@engenty/model-setup), on this Bot Server's routes and ground.

const LOCAL = "/v1/setup/local";
const CLIENTS = ["setup", "clients"] as const;
const PICK = ["setup", "pick"] as const;

/** Each choice has a figure of its own. */
const FIGURES: Record<string, EngentyKind> = {
  codex: "dome",
  claude: "oval",
  ollama: "pebble",
  own: "bean",
};

/** The gateways and providers a key is taken for. */
const PROVIDERS: Omit<KeyProvider, "stored">[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    keyUrl: "https://openrouter.ai/settings/keys",
    keyPlaceholder: "sk-or-…",
  },
  {
    id: "vercel",
    name: "Vercel AI Gateway",
    keyUrl: "https://vercel.com/dashboard/ai-gateway/api-keys",
    keyPlaceholder: "vck_…",
  },
  {
    id: "openai",
    name: "OpenAI",
    keyUrl: "https://platform.openai.com/api-keys",
    keyPlaceholder: "sk-…",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyPlaceholder: "sk-ant-…",
  },
];

interface Pick {
  source: string | null;
  keys: Record<string, boolean>;
}

const works = (check: SetupCheck | undefined) =>
  check?.state === "ok" || check?.state === "warning";

/** The app around the shared parts: its calls with this device's token, its language. */
function Host({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const shown = useLang();
  const host = useMemo<SetupHostApi>(
    () => ({
      lang: shown,
      post: (path, body) => api.post(`${LOCAL}${path}`, body ?? {}),
      put: (path, body) => api.put(`${LOCAL}${path}`, body),
      del: (path) => api.del(`${LOCAL}${path}`),
      follow: (terminal, on) => followTerminal(`${LOCAL}/terminal/${terminal}/stream`, on),
      open: (url) => window.open(url, "_blank", "noopener"),
      changed: () => client.invalidateQueries({ queryKey: keys.setup() }),
    }),
    [client, shown],
  );
  return <SetupProvider host={host}>{children}</SetupProvider>;
}

export function ModelStep({ setup }: { setup: Setup }) {
  return (
    <Host>
      <Sources setup={setup} />
    </Host>
  );
}

function Sources({ setup }: { setup: Setup }) {
  const client = useQueryClient();
  // Below the setup's own key: whatever tells the setup anew tells these too.
  const clients = useQuery({
    queryKey: [...keys.setup(), ...CLIENTS],
    queryFn: ({ signal }) =>
      api.get<{ clients: ClientSetupStatus<ClientId>[] }>(`${LOCAL}/clients`, signal),
  });
  const pick = useQuery({
    queryKey: [...keys.setup(), ...PICK],
    queryFn: ({ signal }) => api.get<Pick>(`${LOCAL}/models`, signal),
  });
  // Ollama and own keys are opened before they are picked: what they need comes first.
  const [opened, setOpened] = useState<"ollama" | "own" | null>(null);
  const [clicked, setClicked] = useState<string | null>(null);
  const found = clients.data?.clients ?? [];
  const clientChoices = useClientChoices(found);
  const ollama = setup.models.find((check) => check.id === "ollama");
  const source = pick.data?.source ?? null;
  const isKey = source !== null && PROVIDERS.some((provider) => provider.id === source);
  const selected = opened ?? (isKey ? "own" : source);
  const status = found.find((entry) => entry.id === selected);
  const ready = works(
    selected === "own"
      ? setup.models.find((check) => check.id === source && isKey)
      : source === selected
        ? setup.models.find((check) => check.id === selected)
        : undefined,
  );
  const stand = useClientStage(status, ready);
  const rescan = useCall(async () => {
    await Promise.all(found.map((entry) => api.post(`${LOCAL}/harness/${entry.id}/detect`, {})));
    await client.invalidateQueries({ queryKey: keys.setup() });
  });

  const choices: SetupChoice[] = [
    ...clientChoices,
    ...(ollama
      ? [
          {
            id: "ollama",
            title: "Ollama",
            description: t("setup.ollama.desc"),
            note: t(
              ollama.state === "absent" || ollama.state === "problem"
                ? `status.state.${ollama.state}`
                : "setup.ollama.here",
            ),
          },
        ]
      : []),
    { id: "own", title: t("setup.own.title"), description: t("setup.own.desc") },
  ];

  const choose = async (id: string) => {
    if (id === "ollama" || id === "own") {
      setOpened(id);
      return;
    }
    setClicked(id);
    try {
      await api.put(`${LOCAL}/models`, { source: id });
      await client.invalidateQueries({ queryKey: keys.setup() });
      setOpened(null);
    } finally {
      setClicked(null);
    }
  };

  const heading = ready
    ? stand.heading
    : selected === "own"
      ? t("setup.own.heading")
      : selected === "ollama"
        ? t("setup.ollama.use")
        : stand.heading;

  return (
    <div className="relative pt-6 lg:pt-[4vh]" style={SETUP_ON_THEME}>
      <SetupColumns
        title={t("setup.models.title")}
        sub={t("setup.models.subtitle")}
        choices={choices}
        selected={selected}
        marked={clicked ?? selected}
        onPick={choose}
        recheck={{ busy: rescan.busy, run: () => void rescan.run() }}
        panel={
          selected
            ? {
                name: choices.find((choice) => choice.id === selected)?.title ?? selected,
                heading,
                stage: ready ? 2 : selected === "own" || selected === "ollama" ? 0 : stand.stage,
                works: ready,
                figure: <Engenty kind={FIGURES[selected] ?? "round"} size={96} />,
                content: status ? (
                  <ClientPanel
                    key={status.id}
                    client={status}
                    autoTest={!ready}
                    hint={t("setup.client.hint", { name: status.name })}
                  />
                ) : selected === "ollama" ? (
                  <OllamaPanel check={ollama} ready={ready} />
                ) : (
                  <OwnKeys
                    providers={PROVIDERS.map((provider) => ({
                      ...provider,
                      stored: Boolean(pick.data?.keys[provider.id]),
                    }))}
                    isOf={(ref, provider) => ref.startsWith(`${provider}:`)}
                    modelName={(ref) => ref.slice(ref.indexOf(":") + 1)}
                    onRemove={(provider) =>
                      api.put(`${LOCAL}/models`, { keys: { [provider]: "" } })
                    }
                    hint={t("setup.own.hint")}
                    later={t("setup.own.later")}
                  />
                ),
                ...(ready ? { footer: <SetupReady /> } : {}),
              }
            : null
        }
      />
    </div>
  );
}

/** Ollama loads a model only once the person presses here: it takes much of the memory. */
function OllamaPanel({ check, ready }: { check: SetupCheck | undefined; ready: boolean }) {
  const host = useSetupHost();
  const use = useCall(async () => {
    const result = await host.post<SourceResult>("/ollama", { url: "http://127.0.0.1:11434" });
    await host.changed();
    return result;
  });
  if (!check) return null;
  const failed = use.error ?? (use.data && !use.data.ok ? (use.data.message ?? "") : undefined);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[0.875rem] text-ink-2 leading-relaxed">{check.said}</p>
      {check.todo && !ready ? <p className="text-[0.8125rem] text-ink-3">{check.todo}</p> : null}
      {check.start ? (
        <p className="text-[0.8125rem] text-ink-3">
          {t("setup.ollama.memory", {
            model: check.start.model,
            size: `${new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(check.start.size / 1e9)} GB`,
          })}
        </p>
      ) : null}
      {check.pull && !ready ? <Pull offer={check.pull} /> : null}
      {ready ? (
        <ModelTest />
      ) : check.start || check.on ? (
        <div>
          <Button busy={use.busy} onClick={() => void use.run()}>
            {t("setup.ollama.use")}
          </Button>
        </div>
      ) : null}
      {failed !== undefined ? <p className="text-[0.875rem] text-rose">{failed}</p> : null}
    </div>
  );
}
