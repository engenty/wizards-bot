import type { Part, StepKind } from "@wizards-bot/protocol";
import {
  AppWindow,
  ArrowRight,
  Bot,
  Brain,
  Copy,
  Eye,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  Globe,
  Image,
  KeyRound,
  ListChecks,
  type LucideIcon,
  MessageCircleQuestion,
  NotebookPen,
  Pencil,
  ScrollText,
  Search,
  Send,
  Settings2,
  Smartphone,
  SquareTerminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { createContext, type ReactNode, useContext } from "react";
import { t } from "../lib/i18n";
import {
  durationOf,
  nowLine,
  type Row,
  rowLine,
  rowsOf,
  type Step,
  summaryOf,
  type Target,
  targetOf,
} from "../lib/steps";
import { cn, Spinner } from "../ui";
import { Markdown } from "../ui/Markdown";
import {
  Trace,
  TraceCollapsible,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "../ui/Trace";

/** Opens what a step was about; answers nothing for what this page cannot show. */
export type OpenTarget = (target: Target) => (() => void) | undefined;

export const StepTargets = createContext<OpenTarget>(() => undefined);

const ICONS: Record<StepKind, LucideIcon> = {
  file_write: Pencil,
  file_edit: Pencil,
  file_copy: Copy,
  file_move: FolderInput,
  file_delete: Trash2,
  folder_make: FolderPlus,
  document_write: Pencil,
  artifact_write: AppWindow,
  agent_make: Bot,
  agent_ask: Send,
  device_ask: Smartphone,
  task_set: ListChecks,
  set: Settings2,
  draft: Send,
  command: SquareTerminal,
  page_use: Globe,
  sign_in: KeyRound,
  memory: NotebookPen,
  ask: MessageCircleQuestion,
  page_read: Globe,
  file_read: FileText,
  picture_look: Image,
  document_read: FileText,
  artifact_read: AppWindow,
  search: Search,
  folder_look: Folder,
  look: Eye,
  skill: ScrollText,
  tool_search: Wrench,
  go_on: ArrowRight,
};

/** A step's title as the way to what it was about, where this page shows it. */
function Title({ row, children }: { row: Row; children: ReactNode }) {
  const opens = useContext(StepTargets);
  const target = targetOf(row);
  const look =
    "min-w-0 truncate rounded-sm text-left underline decoration-border underline-offset-[3px] outline-none transition-colors hover:text-ink hover:decoration-current focus-visible:bg-accent";
  if (target?.to === "page") {
    return (
      <a href={target.url} target="_blank" rel="noopener noreferrer" className={look}>
        {children}
      </a>
    );
  }
  const open = target && opens(target);
  return open ? (
    <button type="button" onClick={open} className={cn(look, "cursor-pointer")}>
      {children}
    </button>
  ) : (
    <TraceTitle>{children}</TraceTitle>
  );
}

/** One thing the agent did, or does, on a line. */
function StepRow({ row, running }: { row: Row; running: boolean }) {
  const Icon = (row.kind && ICONS[row.kind]) ?? Wrench;
  const turning = running ? row.steps.findLast((step) => step.state === "running") : undefined;
  const { title, details, failed } = rowLine(row);
  return (
    <TraceLine
      status={turning ? "running" : failed ? "error" : undefined}
      className="max-w-full coarse:min-h-8"
    >
      {turning ? (
        <Spinner className="size-3.5 shrink-0" />
      ) : (
        <TraceIcon className={failed ? "text-rose" : "text-ink-4"}>
          {failed ? <X /> : <Icon />}
        </TraceIcon>
      )}
      {turning ? (
        <TraceTitle>{nowLine(turning)}</TraceTitle>
      ) : (
        <>
          <Title row={row}>{title}</Title>
          {details.length ? <TraceDescription>{details.join(" · ")}</TraceDescription> : null}
          {failed ? <span className="shrink-0 text-rose">{failed}</span> : null}
        </>
      )}
    </TraceLine>
  );
}

/**
 * The steps between two texts of an answer. One is its own line. Several are one line: while the
 * agent is at them the newest with its spinner and how many there are, then what was done,
 * counted, and what failed. It opens to the things they were done to, each once.
 */
export function Steps({
  parts,
  steps,
  live,
}: {
  /** The steps, and what the model thought between them. */
  parts: Part[];
  steps: Step[];
  /** The agent is still at them. */
  live: boolean;
}) {
  const rows = rowsOf(steps);
  const [first] = rows;
  if (steps.length === 1) {
    return first ? <StepRow row={first} running={live} /> : null;
  }
  const newest = steps.findLast((step) => step.state === "running") ?? steps.at(-1);
  const { done, failed } = summaryOf(steps);
  const took = live ? undefined : durationOf(steps);
  const thoughts = parts.flatMap((part) => (part.type === "reasoning" ? [part.text.trim()] : []));
  return (
    <TraceCollapsible
      line={
        <TraceLine status={live ? "running" : undefined} className="text-inherit">
          {live ? (
            <Spinner className="size-3.5 shrink-0" />
          ) : (
            <TraceIcon className="h-5 self-start text-ink-4">
              <ListChecks />
            </TraceIcon>
          )}
          {live && newest ? (
            <>
              <TraceTitle>{nowLine(newest)}</TraceTitle>
              <span className="shrink-0 text-ink-4 tabular-nums">
                {t("step.steps", { n: steps.length })}
              </span>
              {failed ? <span className="shrink-0 text-rose">{failed}</span> : null}
            </>
          ) : (
            <span className="min-w-0">
              {[...done, ...(took ? [took] : [])].join(" · ")}
              {failed ? (
                <span className="text-rose">
                  {done.length || took ? " · " : ""}
                  {failed}
                </span>
              ) : null}
            </span>
          )}
        </TraceLine>
      }
    >
      <Trace>
        {rows.map((row) => (
          <StepRow key={row.key} row={row} running={live} />
        ))}
        {thoughts.length ? (
          <TraceCollapsible
            line={
              <TraceLine className="text-inherit">
                <TraceIcon className="text-ink-4">
                  <Brain />
                </TraceIcon>
                <TraceTitle>{t("chat.reasoning")}</TraceTitle>
              </TraceLine>
            }
          >
            <Markdown text={thoughts.join("\n\n")} className="text-[0.8125rem]" />
          </TraceCollapsible>
        ) : null}
      </Trace>
    </TraceCollapsible>
  );
}
