import { Agent } from "@mastra/core/agent";
import {
  MASTRA_RESOURCE_ID_KEY,
  MASTRA_THREAD_ID_KEY,
  RequestContext,
} from "@mastra/core/request-context";
import type { Admin, Card, Channel, FileRef, Message } from "@wizards-bot/protocol";
import type { Home } from "../home.ts";
import { newToken } from "../ids.ts";
import { ACCOUNT, type Engine, splitRef } from "../models/models.ts";
import type { AgentRecord } from "../store/store.ts";
import { cacheProcessor, markedInstructions } from "./cache.ts";
import { Draft } from "./draft.ts";
import { type Prompt, systemPrompt } from "./prompt.ts";
import { type Answer, type Asking, mastraTools, runTool, type Tool } from "./tool.ts";

export interface Trigger {
  conversationId: string;
  /** What the agent reads as the new message. */
  text: string;
  channel: Channel;
  spoken?: boolean;
  /** Where the reply goes besides the app. */
  replyTo?: { channel: Channel; peer: string; thread?: string };
  /** Files the person attached to the message. */
  files?: FileRef[];
  /** In a group home: the admin who wrote the message. */
  writer?: Admin;
  /**
   * The turn answers someone else, not the person: a contact (name and handle) or a caller
   * from outside (its name). The agent has none of the person's tools. `hears`: the person
   * said that this contact may hear what the agent remembers.
   */
  guest?: { name: string; handle?: string; hears?: boolean };
  /**
   * The turn answers a room the agent was put into: its name and who is in it. The agent
   * brings what is its own (its task, its memory, the documents, artifacts and files of its
   * conversation) and none of the person's tools.
   */
  room?: { name: string; members: string[] };
  /**
   * The turn runs a task of the agent: which one, what it is called, whether it is quiet, and
   * whether an event started it (mail, a webhook, a connection, a folder) rather than a time.
   */
  task?: { id: string; title: string; quiet: boolean; event?: boolean };
  /** The text carries data from outside the home. What leaves the home in this turn asks first. */
  outside?: boolean;
  /**
   * The turn goes on with longer work: which turn in a row it is (the one that started the
   * work is 1), what the agent said is next, and the message of the turn before.
   */
  work?: { turn: number; next: string; after: Message };
  /**
   * A tool asked the person and no run of Mastra waits for the answer: the home runs the
   * tool again with the answer, and the agent reads what it then says.
   */
  again?: { tool: string; input: unknown; answer: Answer };
  done?: (message: Message) => void;
}

/** A run Mastra suspended: a tool in it asked the person with a card. */
interface Parked {
  runId: string;
  toolCallId: string;
  cardId: string;
}

/** How a turn ended, for the parts of the home that started it. */
export interface Ended {
  message: Message;
  /** The message that started the turn, then those delivered into it. */
  triggers: Trigger[];
  state: "done" | "failed";
  /** The turn left a note instead of an answer. */
  note: boolean;
  /** The turn made a card that waits for the person. */
  asked: boolean;
  /** The person stopped it. */
  stopped: boolean;
}

/** What an agent is doing while it works. */
export interface Doing {
  /** What it works on, in one line: the task, or what it said is next. "" when it answers a message. */
  what: string;
  /** Which turn in a row this is, and how many the home gives. */
  turn: number;
  turns: number;
}

/** What a tool knows about the turn it runs in. */
export interface TurnContext {
  home: Home;
  agent: AgentRecord;
  conversationId: string;
  draft: Draft;
  trigger: Trigger;
  /** Whether the turn read data from outside the home, in its first message or a later one. */
  outside(): boolean;
  /** Whether a task an event started is among what the turn answers. It changes no files. */
  byEvent(): boolean;
  /** Ends a quiet task's run with one line for the person to find, instead of an answer. */
  leaveNote(line: string): void;
  /**
   * Asks the home for the next turn of longer work. False when the turns in a row are used
   * up: the agent then says where the work stands and waits for the person.
   */
  goOn(done: string, next: string): boolean;
}

/** Tool rounds one message may take before the agent has to answer. Mastra's own default is 5. */
const MAX_STEPS = 16;
/** Turns in a row the home gives an agent for longer work before the person has to say go on. */
export const WORK_TURNS = 8;
const TURN = "turn";
/** How long the home keeps reading a conversation's thread after its last turn. */
const IDLE_MS = 60_000;
/** How long, and how much of, a run's output is kept before its turn is known. */
const EARLY_MS = 30_000;
const EARLY_CHUNKS = 5_000;

/** A chunk of a run as Mastra streams it on the thread; the kinds the home reads. */
interface Chunk {
  type: string;
  runId?: string;
  // biome-ignore lint/suspicious/noExplicitAny: Mastra's chunks are a wide union; a few kinds matter here
  payload?: any;
}

interface Following {
  subscription: { unsubscribe(): void };
  idle: ReturnType<typeof setTimeout> | undefined;
}

/** One run of an agent: the message it writes and everything that was said to it meanwhile. */
class Turn {
  readonly controller = new AbortController();
  readonly mcpToken = newToken();
  /** The message that started the run, then those delivered into it. */
  readonly triggers: Trigger[];
  readonly finished: Promise<Message | undefined>;
  private finish: (message: Message | undefined) => void = () => {};
  private started:
    | { draft: Draft; context: TurnContext; tools: Tool[]; asking: Asking }
    | undefined;
  /** The line a quiet task's run leaves instead of an answer. */
  note: string | undefined;
  /** What the agent said is done and what is next, when it asked for another turn. */
  next: { done: string; next: string } | undefined;
  private changing: string | undefined;
  /** Tool rounds the run took, and whether the last one still called tools. */
  steps = 0;
  open = false;
  /** Mastra's run this turn reads, once Mastra said which. */
  runId: string | undefined;
  /** The engine the last step that did not fail ran on, and what went wrong. */
  model: string | undefined;
  problem = "";
  /** The run's own output reached the turn: a status before it belongs to an earlier run. */
  seen = false;
  private readonly home: Home;
  private readonly agent: AgentRecord;
  private readonly engines: Engine[];

  constructor(home: Home, agent: AgentRecord, trigger: Trigger, engines: Engine[]) {
    this.home = home;
    this.agent = agent;
    this.engines = engines;
    this.triggers = [trigger];
    this.finished = new Promise((resolve) => {
      this.finish = resolve;
    });
  }

  get trigger(): Trigger {
    return this.triggers[0] as Trigger;
  }

  /** The run's message and tools, made when the run really starts. */
  get parts(): { draft: Draft; context: TurnContext; tools: Tool[]; asking: Asking } {
    if (this.started) return this.started;
    const { home, agent, trigger } = this;
    const draft = new Draft(
      home.store,
      home.store.addMessage({
        conversationId: trigger.conversationId,
        // A quiet task's run disturbs no one while it works. It becomes an answer when it has one.
        role: trigger.task?.quiet ? "note" : "agent",
        agentId: agent.id,
        channel: trigger.channel,
        parts: [],
        state: "streaming",
      }),
    );
    const context: TurnContext = {
      home,
      agent,
      conversationId: trigger.conversationId,
      draft,
      trigger,
      outside: () => this.outside,
      byEvent: () => this.triggers.some((each) => each.task?.event),
      leaveNote: (line) => {
        this.note = line;
      },
      goOn: (done, next) => {
        if (this.number >= WORK_TURNS) return false;
        this.next = { done, next };
        return true;
      },
    };
    const tools = trigger.room
      ? home.peers.rooms.tools(context)
      : trigger.guest
        ? home.peers.guestTools(context)
        : home.tools(context);
    // The card of a tool that asks: it names the tool and its input, to run it again.
    const asking: Asking = {
      card: (tool, input, { private: hidden, ...card }, kept) => {
        const made = home.store.createCard(
          {
            ...card,
            payload: {
              type: "tool",
              tool: tool.name,
              input,
              kept,
              ...(hidden ? { private: true } : {}),
            },
          },
          { agentId: agent.id, conversationId: trigger.conversationId, messageId: draft.id },
        );
        draft.add({ type: "card", card: made });
        return made;
      },
    };
    // A subscription's client reaches these tools over MCP with the turn's token.
    home.mcp.open(this.mcpToken, { tools, draft, asking });
    this.started = { draft, context, tools, asking };
    return this.started;
  }

  get begun(): boolean {
    return this.started !== undefined;
  }

  /** The agent lives in a contact's home or outside: no run of Mastra answers here. */
  get shared(): boolean {
    return this.agent.origin === "shared";
  }

  /** Which turn in a row this is. */
  get number(): number {
    return this.trigger.work?.turn ?? 1;
  }

  get outside(): boolean {
    return this.triggers.some((trigger) => trigger.outside);
  }

  /** Every message the turn read belongs to a quiet task. */
  get quiet(): boolean {
    return this.triggers.every((trigger) => trigger.task?.quiet);
  }

  /** The run used up its tool rounds before the agent answered. */
  get cut(): boolean {
    return this.open && this.steps >= MAX_STEPS;
  }

  /** The stable part of the prompt: the run's instructions. */
  instructions(): string {
    return this.prompt().stable;
  }

  /**
   * What changes from turn to turn, made once per turn: the same in every step of the run, so
   * each step reads the steps before it from the provider's cache.
   */
  context(): string {
    this.changing ??= this.prompt().context;
    return this.changing;
  }

  private prompt(): Prompt {
    const { home, agent, trigger } = this;
    // In a room the agent reads what is beside its own conversation with the person.
    const beside = trigger.room ? agent.conversationId : trigger.conversationId;
    return systemPrompt({
      agent,
      person: home.person() || "the person",
      group: home.group.isGroup()
        ? { admins: home.group.admins().map((admin) => admin.name) }
        : undefined,
      agents: home.store.agents(),
      connections: home.connections.names(),
      documents: home.store.documents(beside).slice(0, 12),
      artifacts: home.artifacts.list(beside).slice(0, 12),
      files: trigger.room ? home.store.sentFiles(beside, 20) : undefined,
      room: trigger.room,
      folders: trigger.guest ? [] : home.folders.list(),
      tasks: trigger.guest ? [] : home.tasks.lines(agent.id),
      skills: trigger.guest ? undefined : home.skills.prompt(trigger.conversationId),
      devices: trigger.guest ? undefined : home.handoffs.prompt(agent, home.person()),
      shell: trigger.guest || trigger.room ? undefined : home.shell.prompt(home.person()),
      // A card without a button only shows something: a pairing code, a task's address.
      waiting: home.store
        .openCards(trigger.conversationId)
        .filter((card) => card.actions.length)
        .map((card) => card.title),
      spoken: trigger.spoken === true,
      guest: trigger.guest,
    });
  }

  /**
   * The tools a model sees in its next step. A skill's tools are among them only while the
   * skill is loaded, so they cost nothing before.
   */
  shownTools(): string[] {
    return this.parts.tools
      .filter((tool) => this.home.skills.shows(this.trigger.conversationId, tool.name))
      .map((tool) => tool.name);
  }

  /** The engines in the order Mastra tries them: when one fails, it asks the next. */
  models(): unknown {
    const models = this.engines.map((engine) => ({
      model: engine.model({ mcpToken: this.mcpToken, conversationId: this.trigger.conversationId }),
      maxRetries: 0,
    }));
    return models.length === 1 ? models[0]?.model : models;
  }

  /** The ref of the engine a step ran on, from the provider and model id Mastra reports. */
  refOf(provider: unknown, modelId: unknown): string | undefined {
    const exact = this.engines.find((engine) => engine.ref === `${provider}:${modelId}`);
    if (exact) return exact.ref;
    // A gateway's provider is named after it with a suffix, e.g. `openrouter.chat`; the
    // account's gateway client calls itself `gateway`.
    return this.engines.find((engine) => {
      const { sourceId, model } = splitRef(engine.ref);
      if (model !== modelId) return false;
      return (
        String(provider).startsWith(sourceId) || (provider === "gateway" && sourceId === ACCOUNT.id)
      );
    })?.ref;
  }

  end(message: Message | undefined): void {
    this.home.mcp.close(this.mcpToken);
    this.finish(message);
  }
}

/**
 * The next turn of longer work: the agent reads what it said is done and what is next. The
 * answer still goes where the first message came from, and it still belongs to the same task.
 */
function nextTurn(turn: Turn, message: Message): Trigger {
  const first = turn.trigger;
  const waiting = turn.triggers.filter((trigger) => trigger.done);
  const { done, next } = turn.next ?? { done: "", next: "" };
  const number = turn.number + 1;
  return {
    conversationId: first.conversationId,
    text: [
      `[home] Go on with your work. This is turn ${number} of ${WORK_TURNS} in a row.`,
      done ? `Done so far: ${done}` : "",
      next
        ? `Next: ${next}`
        : "Your last turn used up its tool rounds before you answered. Say in one sentence where the work stands, then go on.",
      number === WORK_TURNS
        ? "It is the last turn before the person has to say go on: end it with where the work stands and what is open."
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
    channel: first.channel,
    replyTo: turn.triggers.find((trigger) => trigger.replyTo)?.replyTo,
    task: first.task,
    outside: turn.outside,
    work: { turn: number, next, after: message },
    done: waiting.length
      ? (last) => {
          for (const trigger of waiting) trigger.done?.(last);
        }
      : undefined,
  };
}

/**
 * Runs the agents' turns. What is said to an agent is a Mastra signal on the conversation's
 * thread: it wakes the agent when it is idle and is delivered into the running turn when it
 * is not, so a message written meanwhile is read before the agent goes on. Mastra keeps
 * what was said, the tool calls and their results; the home keeps the message the person
 * reads.
 */
export class Turns {
  private readonly agents = new Map<string, Agent>();
  /** The running turn of each conversation. */
  private readonly runs = new Map<string, Turn>();
  private readonly pending = new Set<Promise<void>>();
  /** Conversations whose agent was given the next turn of longer work that has not begun yet. */
  private readonly between = new Set<string>();
  /** Conversations the person stopped between two turns of longer work. */
  private readonly halted = new Set<string>();
  private readonly listeners: ((ended: Ended) => void)[] = [];
  /**
   * The run Mastra suspended in each conversation, and the card it waits on. Kept in the
   * home's own database: Mastra keeps the run itself, also over a start of the home.
   */
  private readonly parked = {
    get: (conversationId: string): Parked | undefined => {
      const kept = this.home.db.meta(`turn.parked.${conversationId}`);
      return kept ? (JSON.parse(kept) as Parked) : undefined;
    },
    set: (conversationId: string, parked: Parked) =>
      this.home.db.setMeta(`turn.parked.${conversationId}`, JSON.stringify(parked)),
    delete: (conversationId: string) => this.home.db.setMeta(`turn.parked.${conversationId}`, ""),
  };
  /** The answer to a card, for the suspended call that is being resumed. */
  private readonly answers = new Map<string, Answer>();
  /**
   * Each conversation's thread as Mastra streams it: every run on it, however it started (a
   * message that woke the agent, a card's answer that resumed it), read in one place.
   */
  private readonly threads = new Map<string, Promise<Following>>();
  /** The turn of each run of Mastra the home reads, by the run's id. */
  private readonly byRun = new Map<string, Turn>();
  /** What a run streamed before the home knew its turn: Mastra streams before it names the run. */
  private readonly early = new Map<string, Chunk[]>();
  private readonly home: Home;

  constructor(home: Home) {
    this.home = home;
    home.onCard("tool", ({ card, action, values, payload }) =>
      this.answered(card, payload, {
        action,
        values,
        card: { id: card.id, title: card.title, actions: card.actions },
        kept: payload.kept,
        by: card.answer?.admin?.name,
      }),
    );
  }

  /**
   * The person answered the card of a tool that asked. Where Mastra holds the run, also
   * after a start of the home, it goes on in the same tool call. Otherwise (a client that
   * steps by itself, a message in between) the home runs the tool again and the agent reads
   * its answer.
   */
  private async answered(
    card: Card,
    payload: Record<string, unknown>,
    answer: Answer,
  ): Promise<void> {
    const parked = this.parked.get(card.conversationId);
    if (parked?.cardId === card.id) {
      this.parked.delete(card.conversationId);
      try {
        return await this.resume(card, parked, answer);
      } catch (error) {
        console.error("[turn] the suspended run did not go on:", (error as Error).message);
      }
    }
    await this.enqueue({
      conversationId: card.conversationId,
      text: "",
      channel: "home",
      again: { tool: String(payload.tool), input: payload.input, answer },
    });
  }

  /** Lets Mastra go on with a suspended run: the tool runs again inside its call. */
  private async resume(card: Card, parked: Parked, answer: Answer): Promise<void> {
    const { store } = this.home;
    const conversation = store.conversation(card.conversationId);
    const agent = conversation && store.agent(conversation.agentId);
    if (!conversation || !agent) return;
    while (this.runs.has(conversation.id)) await this.runs.get(conversation.id)?.finished;
    await this.home.models.refresh();
    const engines = this.home.models
      .candidates()
      .map((ref) => this.home.models.engine(ref))
      .filter((engine) => engine !== undefined);
    const turn = new Turn(
      this.home,
      agent,
      { conversationId: conversation.id, text: "", channel: "home" },
      engines,
    );
    this.answers.set(card.id, answer);
    try {
      await this.follow(agent, conversation.id);
      // The run goes on under its own id: what it streams now is this turn's.
      this.claim(turn, parked.runId, true);
      this.runs.set(conversation.id, turn);
      store.setWorking(conversation.id, true);
      await this.mastraAgent(agent).resumeStream({ answered: card.id }, {
        runId: parked.runId,
        toolCallId: parked.toolCallId,
        memory: { thread: conversation.id, resource: agent.id },
        ...this.streamOptions(turn),
      } as never);
      await turn.finished;
    } catch (error) {
      this.byRun.delete(parked.runId);
      if (this.runs.get(conversation.id) === turn) this.runs.delete(conversation.id);
      store.setWorking(conversation.id, false);
      throw error;
    } finally {
      this.answers.delete(card.id);
    }
  }

  private streamOptions(turn: Turn): Record<string, unknown> {
    return {
      maxSteps: MAX_STEPS,
      modelSettings: { maxOutputTokens: 8000 },
      requestContext: new RequestContext([[TURN, turn]]),
      // Asked before every step: a skill loaded in one step brings its tools to the next.
      prepareStep: () => ({ activeTools: turn.shownTools() }),
    };
  }

  /** Calls `listener` with every turn that ended and is not followed by another turn of the same work. */
  onEnded(listener: (ended: Ended) => void): void {
    this.listeners.push(listener);
  }

  /** What an agent is doing right now, or nothing when it does not work. */
  doing(conversationId: string): Doing | undefined {
    const turn = this.runs.get(conversationId);
    if (!turn) return undefined;
    const { work, task } = turn.trigger;
    return { what: work?.next || task?.title || "", turn: turn.number, turns: WORK_TURNS };
  }

  /** Says something to an agent. Resolves when the turn that read it is done. */
  enqueue(trigger: Trigger): Promise<void> {
    const work: Promise<void> = this.send(trigger)
      .catch((error) => console.error("[turn]", error))
      .finally(() => this.pending.delete(work));
    this.pending.add(work);
    return work;
  }

  /**
   * Stops the running turn, and with it the longer work it belongs to. Mastra ends the run on
   * the thread. What was said into the run and not read yet stays in the thread: clearing it
   * (`clearPendingSignals`) would drop those words.
   */
  stop(conversationId: string): void {
    const turn = this.runs.get(conversationId);
    if (turn) {
      turn.controller.abort();
      const agent = this.home.store.agent(
        this.home.store.conversation(conversationId)?.agentId ?? "",
      );
      if (!turn.shared && agent) {
        this.mastraAgent(agent).abortThreadStream({
          resourceId: agent.id,
          threadId: conversationId,
        });
      }
    } else if (this.between.has(conversationId)) this.halted.add(conversationId);
  }

  /**
   * A turn that Mastra's A2A handler runs, for someone who is not the person: a contact's home
   * or a caller. The handler starts the agent itself, with this request context: it carries
   * the turn, and the conversation the agent remembers in, whatever the sender names. `close`
   * finishes the turn's message with what the agent answered. Nothing when no model can
   * answer.
   */
  async guestRun(
    conversationId: string,
    guest: NonNullable<Trigger["guest"]>,
  ): Promise<{ context: RequestContext; close(text: string, failed?: boolean): void } | undefined> {
    const { store, models } = this.home;
    const conversation = store.conversation(conversationId);
    const agent = conversation && store.agent(conversation.agentId);
    if (agent?.origin !== "own") return undefined;
    await models.refresh();
    const engines = models
      .candidates()
      .map((ref) => models.engine(ref))
      .filter((engine) => engine !== undefined);
    if (!engines.length) return undefined;
    const turn = new Turn(
      this.home,
      agent,
      { conversationId, text: "", channel: "home", guest },
      engines,
    );
    this.mastraAgent(agent);
    const context = new RequestContext();
    context.set(TURN, turn);
    context.set(MASTRA_THREAD_ID_KEY, conversationId);
    context.set(MASTRA_RESOURCE_ID_KEY, agent.id);
    // The home is not idle while the turn's message is open.
    let closed: () => void = () => {};
    const open: Promise<void> = new Promise<void>((resolve) => {
      closed = resolve;
    }).finally(() => this.pending.delete(open));
    this.pending.add(open);
    return {
      context,
      close: (text, failed = false) => {
        closed();
        // A request that started no run left no message to finish.
        if (!turn.begun && !text) return turn.end(undefined);
        const { draft } = turn.parts;
        if (text) draft.write(text);
        turn.end(draft.finish(failed ? "failed" : "done"));
      },
    };
  }

  /** Resolves when no turn runs or waits. */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all(this.pending);
  }

  private async send(trigger: Trigger): Promise<void> {
    const { store } = this.home;
    const conversation = store.conversation(trigger.conversationId);
    const agent = conversation && store.agent(conversation.agentId);
    if (!conversation || !agent) return;

    if (agent.origin === "shared") return this.askShared(agent, trigger);
    // A room is no agent: what the person writes there goes to everyone in it.
    if (agent.origin === "room") return this.home.peers.rooms.said(agent, trigger.text);

    await this.home.models.refresh();
    const engines = this.home.models
      .candidates()
      .map((ref) => this.home.models.engine(ref))
      .filter((engine) => engine !== undefined);
    const turn = new Turn(this.home, agent, trigger, engines);
    // The person stopped the work between two of its turns.
    if (
      trigger.work &&
      this.between.delete(conversation.id) &&
      this.halted.delete(conversation.id)
    ) {
      store.setWorking(conversation.id, false);
      trigger.done?.(trigger.work.after);
      return;
    }
    if (!engines.length && !this.runs.has(conversation.id)) {
      turn.parts.draft.write(
        "No model can answer right now. Start Ollama on your computer, sign in to Claude or Codex there, or tell me which gateway to use.",
      );
      return this.close(turn, "failed", undefined);
    }

    // Something new is said while a run waits for a card: Mastra would hold the message
    // until the card is answered. The run ends instead; its card stays and is answered
    // by running the tool again.
    const parked = this.parked.get(conversation.id);
    if (parked) {
      this.parked.delete(conversation.id);
      this.mastraAgent(agent).abortRunStream(parked.runId);
    }
    if (trigger.again) {
      while (this.runs.has(conversation.id)) await this.runs.get(conversation.id)?.finished;
      const { tools, draft, asking } = turn.parts;
      const { tool: name, input, answer } = trigger.again;
      const tool = tools.find((candidate) => candidate.name === name);
      const ran = tool
        ? await runTool(tool, input, draft, { ...asking, answer })
        : { text: `There is no tool ${name} any more.` };
      // The tool asked again: its new card waits, and no model has anything to read yet.
      if (draft.asks) return this.close(turn, "done", undefined);
      const chosen = answer.card.actions.find((action) => action.id === answer.action);
      trigger.text = `[home] ${answer.by ?? "The person"} answered "${answer.card.title}" with "${chosen?.label ?? answer.action}". ${name} says:\n${ran.text}`;
    }

    // A message that names a kind of document loads its skill before the model starts.
    if (!trigger.guest) this.home.skills.hear(conversation.id, trigger);
    await this.follow(agent, conversation.id);
    const result = this.mastraAgent(agent).sendSignal(
      { type: "user", contents: await this.contents(trigger) } as never,
      {
        resourceId: agent.id,
        threadId: conversation.id,
        ifActive: { behavior: "deliver" },
        ifIdle: {
          behavior: "wake",
          streamOptions: this.streamOptions(turn),
        },
      } as never,
    );
    const accepted = (await result.accepted) as { action: string; runId?: string };

    // The run's output is read from the thread (`listen`), not from the stream Mastra hands back.
    if (accepted.action === "wake" && accepted.runId) {
      this.runs.set(conversation.id, turn);
      store.setWorking(conversation.id, true);
      this.claim(turn, accepted.runId);
      await turn.finished;
      return;
    }
    // The running turn reads it. This call is done when that turn is.
    const running = await this.running(conversation.id);
    if (!running) return;
    running.triggers.push(trigger);
    await running.finished;
  }

  /** What the agent reads: the text, and with attached files their text and the pictures. */
  private async contents(
    trigger: Trigger,
  ): Promise<
    | string
    | (
        | { type: "text"; text: string }
        | { type: "file"; data: string; mediaType: string; filename: string }
      )[]
  > {
    if (!trigger.files?.length) return trigger.text;
    const { text, pictures } = await this.home.files.forModel(trigger.files);
    return [
      { type: "text", text: [trigger.text, text].filter(Boolean).join("\n\n") },
      ...pictures.map((picture) => ({
        type: "file" as const,
        data: picture.base64,
        mediaType: picture.mime,
        filename: picture.name,
      })),
    ];
  }

  /** Reads the conversation's thread from now on, if the home does not already. */
  private async follow(agent: AgentRecord, conversationId: string): Promise<void> {
    let following = this.threads.get(conversationId);
    if (!following) {
      following = this.mastraAgent(agent)
        .subscribeToThread({ resourceId: agent.id, threadId: conversationId, withRunStatus: true })
        .then((subscription) => {
          void this.listen(subscription.stream as AsyncIterable<Chunk>).catch((error) =>
            console.error("[turn] reading the thread:", error),
          );
          return { subscription, idle: undefined };
        });
      this.threads.set(conversationId, following);
      following.catch(() => this.threads.delete(conversationId));
    }
    const entry = await following;
    if (entry.idle) clearTimeout(entry.idle);
    entry.idle = undefined;
  }

  /** Lets go of a conversation's thread a while after its last turn ended. */
  private rest(conversationId: string): void {
    void this.threads.get(conversationId)?.then((entry) => {
      if (entry.idle) clearTimeout(entry.idle);
      entry.idle = setTimeout(() => {
        if (this.runs.has(conversationId)) return;
        entry.subscription.unsubscribe();
        this.threads.delete(conversationId);
      }, IDLE_MS);
      entry.idle.unref();
    });
  }

  /** Every chunk of every run on one thread, handed to the run's turn. */
  private async listen(stream: AsyncIterable<Chunk>): Promise<void> {
    for await (const chunk of stream) {
      const { runId } = chunk;
      if (!runId) continue;
      const turn = this.byRun.get(runId);
      if (turn) {
        this.take(turn, chunk, true);
        continue;
      }
      // A run whose turn is not known yet, or one the home does not read (a guest's).
      const kept = this.early.get(runId) ?? [];
      if (!kept.length) setTimeout(() => this.early.delete(runId), EARLY_MS).unref();
      if (kept.length < EARLY_CHUNKS) kept.push(chunk);
      this.early.set(runId, kept);
    }
  }

  /**
   * The run `runId` is this turn's: what it streamed before is read now. A status that came
   * before any output of the run is an earlier part's (a run that waited for a card).
   */
  private claim(turn: Turn, runId: string, resumed = false): void {
    turn.runId = runId;
    this.byRun.set(runId, turn);
    const kept = this.early.get(runId) ?? [];
    this.early.delete(runId);
    if (resumed) return;
    for (const chunk of kept) this.take(turn, chunk, false);
  }

  /** One chunk of the turn's run into its message. */
  private take(turn: Turn, chunk: Chunk, live: boolean): void {
    if (chunk.type === "thread-run-status") {
      if (turn.seen || live) this.settle(turn, chunk.payload?.status);
      return;
    }
    turn.seen = true;
    const { draft } = turn.parts;
    const payload = chunk.payload ?? {};
    if (chunk.type === "text-delta") {
      draft.write(payload.text ?? payload.delta ?? "");
    } else if (chunk.type === "step-finish") {
      turn.steps++;
      turn.open = payload.stepResult?.reason === "tool-calls";
      if (payload.stepResult?.reason !== "error") {
        turn.model =
          turn.refOf(payload.metadata?.modelProvider, payload.metadata?.modelId) ?? turn.model;
      }
    } else if (chunk.type === "tool-call-suspended") {
      // A tool asked the person: Mastra keeps the run until the card is answered.
      const cardId = payload.suspendPayload?.cardId;
      if (typeof cardId === "string" && chunk.runId)
        this.parked.set(turn.trigger.conversationId, {
          runId: chunk.runId,
          toolCallId: payload.toolCallId,
          cardId,
        });
    } else if (chunk.type === "error") {
      turn.problem = String(payload.error?.message ?? payload.error ?? "it stopped with an error");
    }
  }

  /** The turn's run ended, or waits for a card: its message is finished. */
  private settle(turn: Turn, status: string | undefined): void {
    if (turn.runId) this.byRun.delete(turn.runId);
    const { draft } = turn.parts;
    const stopped = turn.controller.signal.aborted || status === "aborted";
    if (status === "aborted") turn.controller.abort();
    let problem = turn.problem || (status === "failed" ? "it stopped with an error" : "");
    // A later engine may have answered after an earlier one failed.
    if (turn.model && !draft.empty) problem = "";
    if (problem && !stopped) {
      draft.write(`${draft.empty ? "" : "\n\n"}The model did not answer: ${problem}`);
    }
    this.close(turn, problem && !stopped ? "failed" : "done", turn.model);
  }

  /**
   * Finishes a turn's message and tells everyone who waits for it. When the agent asked for
   * another turn of longer work, the home gives it that turn at once and tells no one yet.
   */
  private close(turn: Turn, state: "done" | "failed", model: string | undefined): void {
    const conversationId = turn.trigger.conversationId;
    const { draft } = turn.parts;
    const stopped = turn.controller.signal.aborted;
    const asked = draft.asks;
    // A card waits for the person: the work goes on with their answer, not before.
    let goesOn = state === "done" && !stopped && !asked && (turn.next !== undefined || turn.cut);
    if (goesOn && turn.number >= WORK_TURNS) {
      goesOn = false;
      draft.write(
        `${draft.empty ? "" : "\n\n"}The work is not finished. I stopped after ${WORK_TURNS} turns in a row. Tell me to go on.`,
      );
    }
    const note = !goesOn && turn.note !== undefined && turn.quiet && !asked && state === "done";
    if (turn.note !== undefined && !note && draft.empty) draft.write(turn.note);
    // A quiet task's run stays a line in the chat while it goes on and when it failed. The
    // home tells the person after several failed runs in a row.
    const quietly = note || (turn.quiet && (goesOn || state === "failed"));
    const message = note
      ? draft.finishAsNote(turn.note ?? "", model)
      : draft.finish(state, model, quietly ? "note" : "agent");
    if (this.runs.get(conversationId) === turn) this.runs.delete(conversationId);
    if (goesOn) {
      this.between.add(conversationId);
      turn.end(message);
      void this.enqueue(nextTurn(turn, message));
      return;
    }
    this.home.store.setWorking(conversationId, false);
    turn.end(message);
    if (!turn.shared) this.rest(conversationId);
    // One reply per place it goes to, however many messages the turn read.
    const told = new Set<string>();
    for (const trigger of turn.triggers) {
      const key = trigger.replyTo ? `${trigger.replyTo.channel}:${trigger.replyTo.peer}` : "";
      // What an agent writes for a room goes to the room, not to the person's devices.
      if (!quietly && !trigger.room && (trigger === turn.trigger || (key && !told.has(key))))
        this.home.delivered(message, trigger);
      told.add(key);
      trigger.done?.(message);
    }
    for (const listener of this.listeners) {
      try {
        listener({ message, triggers: turn.triggers, state, note, asked, stopped });
      } catch (error) {
        console.error("[turn]", error);
      }
    }
  }

  /** An agent that lives in a contact's home or outside: the message goes there, one at a time. */
  private async askShared(agent: AgentRecord, trigger: Trigger): Promise<void> {
    const previous = this.runs.get(trigger.conversationId);
    if (previous) await previous.finished;
    const turn = new Turn(this.home, agent, trigger, []);
    this.runs.set(trigger.conversationId, turn);
    this.home.store.setWorking(trigger.conversationId, true);
    const { draft } = turn.parts;
    try {
      await this.home.peers.ask(agent, trigger.text, turn.controller.signal, (text) =>
        draft.write(text),
      );
      this.close(turn, "done", `shared:${agent.from ?? ""}`);
    } catch (error) {
      draft.write(`This did not work: ${(error as Error)?.message ?? error}`);
      this.close(turn, "failed", `shared:${agent.from ?? ""}`);
    }
  }

  /** The turn Mastra delivered a message into. It may be registered a moment after Mastra knows it. */
  private async running(conversationId: string): Promise<Turn | undefined> {
    for (let tries = 0; tries < 100; tries++) {
      const turn = this.runs.get(conversationId);
      if (turn) return turn;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return undefined;
  }

  /**
   * Mastra's agent for one of the home's agents. Its instructions, model and tools are the
   * turn's: they are read from the run's request context when a run starts.
   */
  private mastraAgent(agent: AgentRecord): Agent {
    const existing = this.agents.get(agent.id);
    if (existing) return existing;
    const turnOf = (context: { get(key: string): unknown }): Turn => {
      const turn = context.get(TURN);
      if (!(turn instanceof Turn)) throw new Error("A run of an agent started without its turn.");
      return turn;
    };
    const created = new Agent({
      id: agent.id,
      name: agent.name,
      instructions: ({ requestContext }) =>
        markedInstructions(turnOf(requestContext).instructions()),
      model: (({ requestContext }: { requestContext: RequestContext }) =>
        turnOf(requestContext).models()) as never,
      tools: (({ requestContext }: { requestContext: RequestContext }) => {
        const { tools, draft, asking } = turnOf(requestContext).parts;
        return mastraTools(tools, draft, asking, (cardId) => this.answers.get(cardId));
      }) as never,
      memory: this.home.mastra.memory,
      // Marks the request for the provider's prompt cache and adds the turn's changing context.
      inputProcessors: [
        cacheProcessor((context) => (context ? turnOf(context).context() : "")) as never,
      ],
    });
    this.home.mastra.instance.addAgent(created);
    this.agents.set(agent.id, created);
    return created;
  }
}
