import { useQueryClient } from "@tanstack/react-query";
import type { Card, Setup, SetupCheck } from "@wizards-bot/protocol";
import { KeyRound } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { CardView } from "../chat/CardView";
import { Engenty } from "../engenty/Engenty";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { keys } from "../lib/keys";
import { useItems } from "../lib/queries";
import { Button, cn, Select } from "../ui";
import { CheckList, Command, useTest } from "./Checks";
import { FoldersStep } from "./Folders";
import { Frame } from "./Frame";
import { ModelStep, PROVIDERS } from "./ModelStep";
import { ReachStep } from "./Reach";
import { canGoOn, type Step, stepsOf, testing, testOnOpen } from "./steps";

const GATEWAYS = PROVIDERS.map(({ id, name }) => ({ value: id, label: name }));

/** Where the setup stands: one dash per step, lit up to the one shown. */
function Dashes({ steps, at }: { steps: Step[]; at: number }) {
  return (
    <div
      className="flex items-center justify-center gap-1.5"
      role="img"
      aria-label={t("setup.step", { n: at + 1, total: steps.length })}
    >
      {steps.map((step, i) => (
        <span
          key={step}
          className={cn(
            "h-1.5 rounded-full transition-all",
            i === at ? "w-5 bg-ember" : "w-1.5",
            i < at && "bg-ember",
            i > at && "bg-paper-2",
          )}
        />
      ))}
    </div>
  );
}

/** What the setup says, as the first agent would say it in the chat. */
function Says({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <span className="mt-1 shrink-0">
        <Engenty kind="round" size={24} animated={false} />
      </span>
      <p className="rounded-2xl bg-card px-3.5 py-2.5 text-[0.9375rem] leading-relaxed">
        {children}
      </p>
    </div>
  );
}

/** A group of rows on a card, under a quiet label. */
function Group({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <section className="mt-3">
      {label ? <h3 className="mb-1.5 pl-0.5 text-[0.75rem] text-ink-3">{label}</h3> : null}
      <div className="rounded-xl bg-card px-3.5">{children}</div>
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

/** One way to a model that is set up by hand: what it is, and what to do. */
function Option({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="py-3">
      <p className="font-medium text-[0.9375rem]">{title}</p>
      <p className="mt-0.5 text-[0.8125rem] text-ink-3 leading-relaxed">{hint}</p>
      <div className="mt-2">{children}</div>
    </div>
  );
}

/** The command that links the person's computer, once they ask how. */
function LinkCommand({ command }: { command: string }) {
  const [shown, setShown] = useState(false);
  if (!shown) {
    return (
      <Button variant="secondary" size="sm" onClick={() => setShown(true)}>
        {t("setup.computer.show")}
      </Button>
    );
  }
  return (
    <>
      <p className="text-[0.8125rem] text-ink-3 leading-relaxed">{t("setup.computer.how")}</p>
      <Command text={command} />
    </>
  );
}

/** What the wizards can do besides writing, once it works: one quiet line each. */
function alsoCan(setup: Setup): string[] {
  const works = (id: string) => setup.capabilities.find((check) => check.id === id)?.state === "ok";
  return [
    ...(works("pictures") ? [t("setup.ability.pictures")] : []),
    ...(works("phone") ? [t("setup.ability.phone")] : []),
  ];
}

/** The options that are not a model of their own: a key, the person's computer. */
const OPTIONS = ["own-key", "link"];

/** A model on the home's own computer, or on a linked computer (`<computer>/<source>`). */
const onComputer = (check: SetupCheck) =>
  ["claude", "codex", "antigravity", "cursor", "ollama", "lmstudio", "mlx"].includes(check.id) ||
  check.id.includes("/");

/**
 * The first start of a home, as a short conversation: the person's name, which model answers
 * (each tested with a short call), the folders, and how the Bot Server is reached. It stands where the chat stands, not over
 * it. What it changes later goes through the main agent or the settings.
 */
export function SetupView({ setup }: { setup: Setup }) {
  const client = useQueryClient();
  const [steps] = useState(() => stepsOf(setup));
  const [at, setAt] = useState(0);
  const [name, setName] = useState(setup.name.value);
  const [own, setOwn] = useState(setup.ownFolder?.path ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const test = useTest(setProblem);
  const step = steps[at] ?? "models";
  const models = setup.models.filter((check) => !OPTIONS.includes(check.id));
  const here = models.filter(onComputer);
  const accounts = models.filter((check) => !onComputer(check));
  const link = setup.models.find((check) => check.id === "link");
  const last = at === steps.length - 1;
  /** The models stand in two columns over the whole width, as in engenty wizards. */
  const columns = step === "models" && !setup.hosted;

  // A hosted home's account is tested once when its step opens, if it never was. On the person's
  // computer they pick first, and the pick is tested.
  const tested = useRef(false);
  useEffect(() => {
    if (setup.hosted && step === "models" && !tested.current && testOnOpen(setup)) {
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
      if (step === "folders" && own) {
        // The agents' own folder: made when it is not there yet, and connected for changes.
        await api.post("/v1/folders", { path: own, access: "write", own: true });
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
      <Frame>
        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 pt-6 pb-6 sm:px-6">
          {steps.length > 1 ? <Dashes steps={steps} at={at} /> : null}

          <div className={cn("mt-6", !columns && "mx-auto w-full max-w-132")}>
            {step === "name" ? (
              <>
                <Says>{t("setup.name.title")}</Says>
                <form
                  className="mt-3 ml-[2.125rem] rounded-xl bg-card px-1.5 py-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (canGoOn("name", setup, name)) {
                      void next();
                    }
                  }}
                >
                  <input
                    aria-label={t("setup.name.label")}
                    value={name}
                    maxLength={80}
                    // biome-ignore lint/a11y/noAutofocus: the one field of this step
                    autoFocus
                    onChange={(e) => setName(e.target.value)}
                    className="w-full bg-transparent px-2 py-1.5 text-[0.9375rem] text-ink outline-none placeholder:text-ink-4"
                  />
                </form>
              </>
            ) : null}

            {step === "models" && !setup.hosted ? <ModelStep setup={setup} /> : null}

            {step === "models" && setup.hosted ? (
              <>
                <h1 className="font-display font-semibold text-[1.375rem] leading-tight">
                  {t("setup.models.title")}
                </h1>
                <p className="mt-1 text-[0.9375rem] text-ink-3">
                  {t("setup.models.subtitleHosted")}
                </p>
                {here.length ? (
                  <Group label={t("setup.models.here")}>
                    <CheckList checks={here} onTest={(source) => void test(source)} />
                  </Group>
                ) : null}
                <Group label={here.length ? t("setup.models.account") : undefined}>
                  {accounts.length ? (
                    <CheckList checks={accounts} onTest={(source) => void test(source)} />
                  ) : null}
                  <div className={cn(accounts.length > 0 && "border-border-soft border-t")}>
                    <Option title={t("setup.ownKey.title")} hint={t("setup.ownKey.hint")}>
                      <GatewayKey onProblem={setProblem} />
                    </Option>
                  </div>
                  {link?.command ? (
                    <div className="border-border-soft border-t">
                      <Option title={t("setup.computer.title")} hint={t("setup.computer.hint")}>
                        <LinkCommand command={link.command} />
                      </Option>
                    </div>
                  ) : null}
                </Group>
                {alsoCan(setup).map((line) => (
                  <p key={line} className="mt-2 text-[0.8125rem] text-ink-3">
                    {line}
                  </p>
                ))}
                {setup.working || testing(setup) ? null : (
                  <p role="status" className="mt-3 text-[0.8125rem] text-ink-3">
                    {t("setup.models.gate")}
                  </p>
                )}
              </>
            ) : null}

            {step === "folders" ? (
              <FoldersStep setup={setup} own={own} onOwn={setOwn} onProblem={setProblem} />
            ) : null}

            {step === "devices" ? <ReachStep setup={setup} onProblem={setProblem} /> : null}
          </div>

          {problem ? (
            <p
              role="alert"
              className={cn(
                "mt-4 text-[0.8125rem] text-rose",
                !columns && "mx-auto w-full max-w-132",
              )}
            >
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
      </Frame>
    </div>
  );
}
