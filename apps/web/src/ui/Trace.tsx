// From engenty wizards, apps/web/src/components/ui/trace.tsx (shadcn/ui Trace), in this app's
// tokens, with a button of its own for Base UI's collapsible.
import { ChevronRight } from "lucide-react";
import { type ComponentProps, type ReactNode, useId, useState } from "react";
import { cn } from ".";

/** Lines of steps, one under the other. */
export function Trace({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex w-full min-w-0 flex-col gap-1.5", className)} {...props} />;
}

export function TraceLine({
  className,
  status,
  ...props
}: ComponentProps<"span"> & { status?: "running" | "error" }) {
  return (
    <span
      data-status={status}
      className={cn(
        "flex w-fit min-w-0 max-w-full items-center gap-2 text-[0.8125rem] text-ink-3 leading-5",
        className,
      )}
      {...props}
    />
  );
}

export function TraceIcon({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-4 shrink-0 items-center justify-center [&_svg]:pointer-events-none [&_svg]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

export function TraceTitle({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("min-w-0 truncate", className)} {...props} />;
}

export function TraceDescription({ className, ...props }: ComponentProps<"span">) {
  return (
    <span
      className={cn("min-w-0 flex-1 basis-0 truncate text-ink-4 tabular-nums", className)}
      {...props}
    />
  );
}

/** A line that opens what is under it. What is folded away is not reached by the keyboard. */
export function TraceCollapsible({
  line,
  className,
  children,
}: {
  line: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex w-full min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
        className="group relative flex w-fit min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-md text-left text-ink-3 outline-none transition-colors hover:text-ink focus-visible:bg-accent coarse:after:absolute coarse:after:inset-x-0 coarse:after:-inset-y-1.5"
      >
        {line}
        <TraceIcon className="text-ink-4 group-aria-expanded:rotate-90 motion-safe:transition-transform">
          <ChevronRight />
        </TraceIcon>
      </button>
      <div
        id={id}
        inert={!open}
        className={cn(
          "grid motion-safe:transition-[grid-template-rows] motion-safe:duration-200",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        )}
      >
        <div className="min-w-0 overflow-hidden">
          <div
            className={cn(
              "mt-1.5 mb-1 ml-[7px] min-w-0 border-border-soft border-l pr-1 pl-4",
              className,
            )}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
