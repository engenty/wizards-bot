import { type EngentyColor, EngentyKind } from "@wizards-bot/protocol";
import { Dices } from "lucide-react";
import { useState } from "react";
import { ENGENTY_FILL } from "../engenty/colors";
import { Engenty } from "../engenty/Engenty";
import { t } from "../lib/i18n";
import { Button, cn, Dialog, IconButton } from "../ui";
import type { Asker } from "./SettingsDialog";

const KINDS = EngentyKind.options;
const COLORS = Object.keys(ENGENTY_FILL) as EngentyColor[];

const pick = <T,>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)] as T;

/**
 * A new bot, as everything in the Bot Server: the person picks how it looks and says what it
 * should do, and the main Wizard sets it up in its chat and asks for what it needs. The figure
 * at the left is the bot as it will be: it looks at the pointer and wears the colour picked.
 */
export function NewBotDialog({
  open,
  onClose,
  asker,
}: {
  open: boolean;
  onClose: () => void;
  asker?: Asker;
}) {
  const [name, setName] = useState("");
  const [task, setTask] = useState("");
  const [kind, setKind] = useState<EngentyKind>(() => pick(KINDS));
  const [color, setColor] = useState<EngentyColor | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const close = () => {
    setName("");
    setTask("");
    setProblem(null);
    setKind(pick(KINDS));
    setColor(undefined);
    onClose();
  };
  const go = async () => {
    if (!(asker && task.trim())) return;
    setBusy(true);
    setProblem(null);
    try {
      await asker.ask(
        t("agents.newAsk", {
          named: name.trim() ? t("agents.newNamed", { name: name.trim() }) : "",
          kind,
          colored: color ? t("agents.newColored", { color }) : "",
          task: task.trim(),
        }),
      );
      close();
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const tint = color ? ENGENTY_FILL[color] : undefined;
  return (
    <Dialog open={open} onClose={close} title={t("agents.new")} wide="palette">
      <div className="grid gap-6 sm:grid-cols-[13rem_1fr]">
        {/* The bot as it will be, on a soft ground of its colour. */}
        <div
          className="flex flex-col items-center justify-center gap-3 rounded-2xl px-4 py-6 transition-colors"
          style={{
            background: tint
              ? `color-mix(in oklch, ${tint} 16%, transparent)`
              : "var(--color-paper-2, transparent)",
          }}
        >
          <Engenty key={kind} kind={kind} color={color} size={132} className="enter-pop" />
          <p className="max-w-full truncate font-display font-semibold text-[1.0625rem]">
            {name.trim() || t("agents.newUnnamed")}
          </p>
          <button
            type="button"
            onClick={() => {
              setKind(pick(KINDS));
              setColor(pick(COLORS));
            }}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[0.8125rem] text-ink-2 ring-1 ring-border-soft transition hover:text-ink"
          >
            <Dices className="size-3.5" />
            {t("agents.newRoll")}
          </button>
        </div>
        <div className="min-w-0">
          <label className="block">
            <span className="mb-1.5 block font-medium text-[0.8125rem]">{t("agents.newName")}</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("agents.newUnnamed")}
              className="h-10 w-full rounded-xl bg-paper-2 px-3 text-[0.9375rem] outline-none ring-1 ring-border-soft placeholder:text-ink-4 focus:ring-ember"
            />
          </label>
          <fieldset className="mt-4">
            <legend className="mb-1.5 font-medium text-[0.8125rem]">{t("agents.newShape")}</legend>
            <div className="flex flex-wrap gap-1">
              {KINDS.map((one) => (
                <button
                  key={one}
                  type="button"
                  aria-label={one}
                  aria-pressed={one === kind}
                  onClick={() => setKind(one)}
                  className={cn(
                    "grid size-11 place-items-center rounded-xl transition",
                    one === kind ? "bg-accent ring-2 ring-ember" : "hover:bg-accent/60",
                  )}
                >
                  <Engenty kind={one} color={color} size={34} animated={false} />
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="mt-4">
            <legend className="mb-1.5 font-medium text-[0.8125rem]">{t("agents.newColor")}</legend>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                aria-pressed={color === undefined}
                onClick={() => setColor(undefined)}
                className={cn(
                  "h-8 rounded-full px-3 text-[0.75rem] ring-1 transition",
                  color === undefined
                    ? "bg-accent text-ink ring-ember"
                    : "text-ink-3 ring-border-soft hover:text-ink",
                )}
              >
                {t("agents.newOwnColor")}
              </button>
              {COLORS.map((one) => (
                <button
                  key={one}
                  type="button"
                  aria-label={one}
                  aria-pressed={one === color}
                  onClick={() => setColor(one)}
                  className={cn(
                    "size-8 rounded-full ring-offset-2 ring-offset-card transition",
                    one === color ? "ring-2 ring-ink" : "hover:scale-110",
                  )}
                  style={{ background: ENGENTY_FILL[one] }}
                />
              ))}
            </div>
          </fieldset>
          <label className="mt-4 block">
            <span className="mb-1.5 block font-medium text-[0.8125rem]">{t("agents.newTask")}</span>
            <textarea
              value={task}
              onChange={(e) => setTask(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void go();
                }
              }}
              rows={3}
              placeholder={t("agents.newTaskHint")}
              className="w-full resize-none rounded-xl bg-paper-2 px-3 py-2 text-[0.9375rem] outline-none ring-1 ring-border-soft placeholder:text-ink-4 focus:ring-ember"
            />
          </label>
          <p className="mt-2 text-[0.8125rem] text-ink-3 leading-relaxed">
            {t("agents.newHint", { name: asker?.name ?? "" })}
          </p>
        </div>
      </div>
      {problem ? (
        <p role="alert" className="mt-3 text-[0.8125rem] text-rose">
          {problem}
        </p>
      ) : null}
      <div className="mt-5 flex items-center justify-end gap-2">
        <IconButton
          label={t("agents.newRoll")}
          className="mr-auto sm:hidden"
          onClick={() => {
            setKind(pick(KINDS));
            setColor(pick(COLORS));
          }}
        >
          <Dices className="size-4" />
        </IconButton>
        <Button variant="ghost" onClick={close}>
          {t("common.cancel")}
        </Button>
        <Button onClick={() => void go()} disabled={busy || !task.trim() || !asker}>
          {t("agents.newGo")}
        </Button>
      </div>
    </Dialog>
  );
}
