import type { Agent, Message } from "@wizards-bot/protocol";
import { Users } from "lucide-react";
import { Engenty } from "../engenty/Engenty";
import { cn } from "../ui";

/** What stands for an entry of the list: an agent's figure, or the mark of a room. */
export function Face({
  agent,
  size,
  animated,
  className,
}: {
  agent: Agent;
  size: number;
  animated?: boolean;
  className?: string;
}) {
  if (agent.origin !== "room") {
    return <Engenty kind={agent.kind} size={size} animated={animated} className={className} />;
  }
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size }}
      className={cn(
        "grid shrink-0 place-items-center rounded-full bg-paper-2 text-ink-2",
        className,
      )}
    >
      <Users style={{ width: size * 0.5, height: size * 0.5 }} />
    </span>
  );
}

/** Who wrote a message in a room: an agent's figure, or the first letter of a person's name. */
export function Writer({ from, size }: { from: NonNullable<Message["from"]>; size: number }) {
  if (from.kind) return <Engenty kind={from.kind} size={size} animated={false} />;
  return (
    <span
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: size * 0.45 }}
      className="grid shrink-0 place-items-center rounded-full bg-paper-2 font-semibold text-ink-2"
    >
      {from.name.trim().charAt(0).toUpperCase()}
    </span>
  );
}
