import { type ViewHost, ViewRenderer } from "@engenty/chatviews/react/chat";
import type { Card } from "@wizards-bot/protocol";
import { VIEW_ANSWER } from "@wizards-bot/protocol/limits";
import { Check } from "lucide-react";
import { useMemo } from "react";
import { viewDraft } from "../lib/drafts";
import { t } from "../lib/i18n";
import { useThisDevice } from "../lib/queries";
import { useAnswer } from "./useAnswer";
import { formOf, stateOf, valuesOf } from "./viewForm";

/** What OpenUI's renderer says when the person pressed something in a view. */
type Pressed = Parameters<NonNullable<Parameters<typeof ViewRenderer>[0]["onAction"]>>[0];

/** An address a view's button may open: a page on the web or a mail, in a tab of its own. */
const opens = (url: unknown): url is string =>
  typeof url === "string" && /^(https:|http:|mailto:)/i.test(url.trim());

/**
 * A card that carries a view an agent wrote (`show_view`), drawn with the components of
 * @engenty/chatviews. A button that asks the agent and a form's send button answer the card:
 * what the person says with it and the form's values go to the home, and the agent reads them
 * as the person's message. The first answer wins; an answered view stays, with its form as it
 * was sent.
 */
export function ViewCard({ card }: { card: Card }) {
  const { answer, busy, problem } = useAnswer(card);
  const me = useThisDevice();
  const program = card.view?.program ?? "";
  const form = useMemo(() => formOf(program), [program]);
  const open = card.state === "open";
  const sent = card.answer?.state;
  // The form as it was sent, or as the person left it in this card before.
  const initial = useMemo(
    () => (sent && form ? stateOf(form, sent) : viewDraft.get(card.id)),
    [sent, form, card.id],
  );
  const person = card.answer?.person;
  const other = person && person.id !== me.data?.person?.id ? person.name : undefined;
  const by = card.answer?.by;
  const host: ViewHost = {
    // A view on a Bot Server shows no files: the home stores none that names one.
    assetUrl: () => "",
    answered: card.answer ? { by: person?.name ?? by ?? "" } : null,
  };

  const pressed = (event: Pressed) => {
    if (event.type === "open_url") {
      if (opens(event.params.url)) window.open(event.params.url.trim(), "_blank", "noopener");
      return;
    }
    if (event.type !== "continue_conversation" || !open || busy) return;
    const state = form ? valuesOf(form, event.formState) : undefined;
    void answer(VIEW_ANSWER, {}, { message: event.humanFriendlyMessage, state }).then((taken) => {
      if (taken) viewDraft.set(card.id, null);
    });
  };

  return (
    <section className="flex flex-col gap-3 rounded-xl bg-card p-4 shadow-soft ring-1 ring-border-soft max-sm:gap-2 max-sm:p-3">
      <h3 className="font-display font-semibold text-[1.0625rem] leading-snug">{card.title}</h3>
      <ViewRenderer
        program={program}
        host={host}
        onAction={pressed}
        initialState={initial}
        onStateUpdate={(state) => {
          if (open) viewDraft.set(card.id, state);
        }}
      />
      {card.answer || card.state === "expired" ? (
        <p className="flex items-center gap-1.5 text-[0.8125rem] text-ink-2">
          <Check className="size-3.5 shrink-0 text-moss" />
          {card.state === "expired"
            ? t("card.expired")
            : card.answer?.message
              ? t("card.viewSaid", { said: card.answer.message })
              : t("card.answered")}
          {by ? (
            <span className="text-ink-3">
              · {other ? t("card.byPerson", { name: other, by }) : t("card.by", { by })}
            </span>
          ) : null}
        </p>
      ) : null}
      {problem ? (
        <p role="alert" className="text-[0.8125rem] text-rose">
          {problem}
        </p>
      ) : null}
    </section>
  );
}
