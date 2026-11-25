import type { Agent, Message } from "@wizards-bot/protocol";
import { ChevronRight, FileText } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Engenty } from "../engenty/Engenty";
import type { Thread, Waiting } from "../lib/events";
import { t } from "../lib/i18n";
import type { Waited } from "../lib/needs";
import { askToNotify, canAskToNotify, notifyLater } from "../lib/notify";
import { useThisDevice } from "../lib/queries";
import { runsOf } from "../lib/steps";
import { elapsed } from "../lib/time";
import { Button, cn } from "../ui";
import { Markdown } from "../ui/Markdown";
import { ArtifactPart } from "./AppView";
import { CardView } from "./CardView";
import { Face, Writer } from "./Face";
import { MessageFiles } from "./MessageFiles";
import { Steps } from "./Steps";

/** An agent about to answer: three dots that rise in turn. */
function Typing() {
  return (
    <div className="flex h-6 items-center gap-1" aria-hidden="true">
      {[0, 0.15, 0.3].map((delay) => (
        <span
          key={delay}
          className="size-1.5 animate-typing rounded-full bg-ink-3"
          style={{ animationDelay: `${delay}s` }}
        />
      ))}
    </div>
  );
}

/** What a model on the Bot Server's computer does before its first word. */
function WaitingFor({ waiting }: { waiting: Waiting }) {
  const { state, share } = waiting;
  return (
    <span className="text-[0.8125rem] text-ink-3 tabular-nums">
      {state === "loading"
        ? t("chat.loading")
        : state === "thinking"
          ? t("chat.thinking")
          : share === undefined
            ? t("chat.reading")
            : t("chat.readingShare", { share: Math.round(share * 100) })}
    </span>
  );
}

/** How long the agent has been at it, once it is longer than a moment: "12 s", "1:05". */
function Elapsed({ since }: { since: string }) {
  const start = Date.parse(since);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const text = elapsed(now - start);
  return text ? (
    <span className="text-[0.75rem] text-ink-4 tabular-nums" aria-hidden="true">
      {text}
    </span>
  ) : null;
}

/**
 * A message's parts, in order, the steps between two of them as one. Files are drawn together; a part of a type this page does not
 * know shows its title, or one line, and never breaks the message.
 */
function Parts({
  message,
  onDocument,
  onArtifact,
  onProblem,
}: {
  message: Message;
  onDocument: (id: string) => void;
  onArtifact: (id: string) => void;
  onProblem: (text: string) => void;
}) {
  const mine = message.role === "you";
  const files = message.parts.flatMap((part) => (part.type === "file" ? [part.file] : []));
  const firstFile = message.parts.findIndex((part) => part.type === "file");
  const sources = message.parts.flatMap((part) => (part.type === "source" ? [part] : []));
  const firstSource = message.parts.findIndex((part) => part.type === "source");
  return runsOf(message.parts).map((run) => {
    if (run.type === "steps") {
      return (
        <Steps
          key={`steps-${run.at}`}
          parts={run.parts}
          steps={run.steps}
          live={run.last && message.state === "streaming"}
        />
      );
    }
    // The message is one list for as long as it stands: a part keeps its place.
    const { part, at: i } = run;
    const key = `${part.type}-${i}`;
    switch (part.type) {
      case "text":
        if (!part.text) {
          return null;
        }
        return mine ? (
          <div key={key} className="rounded-xl rounded-br-md bg-paper-2 px-4 py-2.5">
            <Markdown text={part.text} className="text-[0.9375rem]" />
          </div>
        ) : (
          <Markdown key={key} text={part.text} className="text-[0.9375rem]" />
        );
      case "reasoning":
        return part.text ? (
          <Reasoning key={key} text={part.text} live={message.state === "streaming"} />
        ) : null;
      case "source":
        return i === firstSource ? <Sources key={key} sources={sources} /> : null;
      case "card":
        // Where the list scrolls to for a card that needs the person, clear of the bar at the top.
        return (
          <div
            key={part.card.id}
            data-card={part.card.id}
            tabIndex={-1}
            className="scroll-mt-16 outline-none"
          >
            <CardView card={part.card} />
          </div>
        );
      case "file":
        return i === firstFile ? (
          <MessageFiles key={key} files={files} mine={mine} onProblem={onProblem} />
        ) : null;
      case "document":
        return (
          <button
            key={key}
            type="button"
            onClick={() => onDocument(part.documentId)}
            className="flex w-full max-w-sm items-center gap-2.5 rounded-xl bg-card px-3.5 py-3 text-left text-[0.9375rem] shadow-soft ring-1 ring-border-soft transition hover:ring-ink-4"
          >
            <FileText className="size-4 shrink-0 text-ink-3" />
            <span className="min-w-0 flex-1 truncate font-medium">{part.title}</span>
            <ChevronRight className="size-4 shrink-0 text-ink-4" />
          </button>
        );
      case "artifact":
        return (
          <ArtifactPart key={key} id={part.artifactId} title={part.title} onOpen={onArtifact} />
        );
      default: {
        const title = (part as { title?: unknown }).title;
        return (
          <p key={key} className="text-[0.8125rem] text-ink-3">
            {typeof title === "string" ? title : t("chat.unknownPart")}
          </p>
        );
      }
    }
  });
}

/**
 * What the model thought before it answered: open while the message is written, folded away
 * once it is done.
 */
function Reasoning({ text, live }: { text: string; live: boolean }) {
  return (
    <details open={live} className="group max-w-full text-[0.8125rem] text-ink-3">
      <summary className="cursor-pointer list-none select-none text-ink-4 hover:text-ink-3">
        {live ? t("chat.reasoningLive") : t("chat.reasoning")}
      </summary>
      <Markdown
        text={text}
        className="mt-1.5 border-border-soft border-l-2 pl-3 text-[0.8125rem]"
      />
    </details>
  );
}

/** The pages the answer draws on, as the model named them: web addresses only. */
function Sources({ sources }: { sources: { url: string; title?: string }[] }) {
  const pages = sources.filter((source) => /^https?:\/\//i.test(source.url));
  if (!pages.length) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[0.75rem]">
      <span className="text-ink-4">{t("chat.sources")}</span>
      {pages.map((source) => (
        <a
          key={source.url}
          href={source.url}
          target="_blank"
          rel="noopener noreferrer"
          className="max-w-[16rem] truncate rounded-full bg-paper-2 px-2.5 py-1 text-ink-3 hover:text-ink"
        >
          {source.title || new URL(source.url).hostname}
        </a>
      ))}
    </div>
  );
}

function MessageView({
  message,
  agent,
  waiting,
  onDocument,
  onArtifact,
  onProblem,
}: {
  message: Message;
  agent: Agent;
  waiting?: Waiting;
  onDocument: (id: string) => void;
  onArtifact: (id: string) => void;
  onProblem: (text: string) => void;
}) {
  const me = useThisDevice();
  if (message.role === "note") {
    return (
      <div className="enter-rise flex flex-col items-center gap-2 text-center text-[0.8125rem] text-ink-3 [&_.prose-zen]:text-ink-3">
        <Parts
          message={message}
          onDocument={onDocument}
          onArtifact={onArtifact}
          onProblem={onProblem}
        />
      </div>
    );
  }
  // In a group home another admin's message stands on the other side, with their name.
  const otherAdmin =
    message.role === "you" &&
    message.from?.admin !== undefined &&
    message.from.admin !== me.data?.admin?.id;
  if (message.role === "you" && !otherAdmin) {
    return (
      <div className="enter-rise ml-8 flex min-w-0 flex-col items-end gap-1.5 self-end">
        <Parts
          message={message}
          onDocument={onDocument}
          onArtifact={onArtifact}
          onProblem={onProblem}
        />
        {message.model === "apple:on-device" ? (
          <p className="text-[0.75rem] text-ink-4">{t("chat.onDevice")}</p>
        ) : null}
        {message.queued ? <p className="text-[0.75rem] text-ink-4">{t("chat.queued")}</p> : null}
      </div>
    );
  }
  const drawn = message.parts.some((part) => part.type !== "text" || part.text);
  // While the answer is open and no tool line turns, the dots say the agent is still at it:
  // between two tools, and while it thinks after a line of text.
  const thinking =
    message.state === "streaming" &&
    !message.parts.some((part) => part.type === "activity" && part.state === "running");
  const run = runsOf(message.parts).at(-1);
  // The line of several steps turns until the answer goes on: it says the same.
  const turning = run?.type === "steps" && run.steps.length > 1;
  // An answer that was stopped before its first word is done and holds nothing: no figure
  // stands beside nothing.
  if (!drawn && message.state === "done") {
    return null;
  }
  return (
    <div className="enter-rise flex items-start gap-3">
      <div className="shrink-0">
        {message.from ? (
          <Writer from={message.from} size={28} />
        ) : (
          <Engenty kind={agent.kind} color={agent.color} size={28} animated={false} />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5 pt-0.5">
        {message.from ? (
          // In a room: who wrote it, and for an agent whose it is. In a group home: which admin.
          <p className="-mb-1.5 font-medium text-[0.8125rem] text-ink-2">
            {message.from.name}
            {message.from.of ? (
              <span className="font-normal text-ink-3"> · {message.from.of}</span>
            ) : null}
          </p>
        ) : null}
        <Parts
          message={message}
          onDocument={onDocument}
          onArtifact={onArtifact}
          onProblem={onProblem}
        />
        {message.state === "streaming" ? (
          <div className="flex items-center gap-2.5">
            {thinking && !turning ? <Typing /> : null}
            {thinking && waiting ? <WaitingFor waiting={waiting} /> : null}
            <Elapsed since={message.createdAt} />
          </div>
        ) : null}
        {message.state === "failed" ? (
          <p className="text-[0.8125rem] text-ink-3">{t("chat.failed")}</p>
        ) : null}
        {message.model === "apple:on-device" ? (
          <p className="text-[0.75rem] text-ink-4">{t("chat.onDevice")}</p>
        ) : null}
        {message.unsourced && message.state === "done" ? (
          <p className="text-[0.75rem] text-ink-4">
            {t("chat.unsourced", { model: message.model?.split(/[:/]/).at(-1) ?? "" })}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Another agent whose answer this one waits for, as the way to its chat. Where that agent waits
 * for the person, the line says so and leads to its card.
 */
function WaitsFor({ waited, onChat }: { waited: Waited; onChat: () => void }) {
  const { agent, cardId } = waited;
  return (
    <button
      type="button"
      onClick={onChat}
      className={cn(
        "enter-rise flex min-h-11 w-fit max-w-full items-center gap-2.5 rounded-xl py-1.5 pr-2.5 pl-2 text-left text-[0.875rem] transition active:scale-[0.985]",
        cardId
          ? "bg-primary text-primary-foreground hover:brightness-[1.06]"
          : "bg-paper-2 text-ink-2 hover:bg-accent hover:text-ink",
      )}
    >
      <Face agent={agent} size={28} animated={false} className="shrink-0" />
      <span className="min-w-0">
        {t("chat.waits", { name: agent.name })}
        {cardId ? (
          <span className="block font-semibold">{t("needs.agent", { name: agent.name })}</span>
        ) : null}
      </span>
      <ChevronRight className="size-4 shrink-0" />
    </button>
  );
}

/**
 * A conversation: the person's messages on the right, the agent's with its figure. The list
 * stays at its end while it grows, unless the person has scrolled up to read; earlier messages
 * come in above without moving what is read.
 */
export function Messages({
  thread,
  agent,
  onEarlier,
  onDocument,
  onArtifact,
  onProblem,
  onStart,
  waited,
  onChat,
  focus,
  onMissing,
}: {
  /** Undefined while the conversation loads. */
  thread: Thread | undefined;
  agent: Agent;
  onEarlier: () => void;
  onDocument: (id: string) => void;
  onArtifact: (id: string) => void;
  onProblem: (text: string) => void;
  /** Sends one of the first ideas of an empty conversation. */
  onStart?: (text: string) => void;
  /** The agents whose answer this one waits for. */
  waited: Waited[];
  onChat: (waited: Waited) => void;
  /** A card to show in this conversation, once each time it is asked for. */
  focus?: { cardId: string; at: number };
  /** The conversation does not hold that card. */
  onMissing: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  // Whether the list is at its end, and how far from the end it was before it last grew.
  const atEnd = useRef(true);
  const fromEnd = useRef(0);
  const first = thread?.messages[0]?.id;
  const last = thread?.messages.at(-1);

  // A new conversation starts at its end, and so does the person's own new message.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the conversation and its last message say when
  useLayoutEffect(() => {
    atEnd.current = true;
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [agent.conversationId, last?.role === "you" ? last.id : null]);

  // Earlier messages came in above: what was read stays where it was.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the first message says when
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && !atEnd.current) {
      el.scrollTop = el.scrollHeight - fromEnd.current;
    }
  }, [first]);

  // The card that was asked for: earlier messages are loaded until it is there. This comes after
  // the two above, so its place is the one that counts.
  const focused = useRef<number>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the request and what is loaded say when
  useLayoutEffect(() => {
    if (!focus || !thread || focused.current === focus.at) {
      return;
    }
    const card = content.current?.querySelector<HTMLElement>(
      `[data-card="${CSS.escape(focus.cardId)}"]`,
    );
    if (!card && thread.more) {
      onEarlier();
      return;
    }
    focused.current = focus.at;
    if (!card) {
      onMissing();
      return;
    }
    atEnd.current = false;
    card.scrollIntoView({ block: "start" });
    card.focus({ preventScroll: true });
  }, [focus, agent.conversationId, first, Boolean(thread)]);

  // Whatever makes the list taller (text being written, a picture that has loaded) keeps it
  // at its end.
  useLayoutEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) {
      return;
    }
    const follow = () => {
      if (atEnd.current) {
        el.scrollTop = el.scrollHeight;
      }
    };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={scroller}
      onScroll={(e) => {
        const el = e.currentTarget;
        fromEnd.current = el.scrollHeight - el.scrollTop;
        atEnd.current = fromEnd.current - el.clientHeight < 80;
      }}
      className="scroll-soft min-h-0 flex-1 overflow-y-auto"
    >
      <div
        ref={content}
        className={cn(
          // Room at the top for the bar that lies over the messages.
          "mx-auto flex w-full max-w-[46rem] flex-col gap-5 px-4 pt-16 pb-6 sm:px-5",
          thread?.messages.length === 0 && "h-full justify-center",
        )}
      >
        {thread?.more ? (
          <button
            type="button"
            onClick={onEarlier}
            className="self-center rounded-full px-3 py-1.5 text-[0.8125rem] text-ink-3 transition hover:bg-accent hover:text-ink"
          >
            {t("chat.older")}
          </button>
        ) : null}
        {thread?.messages.length === 0 ? (
          <div className="enter-rise flex flex-col items-center gap-4 text-center">
            <Face agent={agent} size={96} />
            <p className="max-w-xs text-ink-2 leading-relaxed">
              {agent.origin === "room" ? t("room.empty") : t("chat.empty", { name: agent.name })}
            </p>
          </div>
        ) : null}
        {thread?.messages.map((message) => (
          <MessageView
            key={message.id}
            message={message}
            agent={agent}
            waiting={thread.waiting?.messageId === message.id ? thread.waiting : undefined}
            onDocument={onDocument}
            onArtifact={onArtifact}
            onProblem={onProblem}
          />
        ))}
        {waited.length ? (
          <div className="flex flex-col gap-2 pl-10">
            {waited.map((each) => (
              <WaitsFor key={each.agent.id} waited={each} onChat={() => onChat(each)} />
            ))}
          </div>
        ) : null}
        {agent.main && onStart && thread && !spoke(thread) ? <Starts onStart={onStart} /> : null}
        {answered(thread) ? <NotifyOffer /> : null}
      </div>
    </div>
  );
}

const STARTS = ["chat.start.week", "chat.start.folder", "chat.start.friday"] as const;

/** Whether the person has written in this conversation. */
const spoke = (thread: Thread) => thread.messages.some((message) => message.role === "you");

/** Three first ideas while the person has not written to the main agent; a tap sends one. */
function Starts({ onStart }: { onStart: (text: string) => void }) {
  return (
    <div className="enter-rise grid grid-cols-1 gap-2 sm:grid-cols-3">
      {STARTS.map((key) => (
        <button
          key={key}
          type="button"
          onClick={() => onStart(t(key))}
          className="min-h-16 cursor-pointer rounded-xl bg-paper-2 px-3.5 py-3 text-left font-medium text-[0.875rem] leading-snug outline-none transition-colors focus-visible:bg-accent"
        >
          {t(key)}
        </button>
      ))}
    </div>
  );
}

/** Whether an agent has finished an answer to the person in this conversation. */
const answered = (thread: Thread | undefined) => {
  const said = thread?.messages.findIndex((message) => message.role === "you") ?? -1;
  return Boolean(
    said >= 0 &&
      thread?.messages
        .slice(said + 1)
        .some((message) => message.role === "agent" && message.state !== "streaming"),
  );
};

/** After the first answer, once: may the page tell the person when an answer is done. */
function NotifyOffer() {
  const [open, setOpen] = useState(canAskToNotify);
  if (!open) {
    return null;
  }
  return (
    <div className="enter-rise flex flex-wrap items-center gap-2 rounded-xl bg-paper-2 px-3.5 py-2.5">
      <p className="min-w-0 flex-1 text-[0.875rem]">{t("chat.notify.ask")}</p>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => void askToNotify().finally(() => setOpen(false))}
      >
        {t("chat.notify.allow")}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          notifyLater();
          setOpen(false);
        }}
      >
        {t("chat.notify.later")}
      </Button>
    </div>
  );
}
