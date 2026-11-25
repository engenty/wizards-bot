import type { Agent, Card } from "@wizards-bot/protocol";

/** The agent in whose chat a card stands; none for a card of a conversation without a chat here. */
export function chatOf(card: Card, agents: Agent[]): Agent | undefined {
  return agents.find((agent) => agent.conversationId === card.conversationId);
}

/** The one card that needs the person, where its chat can be shown. With several, none. */
export function onlyCard(items: Card[], agents: Agent[]): { card: Card; agent: Agent } | undefined {
  const [card] = items;
  const agent = card && items.length === 1 ? chatOf(card, agents) : undefined;
  return card && agent ? { card, agent } : undefined;
}

/** Another agent whose answer one waits for, and the card that agent waits on. */
export interface Waited {
  agent: Agent;
  cardId?: string;
}

/** The agents one waits for, those that need the person first. */
export function waitedFor(agent: Agent, agents: Agent[]): Waited[] {
  const waited = (agent.waitsFor ?? []).flatMap(({ agentId, cardId }) => {
    const other = agents.find((each) => each.id === agentId);
    return other ? [{ agent: other, ...(cardId ? { cardId } : {}) }] : [];
  });
  return waited.sort((a, b) => Number(Boolean(b.cardId)) - Number(Boolean(a.cardId)));
}
