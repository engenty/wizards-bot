import { useQueryClient } from "@tanstack/react-query";
import type { Setup, SetupCheck } from "@wizards-bot/protocol";
import {
  AlertTriangle,
  Check,
  Circle,
  CircleHelp,
  Copy,
  Download,
  RotateCw,
  X,
} from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { lang, t } from "../lib/i18n";
import { keys } from "../lib/keys";
import { useSetup } from "../lib/queries";
import { when } from "../lib/time";
import { Button, cn, IconButton, Spinner } from "../ui";
import { testable, testedAt, testing } from "./steps";

const ICONS: Record<SetupCheck["state"], React.ReactNode> = {
  ok: <Check className="size-4 text-moss" />,
  warning: <AlertTriangle className="size-4 text-ember-strong" />,
  problem: <X className="size-4 text-rose" />,
  absent: <Circle className="size-3.5 text-ink-4" />,
  untested: <CircleHelp className="size-4 text-ink-4" />,
  testing: <Spinner className="size-4 text-ink-3" />,
};

/** A command for a terminal on the home's computer, with a way to copy it. */
export function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  return (
    <div className="mt-1.5 flex max-w-full items-center gap-1 rounded-lg bg-paper-2 py-0.5 pr-0.5 pl-3">
      <code className="min-w-0 flex-1 truncate font-mono text-[0.8125rem] text-ink">{text}</code>
      <IconButton label={copied ? t("setup.copied") : t("setup.copy")} onClick={() => void copy()}>
        {copied ? <Check className="size-4 text-moss" /> : <Copy className="size-4" />}
      </IconButton>
    </div>
  );
}

/** The hosted Bot Server's checks, in the language shown: the Bot Server words them in English. */
const ACCOUNT = "wizards";

export function labelOf(check: SetupCheck): string {
  if (check.id === "own-key") {
    return t("setup.ownKey.title");
  }
  if (check.id === "link") {
    return t("setup.computer.title");
  }
  return check.id === ACCOUNT ? t("setup.account.label") : check.label;
}

function saidOf(check: SetupCheck): { said: string; detail?: string } {
  if (check.id === "own-key") {
    return { said: t("setup.ownKey.hint") };
  }
  if (check.id === "link") {
    return { said: t("setup.computer.hint"), detail: t("setup.computer.how") };
  }
  if (check.id !== ACCOUNT) {
    return { said: check.said, detail: check.todo };
  }
  if (check.state === "ok" || check.state === "warning") {
    return { said: t("setup.account.ok") };
  }
  if (check.state === "problem") {
    // What the gateway said is the one way to tell no credits from a refused key.
    return { said: t("setup.account.problem"), detail: check.said };
  }
  return { said: t(check.state === "testing" ? "setup.testing" : "setup.account.untested") };
}

/** One check: what was found and, while it is not fine, what to do. */
function CheckRow({
  check,
  onTest,
  quiet,
}: {
  check: SetupCheck;
  onTest?: (source: string) => void;
  quiet?: boolean;
}) {
  const fine = check.state === "ok";
  const { said, detail } = saidOf(check);
  return (
    <li className="flex gap-3 py-3">
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center">
        {quiet ? ICONS.absent : ICONS[check.state]}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <p className="min-w-0 flex-1 font-medium text-[0.9375rem]">{labelOf(check)}</p>
          <span
            hidden={quiet}
            className={cn(
              "shrink-0 text-[0.75rem]",
              check.state === "ok" && "text-moss",
              check.state === "problem" && "text-rose",
              check.state === "warning" && "text-ember-strong",
              !["ok", "problem", "warning"].includes(check.state) && "text-ink-3",
            )}
          >
            {t(check.start ? "status.state.off" : `status.state.${check.state}`)}
          </span>
        </div>
        <p className="mt-0.5 break-words text-[0.875rem] text-ink-2 leading-snug">{said}</p>
        {detail && !fine ? (
          <p className="mt-1 text-[0.8125rem] text-ink-3 leading-snug">{detail}</p>
        ) : null}
        {check.command && !fine ? <Command text={check.command} /> : null}
        {check.pull && !fine ? <Pull offer={check.pull} /> : null}
        {check.id === "ollama" ? <UseOllama check={check} /> : null}
        {onTest && check.source && testable(check) && check.state !== "ok" ? (
          <Button
            variant="ghost"
            size="sm"
            className="-ml-3 mt-1"
            onClick={() => onTest(check.source as string)}
          >
            <RotateCw className="size-3.5" />
            {t("setup.test")}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

const gb = (bytes: number) =>
  `${new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(bytes / 1e9)} GB`;

/**
 * Ollama is used only once the person says so here: its model takes much of the computer's
 * memory while it is loaded. The same place takes it back.
 */
function UseOllama({ check }: { check: SetupCheck }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const set = (on: boolean) => {
    setProblem(null);
    setBusy(true);
    api
      .post<Setup>("/v1/setup/ollama", { on })
      .then(
        (next) => client.setQueryData(keys.setup(), next),
        (err: Error) => setProblem(err.message),
      )
      .finally(() => setBusy(false));
  };
  return (
    <>
      {check.start ? (
        <>
          <p className="mt-1 text-[0.8125rem] text-ink-3 leading-snug">
            {t("setup.ollama.memory", { model: check.start.model, size: gb(check.start.size) })}
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-1.5"
            busy={busy}
            onClick={() => set(true)}
          >
            {t("setup.ollama.use")}
          </Button>
        </>
      ) : check.on && check.state !== "testing" ? (
        <Button
          variant="ghost"
          size="sm"
          className="-ml-3 mt-1"
          busy={busy}
          onClick={() => set(false)}
        >
          {t("setup.ollama.stop")}
        </Button>
      ) : null}
      {problem ? (
        <p role="alert" className="mt-1 text-[0.8125rem] text-rose">
          {problem}
        </p>
      ) : null}
    </>
  );
}

/**
 * A model the Bot Server pulls into Ollama on its own computer, on a click, with how far it is.
 * When it is done the Bot Server tests Ollama again.
 */
function Pull({ offer }: { offer: NonNullable<SetupCheck["pull"]> }) {
  const client = useQueryClient();
  const { data: setup } = useSetup();
  const [problem, setProblem] = useState<string | null>(null);
  const pulling = setup?.pulling?.model === offer.model ? setup.pulling : undefined;
  const start = () => {
    setProblem(null);
    api.post<Setup>("/v1/setup/pull", { model: offer.model }).then(
      (next) => client.setQueryData(keys.setup(), next),
      (err: Error) => setProblem(err.message),
    );
  };
  if (pulling?.state === "pulling") {
    const share = pulling.total ? Math.floor((pulling.done / pulling.total) * 100) : 0;
    return (
      <div className="mt-2 max-w-sm">
        <p className="text-[0.8125rem] text-ink-2">
          {t("setup.pull.loading", { model: offer.model, percent: share })}
        </p>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-paper-2">
          <div
            className="h-full rounded-full bg-moss transition-[width]"
            style={{ width: `${share}%` }}
          />
        </div>
      </div>
    );
  }
  return (
    <div className="mt-1.5">
      <Button variant="secondary" size="sm" onClick={start}>
        <Download className="size-3.5" />
        {t("setup.pull.button", { model: offer.model, size: gb(offer.size) })}
      </Button>
      {pulling?.state === "failed" || problem ? (
        <p role="alert" className="mt-1 text-[0.8125rem] text-rose">
          {t("setup.pull.failed", { why: problem ?? pulling?.error ?? "" })}
        </p>
      ) : null}
    </div>
  );
}

/** `quiet`: a hint, not a state; one model answers already. */
export function CheckList({
  checks,
  onTest,
  quiet,
}: {
  checks: SetupCheck[];
  onTest?: (source: string) => void;
  quiet?: boolean;
}) {
  return (
    <ul className="divide-y divide-border-soft">
      {checks.map((check) => (
        <CheckRow key={check.id} check={check} onTest={onTest} quiet={quiet} />
      ))}
    </ul>
  );
}

/**
 * Makes test calls again, all or one, and keeps what the home answers. The event of each
 * finished call arrives as well; this keeps the page right where the stream is late.
 */
export function useTest(onProblem: (text: string) => void) {
  const client = useQueryClient();
  return (source?: string) =>
    api.post<Setup>("/v1/setup/test", source ? { source } : {}).then(
      (setup) => client.setQueryData(keys.setup(), setup),
      (err: Error) => onProblem(err.message),
    );
}

/** "Test again" for all models, and when they were tested last. */
export function TestAgain({ setup, onTest }: { setup: Setup; onTest: () => void }) {
  const at = testedAt(setup);
  const busy = testing(setup);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-3">
      <Button variant="secondary" size="sm" busy={busy} onClick={onTest}>
        {busy ? null : <RotateCw className="size-3.5" />}
        {busy ? t("setup.testing") : t("setup.testAll")}
      </Button>
      {at && !busy ? (
        <span className="text-[0.75rem] text-ink-3">
          {t("status.tested", { time: when(at, new Date(), lang) })}
        </span>
      ) : null}
    </div>
  );
}

/** The same checks as the first start, for the settings: live, with "Test again". */
export function SetupStatus({ setup }: { setup: Setup }) {
  const [problem, setProblem] = useState<string | null>(null);
  const test = useTest(setProblem);
  return (
    <div>
      <h4 className="mt-1 font-medium text-[0.75rem] text-ink-3 uppercase tracking-wide">
        {t("status.models")}
      </h4>
      <CheckList checks={setup.models} onTest={(source) => void test(source)} />
      <TestAgain setup={setup} onTest={() => void test()} />
      <h4 className="mt-5 font-medium text-[0.75rem] text-ink-3 uppercase tracking-wide">
        {t("status.home")}
      </h4>
      <CheckList checks={setup.home} />
      <h4 className="mt-5 font-medium text-[0.75rem] text-ink-3 uppercase tracking-wide">
        {t("status.abilities")}
      </h4>
      <CheckList checks={setup.capabilities} />
      {problem ? (
        <p role="alert" className="mt-2 text-[0.8125rem] text-rose">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
