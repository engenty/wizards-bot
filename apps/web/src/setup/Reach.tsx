import { useQueryClient } from "@tanstack/react-query";
import type { Setup, SetupAddress } from "@wizards-bot/protocol";
import { Globe, House, type LucideIcon, RefreshCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { t } from "../lib/i18n";
import { keys } from "../lib/keys";
import { Button, cn, Spinner } from "../ui";
import { QrCode } from "../ui/Qr";
import { Command } from "./Checks";

const HEADLINE = "font-display font-semibold text-[1.0625rem] leading-snug";

/**
 * The last step of the first start: where the person reaches their Bot Server from, and how
 * another device is connected to it. A home with an address of its own offers no choice.
 */
export function ReachStep({
  setup,
  onProblem,
}: {
  setup: Setup;
  onProblem: (text: string) => void;
}) {
  const address = setup.hosted ? undefined : setup.address;
  const on = address?.state === "on";
  return (
    <>
      <h1 className="font-display font-semibold text-[1.375rem] leading-tight">
        {t("setup.reach.title")}
      </h1>
      <p className="mt-1 text-[0.9375rem] text-ink-3">
        {t(
          setup.hosted
            ? "setup.reach.hosted"
            : address
              ? "setup.reach.computer"
              : "setup.reach.ownAddress",
        )}
      </p>

      {address ? (
        <section className="mt-7">
          <h2 className={HEADLINE}>{t("setup.reach.from")}</h2>
          <From address={address} onProblem={onProblem} />
        </section>
      ) : null}

      <section className="mt-7">
        <h2 className={HEADLINE}>{t("setup.reach.connect")}</h2>
        {/* A new code once the address is on: the QR then leads to it. */}
        <Connect key={on ? "away" : "home"} onProblem={onProblem} />
      </section>
    </>
  );
}

/** What the address says while it is switched on: how far it is, or why it is not on. */
function stateOf(address: SetupAddress): { text: string; problem?: boolean; busy?: boolean } {
  if (address.state === "on") return { text: t("setup.reach.on") };
  if (address.state === "starting") {
    return {
      text: address.reason
        ? t("setup.reach.again", { why: address.reason })
        : t("setup.reach.starting"),
      busy: true,
    };
  }
  return {
    text: t("setup.reach.problem", { why: address.reason ?? address.state }),
    problem: true,
  };
}

/** At home only, or anywhere through an address at the relay: the second is the person's to pick. */
function From({
  address,
  onProblem,
}: {
  address: SetupAddress;
  onProblem: (text: string) => void;
}) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const pick = (on: boolean) => {
    setBusy(true);
    api
      .post<Setup>("/v1/setup/address", { on })
      .then(
        (saved) => client.setQueryData(keys.setup(), saved),
        (err: Error) => onProblem(err.message),
      )
      .finally(() => setBusy(false));
  };
  const state = address.on ? stateOf(address) : null;
  // The name's own domain: a home can claim its name at another relay than wizards.host.
  const relay = address.name?.split(".").slice(1).join(".") || "wizards.host";
  return (
    <fieldset disabled={busy} className="mt-2.5 grid gap-2 border-0 p-0">
      <legend className="sr-only">{t("setup.reach.from")}</legend>
      <Place
        icon={House}
        title={t("setup.reach.home")}
        hint={t("setup.reach.homeHint")}
        checked={!address.on}
        onPick={() => pick(false)}
      />
      <Place
        icon={Globe}
        title={t("setup.reach.away")}
        hint={t("setup.reach.awayHint", { relay })}
        checked={address.on}
        onPick={() => pick(true)}
      >
        {state ? (
          <span
            role="status"
            className={cn(
              "mt-1.5 flex items-start gap-2 text-[0.8125rem] leading-snug",
              state.problem ? "text-rose" : "text-ink-2",
            )}
          >
            {state.busy ? <Spinner className="mt-0.5 size-3.5 shrink-0" /> : null}
            <span className="min-w-0 break-words">{state.text}</span>
          </span>
        ) : null}
      </Place>
    </fieldset>
  );
}

function Place({
  icon: Icon,
  title,
  hint,
  checked,
  onPick,
  children,
}: {
  icon: LucideIcon;
  title: string;
  hint: string;
  checked: boolean;
  onPick: () => void;
  children?: ReactNode;
}) {
  return (
    <label className="relative flex cursor-pointer items-start gap-3 rounded-xl bg-card px-3.5 py-3 outline-focus ring-border-soft ring-inset transition has-checked:ring-2 has-checked:ring-ember has-focus-visible:outline-2">
      <Icon
        className={cn("mt-0.5 size-5 shrink-0", checked ? "text-ember" : "text-ink-3")}
        aria-hidden="true"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium text-[0.9375rem] leading-snug">{title}</span>
        <span className="mt-0.5 text-[0.8125rem] text-ink-3 leading-snug">{hint}</span>
        {children}
      </span>
      <input
        type="radio"
        name="reach-from"
        className="sr-only"
        checked={checked}
        onChange={onPick}
      />
      <span
        aria-hidden="true"
        className={cn(
          "mt-1 grid size-4 shrink-0 place-items-center rounded-full border-2",
          checked ? "border-ember" : "border-ink-4",
        )}
      >
        {checked ? <span className="size-2 rounded-full bg-ember" /> : null}
      </span>
    </label>
  );
}

/**
 * Another device: the app scans the code, a browser opens the address and takes the code typed.
 * The code is made when the step opens, works once and ends; a new one is a click away.
 */
function Connect({ onProblem }: { onProblem: (text: string) => void }) {
  const [pairing, setPairing] = useState<{ address: string; code: string; link: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const make = useCallback(() => {
    setBusy(true);
    api
      .post<{ address: string; code: string; link: string }>("/v1/setup/pairing", {})
      .then(setPairing, (err: Error) => onProblem(err.message))
      .finally(() => setBusy(false));
  }, [onProblem]);
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    make();
  }, [make]);
  return (
    <div className="mt-2.5 rounded-xl bg-card p-3.5">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
        {pairing ? (
          <QrCode text={pairing.link} label={t("setup.reach.qr")} className="shrink-0" />
        ) : (
          <span className="grid size-40 shrink-0 place-items-center rounded-xl bg-paper-2">
            <Spinner className="size-5 text-ink-3" />
          </span>
        )}
        <div className="min-w-0 flex-1 space-y-4">
          <Way title={t("setup.reach.app")} hint={t("setup.reach.appHint")} />
          <Way title={t("setup.reach.browser")} hint={t("setup.reach.browserHint")} />
        </div>
      </div>
      {pairing ? (
        <>
          <div className="mt-4 grid gap-3 border-border-soft border-t pt-3.5 sm:grid-cols-[1fr_11rem]">
            <Value label={t("setup.reach.address")} text={pairing.address} />
            <Value label={t("setup.reach.code")} text={pairing.code} />
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <p className="text-[0.8125rem] text-ink-3">{t("setup.reach.once")}</p>
            <Button variant="ghost" size="sm" busy={busy} className="-mr-2" onClick={make}>
              {busy ? null : <RefreshCw className="size-3.5" />}
              {t("setup.reach.newCode")}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}

function Way({ title, hint }: { title: string; hint: string }) {
  return (
    <div>
      <h3 className="font-medium text-[0.9375rem] leading-snug">{title}</h3>
      <p className="mt-0.5 text-[0.8125rem] text-ink-3 leading-snug">{hint}</p>
    </div>
  );
}

/** A value to type on the other device, with a way to copy it. */
function Value({ label, text }: { label: string; text: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[0.75rem] text-ink-3">{label}</p>
      <Command text={text} />
    </div>
  );
}
