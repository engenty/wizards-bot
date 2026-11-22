import type { PairResponse } from "@wizards-bot/protocol";
import { useEffect, useState } from "react";
import { Engenty } from "./engenty/Engenty";
import { ApiError, api } from "./lib/api";
import { t } from "./lib/i18n";
import { setDeviceToken } from "./lib/session";
import { Frame } from "./setup/Frame";
import { Button, Input } from "./ui";

/**
 * The code of a pairing link, taken out of the address. It sits after the `#`, which a browser
 * sends to no one.
 */
function takeLinkedCode(): string | null {
  const code = /^#code=([A-Za-z0-9-]+)$/.exec(location.hash)?.[1] ?? null;
  if (code) {
    history.replaceState(null, "", location.pathname);
  }
  return code;
}

/** Where a browser the home does not know starts: a pairing code makes it one of its devices. */
export function Pairing() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const pair = async (entered: string) => {
    setBusy(true);
    setProblem(null);
    try {
      const paired = await api.post<PairResponse>("/v1/pair", {
        code: entered,
        name: t("pair.browser"),
        kind: "browser",
      });
      setDeviceToken(paired.token);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : -1;
      setProblem(
        status === 0 ? t("pair.down") : status === 401 ? t("pair.wrong") : (err as Error).message,
      );
      setBusy(false);
    }
  };

  // A pairing link pairs by itself, also when it is opened in a page that already stands. The
  // code leaves the address as it is taken, so it is tried once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: listens for as long as the page is shown
  useEffect(() => {
    const linked = () => {
      const code = takeLinkedCode();
      if (code) {
        void pair(code);
      }
    };
    linked();
    window.addEventListener("hashchange", linked);
    return () => window.removeEventListener("hashchange", linked);
  }, []);

  return (
    <div className="h-full overflow-y-auto">
      <Frame>
        <form
          className="mx-auto flex w-full max-w-sm flex-1 flex-col items-center justify-center gap-4 px-5 py-10 text-center"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim()) {
              void pair(code.trim());
            }
          }}
        >
          <Engenty kind="round" size={120} />
          <h1 className="font-display font-semibold text-2xl leading-tight">{t("pair.title")}</h1>
          <p className="text-ink-2 leading-relaxed">{t("pair.hint")}</p>
          <div className="mt-2 w-full text-left">
            <label htmlFor="pair-code" className="mb-1.5 block font-medium text-[0.875rem]">
              {t("pair.code")}
            </label>
            <Input
              id="pair-code"
              value={code}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder={t("pair.placeholder")}
              aria-describedby={problem ? "pair-problem" : undefined}
              onChange={(e) => setCode(e.target.value)}
              className="text-center font-mono tracking-widest placeholder:tracking-normal"
            />
          </div>
          {problem ? (
            <p id="pair-problem" role="alert" className="text-[0.875rem] text-rose">
              {problem}
            </p>
          ) : null}
          <Button type="submit" busy={busy} disabled={!code.trim()} className="w-full">
            {t("pair.connect")}
          </Button>
        </form>
      </Frame>
    </div>
  );
}
