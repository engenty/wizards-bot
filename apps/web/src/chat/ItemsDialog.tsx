import type { Card } from "@wizards-bot/protocol";
import { useEffect } from "react";
import { t } from "../lib/i18n";
import { Dialog } from "../ui";
import { CardView } from "./CardView";

/** What needs the person, from every agent, answered in place. It closes with its last card. */
export function ItemsDialog({
  open,
  items,
  onClose,
}: {
  open: boolean;
  items: Card[];
  onClose: () => void;
}) {
  const empty = items.length === 0;
  useEffect(() => {
    if (open && empty) {
      onClose();
    }
  }, [open, empty, onClose]);
  return (
    <Dialog open={open && !empty} onClose={onClose} title={t("needs.title")}>
      <div className="flex flex-col gap-3">
        {items.map((card) => (
          <CardView key={card.id} card={card} />
        ))}
      </div>
    </Dialog>
  );
}
