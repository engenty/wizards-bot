import { useQueryClient } from "@tanstack/react-query";
import type { Card, Setup } from "@wizards-bot/protocol";
import { FolderPlus, KeyRound, Smartphone } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { CardView } from "../chat/CardView";
import { FolderDialog } from "../chat/FolderDialog";
import { Engenty } from "../engenty/Engenty";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { keys } from "../lib/keys";
import { useFolders, useItems } from "../lib/queries";
import { Button, cn, Input, Select } from "../ui";
import { CheckList, TestAgain, useTest } from "./Checks";
import { canGoOn, type Step, stepsOf, testOnOpen } from "./steps";

const GATEWAYS = [
  { value: "openrouter", label: "OpenRouter" },
  { value: "vercel", label: "Vercel AI Gateway" },
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
];

/** Where the setup stands: one dash per step, green once passed, amber where it is now. */
function Dashes({ steps, at }: { steps: Step[]; at: number }) {
  return (
    <div className="flex items-center gap-1.5" aria-hidden="true">
      {steps.map((step, i) => (
        <span
          key={step}
          className={cn(
            "h-1 w-8 rounded-full transition-colors",
            i < at ? "bg-moss" : i === at ? "bg-ember" : "bg-paper-2",
          )}
        />
      ))}
    </div>
  );
}

function Part({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="mt-6">
      <h3 className="font-medium text-[0.9375rem]">{title}</h3>
      {hint ? <p className="mt-1 text-[0.8125rem] text-ink-3 leading-relaxed">{hint}</p> : null}
      <div className="mt-2">{children}</div>
    </section>
  );
}

/** A gateway's key card: the home puts it into the main agent's chat, and it shows here too. */
function GatewayKey({ onProblem }: { onProblem: (text: string) => void }) {
  const items = useItems();
  const [provider, setProvider] = useState("openrouter");
  const [card, setCard] = useState<Card | null>(null);
  const [busy, setBusy] = useState(false);
  const add = () => {
    setBusy(true);
    api.post<{ card: Card }>("/v1/setup/gateway", { provider }).then(
      (made) => {
        setCard(made.card);
        setBusy(false);
      },
      (err: Error) => {
        onProblem(err.message);
        setBusy(false);
      },
    );
  };
  // The card waits among what needs the person until it is answered; then it is gone from there.
  const open = card && items.data?.find((item) => item.id === card.id);
  if (card && open) {
    return <CardView card={open} />;
  }
  if (card) {
    return <p className="text-[0.875rem] text-ink-2">{t("setup.gateway.saved")}</p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        className="w-52"
        label={t("setup.gateway.choose")}
        value={provider}
        onChange={setProvider}
        options={GATEWAYS}
      />
      <Button variant="secondary" size="sm" busy={busy} onClick={add}>
        <KeyRound className="size-4" />
        {t("setup.gateway.add")}
      </Button>
    </div>
  );
}

/** The pairing card of the setup: a QR for the wizards.bot app, an address and a code. */
function AddPhone({ onProblem }: { onProblem: (text: string) => void }) {
  const [card, setCard] = useState<Card | null>(null);
  const [busy, setBusy] = useState(false);
  if (card) {
    return <CardView card={card} />;
  }
  return (
    <Button
      variant="secondary"
      size="sm"
      busy={busy}
      onClick={() => {
        setBusy(true);
        api.post<{ card: Card }>("/v1/setup/pairing", {}).then(
          (made) => setCard(made.card),
          (err: Error) => {
            onProblem(err.message);
            setBusy(false);
          },
        );
      }}
    >
      <Smartphone className="size-4" />
      {t("setup.phone.show")}
    </Button>
  );
}

/**
 * The first start of a home: who the person is, which model answers (tested with a short call
 * each), what the agents can do with it, and a phone and a folder. It stands where the chat
 * stands, not over it. What it changes later goes through the main agent or the settings.
 */
export function SetupView({ setup }: { setup: Setup }) {
  const client = useQueryClient();
  const folders = useFolders();
  const [steps] = useState(() => stepsOf(setup));
  const [at, setAt] = useState(0);
  const [name, setName] = useState(setup.name.value);
  const [busy, setBusy] = useState(false);
  const [folder, setFolder] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const test = useTest(setProblem);
  const step = steps[at] ?? "models";
  const last = at === steps.length - 1;

  // The models are tested once when their step opens, if they never were; later on request.
  const tested = useRef(false);
  useEffect(() => {
    if (step === "models" && !tested.current && testOnOpen(setup)) {
      tested.current = true;
      void test();
    }
  }, [step, setup, test]);

  const save = (change: { name?: string; done?: boolean }) =>
    api.patch<Setup>("/v1/setup", change).then((saved) => {
      client.setQueryData(keys.setup(), saved);
      return saved;
    });

  const next = async () => {
    setProblem(null);
    setBusy(true);
    try {
      if (step === "name") {
        await save({ name: name.trim() });
        void client.invalidateQueries({ queryKey: keys.home() });
      }
      if (last) {
        // The chat takes over once the home says the setup is done.
        await save({ done: true });
        return;
      }
      setAt(at + 1);
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-background">
      <main className="mx-auto flex min-h-full w-full max-w-xl flex-col px-4 pt-10 pb-8 sm:px-6">
        <div className="flex items-center gap-3">
          <Engenty kind="round" size={44} />
          <div className="min-w-0 flex-1">
            <h1 className="font-medium text-[1.125rem]">{t("setup.title")}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              <Dashes steps={steps} at={at} />
              <p className="text-[0.75rem] text-ink-3">
                {t("setup.step", { n: at + 1, total: steps.length })}
              </p>
            </div>
          </div>
        </div>

        <div>
          {step === "name" ? (
            <Part title={t("setup.name.title")} hint={t("setup.name.hint")}>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (canGoOn("name", setup, name)) {
                    void next();
                  }
                }}
              >
                <Input
                  aria-label={t("setup.name.label")}
                  value={name}
                  maxLength={80}
                  autoFocus
                  onChange={(e) => setName(e.target.value)}
                />
              </form>
            </Part>
          ) : null}

          {step === "models" ? (
            <>
              <Part title={t("setup.models.title")} hint={t("setup.models.hint")}>
                <CheckList checks={setup.models} onTest={(source) => void test(source)} />
                <TestAgain setup={setup} onTest={() => void test()} />
              </Part>
              <Part title={t("setup.gateway.title")} hint={t("setup.gateway.hint")}>
                <GatewayKey onProblem={setProblem} />
              </Part>
              <p
                role="status"
                className={cn(
                  "mt-6 rounded-xl px-4 py-3 text-[0.875rem]",
                  setup.working ? "bg-moss-tint text-moss" : "bg-paper-2 text-ink-2",
                )}
              >
                {t(setup.working ? "setup.models.working" : "setup.models.gate")}
              </p>
            </>
          ) : null}

          {step === "abilities" ? (
            <Part title={t("setup.abilities.title")} hint={t("setup.abilities.hint")}>
              <CheckList checks={setup.capabilities} />
            </Part>
          ) : null}

          {step === "devices" ? (
            <>
              <p className="mt-6 text-[0.8125rem] text-ink-3">{t("setup.devices.hint")}</p>
              <Part title={t("setup.phone.title")} hint={t("setup.phone.hint")}>
                <AddPhone onProblem={setProblem} />
              </Part>
              <Part title={t("setup.folder.title")} hint={t("setup.folder.hint")}>
                <div className="flex flex-wrap items-center gap-3">
                  <Button variant="secondary" size="sm" onClick={() => setFolder(true)}>
                    <FolderPlus className="size-4" />
                    {t("setup.folder.add")}
                  </Button>
                  {folders.data?.length ? (
                    <span className="text-[0.8125rem] text-ink-3">
                      {t("setup.folder.count", { n: folders.data.length })}
                    </span>
                  ) : null}
                </div>
              </Part>
              <FolderDialog open={folder} onClose={() => setFolder(false)} />
            </>
          ) : null}
        </div>

        {problem ? (
          <p role="alert" className="mt-4 text-[0.8125rem] text-rose">
            {problem}
          </p>
        ) : null}
        <div className="mt-8 flex items-center gap-2">
          {at > 0 ? (
            <Button variant="ghost" onClick={() => setAt(at - 1)}>
              {t("common.back")}
            </Button>
          ) : null}
          <span className="flex-1" />
          <Button busy={busy} disabled={!canGoOn(step, setup, name)} onClick={() => void next()}>
            {last ? t("setup.finish") : t("setup.next")}
          </Button>
        </div>
      </main>
    </div>
  );
}
