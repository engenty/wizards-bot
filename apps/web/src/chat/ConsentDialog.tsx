import type { ModelService } from "@wizards-bot/protocol";
import { useState } from "react";
import privacy from "../../../../docs/privacy.md?raw";
import { useConsentAsk } from "../lib/consent";
import { t } from "../lib/i18n";
import { Button, Dialog } from "../ui";
import { Markdown } from "../ui/Markdown";

/** One service and the sources that send to it: "Anthropic – Claude". */
export function serviceLine(service: ModelService): string {
  return service.sources.length
    ? `${service.label} – ${service.sources.join(", ")}`
    : service.label;
}

/** The privacy policy of wizards.bot, as `docs/privacy.md` has it. */
export function PrivacyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onClose={onClose} title={t("privacy.title")}>
      <Markdown text={privacy.replace(/^# .*\n/, "")} className="text-[0.875rem]" />
    </Dialog>
  );
}

/**
 * Before what the person writes reaches a model service outside their own computers: where it
 * goes, and a clear yes or no. Nothing is sent before the answer.
 */
export function ConsentDialog() {
  const ask = useConsentAsk();
  const [reads, setReads] = useState(false);
  return (
    <>
      <Dialog open={ask !== null} onClose={() => ask?.answer(false)} title={t("consent.title")}>
        <div className="flex flex-col gap-3 text-[0.875rem] leading-relaxed">
          <p>{t("consent.home", { host: window.location.host })}</p>
          <ul className="flex flex-col gap-1 rounded-xl bg-accent/60 px-3 py-2.5">
            {ask?.services.map((service) => (
              <li key={service.id} className="font-medium">
                {serviceLine(service)}
              </li>
            ))}
          </ul>
          <p className="text-ink-2">{t("consent.what")}</p>
          <p className="text-ink-2">{t("consent.own")}</p>
          <button
            type="button"
            className="self-start text-ember-strong underline underline-offset-2"
            onClick={() => setReads(true)}
          >
            {t("privacy.open")}
          </button>
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => ask?.answer(false)}>
              {t("consent.no")}
            </Button>
            <Button data-autofocus onClick={() => ask?.answer(true)}>
              {t("consent.yes")}
            </Button>
          </div>
        </div>
      </Dialog>
      <PrivacyDialog open={reads} onClose={() => setReads(false)} />
    </>
  );
}
