import { useQueryClient } from "@tanstack/react-query";
import type { Card, CardField } from "@wizards-bot/protocol";
import { Check } from "lucide-react";
import { useState } from "react";
import { ApiError, api } from "../lib/api";
import { withConsent } from "../lib/consent";
import { type Draft, useDraft } from "../lib/drafts";
import { applyEvent } from "../lib/events";
import { t } from "../lib/i18n";
import { keys } from "../lib/keys";
import { nameOf } from "../lib/paths";
import { useThisDevice } from "../lib/queries";
import { Button, cn, Input } from "../ui";
import { Markdown } from "../ui/Markdown";
import { QrCode } from "../ui/Qr";
import { FolderPicker } from "./FolderPicker";
import { PersonCard } from "./PersonCard";

const STYLES = { primary: "primary", plain: "secondary", danger: "danger" } as const;

/** What the fields hold: what the person typed, and where nothing was typed, what a field starts with. */
function valuesOf(fields: CardField[], draft: Draft): Draft {
  const starts = Object.fromEntries(
    fields.flatMap((field) => (field.value === undefined ? [] : [[field.id, field.value]])),
  );
  return { ...starts, ...draft };
}

/** The folder picked on an answered card. */
function folderOf(card: Card): string | undefined {
  const field = card.fields?.find((each) => each.type === "folder");
  const value = field ? card.answer?.values?.[field.id] : undefined;
  return typeof value === "string" && value ? value : undefined;
}

/** Whether every field the card requires has an answer. */
function filled(fields: CardField[], values: Draft): boolean {
  return fields.every((field) => !field.required || (values[field.id]?.length ?? 0) > 0);
}

function Field({
  cardId,
  field,
  value,
  onChange,
}: {
  cardId: string;
  field: CardField;
  value: string | string[] | undefined;
  onChange: (value: string | string[]) => void;
}) {
  const id = `${cardId}-${field.id}`;
  if (field.type === "folder") {
    return (
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 font-medium text-[0.875rem]">{field.label}</legend>
        <FolderPicker
          value={typeof value === "string" && value ? value : undefined}
          onChange={(path) => onChange(path ?? "")}
          hint={value === field.value ? field.placeholder : undefined}
        />
      </fieldset>
    );
  }
  if (field.type === "choice" || field.type === "multi") {
    const multi = field.type === "multi";
    const picked = Array.isArray(value) ? value : value ? [value] : [];
    return (
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1.5 font-medium text-[0.875rem]">{field.label}</legend>
        {(field.options ?? []).map((option) => (
          <label
            key={option.id}
            className="flex min-h-10 items-center gap-2.5 rounded-lg border border-input bg-card px-3 text-[0.875rem] has-checked:border-ember has-checked:bg-ember-tint coarse:min-h-11"
          >
            <input
              type={multi ? "checkbox" : "radio"}
              name={id}
              className="accent-(--ember)"
              checked={picked.includes(option.id)}
              onChange={(e) =>
                onChange(
                  multi
                    ? e.target.checked
                      ? [...picked, option.id]
                      : picked.filter((p) => p !== option.id)
                    : option.id,
                )
              }
            />
            {option.label}
          </label>
        ))}
      </fieldset>
    );
  }
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block font-medium text-[0.875rem]">
        {field.label}
      </label>
      <Input
        id={id}
        // A secret goes to the home and is never shown again; the browser does not keep it.
        type={field.type === "secret" ? "password" : "text"}
        autoComplete="off"
        spellCheck={false}
        placeholder={field.placeholder}
        value={typeof value === "string" ? value : ""}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

/**
 * A card, drawn from its data alone: title, body, fields, a sign-in link, a QR code and one
 * button per action. Answered or expired, it stays with its title and what was chosen. The
 * first answer wins: a card someone answered meanwhile shows that answer.
 */
export function CardView({ card }: { card: Card }) {
  const client = useQueryClient();
  const [draft, setDraft] = useDraft(card.id);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const me = useThisDevice();

  if (card.state !== "open") {
    const action = card.actions.find((each) => each.id === card.answer?.action);
    // A folder the person picked on the card is named beside the yes.
    const picked = action?.style === "primary" ? folderOf(card) : undefined;
    const chosen = action
      ? picked
        ? `${action.label} · ${nameOf(picked)}`
        : action.label
      : undefined;
    const by = card.answer?.by;
    // In a group home: another admin answered, and the card says who.
    const admin = card.answer?.admin;
    const other = admin && admin.id !== me.data?.admin?.id ? admin.name : undefined;
    return (
      <section className="rounded-xl bg-paper-2 px-4 py-3">
        <h3 className="font-medium text-[0.9375rem]">{card.title}</h3>
        <p className="mt-1 flex items-center gap-1.5 text-[0.8125rem] text-ink-2">
          <Check className="size-3.5 shrink-0 text-moss" />
          {card.state === "expired"
            ? t("card.expired")
            : by === "sign-in"
              ? t("card.signedIn")
              : (chosen ?? t("card.answered"))}
          {by && by !== "sign-in" ? (
            <span className="text-ink-3">
              · {other ? t("card.byAdmin", { name: other, by }) : t("card.by", { by })}
            </span>
          ) : null}
        </p>
        {problem ? (
          <p role="alert" className="mt-1 text-[0.8125rem] text-ink-3">
            {problem}
          </p>
        ) : null}
      </section>
    );
  }

  const fields = card.fields ?? [];
  const values = valuesOf(fields, draft);
  const complete = filled(fields, values);
  const answer = async (action: string) => {
    setBusy(true);
    setProblem(null);
    try {
      const { card: answered } = await withConsent(
        () =>
          api.post<{ card: Card }>(`/v1/cards/${card.id}/answer`, {
            action,
            ...(Object.keys(values).length ? { values } : {}),
          }),
        (models) => client.setQueryData(keys.models(), models),
      );
      setDraft(null);
      applyEvent(client, { type: "card.updated", card: answered });
    } catch (err) {
      const kept = err instanceof ApiError && err.code === "already_answered" && err.body?.card;
      if (kept) {
        setProblem(t("card.already"));
        applyEvent(client, { type: "card.updated", card: kept as Card });
      } else {
        setProblem((err as Error).message || t("card.failed"));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-3 rounded-xl bg-card p-4 shadow-soft ring-1 ring-border-soft">
      <h3 className="font-display font-semibold text-[1.0625rem] leading-snug">{card.title}</h3>
      {card.body ? <Markdown text={card.body} className="text-[0.875rem]" /> : null}
      {card.qr ? <QrCode text={card.qr} label={t("card.qr", { title: card.title })} /> : null}
      {fields.map((field) => (
        <Field
          key={field.id}
          cardId={card.id}
          field={field}
          value={values[field.id]}
          onChange={(value) => setDraft({ ...draft, [field.id]: value })}
        />
      ))}
      {card.url || card.actions.length ? (
        <div className="flex flex-wrap gap-2">
          {card.url === "wizardsbot://person" ? (
            // The person's key is made, and their record signed, on this device.
            <PersonCard />
          ) : card.url?.startsWith("wizardsbot://") ? (
            // A call or a message the phone puts together from its own contacts.
            <p className="text-[0.875rem] text-ink-2">{t("card.onPhone")}</p>
          ) : card.url ? (
            <a
              href={card.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-10 items-center justify-center rounded-full bg-primary px-4 font-medium text-primary-foreground text-sm hover:brightness-[1.06] coarse:h-11"
            >
              {card.kind === "connect" ? t("card.signIn") : t("card.open")}
            </a>
          ) : null}
          {card.actions.map((action) => (
            <Button
              key={action.id}
              variant={STYLES[action.style]}
              disabled={busy || (action.style === "primary" && !complete)}
              onClick={() => void answer(action.id)}
              className={cn(action.style === "danger" && "border border-border")}
            >
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
      {problem ? (
        <p role="alert" className="text-[0.8125rem] text-rose">
          {problem}
        </p>
      ) : null}
    </section>
  );
}
