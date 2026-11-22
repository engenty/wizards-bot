import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from ".";

export interface MenuItem {
  icon: ReactNode;
  label: string;
  onSelect: () => void;
}

/**
 * A small menu at its button: above it when the button is in the lower half of the window, as the
 * composer's + is, below it otherwise, as the person's card at the top of the list is. A click
 * beside it or Escape closes it. `head` is shown above the items, e.g. who is signed in.
 */
export function Menu({
  label,
  head,
  items,
  className,
  children,
}: {
  /** What the button and the menu are called for a screen reader. */
  label: string;
  head?: ReactNode;
  /** `null` draws a line between groups. */
  items: (MenuItem | null)[];
  className?: string;
  /** What the button shows. */
  children: ReactNode;
}) {
  const [at, setAt] = useState<{ top?: number; bottom?: number; left: number } | null>(null);
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
    } else if (rect.top + rect.height / 2 < window.innerHeight / 2) {
      setAt({ top: rect.bottom + 8, left: rect.left });
    } else {
      setAt({ bottom: window.innerHeight - rect.top + 8, left: rect.left });
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
          style={{ top: at.top, bottom: at.bottom, left: Math.max(8, at.left) }}
          className="enter-pop fixed z-50 w-72 max-w-[calc(100vw-2rem)] rounded-xl bg-card p-1 shadow-overlay ring-1 ring-border"
        >
          {head ? <div className="px-3 pt-2 pb-1.5">{head}</div> : null}
          {items.map((item, i) =>
            item ? (
              <button
                key={item.label}
                type="button"
                role="menuitem"
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
