import { Check } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from ".";

export interface MenuItem {
  icon: ReactNode;
  label: string;
  onSelect: () => void;
  /** For a choice of one: whether this is the one in effect. */
  checked?: boolean;
}

/**
 * A small menu at its button: above it when the button is in the lower half of the window, as the
 * composer's + is, below it otherwise, as the person's card at the top of the list is; it ends at
 * the button's right edge when the button stands in the right half. A click beside it or Escape
 * closes it. `head` is shown above the items, e.g. who is signed in.
 */
export function Menu({
  label,
  head,
  items,
  narrow = false,
  className,
  children,
}: {
  /** What the button and the menu are called for a screen reader. */
  label: string;
  head?: ReactNode;
  /** `null` draws a line between groups. */
  items: (MenuItem | null)[];
  /** A menu of a few short items. */
  narrow?: boolean;
  className?: string;
  /** What the button shows. */
  children: ReactNode;
}) {
  const [at, setAt] = useState<{
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  } | null>(null);
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
    if (at || !rect) {
      setAt(null);
    } else {
      // Below a button in the upper half, above one in the lower half; lined up with the button's
      // left edge, or with its right edge when the button stands in the right half.
      const vertical =
        rect.top + rect.height / 2 < window.innerHeight / 2
          ? { top: rect.bottom + 8 }
          : { bottom: window.innerHeight - rect.top + 8 };
      const horizontal =
        rect.left + rect.width / 2 > window.innerWidth / 2
          ? { right: Math.max(8, window.innerWidth - rect.right) }
          : { left: Math.max(8, rect.left) };
      setAt({ ...vertical, ...horizontal });
    }
  };
  return (
    <>
      <button
        ref={opener}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={Boolean(at)}
        onClick={toggle}
        className={className}
      >
        {children}
      </button>
      {at ? (
        <div
          ref={panel}
          role="menu"
          aria-label={label}
          style={{ top: at.top, bottom: at.bottom, left: at.left, right: at.right }}
          className={cn(
            "enter-pop fixed z-50 max-w-[calc(100vw-2rem)] rounded-xl bg-card p-1 shadow-overlay ring-1 ring-border",
            narrow ? "w-52" : "w-72",
          )}
        >
          {head ? <div className="px-3 pt-2 pb-1.5">{head}</div> : null}
          {items.map((item, i) =>
            item ? (
              <button
                key={item.label}
                type="button"
                {...(item.checked === undefined
                  ? { role: "menuitem" }
                  : { role: "menuitemradio", "aria-checked": item.checked })}
                onClick={() => {
                  setAt(null);
                  item.onSelect();
                }}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[0.875rem] hover:bg-paper-2 coarse:py-3",
                  "[&>svg:first-child]:size-4 [&>svg:first-child]:text-ink-3",
                )}
              >
                {item.icon}
                <span className="flex-1">{item.label}</span>
                {item.checked ? <Check className="size-4 shrink-0" /> : null}
              </button>
            ) : (
              <hr
                key={`line-${items[i - 1]?.label ?? "top"}`}
                className="mx-2 my-1 border-border-soft border-t"
              />
            ),
          )}
        </div>
      ) : null}
    </>
  );
}
