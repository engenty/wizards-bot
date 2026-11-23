// From engenty wizards, packages/runner/src/ui.tsx: the primitives this app uses.
import {
  type ButtonHTMLAttributes,
  forwardRef,
  type InputHTMLAttributes,
  type ReactNode,
  useEffect,
  useRef,
} from "react";
import { t } from "../lib/i18n";
import { useLingering } from "../lib/motion";

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-primary text-primary-foreground hover:brightness-[1.06] active:brightness-95 shadow-[0_1px_0_oklch(0%_0_0/0.08)]",
  secondary: "bg-card text-ink border border-border hover:bg-paper-2",
  ghost: "text-ink-2 hover:text-ink hover:bg-accent",
  danger: "text-rose hover:bg-rose-tint",
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: Variant;
    size?: "sm" | "md";
    busy?: boolean;
  }
>(function Button(
  { variant = "primary", size = "md", busy, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || busy}
      className={cn(
        "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-full font-medium transition-[background,filter,color,transform] duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50",
        size === "sm" && "h-8 px-3 text-[0.8125rem] coarse:h-11 coarse:px-4",
        size === "md" && "h-10 px-4 text-sm coarse:h-11",
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {busy ? <Spinner className="size-4" /> : null}
      {children}
    </button>
  );
});

export function IconButton({
  label,
  className,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-9 shrink-0 items-center justify-center rounded-full text-ink-3 transition hover:bg-accent hover:text-ink active:scale-90 disabled:opacity-40 coarse:size-11",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

const fieldBase =
  "rounded-lg border border-input bg-card px-3.5 text-[0.9375rem] text-ink shadow-[inset_0_1px_0_oklch(0%_0_0/0.02)] outline-none transition placeholder:text-ink-4 focus:border-focus focus:ring-4 focus:ring-focus-glow disabled:opacity-60";

/** A field fills its row unless the caller gives it a width. */
function fieldWidth(className?: string) {
  return /(^|\s)w-/.test(className ?? "") ? null : "w-full";
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={cn(fieldBase, fieldWidth(className), "h-11", className)}
        {...rest}
      />
    );
  },
);

export function Select({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  /** What is chosen here, for a screen reader. */
  label: string;
  className?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <select
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          fieldBase,
          "h-9 w-full appearance-none pr-9 pl-3 text-[0.8125rem] coarse:h-11",
        )}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <svg
        className="-translate-y-1/2 pointer-events-none absolute top-1/2 right-3 size-4 text-ink-3"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
      >
        <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn("size-5 animate-spin", className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** A state in a word: lower case, no period. `live` carries a dot. */
export function Chip({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "live";
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 font-medium text-[0.75rem]",
        tone === "neutral" && "bg-paper-2 text-ink-2",
        tone === "live" && "bg-moss-tint text-moss",
      )}
    >
      {tone === "live" ? <span className="size-1.5 rounded-full bg-moss" /> : null}
      {children}
    </span>
  );
}

/**
 * Whether the person last used a pointer rather than Tab: a dialog opened by a click gives the
 * focus back to its button without the ring the browser would draw there; after Tab it stays.
 */
let byPointer = false;
if (typeof window !== "undefined") {
  window.addEventListener(
    "pointerdown",
    () => {
      byPointer = true;
    },
    true,
  );
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Tab") byPointer = false;
    },
    true,
  );
}

/**
 * A centred modal on the native <dialog>; on a phone it fills the screen, with no gutter. Esc
 * and a click beside it close it. Its height does not jump while it is open: it keeps the
 * tallest height it has had, so a shorter step leaves it where it is.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  wide,
  bare,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  /** `"full"`: nearly the whole window, for a file to look at. `"settings"`: room for two columns. */
  wide?: "full" | "settings" | "palette";
  /**
   * The children are the panel: the dialog itself draws no card, clips nothing and fills the
   * screen of a phone.
   */
  bare?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // What the dialog shows stays while it closes.
  const shown = useLingering(open ? true : null, 160).value;
  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    if (open && !el.open) {
      el.showModal();
      // A modal dialog focuses its first control (the close button); a field marked
      // `data-autofocus` is where typing starts instead.
      el.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    } else if (!open && el.open) {
      el.close();
      if (byPointer) {
        (document.activeElement as HTMLElement | null)?.blur();
      }
    }
  }, [open]);
  // Open, the dialog never gets shorter than it has been, within what the window allows.
  useEffect(() => {
    const el = ref.current;
    if (!el || !open || bare || wide === "settings") {
      return;
    }
    let tallest = 0;
    const keep = () => {
      tallest = Math.max(tallest, el.getBoundingClientRect().height);
      el.style.minHeight = `${Math.min(tallest, window.innerHeight - 32)}px`;
    };
    const observer = new ResizeObserver(keep);
    observer.observe(el);
    window.addEventListener("resize", keep);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", keep);
      el.style.minHeight = "";
    };
  }, [open, bare, wide]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc closes a dialog; a click beside it is the pointer's way
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) {
          onClose();
        }
      }}
      className={cn(
        "sheet m-auto p-0 text-ink backdrop:bg-[oklch(20%_0.01_60/0.28)] backdrop:backdrop-blur-[2px]",
        // A phone: the whole screen, no gutter, clear of the notch and the home indicator.
        "max-sm:m-0 max-sm:h-dvh max-sm:max-h-none max-sm:w-full max-sm:max-w-none",
        bare
          ? "w-[calc(100%-48px)] overflow-visible bg-transparent"
          : "max-h-[calc(100dvh-32px)] w-[calc(100%-32px)] overflow-y-auto overscroll-contain rounded-2xl bg-card shadow-overlay max-sm:rounded-none max-sm:pt-[env(safe-area-inset-top)] max-sm:pb-[env(safe-area-inset-bottom)]",
        wide === "full"
          ? "sm:max-w-7xl"
          : wide === "settings"
            ? "sm:h-[min(36rem,calc(100dvh-32px))] sm:max-w-3xl sm:overflow-hidden"
            : wide === "palette"
              ? "sm:max-w-2xl"
              : "sm:max-w-md",
      )}
    >
      {shown && bare ? (
        children
      ) : shown ? (
        // As tall as the dialog has been, so a step can keep its buttons at the lower edge.
        wide === "settings" ? (
          // A compact bar with the title and a line under it; the children lay out the rest.
          <div className="flex h-full min-h-[inherit] flex-col">
            <div className="flex shrink-0 items-center justify-between gap-3 border-border-soft border-b py-1 pr-2 pl-5">
              <h2 className="min-w-0 truncate font-medium text-[0.9375rem]">{title}</h2>
              <IconButton label={t("common.close")} onClick={onClose} className="size-8">
                <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden="true">
                  <path
                    d="M4 4l8 8M12 4l-8 8"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </IconButton>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">{children}</div>
          </div>
        ) : (
          <div className="flex min-h-[inherit] flex-col p-5 sm:p-7">
            {title ? (
              <div className="mb-5 flex items-start justify-between gap-3">
                <h2 className="min-w-0 font-display font-semibold text-xl">{title}</h2>
                <IconButton label={t("common.close")} onClick={onClose} className="-mt-1.5 -mr-2">
                  <svg viewBox="0 0 16 16" fill="none" className="size-4" aria-hidden="true">
                    <path
                      d="M4 4l8 8M12 4l-8 8"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </IconButton>
              </div>
            ) : null}
            {children}
          </div>
        )
      ) : null}
    </dialog>
  );
}
