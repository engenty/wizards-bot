import { Textarea } from "@engenty/chatviews/react/ui";
import type { Card } from "@wizards-bot/protocol";
import { REPLY_ACTION, REPLY_FIELD } from "@wizards-bot/protocol/limits";
import { Check, CornerDownLeft } from "lucide-react";
import { createContext, useContext, useState } from "react";
import { useDraft } from "../lib/drafts";
import { lang, t } from "../lib/i18n";
import { useThisDevice } from "../lib/queries";
import { answerText, formOf, isFree, missingIn } from "../lib/questions";
import { Button } from "../ui";
import { Markdown } from "../ui/Markdown";
import { FormFields } from "./FormFields";
import { useAnswer } from "./useAnswer";

/** The chat around a question: which one its input answers now, and how to pick another. */
interface Answering {
  target?: string;
  pick: (cardId: string) => void;
}

/** Without it, as in the list of what needs the person, a question brings a field of its own. */
export const AnsweringContext = createContext<Answering | null>(null);

/** What was asked, as the agent's own words. */
function Asked({ card }: { card: Card }) {
  return (
    <>
      <Markdown text={card.title} className="font-medium text-[0.9375rem]" />
      {card.body ? <Markdown text={card.body} className="text-[0.9375rem]" /> : null}
    </>
  );
}

/** A form that was sent: what was asked, and what the person said to it. */
function Sent({ card }: { card: Card }) {
  const values = card.answer?.values ?? {};
  const rows = (formOf(card) ?? []).map((field) => ({
    field,
    text: answerText(field, values, lang, (n) => t("question.files", { n })),
  }));
  return (
    <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 rounded-xl bg-paper-2 px-4 py-3 text-[0.875rem] sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      {rows.map(({ field, text }) => (
        <div key={field.id} className="contents">
          <dt className="text-ink-3">{field.label}</dt>
          <dd className="min-w-0 break-words max-sm:mb-1.5">{text ?? "–"}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Who answered, where it was not this device. */
function By({ card }: { card: Card }) {
  const me = useThisDevice();
  const { by, admin } = card.answer ?? {};
  if (!by) {
    return null;
  }
  const other = admin && admin.id !== me.data?.admin?.id ? admin.name : undefined;
  return (
    <span className="text-ink-3">
      · {other ? t("card.byAdmin", { name: other, by }) : t("card.by", { by })}
    </span>
  );
}

/**
 * A question of an agent, as its own message: what is written in the chat answers it. A decision
 * has its choices as buttons, several things at once are a form.
 */
export function QuestionView({ card }: { card: Card }) {
  const answering = useContext(AnsweringContext);
  const [draft, setDraft] = useDraft(card.id);
  const [missing, setMissing] = useState<string[]>([]);
  const { answer, busy, problem } = useAnswer(card);
  const form = formOf(card);
  const alert = problem ? (
    <p role="alert" className="text-[0.8125rem] text-rose">
      {problem}
    </p>
  ) : null;

  if (card.state !== "open") {
    const chosen = card.actions.find((action) => action.id === card.answer?.action);
    return (
      <div className="flex flex-col gap-2.5">
        <Asked card={card} />
        {card.state === "expired" ? (
          <p className="text-[0.8125rem] text-ink-3">{t("card.expired")}</p>
        ) : card.answer?.action === REPLY_ACTION ? null : form ? (
          <Sent card={card} />
        ) : (
          <p className="flex items-center gap-1.5 text-[0.875rem] text-ink-2">
            <Check className="size-3.5 shrink-0 text-moss" />
            {chosen?.label ?? t("card.answered")}
            <By card={card} />
          </p>
        )}
        {alert}
      </div>
    );
  }

  const send = async (action: string) => {
    const empty = form ? missingIn(form, draft) : [];
    setMissing(empty);
    if (!empty.length && (await answer(action, form || isFree(card) ? draft : {}))) {
      setDraft(null);
    }
  };
  const words = typeof draft[REPLY_FIELD] === "string" ? draft[REPLY_FIELD] : "";
  const free = isFree(card);
  const open = answering && answering.target !== card.id;
  return (
    <section className="flex flex-col gap-2.5">
      <Asked card={card} />
      {form ? (
        <div className="flex flex-col gap-4 rounded-xl bg-card p-4 ring-1 ring-border">
          <FormFields
            fields={form}
            values={draft}
            missing={missing.filter((id) => !draft[id]?.length)}
            onChange={(id, value) => setDraft({ ...draft, [id]: value })}
          />
          <div className="flex flex-wrap items-center gap-2">
            {card.actions.map((action) => (
              <Button key={action.id} disabled={busy} onClick={() => void send(action.id)}>
                {t("question.send")}
              </Button>
            ))}
          </div>
          {alert}
        </div>
      ) : free ? null : (
        <div className="flex flex-wrap gap-2">
          {card.actions.map((action) => (
            <Button
              key={action.id}
              variant={action.style === "primary" ? "primary" : "secondary"}
              disabled={busy}
              onClick={() => void send(action.id)}
              className="h-auto min-h-10 max-w-full whitespace-normal py-2 text-left"
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}
      {free && !answering ? (
        // In the list there is no chat to write in.
        <div className="flex flex-col items-start gap-2">
          <Textarea
            aria-label={card.reply?.placeholder}
            placeholder={card.reply?.placeholder}
            minRows={2}
            value={words}
            onChange={(e) => setDraft({ [REPLY_FIELD]: e.target.value })}
          />
          <Button disabled={busy || !words.trim()} onClick={() => void send(REPLY_ACTION)}>
            {t("question.send")}
          </Button>
        </div>
      ) : null}
      {answering ? (
        <p className="flex min-h-8 flex-wrap items-center gap-x-2 text-[0.8125rem] text-ink-3">
          <span className="size-1.5 shrink-0 rounded-full bg-primary" />
          {t("question.waits")}
          {open ? (
            <button
              type="button"
              onClick={() => answering.pick(card.id)}
              className="inline-flex min-h-8 items-center gap-1 rounded-full px-2.5 text-ink-2 transition hover:bg-accent hover:text-ink coarse:min-h-11"
            >
              <CornerDownLeft className="size-3.5" />
              {t("question.answer")}
            </button>
          ) : null}
        </p>
      ) : null}
      {form ? null : alert}
    </section>
  );
}
