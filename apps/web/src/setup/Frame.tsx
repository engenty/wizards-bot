// From engenty wizards: the theme switch (apps/web/src/studio/ThemeSwitch.tsx) and the language
// switch and legal links of its account pages (engenty-wizards-manage, apps/web/src/brand.tsx and
// pages/legal.tsx).
import { Check, ChevronDown, Droplet, Moon, Sun } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { PrivacyDialog } from "../chat/ConsentDialog";
import { Engenty } from "../engenty/Engenty";
import { type Key, type Lang, lang, setLang, t } from "../lib/i18n";
import { useHome } from "../lib/queries";
import {
  BRANDED_GROUNDS,
  type BrandedGround,
  setGround,
  setTheme,
  type ThemeMode,
  useGround,
  useThemeMode,
} from "../lib/theme";
import { cn } from "../ui";
import { Menu } from "../ui/Menu";

const THEMES = [
  { mode: "light", icon: Sun, label: "theme.light" },
  { mode: "branded", icon: Droplet, label: "theme.branded" },
  { mode: "dark", icon: Moon, label: "theme.dark" },
] as const satisfies readonly { mode: ThemeMode; icon: typeof Sun; label: string }[];

const GROUND_NAME: Record<BrandedGround, Key> = {
  cobalt: "theme.ground.cobalt",
  violet: "theme.ground.violet",
  berry: "theme.ground.berry",
  petrol: "theme.ground.petrol",
  emerald: "theme.ground.emerald",
  brick: "theme.ground.brick",
  citron: "theme.ground.citron",
};

/**
 * The base colours as round swatches: in the branded theme each its ground with the accent of its
 * buttons, in the light and the dark one the colour the buttons take there. The name on hover.
 */
export function GroundPick({ onPick }: { onPick?: () => void }) {
  const picked = useGround();
  const mode = useThemeMode();
  const name = useId();
  return (
    <fieldset className="flex flex-wrap items-center gap-1.5 border-0 p-0">
      <legend className="sr-only">{t("theme.ground")}</legend>
      {BRANDED_GROUNDS.map(({ ground, stage, accent, light, dark }) => {
        const fill = mode === "branded" ? stage : mode === "light" ? light : dark;
        const mark = mode === "branded" ? accent : mode === "light" ? "white" : "oklch(16% 0.01 0)";
        return (
          <label
            key={ground}
            title={t(GROUND_NAME[ground])}
            style={{ background: fill }}
            className="relative grid size-7 cursor-pointer place-items-center rounded-full ring-1 ring-border transition-transform hover:scale-110 has-checked:ring-2 has-checked:ring-ink has-focus-visible:outline-2 has-focus-visible:outline-ink has-focus-visible:outline-offset-3 motion-reduce:transition-none coarse:size-9"
          >
            <input
              type="radio"
              name={name}
              value={ground}
              checked={ground === picked}
              aria-label={t(GROUND_NAME[ground])}
              onChange={() => setGround(ground)}
              // A click picks and is done; the arrow keys go on to the next one.
              onClick={(e) => {
                if (e.detail) onPick?.();
              }}
              className="absolute inset-0 cursor-pointer appearance-none rounded-full outline-none"
            />
            {ground === picked ? (
              <Check className="size-3.5" style={{ color: mark }} strokeWidth={3} />
            ) : mode === "branded" ? (
              <span className="size-2 rounded-full" style={{ background: mark }} />
            ) : null}
          </label>
        );
      })}
    </fieldset>
  );
}

/**
 * Light · branded · dark: a thumb slides to the pick. The branded button opens a small menu of
 * its colours, and picks the branded theme as well; where the colours stand beside the switch
 * (`plain`) it has no menu.
 */
export function ThemeSwitch({ plain = false }: { plain?: boolean }) {
  const shown = useThemeMode();
  const index = THEMES.findIndex((option) => option.mode === shown);
  const [colours, setColours] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!colours) return;
    const away = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setColours(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") setColours(false);
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", key);
    };
  }, [colours]);
  return (
    <div ref={ref} className="relative inline-flex">
      <fieldset className="relative inline-flex items-center rounded-full border-0 bg-paper-2 p-0.5 ring-1 ring-border-soft">
        <legend className="sr-only">{t("theme.label")}</legend>
        <span
          aria-hidden="true"
          className="absolute top-0.5 bottom-0.5 left-0.5 w-9 rounded-full bg-card shadow-sm transition-transform duration-300 motion-reduce:transition-none"
          style={{ transform: `translateX(${index * 100}%)` }}
        />
        {THEMES.map(({ mode, icon: Icon, label }) => (
          <button
            key={mode}
            type="button"
            aria-label={t(label)}
            aria-pressed={mode === shown}
            aria-haspopup={mode === "branded" && !plain ? "true" : undefined}
            aria-expanded={mode === "branded" && !plain ? colours : undefined}
            title={mode === "branded" && !plain ? t("theme.groundOpen") : t(label)}
            onClick={() => {
              if (mode === "branded" && !plain) {
                if (shown !== "branded") setTheme(mode);
                setColours((open) => !open);
                return;
              }
              setColours(false);
              setTheme(mode);
            }}
            className={cn(
              "relative grid h-7 w-9 cursor-pointer place-items-center rounded-full transition-colors",
              mode === shown ? "text-ink" : "text-ink-3 hover:text-ink-2",
            )}
          >
            {mode === "branded" && !plain ? (
              <span className="flex items-center gap-px">
                <Icon className="size-3.5" />
                <ChevronDown className="size-2.5" strokeWidth={2.5} />
              </span>
            ) : (
              <Icon className="size-3.5" />
            )}
          </button>
        ))}
      </fieldset>
      {colours ? (
        <div className="absolute top-full right-0 z-50 mt-2 w-max max-w-[11.5rem] rounded-xl bg-card p-2 shadow-overlay ring-1 ring-border-soft">
          <GroundPick onPick={() => setColours(false)} />
        </div>
      ) : null}
    </div>
  );
}

const LANGS: Lang[] = ["en", "de"];
const LANG_NAMES: Record<Lang, string> = { en: "English", de: "Deutsch" };

/** EN · DE: the language in effect is lit and named in full. */
export function LangSwitch() {
  return (
    <fieldset className="inline-flex items-center rounded-full border-0 bg-paper-2 p-0.5 ring-1 ring-border-soft">
      <legend className="sr-only">{t("lang.label")}</legend>
      {LANGS.map((code) => (
        <button
          key={code}
          type="button"
          lang={code}
          aria-pressed={code === lang}
          title={LANG_NAMES[code]}
          onClick={() => setLang(code)}
          className={cn(
            "h-7 cursor-pointer rounded-full px-3 font-medium text-[0.75rem] transition",
            code === lang ? "bg-card text-ink shadow-sm" : "text-ink-3 hover:text-ink",
          )}
        >
          {code === lang ? LANG_NAMES[code] : code.toUpperCase()}
        </button>
      ))}
    </fieldset>
  );
}

const HEADER_BUTTON =
  "grid size-9 cursor-pointer place-items-center rounded-full text-ink-2 transition-colors hover:bg-paper-2 hover:text-ink aria-expanded:bg-paper-2 aria-expanded:text-ink coarse:size-11";

/** The theme as one button: the icon of the theme in effect; a click shows the next one. */
function ThemeButton() {
  const shown = useThemeMode();
  const at = THEMES.findIndex((option) => option.mode === shown);
  const now = THEMES[at] ?? THEMES[1];
  const next = THEMES[(at + 1) % THEMES.length] ?? THEMES[0];
  const label = t("theme.next", { now: t(now.label), next: t(next.label) });
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => setTheme(next.mode)}
      className={HEADER_BUTTON}
    >
      <now.icon className="size-[1.125rem]" />
    </button>
  );
}

/** The language as one button: the one in effect. */
function LangMenu() {
  return (
    <Menu
      label={t("lang.label")}
      narrow
      className={cn(HEADER_BUTTON, "font-medium text-[0.8125rem]")}
      items={LANGS.map((code) => ({
        icon: <span className="w-5 text-[0.75rem] text-ink-3">{code.toUpperCase()}</span>,
        label: LANG_NAMES[code],
        checked: code === lang,
        onSelect: () => setLang(code),
      }))}
    >
      {lang.toUpperCase()}
    </Menu>
  );
}

/** The imprint and the terms are engenty's, on its site; the privacy policy is wizards.bot's own. */
const SITE: Record<Lang, { imprint: string; terms: string }> = {
  en: { imprint: "https://engenty.ai/imprint", terms: "https://engenty.ai/terms" },
  de: {
    imprint: "https://engenty.ai/de/impressum",
    terms: "https://engenty.ai/de/nutzungsbedingungen",
  },
};

const LINK = "transition hover:text-ink";

/**
 * The page around the first steps (pairing, setup): the logo at the left, the theme and the
 * language at the right, at the foot engenty's legal links on a hosted Bot Server (engenty runs
 * it) and a line with a link to wizards.bot on one on the person's own computer, then the Bot
 * Server's version.
 */
export function Frame({ children }: { children: ReactNode }) {
  const [privacy, setPrivacy] = useState(false);
  const home = useHome();
  return (
    <div className="flex min-h-full flex-col bg-background">
      <header className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 pt-4 sm:px-6">
        <span className="flex items-center gap-2">
          <Engenty kind="round" size={28} animated={false} />
          <span className="font-display font-semibold text-[1.0625rem] tracking-tight">
            wizards<span className="text-ember">.</span>bot
          </span>
        </span>
        <span className="flex-1" />
        <span className="flex items-center gap-1">
          <ThemeButton />
          <LangMenu />
        </span>
      </header>
      <div className="flex flex-1 flex-col">{children}</div>
      <footer className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-center gap-x-5 gap-y-1 px-4 pt-6 pb-5 text-[0.75rem] text-ink-3">
        {home.data?.hosted ? (
          <>
            <a className={LINK} href={SITE[lang].imprint} target="_blank" rel="noreferrer">
              {t("legal.imprint")}
            </a>
            <button
              type="button"
              className={cn(LINK, "cursor-pointer")}
              onClick={() => setPrivacy(true)}
            >
              {t("legal.privacy")}
            </button>
            <a className={LINK} href={SITE[lang].terms} target="_blank" rel="noreferrer">
              {t("legal.terms")}
            </a>
          </>
        ) : home.data ? (
          <span>
            {t("legal.local")}{" "}
            <a
              className={cn(LINK, "underline underline-offset-2")}
              href="https://wizards.bot"
              target="_blank"
              rel="noreferrer"
            >
              wizards.bot
            </a>
          </span>
        ) : null}
        {home.data ? <span>v{home.data.version}</span> : null}
      </footer>
      <PrivacyDialog open={privacy} onClose={() => setPrivacy(false)} />
    </div>
  );
}
