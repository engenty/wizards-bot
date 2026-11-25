import { useQueryClient } from "@tanstack/react-query";
import type { Agent, Card, FileRef, Message } from "@wizards-bot/protocol";
import {
  ChevronLeft,
  ChevronRight,
  FolderPlus,
  House,
  PanelLeft,
  PanelLeftClose,
  Paperclip,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { withConsent } from "../lib/consent";
import { applyEvent } from "../lib/events";
import { pastedName } from "../lib/files";
import { t } from "../lib/i18n";
import { keys } from "../lib/keys";
import { onlyCard, waitedFor } from "../lib/needs";
import { loadEarlier, useThread } from "../lib/queries";
import { answersOf, formOf, type Picked, questionsIn, targetOf } from "../lib/questions";
import type { Link } from "../lib/stream";
import { uuid } from "../lib/uuid";
import { IconButton } from "../ui";
import { Composer, type ComposerHandle } from "../ui/Composer";
import { Face } from "./Face";
import { Messages } from "./Messages";
import { AnsweringContext } from "./QuestionView";

/** How often the Bot Server hears that the person writes, so that a local model is ready. */
const WARM_EVERY_MS = 60_000;

/** A sentence shown for a few seconds above the composer: something did not work. */
function useFlash(): [string | null, (text: string) => void] {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!text) {
      return;
    }
    const timer = setTimeout(() => setText(null), 5000);
    return () => clearTimeout(timer);
  }, [text]);
  return [text, setText];
}

/**
 * The chat with one agent: who it is and what needs the person at the top, the conversation,
 * and the composer. Files dropped anywhere on it are attached to the next message.
 */
export function Chat({
  agent,
  agents,
  items,
  link,
  onAgents,
  onList,
  onHideList,
  onAgent,
  unread,
  onItems,
  onChat,
  focus,
  onDocument,
  onArtifact,
  onFolder,
  reference,
}: {
  agent: Agent;
  agents: Agent[];
  /** What needs the person, across all agents. */
  items: Card[];
  link: Link;
  /** Opens the list of agents, where the window has no column for it. */
  onAgents?: () => void;
  /** Opens the list of agents from its narrow column of figures. */
  onList?: () => void;
  /** Narrows the open list of agents to its column of figures. */
  onHideList?: () => void;
  /** Opens what there is to know about the agent. */
  onAgent: () => void;
  /** Whether another agent wrote something the person has not read. */
  unread: boolean;
  /** Opens the list of what needs the person. */
  onItems: () => void;
  /** Shows an agent's chat, at a card that needs the person. */
  onChat: (agent: Agent, cardId?: string) => void;
  /** A card to show in this chat. */
  focus?: { cardId: string; at: number };
  onDocument: (id: string) => void;
  onArtifact: (id: string) => void;
  onFolder: () => void;
  /** A file the person named in the file browser, to put into what they are writing. */
  reference?: { text: string; at: number };
}) {
  const client = useQueryClient();
  const thread = useThread(agent.conversationId);
  const [problem, flash] = useFlash();
  const composer = useRef<ComposerHandle>(null);
  useEffect(() => {
    if (reference) composer.current?.insert(reference.text);
  }, [reference]);
  // A model on the Bot Server's computer reads the conversation before the person has written.
  const warmed = useRef(0);
  const warm = useCallback(() => {
    warmed.current = Date.now();
    void api.post(`/v1/conversations/${agent.conversationId}/warm`).catch(() => undefined);
  }, [agent.conversationId]);
  useEffect(warm, [warm]);
  // Entering and leaving the children is counted, so the drop sign does not flicker.
  const [drag, setDrag] = useState(false);
  const depth = useRef(0);
  const only = onlyCard(items, agents);
  // The question the next message answers.
  const questions = questionsIn(items, agent.conversationId);
  const [picked, setPicked] = useState<Picked>();
  const last = thread.data?.messages.at(-1);
  const target = targetOf(questions, picked, { working: agent.state === "working", last });
  const newest = questions.at(-1)?.id;
  const pick = useCallback(
    (cardId: string | null) => {
      if (newest) {
        setPicked({ cardId, newest });
        composer.current?.focus();
      }
    },
    [newest],
  );
  const answering = useMemo(() => ({ target: target?.id, pick }), [target?.id, pick]);
  // A chat opened at a question is ready for its answer.
  const onFocused = (cardId: string) => {
    const asked = questions.find((card) => card.id === cardId);
    if (asked && !formOf(asked)) {
      pick(asked.id);
    }
  };
  const takes = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");

  const send = async (text: string, files: FileRef[], later = false) => {
    try {
      const clientId = uuid();
      const { message } = await withConsent(
        () =>
          api.post<{ message: Message }>(`/v1/conversations/${agent.conversationId}/messages`, {
            text,
            ...(files.length ? { files: files.map((file) => file.id) } : {}),
            ...(later ? { later: true } : {}),
            ...answersOf(questions, target),
            clientId,
          }),
        (models) => client.setQueryData(keys.models(), models),
      );
      applyEvent(client, { type: "message.created", message });
      if (files.length) {
        void client.invalidateQueries({ queryKey: keys.sentFiles(agent.conversationId) });
      }
      return true;
    } catch (err) {
      flash((err as Error).message);
      return false;
    }
  };

  return (
    <main
      className="relative flex h-full min-w-0 flex-col"
      onInput={() => {
        // It may have left the memory since the chat was opened.
        if (Date.now() - warmed.current > WARM_EVERY_MS) {
          warm();
        }
      }}
      // ⌘U (Ctrl+U) picks files, wherever the focus is in the chat.
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && !(e.shiftKey || e.altKey) && e.key.toLowerCase() === "u") {
          e.preventDefault();
          composer.current?.pick();
        }
      }}
      onDragEnter={(e) => {
        if (takes(e)) {
          e.preventDefault();
          depth.current += 1;
          setDrag(true);
        }
      }}
      onDragOver={(e) => {
        if (takes(e)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) {
          setDrag(false);
        }
      }}
      onDrop={(e) => {
        if (takes(e)) {
          e.preventDefault();
          depth.current = 0;
          setDrag(false);
          composer.current?.add(Array.from(e.dataTransfer.files).map(pastedName));
          composer.current?.focus();
        }
      }}
    >
      {drag ? (
        <div className="pointer-events-none absolute inset-3 z-20 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-ember border-dashed bg-ember-veil text-[0.875rem] text-ember-strong">
          <Paperclip className="size-6" />
          {t("chat.drop")}
        </div>
      ) : null}
      {onList || onHideList ? (
        // At the chat's left edge, beside the list: it opens and narrows the list from here.
        <IconButton
          label={t(onList ? "agents.show" : "agents.hide")}
          onClick={onList ?? onHideList}
          className="absolute top-2.5 left-2 z-10"
        >
          {onList ? (
            <PanelLeft className="size-[1.125rem]" />
          ) : (
            <PanelLeftClose className="size-[1.125rem]" />
          )}
        </IconButton>
      ) : null}
      {/* The bar lies over the messages and lets them show through; only its buttons stand on a
          ground of their own. Three parts, as in the iOS app: the way back at the left, the
          Wizard in the middle, what needs the person at the right. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10">
        <header className="mx-auto grid w-full max-w-[46rem] grid-cols-[1fr_auto_1fr] items-center gap-3 px-3 py-2.5 sm:px-4 [&_button]:pointer-events-auto">
          <div className="flex min-w-0 items-center">
            {onAgents ? (
              <IconButton
                label={t("agents.show")}
                onClick={onAgents}
                className="relative -ml-1.5 bg-card/60 shadow-[0_1px_3px_oklch(0%_0_0/0.08)] ring-1 ring-border-soft/60 backdrop-blur-md transition-[background-color,box-shadow] duration-200 hover:bg-card"
              >
                <ChevronLeft className="size-5" />
                {unread ? (
                  <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-ember ring-2 ring-background" />
                ) : null}
              </IconButton>
            ) : null}
          </div>
          <button
            type="button"
            title={t("agent.about", { name: agent.name })}
            onClick={onAgent}
            className="group flex min-w-0 items-center gap-2 rounded-full py-1 pr-3 pl-1 active:scale-[0.98] bg-card/60 shadow-[0_1px_3px_oklch(0%_0_0/0.08)] ring-1 ring-border-soft/60 backdrop-blur-md transition-[background-color,box-shadow] duration-200 hover:bg-card"
          >
            <Face key={agent.id} agent={agent} size={32} className="enter-pop" />
            <h1 className="truncate font-display font-semibold text-[1.0625rem]">{agent.name}</h1>
            {/* On hover a chevron makes room for itself: the name opens one level down, the agent's
              page beside. */}
            <ChevronRight className="-ml-2 w-0 shrink-0 text-ink-3 opacity-0 transition-[width,margin,opacity] duration-200 group-hover:ml-0 group-hover:w-4 group-hover:opacity-100 h-4" />
          </button>
          <div className="flex min-w-0 items-center justify-end">
            {items.length ? (
              <button
                type="button"
                // One card: its chat. Several: the list.
                aria-haspopup={only ? undefined : "dialog"}
                aria-label={t("needs.count", { n: items.length })}
                title={only ? t("needs.agent", { name: only.agent.name }) : undefined}
                onClick={() => (only ? onChat(only.agent, only.card.id) : onItems())}
                className="enter-pop inline-flex h-8 shrink-0 items-center gap-2 rounded-full bg-primary px-3 font-semibold text-[0.8125rem] text-primary-foreground transition hover:brightness-[1.06] active:scale-95 coarse:h-11"
              >
                <span className="size-1.5 rounded-full bg-current" />
                {/* Beside a long name a phone has room for the number only. */}
                <span className="max-sm:hidden">{t("needs.count", { n: items.length })}</span>
                <span className="sm:hidden" aria-hidden="true">
                  {items.length}
                </span>
              </button>
            ) : null}
          </div>
        </header>
        {link === "away" ? (
          <p
            role="status"
            className="mx-auto flex w-fit max-w-[46rem] items-center gap-2 rounded-full bg-card/60 px-3 py-1 text-[0.8125rem] text-ink-3 shadow-[0_1px_3px_oklch(0%_0_0/0.08)] ring-1 ring-border-soft/60 backdrop-blur-md"
          >
            <House className="size-4 shrink-0" />
            {t("home.away")}
          </p>
        ) : null}
      </div>
      <AnsweringContext value={answering}>
        <Messages
          thread={thread.data}
          agent={agent}
          onEarlier={() =>
            void loadEarlier(client, agent.conversationId).catch((err: Error) => flash(err.message))
          }
          onDocument={onDocument}
          onArtifact={onArtifact}
          onProblem={flash}
          onStart={(text) => void send(text, [])}
          waited={waitedFor(agent, agents)}
          onChat={({ agent: other, cardId }) => onChat(other, cardId)}
          focus={focus}
          onFocused={onFocused}
          onMissing={onItems}
        />
      </AnsweringContext>
      <div className="mx-auto w-full max-w-[46rem] px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4">
        {problem ? (
          <p
            role="alert"
            className="enter-rise mb-2 rounded-lg bg-rose-tint px-3 py-2 text-[0.8125rem] text-rose"
          >
            {problem}
          </p>
        ) : null}
        {target && (questions.length > 1 || last?.id !== target.messageId) ? (
          // The question is not the last thing in the chat, or not the only one: it is named.
          <p className="mb-1.5 flex items-center gap-1 pl-4 text-[0.8125rem] text-ink-3">
            <span className="min-w-0 flex-1 truncate">
              {t("question.to", { title: target.title })}
            </span>
            <IconButton
              label={t("question.other")}
              onClick={() => pick(null)}
              className="size-8 coarse:size-11"
            >
              <X className="size-4" />
            </IconButton>
          </p>
        ) : null}
        <Composer
          ref={composer}
          placeholder={target?.reply?.placeholder ?? t("composer.message")}
          busy={agent.state === "working"}
          onStop={() =>
            void api.post(`/v1/conversations/${agent.conversationId}/stop`).catch(() => undefined)
          }
          onSend={send}
          plus={[{ icon: <FolderPlus />, label: t("composer.folder"), onSelect: onFolder }]}
        />
      </div>
    </main>
  );
}
