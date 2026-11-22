// From engenty wizards, apps/web/src/report/Crashed.tsx, without its report.
import { Component, type ReactNode } from "react";
import { t } from "./lib/i18n";
import { Button } from "./ui";

/**
 * Catches what the app throws while it draws: instead of a blank window, the crash in plain
 * words and a reload. Nothing is lost by it: the home keeps the conversation.
 */
export class Crashed extends Component<{ children: ReactNode }, { crashed: boolean }> {
  state = { crashed: false };

  static getDerivedStateFromError() {
    return { crashed: true };
  }

  render() {
    if (!this.state.crashed) {
      return this.props.children;
    }
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center">
        <h1 className="font-display font-semibold text-[1.375rem]">{t("crashed.title")}</h1>
        <p className="mt-2 max-w-md text-[0.9375rem] text-ink-3">{t("crashed.note")}</p>
        <Button variant="secondary" className="mt-6" onClick={() => window.location.reload()}>
          {t("crashed.reload")}
        </Button>
      </div>
    );
  }
}
