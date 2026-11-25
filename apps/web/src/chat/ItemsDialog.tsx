import type { Agent, Card } from "@wizards-bot/protocol";
import { ChevronRight } from "lucide-react";
import { useEffect } from "react";
import { t } from "../lib/i18n";
import { chatOf } from "../lib/needs";
import { Dialog } from "../ui";
import { CardView } from "./CardView";
import { Face } from "./Face";

/**
 * What needs the person, from every agent, answered in place, each card with the way to its
 * chat. It closes with its last card.
 */
export function ItemsDialog({
  open,
  items,
  agents,
  onChat,
  onClose,
}: {
  open: boolean;
  items: Card[];
  agents: Agent[];
  /** Shows a card in its chat. */
  onChat: (agent: Agent, cardId: string) => void;
  onClose: () => void;
}) {
  const empty = items.length === 0;
  useEffect(() => {
    if (open && empty) {
      onClose();
    }
  }, [open, empty, onClose]);
  return (
    <Dialog open={open && !empty} onClose={onClose} title={t("needs.title")} wide="chat">
      <ul className="flex flex-col gap-6">
        {items.map((card) => {
          const chat = chatOf(card, agents);
          const agent = chat ?? agents.find((each) => each.id === card.agentId);
          return (
            <li key={card.id} className="flex min-w-0 flex-col gap-2">
              {agent ? (
                <div className="flex items-center gap-2">
                  <Face agent={agent} size={28} animated={false} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate font-medium text-[0.9375rem]">
                    {agent.name}
                  </span>
                  {chat ? (
                    <button
                      type="button"
                      onClick={() => onChat(chat, card.id)}
                      className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-full pr-2 pl-3 text-[0.8125rem] text-ink-2 transition hover:bg-accent hover:text-ink coarse:min-h-11"
                    >
                      {t("needs.chat")}
                      <ChevronRight className="size-4" />
                    </button>
                  ) : null}
                </div>
              ) : null}
              <CardView card={card} />
            </li>
          );
        })}
      </ul>
    </Dialog>
  );
}
