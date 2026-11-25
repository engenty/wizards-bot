import { NumberInput } from "@engenty/chatviews/react/field-looks";
import { Label, Segmented, Select, Textarea } from "@engenty/chatviews/react/ui";
import type { CardField } from "@wizards-bot/protocol";
import { UNSURE } from "@wizards-bot/protocol/limits";
import { Paperclip } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { ShownFile } from "../lib/files";
import { t } from "../lib/i18n";
import { useAttachments } from "../lib/uploads";
import { Button, cn, Input } from "../ui";
import { FilePreview, FileTile } from "../ui/FilePreview";

type Value = string | string[] | undefined;

/** More options than this, or longer ones, are a list to pick from instead of pills. */
const PILLS = 6;
const PILL_LENGTH = 32;

/** Files given as an answer: they go to the Bot Server as they are picked, the form names them. */
function FileField({ onChange }: { onChange: (ids: string[]) => void }) {
  const picker = useRef<HTMLInputElement>(null);
  const attached = useAttachments();
  const [shown, setShown] = useState<number | null>(null);
  const ids = attached.list.flatMap((each) => (each.ref ? [each.ref.id] : [])).join(" ");
  const change = useRef(onChange);
  change.current = onChange;
  const was = useRef("");
  useEffect(() => {
    if (ids !== was.current) {
      was.current = ids;
      change.current(ids ? ids.split(" ") : []);
    }
  }, [ids]);
  const failed = attached.list.find((each) => each.state === "failed");
  return (
    <div className="flex flex-col items-start gap-2">
      {attached.list.length ? (
        <ul className="flex flex-wrap gap-2">
          {attached.list.map((each, i) => (
            <FileTile
              key={each.key}
              file={each as ShownFile}
              label={t("files.open", { name: each.name })}
              state={each.state === "ready" ? undefined : each.state}
              onOpen={() => setShown(i)}
              onRemove={() => attached.remove(each.key)}
            />
          ))}
        </ul>
      ) : null}
      <Button variant="secondary" size="sm" onClick={() => picker.current?.click()}>
        <Paperclip className="size-4" />
        {t("question.file")}
      </Button>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          e.target.value = "";
          attached.add(picked);
        }}
      />
      <FilePreview files={attached.list} at={shown} onAt={setShown} />
      {attached.notice || failed ? (
        <p role="alert" className="text-[0.8125rem] text-rose">
          {attached.notice ??
            t("files.notAttached", { name: failed?.name ?? "", why: failed?.why ?? "" })}
        </p>
      ) : null}
    </div>
  );
}

function Control({
  id,
  field,
  value,
  onChange,
}: {
  id: string;
  field: CardField;
  value: Value;
  onChange: (value: string | string[]) => void;
}) {
  const typed = value === UNSURE || typeof value !== "string" ? "" : value;
  if (field.options) {
    const label = (option: string) =>
      field.options?.find((each) => each.id === option)?.label ?? option;
    const ids = field.options.map((option) => option.id);
    const multi = field.type === "multi";
    const pills =
      multi ||
      (ids.length <= PILLS && field.options.every((each) => each.label.length <= PILL_LENGTH));
    if (!pills) {
      return (
        <Select
          value={typeof value === "string" ? value : ""}
          placeholder={t("question.choose")}
          options={field.options.map((each) => ({ value: each.id, label: each.label }))}
          onChange={onChange}
        />
      );
    }
    return (
      <Segmented
        value={value ?? (multi ? [] : "")}
        options={ids}
        multi={multi}
        label={label}
        onChange={(next: string | string[]) => {
          // "I don't know" stands alone among several choices.
          if (multi && next.includes(UNSURE) && next.length > 1) {
            onChange(
              (value ?? []).includes(UNSURE)
                ? (next as string[]).filter((each) => each !== UNSURE)
                : [UNSURE],
            );
          } else {
            onChange(next);
          }
        }}
      />
    );
  }
  switch (field.type) {
    case "long_text":
      return (
        <Textarea
          id={id}
          value={typed}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case "number":
      return (
        <div className="max-w-52">
          <NumberInput
            value={typed}
            unit={field.unit}
            placeholder={field.placeholder}
            onChange={(next) => onChange(String(next ?? ""))}
          />
        </div>
      );
    case "file":
      return <FileField onChange={onChange} />;
    default:
      return (
        <Input
          id={id}
          type={field.type === "date" ? "date" : "text"}
          autoComplete="off"
          placeholder={field.placeholder}
          value={typed}
          onChange={(e) => onChange(e.target.value)}
          className={cn(field.type === "date" && "max-w-52")}
        />
      );
  }
}

/** One part of a form: what is asked, its control, and "I don't know" where the agent allows it. */
function Part({
  field,
  value,
  missing,
  onChange,
}: {
  field: CardField;
  value: Value;
  missing: boolean;
  onChange: (value: string | string[]) => void;
}) {
  const id = useId();
  const label = <Label required={field.required}>{field.label}</Label>;
  const control = <Control id={id} field={field} value={value} onChange={onChange} />;
  const unsure = field.unsure;
  return (
    <div>
      {field.options || field.type === "file" ? (
        <fieldset>
          <legend className="contents">{label}</legend>
          {control}
        </fieldset>
      ) : (
        // biome-ignore lint/a11y/noLabelWithoutControl: the control is inside
        <label className="block">
          {label}
          {control}
        </label>
      )}
      {unsure ? (
        <button
          type="button"
          aria-pressed={value === UNSURE}
          onClick={() => onChange(value === UNSURE ? "" : UNSURE)}
          className={cn(
            "mt-2 h-8 rounded-full border px-3 text-[0.8125rem] transition coarse:h-11",
            value === UNSURE
              ? "border-ember bg-ember-tint text-ink"
              : "border-input text-ink-3 hover:border-ink-4 hover:text-ink",
          )}
        >
          {unsure}
        </button>
      ) : null}
      {missing ? <p className="mt-1 text-[0.8125rem] text-rose">{t("question.empty")}</p> : null}
    </div>
  );
}

/** The parts of a form an agent asks with, drawn with the fields of @engenty/chatviews. */
export function FormFields({
  fields,
  values,
  missing,
  onChange,
}: {
  fields: CardField[];
  values: Record<string, string | string[]>;
  /** The parts to say that they are still empty. */
  missing: string[];
  onChange: (id: string, value: string | string[]) => void;
}) {
  return fields.map((field) => (
    <Part
      key={field.id}
      field={field}
      value={values[field.id]}
      missing={missing.includes(field.id)}
      onChange={(value) => onChange(field.id, value)}
    />
  ));
}
