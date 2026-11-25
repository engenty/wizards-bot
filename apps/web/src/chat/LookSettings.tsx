import { Check } from "lucide-react";
import { type ReactNode, useId } from "react";
import { Engenty } from "../engenty/Engenty";
import { type Key, t } from "../lib/i18n";
import {
  CHAT_VIEWS,
  type ChatView,
  TOOL_DETAILS,
  type ToolDetail,
  useChatView,
  useToolDetail,
} from "../lib/look";
import { pickLook } from "../lib/queries";
import { GroundPick, LangSwitch, ThemeSwitch } from "../setup/Frame";
import { cn } from "../ui";

const VIEW_NAME: Record<ChatView, Key> = {
  canvas: "look.view.canvas",
  bubbles: "look.view.bubbles",
};

const DETAIL: Record<ToolDetail, { name: Key; hint: Key }> = {
  none: { name: "look.tools.none", hint: "look.tools.noneHint" },
  summary: { name: "look.tools.summary", hint: "look.tools.summaryHint" },
  all: { name: "look.tools.all", hint: "look.tools.allHint" },
};

/** One line of the page: what is set at the left, its control at the right or, on a phone, below. */
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-2">
      <span className="min-w-44 flex-1 text-[0.875rem]">
        {label}
        {hint ? <span className="block text-[0.75rem] text-ink-3">{hint}</span> : null}
      </span>
      {children}
    </div>
  );
}

/** A choice with its name and one line about it. */
function Choice({ label, hint, children }: { label: string; hint: string; children: ReactNode }) {
  return (
    <fieldset className="mt-3 border-0 border-border-soft border-t p-0 pt-3">
      <legend className="sr-only">{label}</legend>
      <p aria-hidden="true" className="text-[0.875rem]">
        {label}
      </p>
      <p className="mb-2 text-[0.75rem] text-ink-3">{hint}</p>
      {children}
    </fieldset>
  );
}

/** Lines of writing, as a drawing. */
function Lines({ widths, className }: { widths: string[]; className: string }) {
  return widths.map((width) => (
    <span key={width} className={cn("h-1.5 rounded-full", width, className)} />
  ));
}

/** From engenty-pro (AppearanceChatSection): a small chat, the person's bubble, then the answer. */
function ViewPicture({ view }: { view: ChatView }) {
  const answer = <Lines widths={["w-20", "w-full", "w-14"]} className="bg-ink-3/50" />;
  return (
    <span
      aria-hidden="true"
      className="flex h-24 w-full flex-col gap-2 rounded-lg bg-card p-2.5 ring-1 ring-border-soft"
    >
      <span className="ml-auto flex w-16 flex-col rounded-lg rounded-br-sm bg-bubble px-2 py-1.5">
        <Lines widths={["w-full"]} className="bg-ink-3/60" />
      </span>
      <span className="flex items-start gap-1.5">
        {view === "bubbles" ? (
          <>
            <Engenty kind="round" size={18} animated={false} className="shrink-0" />
            <span className="flex w-28 max-w-full flex-col gap-1 rounded-lg rounded-tl-sm bg-bubble-agent px-2 py-1.5">
              {answer}
            </span>
          </>
        ) : (
          <span className="flex w-32 max-w-full flex-col gap-1 px-0.5">{answer}</span>
        )}
      </span>
    </span>
  );
}

/**
 * The page “Appearance”: the theme, its base colour and the language, which are this browser's,
 * and how the chat looks, which the home keeps for all the person's devices.
 */
export function LookSettings({ onProblem }: { onProblem: (text: string | null) => void }) {
  const view = useChatView();
  const tools = useToolDetail();
  const name = useId();
  const pick = (change: Parameters<typeof pickLook>[0]) => {
    onProblem(null);
    pickLook(change).catch((err: Error) => onProblem(err.message));
  };
  return (
    <section>
      <Row label={t("theme.label")}>
        <ThemeSwitch plain />
      </Row>
      <Row label={t("theme.ground")} hint={t("look.groundHint")}>
        <GroundPick />
      </Row>
      <Row label={t("lang.label")}>
        <LangSwitch />
      </Row>
      <Choice label={t("look.view")} hint={t("look.viewHint")}>
        <div className="grid max-w-md grid-cols-2 gap-3">
          {CHAT_VIEWS.map((each) => (
            <label
              key={each}
              className="relative flex flex-col gap-2 rounded-xl bg-card p-2.5 ring-1 ring-border transition hover:bg-accent/60 has-checked:bg-accent has-checked:ring-2 has-checked:ring-ember has-focus-visible:outline-2 has-focus-visible:outline-ink has-focus-visible:outline-offset-3 motion-reduce:transition-none"
            >
              <input
                type="radio"
                name={`${name}-view`}
                value={each}
                checked={each === view}
                onChange={() => pick({ view: each })}
                className="peer absolute inset-0 cursor-pointer appearance-none rounded-xl outline-none"
              />
              <ViewPicture view={each} />
              <span className="flex items-start justify-between gap-1.5 text-[0.8125rem] leading-snug">
                {t(VIEW_NAME[each])}
                {/* Its room is kept, so nothing moves when the pick does. */}
                <Check
                  className={cn("mt-px size-4 shrink-0 text-ember", each !== view && "invisible")}
                />
              </span>
            </label>
          ))}
        </div>
      </Choice>
      <Choice label={t("look.tools")} hint={t("look.toolsHint")}>
        <div className="flex flex-col gap-1">
          {TOOL_DETAILS.map((each) => (
            <label
              key={each}
              className="-mx-2 flex items-start gap-3 rounded-xl px-2 py-2 transition hover:bg-accent/60 has-checked:bg-accent motion-reduce:transition-none"
            >
              <input
                type="radio"
                name={`${name}-tools`}
                value={each}
                checked={each === tools}
                onChange={() => pick({ tools: each })}
                className="mt-0.5 size-4 shrink-0 accent-ember"
              />
              <span className="min-w-0 text-[0.875rem]">
                {t(DETAIL[each].name)}
                <span className="block text-[0.75rem] text-ink-3">{t(DETAIL[each].hint)}</span>
              </span>
            </label>
          ))}
        </div>
      </Choice>
    </section>
  );
}
