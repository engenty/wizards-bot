import { useQueryClient } from "@tanstack/react-query";
import type { Card, Setup, SetupCheck } from "@wizards-bot/protocol";
import { ChevronDown, FolderPlus, KeyRound, Smartphone } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { CardView } from "../chat/CardView";
import { FolderDialog } from "../chat/FolderDialog";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { keys } from "../lib/keys";
import { useFolders, useItems } from "../lib/queries";
import { Button, cn, Input, Select } from "../ui";
import { QrCode } from "../ui/Qr";
import { CheckList, Command, TestAgain, useTest } from "./Checks";
import { Frame } from "./Frame";
import { canGoOn, type Step, stepsOf, testing, testOnOpen } from "./steps";

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

/** A code to add the phone, shown here only: a QR for the wizards.bot app, the address, the code. */
function AddPhone({ onProblem }: { onProblem: (text: string) => void }) {
  const [pairing, setPairing] = useState<{ address: string; code: string; link: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  if (pairing) {
    return (
      <div className="flex flex-wrap items-center gap-5">
        <QrCode text={pairing.link} label={t("setup.phone.qr")} />
        <dl className="min-w-0 text-[0.875rem]">
          <dt className="text-[0.75rem] text-ink-3">{t("setup.phone.address")}</dt>
          <dd className="break-all font-mono">{pairing.address}</dd>
          <dt className="mt-2 text-[0.75rem] text-ink-3">{t("setup.phone.code")}</dt>
          <dd className="font-mono font-medium text-[1.0625rem] tracking-widest">{pairing.code}</dd>
          <dd className="mt-2 text-[0.75rem] text-ink-3">{t("setup.phone.once")}</dd>
        </dl>
      </div>
    );
  }
  return (
    <Button
      variant="secondary"
      size="sm"
      busy={busy}
      onClick={() => {
        setBusy(true);
        api
          .post<{ address: string; code: string; link: string }>("/v1/setup/pairing", {})
          .then(setPairing, (err: Error) => {
            onProblem(err.message);
            setBusy(false);
          });
      }}
    >
      <Smartphone className="size-4" />
      {t("setup.phone.show")}
    </Button>
  );
}

/** What the setup offers besides the models that answer: a key, the person's computer. */
const OPTIONS = ["own-key", "link"];

/** A model source not on this computer and never tested: something to set up, not a state. */
const notHere = (check: SetupCheck) => check.state === "absent" && !check.at;

/** A quiet line that opens what else there is. */
function More({ open: start, children }: { open: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(start);
  return (
    <section className="mt-6">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex cursor-pointer items-center gap-1.5 font-medium text-[0.875rem] text-ink-2 transition hover:text-ink"
      >
        {t("setup.more")}
        <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
      </button>
      {open ? <div className="mt-1 divide-y divide-border-soft">{children}</div> : null}
    </section>
  );
}

function Option({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="py-3">
      <h3 className="font-medium text-[0.9375rem]">{title}</h3>
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
  // The models that answer, or could while none does, here; the rest is under "More options",
  // as a quiet hint: once one model answers, one that does not is no error.
  const sources = setup.models.filter((check) => !OPTIONS.includes(check.id));
  const ready = (check: SetupCheck) =>
    setup.working ? ["ok", "warning", "testing"].includes(check.state) : !notHere(check);
  const models = sources.filter(ready);
  const elsewhere = sources.filter((check) => !ready(check));
  const link = setup.models.find((check) => check.id === "link");
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
      <Frame>
        <main className="mx-auto flex w-full max-w-xl flex-1 flex-col px-4 pt-8 pb-8 sm:px-6">
          <div className="flex items-center gap-3">
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
                <Part
                  title={t("setup.models.title")}
                  hint={setup.hosted ? undefined : t("setup.models.hint")}
                >
                  <CheckList checks={models} onTest={(source) => void test(source)} />
                  {alsoCan(setup).map((line) => (
                    <p key={line} className="mt-1 text-[0.8125rem] text-ink-3">
                      {line}
                    </p>
                  ))}
                  {setup.hosted ? null : <TestAgain setup={setup} onTest={() => void test()} />}
                </Part>
                <More open={models.length === 0}>
                  {elsewhere.length ? (
                    <CheckList quiet checks={elsewhere} onTest={(source) => void test(source)} />
                  ) : null}
                  <Option title={t("setup.ownKey.title")} hint={t("setup.ownKey.hint")}>
                    <GatewayKey onProblem={setProblem} />
                  </Option>
                  {link?.command ? (
                    <Option title={t("setup.computer.title")} hint={t("setup.computer.hint")}>
                      <LinkCommand command={link.command} />
                    </Option>
                  ) : null}
                </More>
                {setup.working || testing(setup) ? null : (
                  <p role="status" className="mt-6 text-[0.8125rem] text-ink-3">
                    {t("setup.models.gate")}
                  </p>
                )}
              </>
            ) : null}

            {step === "devices" ? (
              <>
                <p className="mt-6 text-[0.8125rem] text-ink-3">
                  {t(setup.hosted ? "setup.devices.hintOne" : "setup.devices.hint")}
                </p>
                <Part title={t("setup.phone.title")} hint={t("setup.phone.hint")}>
                  <AddPhone onProblem={setProblem} />
                </Part>
                {setup.hosted ? null : (
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
                )}
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
      </Frame>
    </div>
  );
}
