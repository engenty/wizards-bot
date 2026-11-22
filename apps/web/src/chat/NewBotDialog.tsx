import { useState } from "react";
import { t } from "../lib/i18n";
import { Button, Dialog } from "../ui";
import type { Asker } from "./SettingsDialog";

/**
 * A new bot, as everything in the Bot Server: the person says what it should do, and the main
 * Wizard sets it up in its chat and asks for what it needs.
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
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const close = () => {
    setName("");
    setTask("");
    setProblem(null);
    onClose();
  };
  const go = async () => {
    if (!(asker && task.trim())) return;
    setBusy(true);
    setProblem(null);
    try {
      const named = name.trim() ? t("agents.newNamed", { name: name.trim() }) : "";
      await asker.ask(t("agents.newAsk", { named, task: task.trim() }));
      close();
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onClose={close} title={t("agents.new")}>
      <p className="text-[0.875rem] text-ink-2 leading-relaxed">
        {t("agents.newHint", { name: asker?.name ?? "" })}
      </p>
      <label className="mt-4 block">
        <span className="mb-1.5 block font-medium text-[0.8125rem]">{t("agents.newTask")}</span>
        <textarea
          data-autofocus
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void go();
            }
          }}
          rows={3}
          className="w-full resize-none rounded-xl bg-paper-2 px-3 py-2 text-[0.9375rem] outline-none ring-1 ring-border-soft focus:ring-ember"
        />
      </label>
      <label className="mt-3 block">
        <span className="mb-1.5 block font-medium text-[0.8125rem]">{t("agents.newName")}</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-10 w-full rounded-xl bg-paper-2 px-3 text-[0.9375rem] outline-none ring-1 ring-border-soft focus:ring-ember"
        />
      </label>
      {problem ? (
        <p role="alert" className="mt-3 text-[0.8125rem] text-rose">
          {problem}
        </p>
      ) : null}
      <div className="mt-5 flex justify-end gap-2">
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
