// From engenty wizards: the theme switch (apps/web/src/studio/ThemeSwitch.tsx) and the language
// switch and legal links of its account pages (engenty-wizards-manage, apps/web/src/brand.tsx and
// pages/legal.tsx).
import { Moon, Palette, Sun } from "lucide-react";
import { type ReactNode, useState } from "react";
import { PrivacyDialog } from "../chat/ConsentDialog";
import { Engenty } from "../engenty/Engenty";
import { type Lang, lang, setLang, t } from "../lib/i18n";
import { setTheme, type ThemeMode, useThemeMode } from "../lib/theme";
import { cn } from "../ui";

const THEMES = [
  { mode: "light", icon: Sun, label: "theme.light" },
  { mode: "branded", icon: Palette, label: "theme.branded" },
  { mode: "dark", icon: Moon, label: "theme.dark" },
] as const satisfies readonly { mode: ThemeMode; icon: typeof Sun; label: string }[];

/** Light · branded · dark: a thumb slides to the pick. */
export function ThemeSwitch() {
  const shown = useThemeMode();
  const index = THEMES.findIndex((option) => option.mode === shown);
  return (
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
          title={t(label)}
          onClick={() => setTheme(mode)}
          className={cn(
            "relative grid h-7 w-9 cursor-pointer place-items-center rounded-full transition-colors",
            mode === shown ? "text-ink" : "text-ink-3 hover:text-ink-2",
          )}
        >
          <Icon className="size-3.5" />
        </button>
      ))}
    </fieldset>
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
 * language at the right, the legal links at the foot.
 */
export function Frame({ children }: { children: ReactNode }) {
  const [privacy, setPrivacy] = useState(false);
  return (
    <div className="flex min-h-full flex-col bg-background">
      <header className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 pt-4 sm:px-6">
        <span className="flex items-center gap-2">
          <Engenty kind="round" size={28} animated={false} />
          <span className="font-display font-semibold text-[1.0625rem] tracking-tight">
            wizards<span className="text-ember">.</span>bot
          </span>
        </span>
        <span className="flex-1" />
        <ThemeSwitch />
        <LangSwitch />
      </header>
      <div className="flex flex-1 flex-col">{children}</div>
      <footer className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-center gap-x-5 gap-y-1 px-4 pt-6 pb-5 text-[0.75rem] text-ink-3">
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
      </footer>
      <PrivacyDialog open={privacy} onClose={() => setPrivacy(false)} />
    </div>
  );
}
