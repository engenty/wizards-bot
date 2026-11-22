import { useQueryClient } from "@tanstack/react-query";
import { DEFAULT_AVATAR, GARMENT, HAIR, SKIN } from "@wizards-bot/avatar";
import type { Avatar, AvatarFromSelfie, FileRef } from "@wizards-bot/protocol";
import { Camera, ImageUp } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../lib/api";
import {
  ACCESSORIES,
  BEARDS,
  BOTTOMS,
  cssColor,
  GARMENT_NAMES,
  GLASSES,
  HAIR_NAMES,
  HAIR_STYLES,
  HATS,
  SHOES,
  SKIN_NAMES,
  sameAvatar,
  TOPS,
} from "../lib/avatar";
import { canUseCamera } from "../lib/device";
import { type Key, orList, t } from "../lib/i18n";
import { shrinkImage } from "../lib/image";
import { keys } from "../lib/keys";
import { Button, cn, Dialog, Spinner } from "../ui";
import { CameraDialog } from "../ui/CameraDialog";
import { StackedAvatar } from "../ui/StackedAvatar";

/** One trait of the figure: its name, and beside it what there is to choose. */
function Trait({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3 py-2.5">
      <span className="w-20 shrink-0 pt-1 text-[0.8125rem] text-ink-3">{label}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">{children}</div>
    </div>
  );
}

/** A handful of named options as small buttons; the chosen one is marked. */
function Options<T extends string>({
  label,
  value,
  names,
  onChange,
}: {
  label: string;
  value: T;
  names: Record<T, Key>;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="flex flex-wrap gap-1.5">
      <legend className="sr-only">{label}</legend>
      {(Object.keys(names) as T[]).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === value}
          onClick={() => onChange(option)}
          className={cn(
            "h-7 rounded-full border px-2.5 text-[0.8125rem] transition coarse:h-9 coarse:px-3",
            option === value
              ? "border-ember bg-ember-tint text-ink"
              : "border-input bg-card text-ink-2 hover:border-ink-4 hover:text-ink",
          )}
        >
          {t(names[option])}
        </button>
      ))}
    </fieldset>
  );
}

/** The colours of a palette as round swatches; each says its name. */
function Swatches<T extends string>({
  label,
  value,
  colors,
  names,
  onChange,
}: {
  label: string;
  value: T;
  colors: Record<T, number>;
  names: Record<T, Key>;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="flex flex-wrap gap-2">
      <legend className="sr-only">{label}</legend>
      {(Object.keys(names) as T[]).map((color) => (
        <button
          key={color}
          type="button"
          aria-pressed={color === value}
          aria-label={t(names[color])}
          title={t(names[color])}
          onClick={() => onChange(color)}
          style={{ background: cssColor(colors[color]) }}
          className={cn(
            "size-6 rounded-full ring-1 ring-border transition coarse:size-8",
            color === value && "ring-2 ring-ink ring-offset-2 ring-offset-card",
          )}
        />
      ))}
    </fieldset>
  );
}

/** The traits come in three groups; one is open at a time. */
type Group = "head" | "clothes" | "extras";
const GROUPS: Record<Group, Key> = {
  head: "avatar.group.head",
  clothes: "avatar.group.clothes",
  extras: "avatar.group.extras",
};

/** Which group of traits is open, as one row of three. */
function Groups({ value, onChange }: { value: Group; onChange: (group: Group) => void }) {
  return (
    <div className="mt-3 flex rounded-full bg-paper-2 p-0.5">
      {(Object.keys(GROUPS) as Group[]).map((group) => (
        <button
          key={group}
          type="button"
          aria-pressed={group === value}
          onClick={() => onChange(group)}
          className={cn(
            "h-7 flex-1 rounded-full text-[0.8125rem] transition coarse:h-9",
            group === value ? "bg-card text-ink shadow-sm" : "text-ink-3 hover:text-ink",
          )}
        >
          {t(GROUPS[group])}
        </button>
      ))}
    </div>
  );
}

/** Choices that change the head, each drawn as the person's own head with it. */
function Heads<T extends string>({
  label,
  value,
  names,
  draw,
  onChange,
}: {
  label: string;
  value: T;
  names: Record<T, Key>;
  draw: (option: T) => Avatar;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="flex flex-wrap gap-1.5">
      <legend className="sr-only">{label}</legend>
      {(Object.keys(names) as T[]).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={option === value}
          aria-label={t(names[option])}
          title={t(names[option])}
          onClick={() => onChange(option)}
          className={cn(
            "rounded-[24%] ring-1 transition",
            option === value
              ? "ring-2 ring-ember ring-offset-1 ring-offset-card"
              : "ring-border hover:ring-ink-4",
          )}
        >
          <StackedAvatar avatar={draw(option)} size={1} view="head" />
        </button>
      ))}
    </fieldset>
  );
}

/** Where a selfie is on its way to a figure. `asking`: the home kept it and waits for a yes. */
type Selfie =
  | { step: "idle" | "uploading" | "looking" }
  | { step: "asking"; fileId: string; models: string[] };

/** Deletes a picture the home kept. */
const drop = (fileId: string) => api.del(`/v1/files/${fileId}`).catch(() => undefined);

function Editor({ saved, onClose }: { saved: Avatar | null; onClose: () => void }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState(saved ?? DEFAULT_AVATAR);
  /** The person has changed the figure here: it no longer follows what the home has. */
  const [changed, setChanged] = useState(false);
  const [selfie, setSelfie] = useState<Selfie>({ step: "idle" });
  const [note, setNote] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [camera, setCamera] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [group, setGroup] = useState<Group>("head");
  const picker = useRef<HTMLInputElement>(null);
  const shot = useRef<HTMLInputElement>(null);
  /** A picture the home keeps until the person has answered; and whether this editor is gone. */
  const kept = useRef<string | null>(null);
  const gone = useRef(false);

  const change = (next: Avatar) => {
    setDraft(next);
    setChanged(true);
  };
  useEffect(() => {
    if (!changed) {
      setDraft(saved ?? DEFAULT_AVATAR);
    }
  }, [saved, changed]);

  // Closed with the question open: no picture stays in the home without an answer.
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
      if (kept.current) {
        void drop(kept.current);
      }
    };
  }, []);

  const look = async (fileId: string, anywhere: boolean) => {
    kept.current = null;
    setSelfie({ step: "looking" });
    try {
      const made = await api.post<AvatarFromSelfie>("/v1/avatar/from-selfie", {
        fileId,
        anywhere,
      });
      change(made.avatar);
      setNote(t("avatar.looked", { model: made.model, where: made.where }));
      setSelfie({ step: "idle" });
    } catch (err) {
      if (!(err instanceof ApiError && err.code === "leaves_home")) {
        setProblem((err as Error).message);
        setSelfie({ step: "idle" });
      } else if (gone.current) {
        void drop(fileId);
      } else {
        kept.current = fileId;
        const models = Array.isArray(err.body?.models) ? (err.body.models as string[]) : [];
        setSelfie({ step: "asking", fileId, models });
      }
    }
  };
  const start = async (picked: File | undefined) => {
    if (!picked) {
      return;
    }
    setNote(null);
    setProblem(null);
    setSelfie({ step: "uploading" });
    try {
      const file = await api.upload<FileRef>("/v1/files", await shrinkImage(picked));
      await look(file.id, false);
    } catch (err) {
      setProblem((err as Error).message);
      setSelfie({ step: "idle" });
    }
  };
  const chosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    e.target.value = "";
    void start(picked);
  };
  const store = async (work: Promise<Avatar | null>) => {
    setSaving(true);
    setProblem(null);
    try {
      client.setQueryData(keys.avatar(), await work);
      onClose();
    } catch (err) {
      setProblem((err as Error).message);
      setSaving(false);
    }
  };

  const busy = selfie.step === "uploading" || selfie.step === "looking";
  return (
    <div className="flex flex-col">
      <div className="-mt-2 sticky top-0 z-10 flex justify-center bg-card pb-2">
        <StackedAvatar avatar={draft} size={2} turns follows label={t("avatar.turn")} />
      </div>

      <div className="flex flex-col gap-2 border-border-soft border-b pb-4">
        <p className="font-medium text-[0.875rem]">{t("avatar.selfie")}</p>
        {selfie.step === "asking" ? (
          <>
            <p className="text-[0.875rem] text-ink-2 leading-relaxed">
              {t("avatar.leaves", { models: orList(selfie.models) })}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  kept.current = null;
                  setSelfie({ step: "idle" });
                  void drop(selfie.fileId).then(() => setNote(t("avatar.pictureDeleted")));
                }}
              >
                {t("avatar.deletePicture")}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => void look(selfie.fileId, true)}>
                {t("avatar.send")}
              </Button>
            </div>
          </>
        ) : busy ? (
          <p role="status" className="flex items-center gap-2 text-[0.875rem] text-ink-2">
            <Spinner className="size-4 shrink-0" />
            {t(selfie.step === "uploading" ? "avatar.uploading" : "avatar.looking")}
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              size="sm"
              // Where the browser gives no camera, the phone's own camera app takes the photo.
              onClick={() => (canUseCamera ? setCamera(true) : shot.current?.click())}
            >
              <Camera className="size-4" />
              {t("composer.photo")}
            </Button>
            <Button variant="secondary" size="sm" onClick={() => picker.current?.click()}>
              <ImageUp className="size-4" />
              {t("avatar.choose")}
            </Button>
          </div>
        )}
        <input ref={picker} type="file" accept="image/*" hidden onChange={chosen} />
        <input ref={shot} type="file" accept="image/*" capture="user" hidden onChange={chosen} />
        {note ? <p className="text-[0.8125rem] text-ink-3 leading-relaxed">{note}</p> : null}
      </div>

      <Groups value={group} onChange={setGroup} />
      <div key={group} className="enter-fade divide-y divide-border-soft">
        {group === "head" ? (
          <>
            <Trait label={t("avatar.skin")}>
              <Swatches
                label={t("avatar.skin")}
                value={draft.skin}
                colors={SKIN}
                names={SKIN_NAMES}
                onChange={(skin) => change({ ...draft, skin })}
              />
            </Trait>
            <Trait label={t("avatar.hair")}>
              <Heads
                label={t("avatar.hair")}
                value={draft.hair.style}
                names={HAIR_STYLES}
                // The hair as it is without a hat, whatever is worn now.
                draw={(style) => ({
                  ...draft,
                  hair: { ...draft.hair, style },
                  hat: { ...draft.hat, style: "none" },
                })}
                onChange={(style) => change({ ...draft, hair: { ...draft.hair, style } })}
              />
              {draft.hair.style === "bald" ? null : (
                <Swatches
                  label={t("avatar.colour", { trait: t("avatar.hair") })}
                  value={draft.hair.color}
                  colors={HAIR}
                  names={HAIR_NAMES}
                  onChange={(color) => change({ ...draft, hair: { ...draft.hair, color } })}
                />
              )}
            </Trait>
            <Trait label={t("avatar.beard")}>
              <Options
                label={t("avatar.beard")}
                value={draft.beard}
                names={BEARDS}
                onChange={(beard) => change({ ...draft, beard })}
              />
            </Trait>
            <Trait label={t("avatar.glasses")}>
              <Options
                label={t("avatar.glasses")}
                value={draft.glasses}
                names={GLASSES}
                onChange={(glasses) => change({ ...draft, glasses })}
              />
            </Trait>
          </>
        ) : group === "clothes" ? (
          <>
            <Trait label={t("avatar.top")}>
              <Options
                label={t("avatar.top")}
                value={draft.top.style}
                names={TOPS}
                onChange={(style) => change({ ...draft, top: { ...draft.top, style } })}
              />
              <Swatches
                label={t("avatar.colour", { trait: t("avatar.top") })}
                value={draft.top.color}
                colors={GARMENT}
                names={GARMENT_NAMES}
                onChange={(color) => change({ ...draft, top: { ...draft.top, color } })}
              />
            </Trait>
            <Trait label={t("avatar.bottom")}>
              <Options
                label={t("avatar.bottom")}
                value={draft.bottom.style}
                names={BOTTOMS}
                onChange={(style) => change({ ...draft, bottom: { ...draft.bottom, style } })}
              />
              <Swatches
                label={t("avatar.colour", { trait: t("avatar.bottom") })}
                value={draft.bottom.color}
                colors={GARMENT}
                names={GARMENT_NAMES}
                onChange={(color) => change({ ...draft, bottom: { ...draft.bottom, color } })}
              />
            </Trait>
            <Trait label={t("avatar.shoes")}>
              <Options
                label={t("avatar.shoes")}
                value={draft.shoes.style}
                names={SHOES}
                onChange={(style) => change({ ...draft, shoes: { ...draft.shoes, style } })}
              />
              <Swatches
                label={t("avatar.colour", { trait: t("avatar.shoes") })}
                value={draft.shoes.color}
                colors={GARMENT}
                names={GARMENT_NAMES}
                onChange={(color) => change({ ...draft, shoes: { ...draft.shoes, color } })}
              />
            </Trait>
          </>
        ) : (
          <>
            <Trait label={t("avatar.hat")}>
              <Options
                label={t("avatar.hat")}
                value={draft.hat.style}
                names={HATS}
                onChange={(style) => change({ ...draft, hat: { ...draft.hat, style } })}
              />
              {draft.hat.style === "none" ? null : (
                <Swatches
                  label={t("avatar.colour", { trait: t("avatar.hat") })}
                  value={draft.hat.color}
                  colors={GARMENT}
                  names={GARMENT_NAMES}
                  onChange={(color) => change({ ...draft, hat: { ...draft.hat, color } })}
                />
              )}
            </Trait>
            <Trait label={t("avatar.accessory")}>
              <Options
                label={t("avatar.accessory")}
                value={draft.accessory.style}
                names={ACCESSORIES}
                onChange={(style) => change({ ...draft, accessory: { ...draft.accessory, style } })}
              />
              {draft.accessory.style === "none" ? null : (
                <Swatches
                  label={t("avatar.colour", { trait: t("avatar.accessory") })}
                  value={draft.accessory.color}
                  colors={GARMENT}
                  names={GARMENT_NAMES}
                  onChange={(color) =>
                    change({ ...draft, accessory: { ...draft.accessory, color } })
                  }
                />
              )}
            </Trait>
          </>
        )}
      </div>

      {problem ? (
        <p role="alert" className="mt-2 text-[0.875rem] text-rose">
          {problem}
        </p>
      ) : null}
      {removing ? (
        <div className="mt-4 flex flex-col gap-3">
          <p className="text-[0.875rem]">{t("avatar.removeAsk")}</p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRemoving(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="secondary"
              busy={saving}
              onClick={() => void store(api.del("/v1/avatar").then(() => null))}
            >
              {t("avatar.remove")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {saved ? (
            <Button variant="ghost" className="mr-auto" onClick={() => setRemoving(true)}>
              {t("avatar.remove")}
            </Button>
          ) : null}
          <Button
            busy={saving}
            disabled={busy || Boolean(saved && sameAvatar(saved, draft))}
            onClick={() =>
              void store(api.put<{ avatar: Avatar }>("/v1/avatar", draft).then((r) => r.avatar))
            }
          >
            {t("avatar.save")}
          </Button>
        </div>
      )}
      <CameraDialog
        open={camera}
        selfie
        onClose={() => setCamera(false)}
        onCapture={(file) => void start(file)}
        onNative={() => shot.current?.click()}
      />
    </div>
  );
}

/**
 * The avatar editor: the figure that turns, a selfie a model reads the traits from, and every
 * trait to adjust by hand. Nothing is kept until it is saved. A selfie goes to the home, is
 * looked at once and deleted; when no model on the person's computer sees pictures, the person
 * decides whether it may leave the computer.
 */
export function AvatarDialog({
  open,
  saved,
  onClose,
}: {
  open: boolean;
  /** The avatar the home has; null: none yet. */
  saved: Avatar | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={t("avatar.title")}>
      <Editor saved={saved} onClose={onClose} />
    </Dialog>
  );
}
