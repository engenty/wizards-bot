// From engenty wizards, apps/web/src/ui/composer.tsx: the pill, its plus menu, files and
// dictation. The files go to the home as they are attached; a photo from the camera is one of
// them.
import type { FileRef } from "@wizards-bot/protocol";
import { ArrowUp, Camera, Mic, Paperclip, Plus, Square } from "lucide-react";
import { type ReactNode, type Ref, useEffect, useImperativeHandle, useRef, useState } from "react";
import { canUseCamera } from "../lib/device";
import { pastedName } from "../lib/files";
import { t } from "../lib/i18n";
import { useKeyboard } from "../lib/keyboard";
import { useDictation } from "../lib/speech";
import { useAttachments } from "../lib/uploads";
import { CameraDialog } from "./CameraDialog";
import { FilePreview, FileTile } from "./FilePreview";
import { cn, IconButton } from "./index";

/** One more entry in the plus menu, below the composer's own. */
interface PlusItem {
  icon: ReactNode;
  label: string;
  onSelect: () => void;
}

/** What a conversation around the composer can do with it: files dropped on it go in here. */
export interface ComposerHandle {
  add: (files: File[]) => void;
  /** Opens the file picker. */
  pick: () => void;
  focus: () => void;
  /** Puts a text at the end of what is being written, and the cursor after it. */
  insert: (text: string) => void;
}

/** Taller than this the field scrolls. */
const MAX_HEIGHT = 200;

const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
/** The keys that open the file picker: ⌘U on a Mac, Ctrl+U elsewhere. */
const UPLOAD_KEYS = MAC ? "⌘U" : "Ctrl+U";
/** The keys that send a message for after the answer under way. */
const LATER_KEYS = MAC ? "⌘↩" : "Ctrl+↩";

/**
 * The field a message is written in: text (typed or spoken), files (picked, pasted,
 * photographed or handed in through `ref`), and the send button. One line, it is a pill; the
 * buttons stay level with the text, and on the last line once it grows. An answer under way
 * (`busy`) does not lock it: Enter sends into it, ⌘↩ (Ctrl+↩) for after it, and an empty field
 * offers Stop.
 */
export function Composer({
  placeholder,
  busy,
  onStop,
  onSend,
  plus,
  className,
  ref,
}: {
  placeholder: string;
  /** An answer is under way. */
  busy: boolean;
  /** Stops the answer under way: its button stands where Send does while the field is empty. */
  onStop: () => void;
  /**
   * False keeps the draft, e.g. when the home did not take the message. `later`: the agent reads
   * it after the answer under way.
   */
  onSend: (text: string, files: FileRef[], later: boolean) => Promise<boolean>;
  plus: PlusItem[];
  className?: string;
  ref?: Ref<ComposerHandle>;
}) {
  const keyboard = useKeyboard();
  const [text, setText] = useState("");
  const attached = useAttachments();
  const [tall, setTall] = useState(false);
  const [camera, setCamera] = useState(false);
  const [previewAt, setPreviewAt] = useState<number | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const shot = useRef<HTMLInputElement>(null);
  const speech = useDictation(text, setText);
  const pick = () => picker.current?.click();
  useImperativeHandle(ref, () => ({
    add: attached.add,
    pick,
    focus: () => area.current?.focus(),
    insert: (piece: string) => {
      setText((was) => (was && !/\s$/.test(was) ? `${was} ${piece} ` : `${was}${piece} `));
      requestAnimationFrame(() => area.current?.focus());
    },
  }));

  // The height follows the text, typed or spoken, and the field's width. Empty, the field is one
  // line; a placeholder that wraps does not make it taller.
  useEffect(() => {
    const el = area.current;
    if (!el) {
      return;
    }
    const resize = () => {
      el.style.height = "auto";
      const one = Number.parseFloat(getComputedStyle(el).minHeight) || 0;
      el.style.height = text ? `${Math.min(el.scrollHeight, MAX_HEIGHT)}px` : "";
      setTall(Boolean(text) && el.scrollHeight > one + 1);
    };
    resize();
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      // Only a new width: the height this sets would call it again.
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        resize();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);

  const files = attached.list.flatMap((a) => (a.ref ? [a.ref] : []));
  const uploading = attached.list.some((a) => a.state === "uploading");
  const typed = Boolean(text.trim() || files.length > 0);
  const ready = typed && !uploading;
  const submit = async (later = false) => {
    if (!ready) {
      return;
    }
    speech.stop();
    const draft = text;
    const taken = attached.take();
    setText("");
    if (await onSend(draft.trim(), files, later && busy)) {
      attached.sent(taken);
    } else {
      setText(draft);
      attached.restore(taken);
    }
  };
  // Where the browser gives no camera, the phone's own camera app takes the photo.
  const photo = () => (canUseCamera ? setCamera(true) : shot.current?.click());
  const chosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = "";
    attached.add(picked);
  };

  return (
    <div className={className}>
      <div
        className={cn(
          "bg-card p-1 shadow-soft ring-1 ring-border focus-within:ring-focus",
          tall || attached.list.length ? "rounded-[1.375rem]" : "rounded-full",
        )}
      >
        {attached.list.length ? (
          <ul className="flex flex-wrap gap-2 px-2 pt-2 pb-1">
            {attached.list.map((a, i) => (
              <FileTile
                key={a.key}
                file={a}
                label={t("files.open", { name: a.name })}
                state={a.state === "ready" ? undefined : a.state}
                onOpen={() => setPreviewAt(i)}
                onRemove={() => attached.remove(a.key)}
              />
            ))}
          </ul>
        ) : null}
        {/* The field is as high as a button on one line, so text and buttons share a middle. */}
        <div className="flex items-end gap-0.5">
          <PlusMenu onAttach={pick} onPhoto={photo} items={plus} />
          <input ref={picker} type="file" multiple hidden onChange={chosen} />
          <input
            ref={shot}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={chosen}
          />
          <textarea
            ref={area}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const pasted = Array.from(e.clipboardData.files);
              if (pasted.length) {
                e.preventDefault();
                attached.add(pasted.map(pastedName));
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit(e.metaKey || e.ctrlKey);
              }
            }}
            aria-label={placeholder}
            placeholder={
              speech.listening
                ? t("composer.listening")
                : busy && keyboard
                  ? t("composer.later", { keys: LATER_KEYS })
                  : placeholder
            }
            className="max-h-[200px] min-h-9 flex-1 resize-none bg-transparent px-1 py-2 text-[0.9375rem] leading-5 outline-none placeholder:truncate placeholder:text-ink-4 coarse:min-h-11 coarse:py-3"
          />
          {speech.supported ? (
            <IconButton
              label={speech.listening ? t("composer.dictateStop") : t("composer.dictate")}
              aria-pressed={speech.listening}
              onClick={speech.toggle}
              className={cn(
                speech.listening && "bg-rose-tint text-rose hover:bg-rose-tint hover:text-rose",
              )}
            >
              {speech.listening ? (
                <Square className="size-3.5 animate-pulse-dot fill-current" />
              ) : (
                <Mic className="size-4" />
              )}
            </IconButton>
          ) : null}
          {busy && !typed ? (
            <button
              type="button"
              onClick={onStop}
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition coarse:size-11"
              aria-label={t("composer.stop")}
              title={t("composer.stop")}
            >
              <Square className="size-3 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!ready}
              className={cn(
                "inline-flex size-9 shrink-0 items-center justify-center rounded-full transition coarse:size-11",
                ready ? "bg-primary text-primary-foreground" : "bg-paper-2 text-ink-4",
              )}
              aria-label={t("composer.send")}
              title={t("composer.send")}
            >
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>
      </div>
      <FilePreview files={attached.list} at={previewAt} onAt={setPreviewAt} />
      <CameraDialog
        open={camera}
        onClose={() => setCamera(false)}
        onCapture={(file) => attached.add([file])}
        onNative={() => shot.current?.click()}
      />
      <div aria-live="polite" className="px-3 text-[0.75rem] text-rose empty:hidden">
        {attached.notice ? <p className="mt-2">{attached.notice}</p> : null}
        {attached.list.map((a) =>
          a.state === "failed" ? (
            <p key={a.key} className="mt-2">
              {t("files.notAttached", { name: a.name, why: a.why ?? "" })}
            </p>
          ) : null,
        )}
        {speech.error ? (
          <p className="mt-2">
            {t(speech.error === "denied" ? "composer.micDenied" : "composer.micFailed")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The plus button with its menu: add files (⌘U), take a photo, and the caller's entries. The
 * menu stands fixed to the window above the button, so nothing around the composer cuts it.
 */
function PlusMenu({
  onAttach,
  onPhoto,
  items,
}: {
  onAttach: () => void;
  onPhoto: () => void;
  items: PlusItem[];
}) {
  const keyboard = useKeyboard();
  const [at, setAt] = useState<{ bottom: number; left: number } | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!at) {
      return;
    }
    const away = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!(panel.current?.contains(target) || opener.current?.contains(target))) {
        setAt(null);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setAt(null);
        opener.current?.focus();
      }
    };
    const shut = () => setAt(null);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", shut);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", shut);
    };
  }, [at]);
  const toggle = () => {
    const rect = opener.current?.getBoundingClientRect();
    setAt(at || !rect ? null : { bottom: window.innerHeight - rect.top + 8, left: rect.left });
  };
  const row =
    "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[0.875rem] hover:bg-paper-2 coarse:py-3 [&>svg:first-child]:size-4 [&>svg:first-child]:text-ink-3";
  const entry = (item: PlusItem, keys?: string) => (
    <button
      key={item.label}
      type="button"
      role="menuitem"
      onClick={() => {
        setAt(null);
        item.onSelect();
      }}
      className={row}
    >
      {item.icon}
      <span className="flex-1">{item.label}</span>
      {keys ? <kbd className="font-sans text-[0.75rem] text-ink-4">{keys}</kbd> : null}
    </button>
  );
  return (
    <>
      <button
        ref={opener}
        type="button"
        aria-label={t("composer.more")}
        title={t("composer.more")}
        aria-haspopup="menu"
        aria-expanded={Boolean(at)}
        onClick={toggle}
        className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-ink-3 transition hover:bg-accent hover:text-ink coarse:size-11"
      >
        <Plus className="size-4" />
      </button>
      {at ? (
        <div
          ref={panel}
          role="menu"
          aria-label={t("composer.more")}
          style={{ bottom: at.bottom, left: at.left }}
          className="fixed z-50 w-72 max-w-[calc(100vw-2rem)] rounded-xl bg-card p-1 shadow-overlay ring-1 ring-border"
        >
          {entry(
            { icon: <Paperclip />, label: t("composer.upload"), onSelect: onAttach },
            keyboard ? UPLOAD_KEYS : undefined,
          )}
          {entry({ icon: <Camera />, label: t("composer.photo"), onSelect: onPhoto })}
          {items.length ? <div className="mx-2 my-1 border-border-soft border-t" /> : null}
          {items.map((item) => entry(item))}
        </div>
      ) : null}
    </>
  );
}
