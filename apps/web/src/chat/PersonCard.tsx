import type { PersonState } from "@wizards-bot/protocol";
import { useEffect, useState } from "react";
import { ApiError, api } from "../lib/api";
import { t } from "../lib/i18n";
import { bringBack, canKeepKey, heldKey, makeKey, signWith } from "../lib/personKey";
import { Button, Input, Spinner } from "../ui";

/**
 * What the card for the person's key does on this device: make the key and show its recovery
 * code once, bring a key back from its code, or sign the version of the record the home asks
 * for. The key stays in this browser; the home gets the signature.
 */
export function PersonCard() {
  const [state, setState] = useState<PersonState | null>(null);
  const [held, setHeld] = useState<string | undefined>();
  const [code, setCode] = useState<string | null>(null);
  const [entering, setEntering] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const can = canKeepKey();

  useEffect(() => {
    if (!can) return;
    let gone = false;
    void Promise.all([api.get<PersonState>("/v1/person"), heldKey()])
      .then(([person, key]) => {
        if (gone) return;
        setState(person);
        setHeld(key);
      })
      .catch(() => {
        if (!gone) setProblem(t("person.failed"));
      });
    return () => {
      gone = true;
    };
  }, [can]);

  if (!can) return <p className="text-[0.875rem] text-ink-2">{t("person.cannot")}</p>;
  if (!state) {
    return problem ? (
      <p role="alert" className="text-[0.8125rem] text-rose">
        {problem}
      </p>
    ) : (
      <Spinner className="size-4" />
    );
  }

  /** Runs one step and says so when it did not work. */
  const step = async (work: () => Promise<void>) => {
    setBusy(true);
    setProblem(null);
    try {
      await work();
    } catch (error) {
      setProblem(error instanceof ApiError && error.message ? error.message : t("person.failed"));
    } finally {
      setBusy(false);
    }
  };

  /** Has the home name what is to be signed, signs it here and hands the signature in. */
  const sign = async (key: string) => {
    const { payload } = await api.post<{ payload: string }>("/v1/person/start", { key });
    const sig = await signWith(payload);
    setState(await api.post<PersonState>("/v1/person/records", { payload, sig }));
  };

  const recordKey = state.record?.key;
  // The code is on the screen: it is shown this once, and the record is signed after it.
  if (code && held) {
    return (
      <div className="flex w-full flex-col gap-3">
        <p className="font-medium text-[0.875rem]">{t("person.code.title")}</p>
        <p className="select-all break-all rounded-lg bg-paper-2 px-3 py-2.5 font-mono text-[0.875rem] leading-relaxed">
          {code}
        </p>
        <p className="text-[0.875rem] text-ink-2">{t("person.code.hint")}</p>
        <div>
          <Button
            busy={busy}
            onClick={() =>
              void step(async () => {
                await sign(held);
                setCode(null);
              })
            }
          >
            {t("person.code.done")}
          </Button>
        </div>
      </div>
    );
  }

  const enter = (
    <form
      className="flex w-full flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void step(async () => {
          const key = await bringBack(typed);
          if (!key) return setProblem(t("person.enter.wrong"));
          if (recordKey && recordKey !== key) return setProblem(t("person.enter.other"));
          setHeld(key);
          setEntering(false);
          setTyped("");
          // With no record here, or one that waits for a signature, the key signs at once.
          if (!state.record || state.proposed) await sign(key);
        });
      }}
    >
      <label htmlFor="person-code" className="font-medium text-[0.875rem]">
        {t("person.enter.label")}
      </label>
      <Input
        id="person-code"
        autoComplete="off"
        spellCheck={false}
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
      />
      <div>
        <Button type="submit" busy={busy} disabled={!typed.trim()}>
          {t("person.enter.go")}
        </Button>
      </div>
    </form>
  );

  const holdsIt = held !== undefined && (!recordKey || recordKey === held);
  return (
    <div className="flex w-full flex-col gap-3">
      {state.record && !holdsIt ? (
        <p className="text-[0.875rem] text-ink-2">{t("person.elsewhere")}</p>
      ) : null}
      {holdsIt ? (
        <div>
          <Button busy={busy} onClick={() => void step(() => sign(held))}>
            {t("person.sign")}
          </Button>
        </div>
      ) : entering || state.record ? (
        enter
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            busy={busy}
            onClick={() =>
              void step(async () => {
                const made = await makeKey();
                setHeld(made.publicKey);
                setCode(made.code);
              })
            }
          >
            {t("person.make")}
          </Button>
          <Button variant="secondary" onClick={() => setEntering(true)}>
            {t("person.haveCode")}
          </Button>
        </div>
      )}
      {problem ? (
        <p role="alert" className="text-[0.8125rem] text-rose">
          {problem}
        </p>
      ) : null}
    </div>
  );
}
