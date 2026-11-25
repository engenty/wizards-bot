import { createHash } from "node:crypto";
import type { Card, EventRule, Message, Task, TimeRule } from "@wizards-bot/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import { defineTool, type Tool } from "../agent/tool.ts";
import type { Ended, TurnContext } from "../agent/turns.ts";
import type { Incoming } from "../channels/channels.ts";
import type { Home } from "../home.ts";
import { newId, newToken, now } from "../ids.ts";
import { nextAfter, ruleOf, When } from "../schedule.ts";
import { langOf } from "../setup/words.ts";
import type { AgentRecord, NewCard } from "../store/store.ts";
import { offerMorningLook } from "./morning.ts";
import { describeRule, eventText, type Happened, QUIET } from "./words.ts";
import { workTools } from "./work.ts";

// What an agent does by itself. A task says what to do (`prompt`) and what starts it: a time
// or an event. When it starts, the agent gets a turn. A quiet task tells the person only
// when something needs them. Tasks are set, listed and removed by the agent, in the
// conversation.

/** A connection's look also keeps the arguments it calls the tool with. */
export type StoredRule =
  | TimeRule
  | Exclude<EventRule, { on: "connection" }>
  | (Extract<EventRule, { on: "connection" }> & { arguments?: Record<string, unknown> });

interface Row {
  id: string;
  agent_id: string;
  rule: string;
  title: string | null;
  prompt: string;
  next_at: string | null;
  quiet: number;
  paused: string | null;
  failures: number;
  last_at: string | null;
  last: string | null;
  state: string | null;
  hook: string | null;
}

/** Tasks one agent may have. */
const TASKS_PER_AGENT = 30;
/** Failed runs, or failed looks at what a task waits for, in a row before the home pauses it. */
const FAILURES = 3;
/** Events one turn is told of. With more, the oldest are counted and not shown. */
const EVENTS_KEPT = 20;
/** What one event may carry into a turn, in characters. */
const DATA_LIMIT = 6000;
/** What a service may post to a task's address, in bytes. */
const HOOK_LIMIT = 64 * 1024;
const FILES_NAMED = 30;

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const clip = (text: string, limit: number): string =>
  text.length > limit ? `${text.slice(0, limit)}\n[cut: ${text.length} characters in all]` : text;
const short = (text: string, limit = 70): string =>
  text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;

const isEvent = (rule: StoredRule): rule is Exclude<StoredRule, TimeRule> => "on" in rule;

interface Waiting {
  events: Happened[];
  /** Events that were dropped because too many waited. */
  more: number;
  first: number;
  timer: NodeJS.Timeout | undefined;
}

export class Tasks {
  /**
   * How events become turns, in milliseconds. A turn starts when nothing more happened for
   * `settle`, at the latest `longest` after the first event; it waits while the agent works
   * (`busy` between looks); and one task starts at most `perHour` turns in an `hour`.
   */
  readonly timing = {
    tick: 30_000,
    settle: 15_000,
    longest: 2 * 60_000,
    busy: 5_000,
    hour: 60 * 60_000,
    perHour: 6,
  };
  private timer: NodeJS.Timeout | undefined;
  /** Events that wait to be told in one turn, by task. */
  private readonly waiting = new Map<string, Waiting>();
  /** When each task's turns started, within the last hour. */
  private readonly started = new Map<string, number[]>();
  /** Failed looks at what a task waits for, in a row. */
  private readonly misses = new Map<string, number>();
  /** What each watched folder held at the last look. */
  private readonly seen = new Map<string, Record<string, string>>();
  private readonly looks = new Set<Promise<void>>();
  private readonly home: Home;

  constructor(home: Home) {
    this.home = home;
    home.addTools((context) => this.tools(context));
    home.addTools(workTools);
    home.turns.onEnded((ended) => this.ended(ended));
    home.onCard("task_paused", ({ action, payload }) => {
      const id = String(payload.taskId);
      if (action === "resume") this.resume(id);
      else if (action === "remove") this.remove(id);
    });
    offerMorningLook(home);
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), this.timing.tick);
    this.timer.unref();
    this.tick();
  }

  stop(): void {
    clearInterval(this.timer);
    for (const waiting of this.waiting.values()) clearTimeout(waiting.timer);
    this.waiting.clear();
  }

  /** An agent's tasks: the scheduled ones with the next one first, then those that wait for an event. */
  list(agentId: string): Task[] {
    return this.home.db
      .all<Row>(
        "select * from schedule where agent_id = ? order by json_extract(rule, '$.on') is not null, next_at, created_at",
        agentId,
      )
      .map((row) => {
        const rule = JSON.parse(row.rule) as StoredRule;
        return {
          id: row.id,
          title: titleOf(row),
          prompt: row.prompt,
          rule: publicRule(rule),
          // A look at a connection has a next time too, but that is not when the task runs.
          nextAt: isEvent(rule) ? undefined : (row.next_at ?? undefined),
          quiet: row.quiet === 1,
          paused: row.paused ?? undefined,
          lastAt: row.last_at ?? undefined,
          last: (row.last as Task["last"]) ?? undefined,
        };
      });
  }

  /** An agent's tasks as lines of its instructions: it knows in every turn what it does by itself. */
  lines(agentId: string): string[] {
    return this.home.db
      .all<Row>("select * from schedule where agent_id = ? order by created_at", agentId)
      .map((row) => {
        const facts = [
          describeRule(JSON.parse(row.rule) as StoredRule),
          row.quiet ? "quiet" : "",
          row.paused ? `paused: ${row.paused}` : "",
        ];
        return `- ${row.id} “${titleOf(row)}”: ${row.prompt} (${facts.filter(Boolean).join("; ")})`;
      });
  }

  /** Sets a scheduled task. Nothing when the time is in the past. */
  schedule(agentId: string, rule: TimeRule, what: What): { id: string; next: Date } | undefined {
    const next = nextAfter(rule, new Date());
    if (!next) return undefined;
    const id = this.insert(agentId, rule, what, { nextAt: next.toISOString() });
    return { id, next };
  }

  remove(id: string, agentId?: string): boolean {
    const row = this.row(id);
    if (!row || (agentId && row.agent_id !== agentId)) return false;
    this.home.db.run("delete from schedule where id = ?", id);
    this.forget(id);
    return true;
  }

  /** Lets a paused task run again. What it waits for is looked at anew, so nothing old starts it. */
  resume(id: string, agentId?: string): boolean {
    const row = this.row(id);
    if (!row || (agentId && row.agent_id !== agentId)) return false;
    const rule = JSON.parse(row.rule) as StoredRule;
    const next = isEvent(rule)
      ? rule.on === "connection"
        ? now()
        : null
      : (nextAfter(rule, new Date())?.toISOString() ?? null);
    this.forget(id);
    this.home.db.run(
      "update schedule set paused = null, failures = 0, state = null, next_at = ? where id = ?",
      next,
      id,
    );
    return true;
  }

  // ── What starts a task ────────────────────────────────────────────────────

  /** Starts the scheduled tasks that are due and looks at what the other tasks wait for. */
  tick(at: Date = new Date()): void {
    const { db, store } = this.home;
    const rows = db.all<Row>("select * from schedule where paused is null");
    for (const row of rows) {
      const rule = JSON.parse(row.rule) as StoredRule;
      if (isEvent(rule)) {
        if (rule.on === "folder") this.lookAtFolder(row, rule);
        else if (rule.on === "connection" && row.next_at && row.next_at <= at.toISOString()) {
          db.run(
            "update schedule set next_at = ? where id = ?",
            new Date(at.getTime() + rule.minutes * 60_000).toISOString(),
            row.id,
          );
          const look: Promise<void> = this.lookAtConnection(row, rule)
            .catch((error) => console.error("[task]", error))
            .finally(() => this.looks.delete(look));
          this.looks.add(look);
        }
        continue;
      }
      if (!row.next_at || row.next_at > at.toISOString()) continue;
      const agent = store.agent(row.agent_id);
      // One turn at a time: a task that is due while the agent works starts at the next look.
      if (!agent || store.isWorking(agent.conversationId)) continue;
      const next = nextAfter(rule, at);
      if (next) db.run("update schedule set next_at = ? where id = ?", next.toISOString(), row.id);
      else db.run("delete from schedule where id = ?", row.id);
      this.run(row, agent, `A task you scheduled is due now: ${row.prompt}`, false);
    }
  }

  /** Resolves when no look at a connection runs. */
  async looked(): Promise<void> {
    while (this.looks.size) await Promise.all(this.looks);
  }

  /** A mail arrived in the agent's mailbox that is not from the person. */
  mail(incoming: Incoming): void {
    const subject = subjectOf(incoming.thread);
    for (const row of this.waitingFor("mail")) {
      const rule = JSON.parse(row.rule) as Extract<EventRule, { on: "mail" }>;
      if (rule.from && !fromMatches(incoming.from, rule.from)) continue;
      if (rule.subject && !subject.toLowerCase().includes(rule.subject.toLowerCase())) continue;
      this.happened(
        row.id,
        `mail from ${incoming.from}${subject ? `, subject “${subject}”` : ""}:\n${clip(incoming.text, DATA_LIMIT)}`,
      );
    }
  }

  /** The addresses other services post to, one per task that waits for that. */
  routes(app: Hono): void {
    app.post("/hooks/:token", async (c) => {
      const row = this.home.db.get<Row>(
        "select * from schedule where hook = ?",
        hash(c.req.param("token")),
      );
      if (!row) return c.json({ error: "not_found", message: "There is no such address." }, 404);
      const tooLarge = () =>
        c.json(
          { error: "too_large", message: "This is more than the Bot Server takes at once." },
          413,
        );
      if (Number(c.req.header("content-length") ?? 0) > HOOK_LIMIT) return tooLarge();
      const body = await c.req.text();
      if (Buffer.byteLength(body) > HOOK_LIMIT) return tooLarge();
      const type = (c.req.header("content-type") ?? "").split(";")[0]?.trim();
      if (!row.paused)
        this.happened(
          row.id,
          `posted${type ? ` as ${type}` : ""}:\n${clip(body, DATA_LIMIT) || "(nothing)"}`,
        );
      // Accepted says the home has it, not that the agent is done with it.
      return c.json({ accepted: true }, 202);
    });
  }

  /**
   * Something a task waits for happened. Many events in a short time are told in one turn,
   * and what arrived is given to the agent as data from outside.
   */
  happened(id: string, text: string): void {
    const entry = this.waiting.get(id) ?? {
      events: [],
      more: 0,
      first: Date.now(),
      timer: undefined,
    };
    if (entry.events.length >= EVENTS_KEPT) {
      entry.events.shift();
      entry.more++;
    }
    entry.events.push({ at: new Date(), text });
    this.waiting.set(id, entry);
    const { settle, longest } = this.timing;
    this.arm(id, Math.min(settle, entry.first + longest - Date.now()));
  }

  private arm(id: string, wait: number): void {
    const entry = this.waiting.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.tell(id), Math.max(wait, 0));
    entry.timer.unref();
  }

  /** Gives the agent one turn with every event that waits, when it is free and the hour allows it. */
  private tell(id: string) {
    const entry = this.waiting.get(id);
    if (!entry) return;
    const row = this.row(id);
    const agent = row && this.home.store.agent(row.agent_id);
    if (!row || !agent || row.paused) return this.forget(id);
    if (this.home.store.isWorking(agent.conversationId)) return this.arm(id, this.timing.busy);
    const since = Date.now() - this.timing.hour;
    const recent = (this.started.get(id) ?? []).filter((at) => at > since);
    if (recent.length >= this.timing.perHour) {
      const free = (recent[0] ?? 0) + this.timing.hour - Date.now();
      return this.arm(id, Math.min(free, 60_000));
    }
    this.waiting.delete(id);
    this.started.set(id, [...recent, Date.now()]);
    const rule = JSON.parse(row.rule) as StoredRule;
    this.run(row, agent, eventText(row, rule, entry.events, entry.more), true);
  }

  private run(row: Row, agent: AgentRecord, text: string, outside: boolean): void {
    const quiet = row.quiet === 1;
    void this.home.turns.enqueue({
      conversationId: agent.conversationId,
      text: `[home] ${text}${quiet ? `\n${QUIET}` : ""}`,
      channel: "home",
      task: { id: row.id, title: titleOf(row), quiet, ...(outside ? { event: true } : {}) },
      outside: outside || undefined,
    });
  }

  private lookAtFolder(row: Row, rule: Extract<EventRule, { on: "folder" }>) {
    const folder = this.home.folders.byName(rule.folder);
    if (!folder) return this.pause(row, `The folder ${rule.folder} is not connected any more.`);
    let listed: ReturnType<Home["folders"]["files"]>;
    try {
      listed = this.home.folders.files(folder, rule.path);
    } catch {
      listed = undefined;
    }
    const place = rule.path ? `${folder.name}/${rule.path}` : folder.name;
    if (!listed) return this.missed(row, `The folder ${place} is not there.`);
    this.misses.delete(row.id);
    const held = Object.fromEntries(listed.files);
    const before =
      this.seen.get(row.id) ??
      (row.state ? (JSON.parse(row.state) as Record<string, string>) : undefined);
    this.seen.set(row.id, held);
    // The first look only notes what is there.
    if (!before) return this.keep(row.id, JSON.stringify(held));
    const lines: string[] = [];
    for (const [path, stamp] of Object.entries(held)) {
      if (before[path] === stamp) continue;
      lines.push(`${before[path] === undefined ? "added" : "changed"}: ${path}`);
    }
    const same = !lines.length && Object.keys(before).length === listed.files.size;
    if (same) return;
    this.keep(row.id, JSON.stringify(held));
    if (!lines.length) return;
    const named = lines.slice(0, FILES_NAMED);
    if (lines.length > named.length) named.push(`and ${lines.length - named.length} more files`);
    this.happened(row.id, named.join("\n"));
  }

  private async lookAtConnection(
    row: Row,
    rule: Extract<StoredRule, { on: "connection" }>,
  ): Promise<void> {
    const { connections } = this.home;
    const connection = connections.byName(rule.connection);
    if (!connection) return this.pause(row, `${rule.connection} is not connected any more.`);
    const tool = connection.tools.find((candidate) => candidate.name === rule.tool);
    if (connection.state !== "connected" || !tool)
      return this.missed(row, `${connection.name} does not answer with ${rule.tool}.`);
    if (!tool.readOnly)
      return this.pause(row, `${tool.name} of ${connection.name} does not only read any more.`);
    const agent = this.home.store.agent(row.agent_id);
    if (!agent) return;
    let answer: string | undefined;
    try {
      answer = await connections.call(connection, tool.name, rule.arguments ?? {}, {
        agentId: agent.id,
        conversationId: agent.conversationId,
      });
    } catch (error) {
      return this.missed(row, `${connection.name} did not answer: ${(error as Error).message}`);
    }
    // No answer: the service asked the person something first, with a card.
    if (answer === undefined || answer.startsWith("The tool failed:"))
      return this.missed(row, `${tool.name} of ${connection.name} gave no answer.`);
    this.misses.delete(row.id);
    const current = this.row(row.id);
    if (!current || current.paused) return;
    const stamp = hash(answer);
    if (current.state === stamp) return;
    this.keep(row.id, stamp);
    // The first look only notes the answer.
    if (current.state) this.happened(row.id, `the answer now:\n${clip(answer, DATA_LIMIT)}`);
  }

  // ── How a run ended ───────────────────────────────────────────────────────

  private ended(ended: Ended): void {
    const ids = new Set(ended.triggers.map((trigger) => trigger.task?.id));
    for (const id of ids) {
      const row = id ? this.row(id) : undefined;
      if (!row) continue;
      const last: NonNullable<Task["last"]> =
        ended.state === "failed"
          ? "failed"
          : ended.asked
            ? "asked"
            : ended.note
              ? "note"
              : "answered";
      const failures = last === "failed" && !ended.stopped ? row.failures + 1 : 0;
      this.home.db.run(
        "update schedule set last_at = ?, last = ?, failures = ? where id = ?",
        now(),
        last,
        failures,
        row.id,
      );
      if (failures >= FAILURES) this.pause(row, `It failed ${FAILURES} times in a row.`);
    }
  }

  /** A look at what a task waits for failed. After several in a row the task is paused. */
  private missed(row: Row, reason: string): void {
    const misses = (this.misses.get(row.id) ?? 0) + 1;
    this.misses.set(row.id, misses);
    if (misses >= FAILURES) this.pause(row, reason);
  }

  /** Pauses a task and tells the person, with a card that lets it run again or removes it. */
  private pause(row: Row, reason: string): void {
    this.forget(row.id);
    this.home.db.run("update schedule set paused = ?, failures = 0 where id = ?", reason, row.id);
    const agent = this.home.store.agent(row.agent_id);
    if (!agent) return;
    const { message } = this.say(agent, {
      kind: "approval",
      level: "needs_you",
      title: `Paused: ${titleOf(row)}`,
      body: `${reason}\n\nThis task does not run until you say so.`,
      actions: [
        { id: "resume", label: "Try again", style: "primary" },
        { id: "remove", label: "Remove task", style: "plain" },
      ],
      payload: { type: "task_paused", taskId: row.id },
    });
    this.home.delivered(message, {
      conversationId: agent.conversationId,
      text: "",
      channel: "home",
    });
  }

  /** Puts a card of the home itself into an agent's conversation. */
  say(agent: AgentRecord, input: NewCard): { card: Card; message: Message } {
    const { store } = this.home;
    const empty = store.addMessage({
      conversationId: agent.conversationId,
      role: "agent",
      agentId: agent.id,
      channel: "home",
      parts: [],
    });
    const card = store.createCard(input, {
      agentId: agent.id,
      conversationId: agent.conversationId,
      messageId: empty.id,
    });
    const message = store.updateMessage(empty.id, { parts: [{ type: "card", card }] });
    return { card, message: message ?? empty };
  }

  // ── What the agent can do ─────────────────────────────────────────────────

  private tools(context: TurnContext): Tool[] {
    const { home, agent, conversationId, draft } = context;
    const title = z
      .string()
      .min(1)
      .max(60)
      .describe(
        "What the task does, in two to five words in the person's language: they see it in the list of what you do by yourself.",
      );
    const quiet = z
      .boolean()
      .optional()
      .describe(
        "Tell the person only when something needs them. Otherwise you leave one line in the chat that notifies no one. For looks that mostly find nothing.",
      );
    const full = (): string | undefined =>
      this.count(agent.id) >= TASKS_PER_AGENT
        ? `You have ${TASKS_PER_AGENT} tasks, which is the most an agent can have. Remove one first.`
        : undefined;
    const tools: Tool[] = [
      defineTool({
        name: "schedule_set",
        description:
          "Set a task for yourself at a time: once (`at`) or repeating (`every`). When it is due you get a turn with the prompt, and the person is notified of what you write.",
        input: z.object({
          title,
          prompt: z.string().describe("What you do when it is due, addressed to yourself."),
          ...When.shape,
          quiet,
        }),
        label: () => "Scheduling a task",
        // The times themselves: whoever reads them sees whether they are meant.
        says: (input) => {
          const when = When.safeParse(input);
          const rule = when.success ? ruleOf(when.data) : "";
          const lang = langOf(this.home.db);
          const times: string[] = [];
          let from = new Date();
          while (typeof rule !== "string" && times.length < 3) {
            const next = nextAfter(rule, from);
            if (!next) break;
            times.push(next.toLocaleString(lang, { dateStyle: "full", timeStyle: "short" }));
            from = next;
          }
          return [
            `**${String(input.title ?? "")}**`,
            String(input.prompt ?? ""),
            times.map((time) => `- ${time}`).join("\n"),
          ]
            .filter(Boolean)
            .join("\n\n");
        },
        run: async (input) => {
          const rule = ruleOf(input);
          if (typeof rule === "string") return rule;
          const set = full() ?? this.schedule(agent.id, rule, whatOf(input));
          if (typeof set === "string") return set;
          if (!set) return "That time is in the past.";
          return `Scheduled as ${set.id}: ${describeRule(rule)}. Next: ${set.next.toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}. If that is not what the person asked for, remove it and set it again.`;
        },
      }),
      defineTool({
        name: "when_set",
        description:
          "Set a task for yourself that starts when something happens: a file is added or changed in a connected folder (`folder`), mail arrives in your mailbox that is not from the person (`mail`), another service posts to an address made for this task (`webhook`), or a tool of a connection that only reads answers differently than at the last look (`connection`). You then get a turn with the prompt and with what happened. Many events in a short time are one turn.",
        input: z.object({
          title,
          prompt: z.string().describe("What you do when it happens, addressed to yourself."),
          on: z.enum(["folder", "mail", "webhook", "connection"]),
          folder: z.string().optional().describe("For folder: the connected folder's name."),
          path: z.string().optional().describe("For folder: only this subfolder, e.g. invoices."),
          from: z
            .string()
            .optional()
            .describe("For mail: only from this address, or a whole domain as @example.com."),
          subject: z.string().optional().describe("For mail: only when the subject has this."),
          connection: z.string().optional().describe("For connection: its name."),
          tool: z.string().optional().describe("For connection: one of its tools that only reads."),
          arguments: z.record(z.string(), z.unknown()).optional().describe("For connection."),
          minutes: z
            .number()
            .int()
            .min(5)
            .max(24 * 60)
            .optional()
            .describe("For connection: how often to look. 15 when left out."),
          quiet,
        }),
        label: () => "Setting a task",
        run: async (input) => {
          const refused = full();
          if (refused) return refused;
          const what = whatOf(input);
          if (input.on === "folder") {
            const folder = input.folder ? home.folders.byName(input.folder) : undefined;
            if (!folder) {
              const known = home.folders.list().map((each) => each.name);
              return known.length
                ? `Name one of the connected folders: ${known.join(", ")}.`
                : "No folder is connected. The person connects one in the app.";
            }
            const path = input.path?.replace(/^\/+|\/+$/g, "") || undefined;
            const listed = home.folders.files(folder, path);
            if (!listed) return `There is no folder ${path} in ${folder.name}.`;
            const id = this.insert(
              agent.id,
              { on: "folder", folder: folder.name, path },
              what,
              // What is there now is known, so only what comes after starts the task.
              { state: JSON.stringify(Object.fromEntries(listed.files)) },
            );
            return `Set as ${id}. It starts when a file is added or changed in ${folder.name}${path ? `/${path}` : ""}.${listed.more ? ` The folder is large: only its first ${listed.files.size} files are looked at.` : ""}`;
          }
          if (input.on === "mail") {
            if (!home.channels.owner("email"))
              return "A task on mail needs your mailbox. Set up the email channel first; the person then claims it.";
            const from = input.from?.trim().toLowerCase() || undefined;
            const subject = input.subject?.trim() || undefined;
            const id = this.insert(agent.id, { on: "mail", from, subject }, what);
            return `Set as ${id}. It starts when mail arrives that is not from the person${from ? `, from ${from}` : ""}${subject ? `, with “${subject}” in the subject` : ""}.`;
          }
          if (input.on === "webhook") {
            const token = newToken();
            const id = this.insert(agent.id, { on: "webhook" }, what, { hook: hash(token) });
            // The address is a secret: the person reads it on a card, no model does.
            const card = home.store.createCard(
              {
                kind: "question",
                level: "update",
                title: "Address for this task",
                body: [
                  `“${what.title}” starts when another service posts to this address:`,
                  `\`${home.address()}/hooks/${token}\``,
                  "Whoever has the address can start the task, so give it to that service only. It is shown on this card and nowhere else.",
                  home.config.publicUrl
                    ? ""
                    : "Your Bot Server has no public address yet: only what runs in your own network reaches it.",
                ]
                  .filter(Boolean)
                  .join("\n\n"),
                actions: [],
              },
              { agentId: agent.id, conversationId, messageId: draft.id },
            );
            draft.add({ type: "card", card });
            return `Set as ${id}. Its address is on a card in the chat. You do not see it: tell the person to copy it from the card into the other service.`;
          }
          const connection = input.connection
            ? home.connections.byName(input.connection)
            : undefined;
          if (connection?.state !== "connected")
            return `Name a connected account or app: ${home.connections.names().join(", ") || "none is connected"}.`;
          const tool = connection.tools.find(
            (candidate) => candidate.name === input.tool && !candidate.appOnly,
          );
          if (!tool) return `${connection.name} has no tool ${input.tool}. Call connection_tools.`;
          if (!tool.readOnly)
            return `${tool.name} changes something. Only a tool that reads can be looked at by itself.`;
          const minutes = input.minutes ?? 15;
          const id = this.insert(
            agent.id,
            {
              on: "connection",
              connection: connection.name,
              tool: tool.name,
              minutes,
              arguments: input.arguments ?? {},
            },
            what,
            { nextAt: now() },
          );
          return `Set as ${id}. The Bot Server looks at ${connection.name} every ${minutes} minutes and starts the task when ${tool.name} answers differently than before.`;
        },
      }),
      defineTool({
        name: "task_list",
        description:
          "List your tasks: the scheduled ones and the ones that wait for an event, with when each ran last.",
        input: z.object({}),
        label: () => "Looking at the tasks",
        run: async () => {
          const rows = home.db.all<Row>(
            "select * from schedule where agent_id = ? order by created_at",
            agent.id,
          );
          if (!rows.length) return "You have no tasks.";
          return rows
            .map((row) => {
              const rule = JSON.parse(row.rule) as StoredRule;
              const facts = [
                describeRule(rule),
                row.quiet ? "quiet" : "",
                !isEvent(rule) && row.next_at
                  ? `next ${new Date(row.next_at).toLocaleString("en-GB")}`
                  : "",
                row.last_at
                  ? `last ran ${new Date(row.last_at).toLocaleString("en-GB")}: ${row.last}`
                  : "has not run yet",
                row.paused ? `PAUSED: ${row.paused}` : "",
              ];
              return `- ${row.id} “${titleOf(row)}”: ${row.prompt} (${facts.filter(Boolean).join("; ")})`;
            })
            .join("\n");
        },
      }),
      defineTool({
        name: "task_remove",
        description: "Remove one of your tasks.",
        input: z.object({ id: z.string() }),
        label: () => "Removing a task",
        run: async (input) =>
          this.remove(input.id, agent.id) ? "Removed." : `You have no task ${input.id}.`,
      }),
      defineTool({
        name: "task_resume",
        description:
          "Let a task run again that the Bot Server paused because it kept failing. Do it when the person says so or the cause is gone.",
        input: z.object({ id: z.string() }),
        label: () => "Resuming a task",
        run: async (input) =>
          this.resume(input.id, agent.id) ? "It runs again." : `You have no task ${input.id}.`,
      }),
    ];
    if (context.trigger.task?.quiet) {
      tools.push(
        defineTool({
          name: "note",
          description:
            "End a quiet task's run when nothing needs the person: one line that says what you looked at. It stays in the chat for them to find and notifies no one. Do not use it when something needs them.",
          input: z.object({ line: z.string().min(1).max(240) }),
          label: () => "Leaving a note",
          run: async (input) => {
            context.leaveNote(input.line);
            return "The note is left. End your turn now and write nothing else.";
          },
        }),
      );
    }
    return tools;
  }

  // ── The rows ──────────────────────────────────────────────────────────────

  private row(id: string): Row | undefined {
    return this.home.db.get<Row>("select * from schedule where id = ?", id);
  }

  private count(agentId: string): number {
    return (
      this.home.db.get<{ n: number }>(
        "select count(*) as n from schedule where agent_id = ?",
        agentId,
      )?.n ?? 0
    );
  }

  /** The tasks that wait for one kind of event and are not paused. */
  private waitingFor(on: EventRule["on"]): Row[] {
    return this.home.db.all<Row>(
      "select * from schedule where paused is null and json_extract(rule, '$.on') = ?",
      on,
    );
  }

  private insert(
    agentId: string,
    rule: StoredRule,
    what: What,
    more: { nextAt?: string; state?: string; hook?: string } = {},
  ): string {
    const id = newId("sch");
    this.home.db.run(
      "insert into schedule (id, agent_id, rule, title, prompt, next_at, created_at, quiet, state, hook) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      agentId,
      JSON.stringify(rule),
      what.title,
      what.prompt,
      more.nextAt ?? null,
      now(),
      what.quiet ? 1 : 0,
      more.state ?? null,
      more.hook ?? null,
    );
    return id;
  }

  private keep(id: string, state: string): void {
    this.home.db.run("update schedule set state = ? where id = ?", state, id);
  }

  /** Drops what the home holds in memory about a task. */
  private forget(id: string): void {
    clearTimeout(this.waiting.get(id)?.timer);
    this.waiting.delete(id);
    this.misses.delete(id);
    this.seen.delete(id);
  }
}

/** What a task does: its name for the person, what the agent is told, and whether it is quiet. */
export interface What {
  title: string;
  prompt: string;
  quiet: boolean;
}

const whatOf = (input: { title: string; prompt: string; quiet?: boolean }): What => ({
  title: input.title.trim(),
  prompt: input.prompt,
  quiet: input.quiet === true,
});

/** A task's name. A task without one is called by the start of its prompt. */
const titleOf = (row: Row): string => row.title || short(row.prompt, 60);

/** A rule as devices get it: without what a look calls a tool with. */
function publicRule(rule: StoredRule): Task["rule"] {
  if (!isEvent(rule) || rule.on !== "connection") return rule;
  const { arguments: _arguments, ...rest } = rule;
  return rest;
}

/** The subject of a mail, from what the email channel keeps to answer in its thread. */
function subjectOf(thread: string | undefined): string {
  if (!thread) return "";
  try {
    const subject = (JSON.parse(thread) as { subject?: unknown }).subject;
    return typeof subject === "string" ? subject : "";
  } catch {
    return "";
  }
}

/** Whether a sender fits what a task names: an address, or a domain as `@example.com`. */
export function fromMatches(sender: string, wanted: string): boolean {
  const from = sender.toLowerCase();
  const want = wanted.toLowerCase().replace(/^\*/, "");
  if (want.startsWith("@")) return from.endsWith(want);
  return want.includes("@") ? from === want : from.endsWith(`@${want}`);
}
