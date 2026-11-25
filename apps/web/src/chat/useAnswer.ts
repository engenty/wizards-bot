import { useQueryClient } from "@tanstack/react-query";
import type { Card } from "@wizards-bot/protocol";
import { useState } from "react";
import { ApiError, api } from "../lib/api";
import { withConsent } from "../lib/consent";
import { applyEvent } from "../lib/events";
import { t } from "../lib/i18n";
import { keys } from "../lib/keys";

/**
 * Answers a card. The first answer wins: a card someone answered meanwhile shows that answer,
 * and `problem` says so. Returns whether the answer was taken.
 */
export function useAnswer(card: Card) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const answer = async (action: string, values: Record<string, string | string[]> = {}) => {
    setBusy(true);
    setProblem(null);
    try {
      const { card: answered } = await withConsent(
        () =>
          api.post<{ card: Card }>(`/v1/cards/${card.id}/answer`, {
            action,
            ...(Object.keys(values).length ? { values } : {}),
          }),
        (models) => client.setQueryData(keys.models(), models),
      );
      applyEvent(client, { type: "card.updated", card: answered });
      return true;
    } catch (err) {
      const kept = err instanceof ApiError && err.code === "already_answered" && err.body?.card;
      if (kept) {
        setProblem(t("card.already"));
        applyEvent(client, { type: "card.updated", card: kept as Card });
      } else {
        setProblem((err as Error).message || t("card.failed"));
      }
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { answer, busy, problem };
}
