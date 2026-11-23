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
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { withConsent } from "../lib/consent";
import { applyEvent } from "../lib/events";
import { pastedName } from "../lib/files";
import { t } from "../lib/i18n";
import { keys } from "../lib/keys";
import { askToNotify } from "../lib/notify";
import { loadEarlier, useThread } from "../lib/queries";
import type { Link } from "../lib/stream";
import { uuid } from "../lib/uuid";
import { IconButton } from "../ui";
import { Composer, type ComposerHandle } from "../ui/Composer";
import { Face } from "./Face";
import { Messages } from "./Messages";

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
  items,
  link,
  onAgents,
  onList,
  onHideList,
  onAgent,
  unread,
  onItems,
  onDocument,
  onArtifact,
  onFolder,
}: {
  agent: Agent;
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
  onItems: () => void;
  onDocument: (id: string) => void;
  onArtifact: (id: string) => void;
  onFolder: () => void;
}) {
  const client = useQueryClient();
  const thread = useThread(agent.conversationId);
  const [problem, flash] = useFlash();
  const composer = useRef<ComposerHandle>(null);
  // Entering and leaving the children is counted, so the drop sign does not flicker.
  const [drag, setDrag] = useState(false);
  const depth = useRef(0);
  const takes = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");

  const send = async (text: string, files: FileRef[]) => {
    askToNotify();
    try {
      const clientId = uuid();
      const { message } = await withConsent(
        () =>
          api.post<{ message: Message }>(`/v1/conversations/${agent.conversationId}/messages`, {
            text,
            ...(files.length ? { files: files.map((file) => file.id) } : {}),
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
      {/* Three parts, as in the iOS app: the way back at the left, the Wizard in the middle,
          what needs the person at the right. */}
      <header className="mx-auto grid w-full max-w-[46rem] grid-cols-[1fr_auto_1fr] items-center gap-3 px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 items-center">
          {onAgents ? (
            <IconButton label={t("agents.show")} onClick={onAgents} className="relative -ml-1.5">
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
          className="group flex min-w-0 items-center gap-2 rounded-full py-1 pr-2 pl-1 transition hover:bg-accent active:scale-[0.98]"
        >
          <Face key={agent.id} agent={agent} size={32} className="enter-pop" />
          <h1 className="truncate font-display font-semibold text-[1.0625rem]">{agent.name}</h1>
          {/* On hover a chevron says the name opens one level down: the agent's page beside. */}
          <ChevronRight className="size-4 shrink-0 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100" />
        </button>
        <div className="flex min-w-0 items-center justify-end">
          {items.length ? (
            <button
              type="button"
              aria-haspopup="dialog"
              onClick={onItems}
              className="enter-pop inline-flex h-8 shrink-0 items-center gap-2 rounded-full bg-ember-tint px-3 font-medium text-[0.8125rem] text-ember-strong transition hover:brightness-[0.97] active:scale-95 coarse:h-11"
            >
              <span className="size-1.5 rounded-full bg-ember" />
              {t("needs.count", { n: items.length })}
            </button>
          ) : null}
        </div>
      </header>
      {link === "away" ? (
        <p
          role="status"
          className="mx-auto flex w-full max-w-[46rem] items-center gap-2 px-4 pb-2 text-[0.8125rem] text-ink-3 sm:px-5"
        >
          <House className="size-4 shrink-0" />
          {t("home.away")}
        </p>
      ) : null}
      <Messages
        thread={thread.data}
        agent={agent}
        onEarlier={() =>
          void loadEarlier(client, agent.conversationId).catch((err: Error) => flash(err.message))
        }
        onDocument={onDocument}
        onArtifact={onArtifact}
        onProblem={flash}
      />
      <div className="mx-auto w-full max-w-[46rem] px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4">
        {problem ? (
          <p
            role="alert"
            className="enter-rise mb-2 rounded-lg bg-rose-tint px-3 py-2 text-[0.8125rem] text-rose"
          >
            {problem}
          </p>
        ) : null}
        <Composer
          ref={composer}
          placeholder={t("composer.message")}
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
