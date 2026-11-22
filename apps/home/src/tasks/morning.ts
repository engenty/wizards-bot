import type { Home } from "../home.ts";

// The morning look: a quiet task every weekday morning that tells the person what needs
// them today. A new home offers it once, in the conversation, after the main agent's first
// answers. After a yes or a no it is never offered again; the person can still ask for it.

const META = "morning.offer";
/** A home is new while its main agent has written this many messages or fewer. */
const FIRST_ANSWERS = 3;
const TIME = "08:00";

const PROMPT =
  "Look at what needs the person today: the cards that still wait for an answer, today in the connected accounts and apps (calendar, mail, tasks), and what is new in the connected folders. Report only what needs them today, the most pressing first.";

export function offerMorningLook(home: Home): void {
  home.onDelivered((message, trigger) => {
    if (home.db.meta(META) !== undefined) return;
    const agent = home.store.mainAgent();
    // Only after an answer to the person, not after a task's run or a guest's question.
    if (message.conversationId !== agent.conversationId || message.state !== "done") return;
    if (trigger.guest || trigger.channel === "home") return;
    const answers =
      home.db.get<{ n: number }>(
        "select count(*) as n from message where conversation_id = ? and role = 'agent'",
        agent.conversationId,
      )?.n ?? 0;
    if (answers > FIRST_ANSWERS || home.tasks.list(agent.id).length) {
      home.db.setMeta(META, "not_new");
      return;
    }
    home.db.setMeta(META, "offered");
    home.tasks.say(agent, {
      kind: "question",
      level: "update",
      title: "Shall I look at what needs you every weekday morning?",
      body: `At ${TIME} I look at your open cards and at what is new in the accounts and folders you connected. I write only when something needs you. You can change the time or stop it by telling me.`,
      actions: [
        { id: "yes", label: "Yes, every weekday", style: "primary" },
        { id: "no", label: "No", style: "plain" },
      ],
      payload: { type: "morning_look" },
    });
  });

  home.onCard("morning_look", ({ card, action }) => {
    if (action !== "yes") return home.db.setMeta(META, "no");
    home.db.setMeta(META, "yes");
    const agent = home.store.mainAgent();
    const set = home.tasks.schedule(
      agent.id,
      { every: "weekday", time: TIME },
      { title: "Morning look", prompt: PROMPT, quiet: true },
    );
    if (!set) return;
    home.tell(
      card.conversationId,
      `The person said yes to the morning look. It is set as your task ${set.id}: Monday to Friday at ${TIME}, quiet. Say so in one sentence, and that they can change the time or stop it by telling you.`,
    );
  });
}
