import type { PairResponse } from "@wizards-bot/protocol";
import { useEffect, useState } from "react";
import { Engenty } from "./engenty/Engenty";
import { ApiError, api } from "./lib/api";
import { t } from "./lib/i18n";
import { macName } from "./lib/mac";
import { setDeviceToken } from "./lib/session";
import { Frame } from "./setup/Frame";
import { Button, Input } from "./ui";

/**
 * The code of a pairing link, or the pass someone of a group home brings from their account,
 * taken out of the address. It sits after the `#`, which a browser sends to no one.
 */
function takeLinked(): { code: string } | { pass: string } | null {
  const code = /^#code=([A-Za-z0-9-]+)$/.exec(location.hash)?.[1];
  const pass = /^#admin=([A-Za-z0-9._-]+)$/.exec(location.hash)?.[1];
  if (code || pass) {
    history.replaceState(null, "", location.pathname);
  }
  return code ? { code } : pass ? { pass } : null;
}

/** Where a browser the home does not know starts: a pairing code makes it one of its devices. */
export function Pairing() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const pair = async (entered: string | { pass: string }) => {
    setBusy(true);
    setProblem(null);
    const name = macName() ?? t("pair.browser");
    try {
      const paired =
        typeof entered === "string"
          ? await api.post<PairResponse>("/v1/pair", { code: entered, name, kind: "browser" })
          : await api.post<PairResponse>("/v1/pair/pass", {
              pass: entered.pass,
              name,
              kind: "browser",
            });
      setDeviceToken(paired.token);
    } catch (err) {
      const status = err instanceof ApiError ? err.status : -1;
      // A refused pass says why: used, too old, or for someone who is not in the team.
      setProblem(
        status === 0
          ? t("pair.down")
          : status === 401 && typeof entered === "string"
            ? t("pair.wrong")
            : (err as Error).message,
      );
      setBusy(false);
    }
  };

  // A pairing link pairs by itself, also when it is opened in a page that already stands. The
  // code leaves the address as it is taken, so it is tried once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: listens for as long as the page is shown
  useEffect(() => {
    const linked = () => {
      const linked = takeLinked();
      if (linked) {
        void pair("code" in linked ? linked.code : linked);
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
