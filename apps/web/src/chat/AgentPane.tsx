import type { Agent, TaskRule } from "@wizards-bot/protocol";
import { CalendarClock, CirclePause, FolderOpen, Mail, RefreshCw, Webhook, X } from "lucide-react";
import { lang, t } from "../lib/i18n";
import { useAgentDetail } from "../lib/queries";
import { taskLine } from "../lib/tasks";
import { cn, IconButton, Spinner } from "../ui";
import { Markdown } from "../ui/Markdown";
import { AgentData } from "./AgentData";
import { Face } from "./Face";

/**
 * An agent, looked at, beside the chat: who it is, what it works on right now, what it does by
 * itself (at a time or when something happens), and what it wrote down to remember. Nothing
 * is changed here: the person tells the agent.
 */
export function AgentPane({
  agent,
  runs,
  over,
  leaving,
  onFolder,
  onOpenFolder,
  onClose,
}: {
  agent: Agent;
  /**
   * The person runs the home. A member of a team reads who the agent is and what it works on;
   * its tasks, its data and what it remembers are the team's admins'.
   */
  runs: boolean;
  /** It lies over the chat, as on a phone, instead of standing beside it. */
  over: boolean;
  /** It is on its way out. */
  leaving: boolean;
  /** Connects a folder from this agent's chat. */
  onFolder: () => void;
  /** Opens a connected folder in the file browser, where this pane stands. */
  onOpenFolder: (id: string) => void;
  onClose: () => void;
}) {
  const detail = useAgentDetail(agent.id, true);
  const doing = agent.state === "working" ? detail.data?.doing : undefined;
  const title = t("agent.about", { name: agent.name });
  return (
    <aside
      aria-label={title}
      className={cn(
        "flex h-full min-w-0 flex-col bg-background",
        over ? "pane-over fixed inset-0 z-30" : "border-border-soft border-l",
      )}
      data-leaving={leaving || undefined}
    >
      {/* The page names the agent below; the bar holds only the way out, at the right. */}
      <header className="flex items-center justify-end px-3 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))]">
        <IconButton label={t("common.close")} onClick={onClose}>
          <X className="size-4" />
        </IconButton>
      </header>
      <div className="mx-auto min-h-0 w-full max-w-xl flex-1 overflow-y-auto px-6 pt-4 pb-8 sm:px-8">
        <div className="flex flex-col items-center gap-3 pb-1 text-center">
          <Face agent={agent} size={96} />
          <div>
            <p className="font-display font-semibold text-lg">{agent.name}</p>
            {agent.origin === "shared" && agent.from ? (
              <p className="text-[0.8125rem] text-ink-3">
                {t("agents.shared", { from: agent.from })}
              </p>
            ) : null}
          </div>
          {agent.about ? (
            <p className="max-w-xs text-[0.9375rem] text-ink-2 leading-relaxed">{agent.about}</p>
          ) : null}
          {doing ? (
            <p className="enter-fade flex max-w-xs items-center gap-2 text-[0.8125rem] text-ink-3">
              <Spinner className="size-3.5 shrink-0" />
              <span className="min-w-0">
                {[
                  doing.what ? t("agent.doing", { what: doing.what }) : t("agent.working"),
                  doing.turn > 1 ? t("agent.turn", { turn: doing.turn, turns: doing.turns }) : "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </p>
          ) : null}
        </div>
        {runs ? (
          <AgentKeeps
            agent={agent}
            detail={detail}
            onFolder={onFolder}
            onOpenFolder={onOpenFolder}
          />
        ) : null}
      </div>
    </aside>
  );
}

/** What an agent does by itself, what it reads and what it remembers: for who runs the home. */
function AgentKeeps({
  agent,
  detail,
  onFolder,
  onOpenFolder,
}: {
  agent: Agent;
  detail: ReturnType<typeof useAgentDetail>;
  onFolder: () => void;
  onOpenFolder: (id: string) => void;
}) {
  // Every agent of the home uses the connected folders; one shared with you does not.
  const usesFolders = agent.origin === "own";
  const tasks = detail.data?.tasks;
  return (
    <>
      <section className="mt-6">
        <h3 className="mb-2 font-medium text-[0.8125rem] text-ink-3">{t("agent.tasks")}</h3>
        {tasks?.length ? (
          <>
            <ul className="enter-fade divide-y divide-border-soft rounded-xl border border-border-soft bg-card px-4">
              {tasks.map((task) => (
                <li key={task.id} className="flex items-start gap-3 py-3">
                  <TaskIcon rule={task.rule} paused={task.paused !== undefined} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[0.9375rem] leading-snug" title={task.prompt}>
                      {task.title}
                    </p>
                    <p className="mt-0.5 text-[0.8125rem] text-ink-3">{taskLine(task, lang)}</p>
                    {task.paused ? (
                      <p className="mt-0.5 text-[0.8125rem] text-rose">
                        {t("task.paused", { why: task.paused })}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[0.8125rem] text-ink-3">
              {t("agent.tasksHint", { name: agent.name })}
            </p>
          </>
        ) : tasks ? (
          <p className="enter-fade text-[0.875rem] text-ink-2 leading-relaxed">
            {t("agent.noTasks", { name: agent.name })}
          </p>
        ) : detail.error ? (
          <p role="alert" className="text-[0.8125rem] text-rose">
            {detail.error.message}
          </p>
        ) : (
          <Spinner className="size-4 text-ink-4" />
        )}
      </section>
      {usesFolders ? (
        <AgentData
          agentId={agent.id}
          name={agent.name}
          conversationId={agent.conversationId}
          onFolder={onFolder}
          onOpenFolder={onOpenFolder}
        />
      ) : null}
      {detail.data?.memory.trim() ? (
        <section className="enter-fade mt-6">
          <h3 className="mb-2 font-medium text-[0.8125rem] text-ink-3">{t("agent.memory")}</h3>
          <div className="max-h-56 overflow-y-auto rounded-xl bg-paper-2 px-4 py-3">
            <Markdown text={detail.data.memory} className="text-[0.875rem]" />
          </div>
        </section>
      ) : null}
    </>
  );
}

/** What starts a task, as a small picture: a time, a folder, mail, an address, a look. */
function TaskIcon({ rule, paused }: { rule: TaskRule; paused: boolean }) {
  const Icon = paused
    ? CirclePause
    : !("on" in rule)
      ? CalendarClock
      : rule.on === "folder"
        ? FolderOpen
        : rule.on === "mail"
          ? Mail
          : rule.on === "webhook"
            ? Webhook
            : RefreshCw;
  return <Icon className="mt-0.5 size-4 shrink-0 text-ink-3" />;
}
