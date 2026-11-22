import type {
  AddMark,
  Agent,
  Card,
  CardAction,
  CardAnswer,
  CardField,
  CardKind,
  Channel,
  Conversation,
  Device,
  DeviceAgents,
  DeviceKind,
  DeviceResource,
  Document,
  DocumentMark,
  DocumentMeta,
  EngentyKind,
  Event,
  FileRef,
  Message,
  Part,
  Push,
  SearchHit,
} from "@wizards-bot/protocol";
import type { Events } from "../events.ts";
import { sha256 } from "../identity.ts";
import { newId, newPairingCode, newToken, now } from "../ids.ts";
import { langOf, MAIN_ABOUT, say } from "../setup/words.ts";
import type { Db } from "./db.ts";

/** A part as the database keeps it: a card is a reference, so its state has one place. */
type StoredPart = Exclude<Part, { type: "card" }> | { type: "card"; cardId: string };

interface AgentRow {
  id: string;
  name: string;
  kind: string;
  about: string;
  instructions: string;
  memory: string;
  origin: string;
  from_handle: string | null;
  remote: string | null;
  main: number;
  created_at: string;
}

interface MessageRow {
  seq: number;
  id: string;
  conversation_id: string;
  role: string;
  agent_id: string | null;
  channel: string;
  parts: string;
  state: string;
  model: string | null;
  client_id: string | null;
  sender: string | null;
  created_at: string;
}

interface CardRow {
  id: string;
  kind: string;
  level: string;
  state: string;
  title: string;
  body: string | null;
  fields: string | null;
  actions: string;
  url: string | null;
  qr: string | null;
  answer: string | null;
  payload: string | null;
  agent_id: string;
  conversation_id: string;
  message_id: string;
  created_at: string;
}

interface DeviceRow {
  id: string;
  name: string;
  kind: string;
  push: string | null;
  quiet: string | null;
  resources: string | null;
  agents: string | null;
  created_at: string;
  seen_at: string;
}

interface DocumentRow {
  id: string;
  title: string;
  format: string;
  content: string;
  version: number;
  updated_at: string;
  updated_by: string;
  conversation_id: string;
}

interface MarkRow {
  id: string;
  document_id: string;
  quote: string;
  before: string;
  after: string;
  comment: string;
  created_at: string;
}

const toMark = (row: MarkRow): DocumentMark => ({
  id: row.id,
  documentId: row.document_id,
  quote: row.quote,
  before: row.before,
  after: row.after,
  comment: row.comment,
  createdAt: row.created_at,
});

export interface AgentRecord extends Agent {
  instructions: string;
  memory: string;
  /** For a shared agent: where its home takes messages. */
  remote?: string;
}

export interface NewCard {
  kind: CardKind;
  level: "needs_you" | "update";
  title: string;
  body?: string;
  fields?: CardField[];
  actions: CardAction[];
  url?: string;
  qr?: string;
  /** What the home does when the card is answered. Never sent to a device. */
  payload?: unknown;
}

export interface DeviceRecord extends Device {
  push?: Push;
  quiet?: { from: number; to: number; timezone: string };
}

export class AlreadyAnswered extends Error {
  readonly card: Card;
  constructor(card: Card) {
    super("already answered");
    this.card = card;
  }
}

export class VersionConflict extends Error {
  readonly document: Document;
  constructor(document: Document) {
    super("version conflict");
    this.document = document;
  }
}

const PAIRING_MINUTES = 10;

export class Store {
  /** Which conversations are someone else's with an agent, as far as looked up. */
  private readonly guests = new Map<string, boolean>();
  /** Conversations in which an agent writes right now. */
  private readonly working = new Set<string>();
  readonly db: Db;
  readonly events: Events;

  constructor(db: Db, events: Events) {
    this.db = db;
    this.events = events;
  }

  // ── Agents ────────────────────────────────────────────────────────────────

  createAgent(input: {
    name: string;
    kind: EngentyKind;
    about?: string;
    instructions?: string;
    main?: boolean;
    origin?: Agent["origin"];
    from?: string;
    remote?: string;
  }): AgentRecord {
    const id = newId("agt");
    const at = now();
    this.db.transaction(() => {
      this.db.run(
        "insert into agent (id, name, kind, about, instructions, origin, from_handle, remote, main, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        id,
        input.name,
        input.kind,
        input.about ?? "",
        input.instructions ?? "",
        input.origin ?? "own",
        input.from ?? null,
        input.remote ?? null,
        input.main ? 1 : 0,
        at,
      );
      this.db.run(
        "insert into conversation (id, agent_id, updated_at, read_at) values (?, ?, ?, ?)",
        newId("cnv"),
        id,
        at,
        at,
      );
    });
    const agent = this.agent(id) as AgentRecord;
    this.events.emit({ type: "agent.updated", agent: publicAgent(agent) });
    return agent;
  }

  /** The first agent of the home. It is made on the first start. */
  mainAgent(): AgentRecord {
    const row = this.db.get<AgentRow>("select * from agent where main = 1");
    if (row) return this.toAgent(row);
    return this.createAgent({
      name: "Goose",
      kind: "round",
      about: say(MAIN_ABOUT, langOf(this.db)),
      main: true,
    });
  }

  agent(id: string): AgentRecord | undefined {
    const row = this.db.get<AgentRow>("select * from agent where id = ?", id);
    return row ? this.toAgent(row) : undefined;
  }

  /**
   * What the person finds in their Bot Server: Wizards by name and about, the text of messages in
   * their own conversations, documents and artifacts by title and content. A conversation
   * someone else has with an agent (a guest's) is never searched.
   */
  search(query: string, limit = 20): SearchHit[] {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const around = (text: string): string => {
      const flat = text.replace(/\s+/g, " ").trim();
      const at = flat.toLowerCase().indexOf(q);
      if (at < 0) return flat.slice(0, 90);
      const from = Math.max(0, at - 36);
      return `${from > 0 ? "…" : ""}${flat.slice(from, at + q.length + 54)}${at + q.length + 54 < flat.length ? "…" : ""}`;
    };
    const hits: SearchHit[] = [];
    for (const row of this.db.all<{ id: string; name: string; about: string; created_at: string }>(
      "select id, name, about, created_at from agent where instr(lower(name), ?) > 0 or instr(lower(about), ?) > 0 order by main desc, created_at limit ?",
      q,
      q,
      limit,
    )) {
      hits.push({
        kind: "agent",
        id: row.id,
        agentId: row.id,
        title: row.name,
        snippet: around(row.about),
        at: row.created_at,
      });
    }
    const textOf = (parts: string): string =>
      (JSON.parse(parts) as Part[])
        .map((part) => (part.type === "text" ? part.text : ""))
        .join(" ");
    for (const row of this.db.all<{
      id: string;
      parts: string;
      created_at: string;
      agent: string;
      name: string;
    }>(
      `select m.id, m.parts, m.created_at, c.agent_id as agent, a.name
         from message m join conversation c on c.id = m.conversation_id join agent a on a.id = c.agent_id
        where c.guest is null and instr(lower(m.parts), ?) > 0
        order by m.seq desc limit ?`,
      q,
      limit * 3,
    )) {
      const text = textOf(row.parts);
      if (!text.toLowerCase().includes(q)) continue;
      hits.push({
        kind: "message",
        id: row.id,
        agentId: row.agent,
        title: row.name,
        snippet: around(text),
        at: row.created_at,
      });
      if (hits.filter((h) => h.kind === "message").length >= limit) break;
    }
    for (const kind of ["document", "artifact"] as const) {
      for (const row of this.db.all<{
        id: string;
        title: string;
        content: string;
        updated_at: string;
        agent: string;
      }>(
        `select d.id, d.title, d.content, d.updated_at, c.agent_id as agent
           from ${kind} d join conversation c on c.id = d.conversation_id
          where c.guest is null and (instr(lower(d.title), ?) > 0 or instr(lower(d.content), ?) > 0)
          order by d.updated_at desc limit ?`,
        q,
        q,
        limit,
      )) {
        const inTitle = row.title.toLowerCase().includes(q);
        hits.push({
          kind,
          id: row.id,
          agentId: row.agent,
          title: row.title,
          snippet: inTitle ? "" : around(row.content),
          at: row.updated_at,
        });
      }
    }
    return hits;
  }

  agents(): AgentRecord[] {
    return this.db
      .all<AgentRow>("select * from agent order by main desc, created_at")
      .map((row) => this.toAgent(row));
  }

  updateAgent(
    id: string,
    patch: Partial<Pick<AgentRecord, "name" | "kind" | "about" | "instructions" | "memory">>,
  ): AgentRecord | undefined {
    const current = this.agent(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.db.run(
      "update agent set name = ?, kind = ?, about = ?, instructions = ?, memory = ? where id = ?",
      next.name,
      next.kind,
      next.about,
      next.instructions,
      next.memory,
      id,
    );
    this.touchAgent(id);
    return this.agent(id);
  }

  removeAgent(id: string): boolean {
    const agent = this.agent(id);
    if (!agent || agent.main) return false;
    this.db.run("delete from card where agent_id = ?", id);
    this.db.run("delete from agent where id = ?", id);
    this.events.emit({ type: "agent.removed", agentId: id });
    return true;
  }

  setWorking(conversationId: string, working: boolean): void {
    if (working) this.working.add(conversationId);
    else this.working.delete(conversationId);
    const conversation = this.conversation(conversationId);
    if (conversation) this.touchAgent(conversation.agentId);
  }

  isWorking(conversationId: string): boolean {
    return this.working.has(conversationId);
  }

  /** Tells the devices that an agent's line in the list changed: its newest message or what is unread. */
  private touchConversation(conversationId: string): void {
    const row = this.db.get<{ agent_id: string }>(
      "select agent_id from conversation where id = ? and guest is null",
      conversationId,
    );
    if (row) this.touchAgent(row.agent_id);
  }

  private touchAgent(id: string): void {
    const agent = this.agent(id);
    if (agent) this.events.emit({ type: "agent.updated", agent: publicAgent(agent) });
  }

  private toAgent(row: AgentRow): AgentRecord {
    const conversationId =
      this.db.get<{ id: string }>(
        "select id from conversation where agent_id = ? and guest is null",
        row.id,
      )?.id ?? "";
    const open =
      this.db.get<{ n: number }>(
        "select count(*) as n from card where agent_id = ? and state = 'open' and level = 'needs_you'",
        row.id,
      )?.n ?? 0;
    const conversation = this.conversation(conversationId);
    return {
      id: row.id,
      name: row.name,
      kind: row.kind as EngentyKind,
      about: row.about,
      origin: row.origin as Agent["origin"],
      from: row.from_handle ?? undefined,
      state: this.working.has(conversationId) ? "working" : open > 0 ? "needs_you" : "idle",
      open,
      conversationId,
      preview: conversation?.preview ?? "",
      unread: conversation?.unread ?? 0,
      updatedAt: conversation?.updatedAt ?? "",
      main: row.main === 1,
      instructions: row.instructions,
      memory: row.memory,
      remote: row.remote ?? undefined,
    };
  }

  // ── Conversations and messages ────────────────────────────────────────────

  conversation(id: string): Conversation | undefined {
    const row = this.db.get<{ id: string; agent_id: string; updated_at: string; read_at: string }>(
      "select * from conversation where id = ?",
      id,
    );
    if (!row) return undefined;
    const last = this.db.get<MessageRow>(
      "select * from message where conversation_id = ? order by seq desc limit 1",
      id,
    );
    const unread =
      this.db.get<{ n: number }>(
        "select count(*) as n from message where conversation_id = ? and role = 'agent' and created_at > ?",
        id,
        row.read_at,
      )?.n ?? 0;
    return {
      id: row.id,
      agentId: row.agent_id,
      updatedAt: row.updated_at,
      preview: last ? preview(this.toMessage(last)) : "",
      unread,
    };
  }

  /**
   * Whether a conversation is one someone else has with an agent: a contact the agent is
   * shared with, a caller, or a room the agent answers. It is theirs, not the person's.
   */
  isGuest(conversationId: string): boolean {
    const known = this.guests.get(conversationId);
    if (known !== undefined) return known;
    const row = this.db.get<{ guest: string | null }>(
      "select guest from conversation where id = ?",
      conversationId,
    );
    if (!row) return false;
    this.guests.set(conversationId, row.guest !== null);
    return row.guest !== null;
  }

  /**
   * Tells the devices what happened in a conversation. What is written in a conversation
   * someone else has with an agent is told to no device.
   */
  emit(
    event: Extract<Event, { type: "message.created" | "message.updated" | "message.delta" }>,
  ): void {
    const conversationId =
      event.type === "message.delta" ? event.conversationId : event.message.conversationId;
    if (!this.isGuest(conversationId)) this.events.emit(event);
  }

  /** Removes the conversations someone had with an agent, with what was written in them. */
  removeGuestConversations(guest: string, agentId?: string): string[] {
    const ids = this.db
      .all<{ id: string }>(
        agentId
          ? "select id from conversation where guest = ? and agent_id = ?"
          : "select id from conversation where guest = ?",
        ...(agentId ? [guest, agentId] : [guest]),
      )
      .map((row) => row.id);
    for (const id of ids) {
      this.db.run("delete from conversation where id = ?", id);
      this.guests.delete(id);
    }
    return ids;
  }

  /** The conversation a contact has with an agent that is shared with them. */
  guestConversation(agentId: string, handle: string): string {
    const existing = this.db.get<{ id: string }>(
      "select id from conversation where agent_id = ? and guest = ?",
      agentId,
      handle,
    );
    if (existing) return existing.id;
    const id = newId("cnv");
    const at = now();
    this.db.run(
      "insert into conversation (id, agent_id, updated_at, read_at, guest) values (?, ?, ?, ?, ?)",
      id,
      agentId,
      at,
      at,
      handle,
    );
    return id;
  }

  markRead(conversationId: string): void {
    const before = this.conversation(conversationId)?.unread ?? 0;
    this.db.run("update conversation set read_at = ? where id = ?", now(), conversationId);
    if (before > 0) this.touchConversation(conversationId);
  }

  addMessage(input: {
    conversationId: string;
    role: Message["role"];
    agentId?: string;
    channel: Channel;
    parts: Part[];
    state?: Message["state"];
    model?: string;
    clientId?: string;
    createdAt?: string;
    /** In a room: who wrote it, when it is not the person. */
    from?: Message["from"];
  }): Message {
    if (input.clientId) {
      const existing = this.db.get<MessageRow>(
        "select * from message where client_id = ?",
        input.clientId,
      );
      if (existing) return this.toMessage(existing);
    }
    const id = newId("msg");
    const at = input.createdAt ?? now();
    this.db.run(
      "insert into message (id, conversation_id, role, agent_id, channel, parts, state, model, client_id, sender, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      input.conversationId,
      input.role,
      input.agentId ?? null,
      input.channel,
      JSON.stringify(input.parts.map(toStored)),
      input.state ?? "done",
      input.model ?? null,
      input.clientId ?? null,
      input.from ? JSON.stringify(input.from) : null,
      at,
    );
    this.db.run("update conversation set updated_at = ? where id = ?", now(), input.conversationId);
    const message = this.message(id) as Message;
    this.emit({ type: "message.created", message });
    this.touchConversation(input.conversationId);
    return message;
  }

  messageByClientId(clientId: string): Message | undefined {
    const row = this.db.get<MessageRow>("select * from message where client_id = ?", clientId);
    return row ? this.toMessage(row) : undefined;
  }

  message(id: string): Message | undefined {
    const row = this.db.get<MessageRow>("select * from message where id = ?", id);
    return row ? this.toMessage(row) : undefined;
  }

  /** Replaces the parts or the state of a message and tells the devices. */
  updateMessage(
    id: string,
    patch: { parts?: Part[]; state?: Message["state"]; model?: string; role?: "agent" | "note" },
  ): Message | undefined {
    const current = this.db.get<MessageRow>("select * from message where id = ?", id);
    if (!current) return undefined;
    this.db.run(
      "update message set parts = ?, state = ?, model = ?, role = ? where id = ?",
      patch.parts ? JSON.stringify(patch.parts.map(toStored)) : current.parts,
      patch.state ?? current.state,
      patch.model ?? current.model,
      patch.role ?? current.role,
      id,
    );
    const message = this.message(id) as Message;
    this.emit({ type: "message.updated", message });
    if (message.state !== current.state || message.role !== current.role)
      this.touchConversation(message.conversationId);
    return message;
  }

  /** The files the person sent in a conversation, newest first, each once. */
  sentFiles(conversationId: string, limit = 200): FileRef[] {
    const rows = this.db.all<{ parts: string }>(
      "select parts from message where conversation_id = ? and role = 'you' and parts like '%\"type\":\"file\"%' order by seq desc",
      conversationId,
    );
    const files = new Map<string, FileRef>();
    for (const row of rows) {
      for (const part of JSON.parse(row.parts) as Part[]) {
        if (part.type === "file" && !files.has(part.file.id)) files.set(part.file.id, part.file);
        if (files.size >= limit) return [...files.values()];
      }
    }
    return [...files.values()];
  }

  messages(
    conversationId: string,
    options: { before?: string; limit?: number } = {},
  ): { messages: Message[]; more: boolean } {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const beforeSeq = options.before
      ? (this.db.get<{ seq: number }>("select seq from message where id = ?", options.before)
          ?.seq ?? Number.MAX_SAFE_INTEGER)
      : Number.MAX_SAFE_INTEGER;
    const rows = this.db.all<MessageRow>(
      "select * from message where conversation_id = ? and seq < ? order by seq desc limit ?",
      conversationId,
      beforeSeq,
      limit + 1,
    );
    const more = rows.length > limit;
    return {
      messages: rows
        .slice(0, limit)
        .reverse()
        .map((row) => this.toMessage(row)),
      more,
    };
  }

  /** Messages left in `streaming` by a home that stopped mid-reply. */
  failInterrupted(): void {
    for (const row of this.db.all<{ id: string }>(
      "select id from message where state = 'streaming'",
    )) {
      this.updateMessage(row.id, { state: "failed" });
    }
  }

  private toMessage(row: MessageRow): Message {
    const stored = JSON.parse(row.parts) as StoredPart[];
    const parts: Part[] = [];
    for (const part of stored) {
      if (part.type !== "card") {
        parts.push(part);
        continue;
      }
      const card = this.card(part.cardId);
      if (card) parts.push({ type: "card", card });
    }
    return {
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role as Message["role"],
      agentId: row.agent_id ?? undefined,
      channel: row.channel as Channel,
      parts,
      state: row.state as Message["state"],
      model: row.model ?? undefined,
      from: row.sender ? (JSON.parse(row.sender) as Message["from"]) : undefined,
      createdAt: row.created_at,
    };
  }

  // ── Cards ─────────────────────────────────────────────────────────────────

  createCard(
    input: NewCard,
    where: { agentId: string; conversationId: string; messageId: string },
  ): Card {
    const id = newId("crd");
    this.db.run(
      "insert into card (id, kind, level, state, title, body, fields, actions, url, qr, payload, agent_id, conversation_id, message_id, created_at) values (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      input.kind,
      input.level,
      input.title,
      input.body ?? null,
      input.fields ? JSON.stringify(input.fields) : null,
      JSON.stringify(input.actions),
      input.url ?? null,
      input.qr ?? null,
      input.payload === undefined ? null : JSON.stringify(input.payload),
      where.agentId,
      where.conversationId,
      where.messageId,
      now(),
    );
    const card = this.card(id) as Card;
    this.touchAgent(where.agentId);
    return card;
  }

  card(id: string): Card | undefined {
    const row = this.db.get<CardRow>("select * from card where id = ?", id);
    return row ? toCard(row) : undefined;
  }

  cardPayload<T>(id: string): T | undefined {
    const row = this.db.get<{ payload: string | null }>(
      "select payload from card where id = ?",
      id,
    );
    return row?.payload ? (JSON.parse(row.payload) as T) : undefined;
  }

  /** Every open card that waits for the person, oldest first. */
  items(): Card[] {
    return this.db
      .all<CardRow>(
        "select * from card where state = 'open' and level = 'needs_you' order by created_at",
      )
      .map(toCard);
  }

  openCards(conversationId: string): Card[] {
    return this.db
      .all<CardRow>(
        "select * from card where state = 'open' and conversation_id = ?",
        conversationId,
      )
      .map(toCard);
  }

  openCardsOfKind(kind: CardKind): Card[] {
    return this.db
      .all<CardRow>("select * from card where state = 'open' and kind = ?", kind)
      .map(toCard);
  }

  /** The first answer wins. A later one throws `AlreadyAnswered` with the card as it stands. */
  answerCard(id: string, answer: Omit<CardAnswer, "at">): Card | undefined {
    const card = this.card(id);
    if (!card) return undefined;
    const stored: CardAnswer = { ...answer, at: now() };
    this.db.run(
      "update card set state = 'answered', answer = ? where id = ? and state = 'open'",
      JSON.stringify(stored),
      id,
    );
    const after = this.card(id) as Card;
    if (after.answer?.at !== stored.at) throw new AlreadyAnswered(after);
    this.events.emit({ type: "card.updated", card: after });
    this.touchAgent(after.agentId);
    return after;
  }

  expireCard(id: string): void {
    this.db.run("update card set state = 'expired' where id = ? and state = 'open'", id);
    const card = this.card(id);
    if (!card) return;
    this.events.emit({ type: "card.updated", card });
    this.touchAgent(card.agentId);
  }

  updateCard(id: string, patch: { url?: string; body?: string; title?: string }): Card | undefined {
    const card = this.card(id);
    if (!card) return undefined;
    this.db.run(
      "update card set url = ?, body = ?, title = ? where id = ?",
      patch.url ?? card.url ?? null,
      patch.body ?? card.body ?? null,
      patch.title ?? card.title,
      id,
    );
    const after = this.card(id) as Card;
    this.events.emit({ type: "card.updated", card: after });
    return after;
  }

  // ── Documents ─────────────────────────────────────────────────────────────

  document(id: string): Document | undefined {
    const row = this.db.get<DocumentRow>("select * from document where id = ?", id);
    return row ? toDocument(row) : undefined;
  }

  documents(conversationId: string): DocumentMeta[] {
    return this.db
      .all<DocumentRow>(
        "select * from document where conversation_id = ? order by updated_at desc",
        conversationId,
      )
      .map((row) => meta(toDocument(row)));
  }

  createDocument(input: { title: string; content: string; conversationId: string }): Document {
    const id = newId("doc");
    const at = now();
    this.db.run(
      "insert into document (id, title, format, content, version, updated_at, updated_by, conversation_id) values (?, ?, 'markdown', ?, 1, ?, 'agent', ?)",
      id,
      input.title,
      input.content,
      at,
      input.conversationId,
    );
    this.db.run(
      "insert into document_version (document_id, version, content, by, at) values (?, 1, ?, 'agent', ?)",
      id,
      input.content,
      at,
    );
    const document = this.document(id) as Document;
    this.events.emit({ type: "document.updated", document: meta(document) });
    return document;
  }

  /** Saves a new version. With `baseVersion`, a newer version on the home is a conflict. */
  saveDocument(
    id: string,
    input: { content: string; title?: string; by: "you" | "agent"; baseVersion?: number },
  ): Document | undefined {
    const current = this.document(id);
    if (!current) return undefined;
    if (input.baseVersion !== undefined && input.baseVersion !== current.version) {
      throw new VersionConflict(current);
    }
    const version = current.version + 1;
    const at = now();
    this.db.run(
      "update document set content = ?, title = ?, version = ?, updated_at = ?, updated_by = ? where id = ?",
      input.content,
      input.title ?? current.title,
      version,
      at,
      input.by,
      id,
    );
    this.db.run(
      "insert into document_version (document_id, version, content, by, at) values (?, ?, ?, ?, ?)",
      id,
      version,
      input.content,
      input.by,
      at,
    );
    const document = this.document(id) as Document;
    this.events.emit({ type: "document.updated", document: meta(document) });
    return document;
  }

  /** What the person marked in a document, oldest first. */
  marks(documentId: string): DocumentMark[] {
    return this.db
      .all<MarkRow>(
        "select * from document_mark where document_id = ? order by created_at, id",
        documentId,
      )
      .map(toMark);
  }

  addMark(documentId: string, input: AddMark): DocumentMark {
    const id = newId("mrk");
    this.db.run(
      "insert into document_mark (id, document_id, quote, before, after, comment, created_at) values (?, ?, ?, ?, ?, ?, ?)",
      id,
      documentId,
      input.quote,
      input.before,
      input.after,
      input.comment ?? "",
      now(),
    );
    return toMark(this.db.get<MarkRow>("select * from document_mark where id = ?", id) as MarkRow);
  }

  /** `false` when the document has no such mark. */
  removeMark(documentId: string, id: string): boolean {
    const known = this.db.get(
      "select id from document_mark where id = ? and document_id = ?",
      id,
      documentId,
    );
    if (!known) return false;
    this.db.run("delete from document_mark where id = ?", id);
    return true;
  }

  // ── Devices ───────────────────────────────────────────────────────────────

  newPairingCode(): string {
    const code = newPairingCode();
    this.db.run("delete from pairing where expires_at < ?", now());
    this.db.run(
      "insert into pairing (code, expires_at) values (?, ?)",
      code,
      new Date(Date.now() + PAIRING_MINUTES * 60_000).toISOString(),
    );
    return code;
  }

  /** Uses up a pairing code. `false` when it is unknown or too old. */
  redeemPairingCode(code: string): boolean {
    const normal = code.trim().toUpperCase();
    const row = this.db.get<{ expires_at: string }>(
      "select expires_at from pairing where code = ?",
      normal,
    );
    if (!row) return false;
    this.db.run("delete from pairing where code = ?", normal);
    return row.expires_at > now();
  }

  addDevice(input: { name: string; kind: DeviceKind; push?: Push }): {
    token: string;
    device: DeviceRecord;
  } {
    const id = newId("dev");
    const token = newToken();
    const at = now();
    this.db.run(
      "insert into device (id, name, kind, token_hash, push, created_at, seen_at) values (?, ?, ?, ?, ?, ?, ?)",
      id,
      input.name,
      input.kind,
      sha256(token),
      input.push ? JSON.stringify(input.push) : null,
      at,
      at,
    );
    return { token, device: this.device(id) as DeviceRecord };
  }

  device(id: string): DeviceRecord | undefined {
    const row = this.db.get<DeviceRow>("select * from device where id = ?", id);
    return row ? toDevice(row) : undefined;
  }

  deviceByToken(token: string): DeviceRecord | undefined {
    const row = this.db.get<DeviceRow>("select * from device where token_hash = ?", sha256(token));
    if (!row) return undefined;
    if (Date.now() - Date.parse(row.seen_at) > 60_000) {
      this.db.run("update device set seen_at = ? where id = ?", now(), row.id);
    }
    return toDevice(row);
  }

  devices(): DeviceRecord[] {
    return this.db.all<DeviceRow>("select * from device order by created_at").map(toDevice);
  }

  updateDevice(
    id: string,
    patch: { name?: string; push?: Push | null; quiet?: DeviceRecord["quiet"] | null },
  ): DeviceRecord | undefined {
    const current = this.device(id);
    if (!current) return undefined;
    const push = patch.push === undefined ? current.push : (patch.push ?? undefined);
    const quiet = patch.quiet === undefined ? current.quiet : (patch.quiet ?? undefined);
    this.db.run(
      "update device set name = ?, push = ?, quiet = ? where id = ?",
      patch.name ?? current.name,
      push ? JSON.stringify(push) : null,
      quiet ? JSON.stringify(quiet) : null,
      id,
    );
    return this.device(id);
  }

  /** What a device offers its agents, and which agents may ask it, as it said last. */
  setDeviceResources(
    id: string,
    resources: DeviceResource[],
    agents?: DeviceAgents,
  ): DeviceRecord | undefined {
    this.db.run(
      "update device set resources = ?, agents = ? where id = ?",
      JSON.stringify(resources),
      agents ? JSON.stringify(agents) : null,
      id,
    );
    return this.device(id);
  }

  removeDevice(id: string): void {
    this.db.run("delete from device where id = ?", id);
  }
}

export function publicAgent(agent: AgentRecord): Agent {
  const { instructions: _instructions, memory: _memory, remote: _remote, ...rest } = agent;
  return rest;
}

const toStored = (part: Part): StoredPart =>
  part.type === "card" ? { type: "card", cardId: part.card.id } : part;

function toCard(row: CardRow): Card {
  return {
    id: row.id,
    kind: row.kind as CardKind,
    level: row.level as Card["level"],
    state: row.state as Card["state"],
    title: row.title,
    body: row.body ?? undefined,
    fields: row.fields ? (JSON.parse(row.fields) as CardField[]) : undefined,
    actions: JSON.parse(row.actions) as CardAction[],
    url: row.url ?? undefined,
    qr: row.qr ?? undefined,
    answer: row.answer ? (JSON.parse(row.answer) as CardAnswer) : undefined,
    agentId: row.agent_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    createdAt: row.created_at,
  };
}

function toDocument(row: DocumentRow): Document {
  return {
    id: row.id,
    title: row.title,
    format: "markdown",
    content: row.content,
    version: row.version,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by as "you" | "agent",
    conversationId: row.conversation_id,
  };
}

const meta = ({ content: _content, ...rest }: Document): DocumentMeta => rest;

function toDevice(row: DeviceRow): DeviceRecord {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as DeviceKind,
    createdAt: row.created_at,
    seenAt: row.seen_at,
    push: row.push ? (JSON.parse(row.push) as Push) : undefined,
    quiet: row.quiet ? (JSON.parse(row.quiet) as DeviceRecord["quiet"]) : undefined,
    resources: row.resources ? (JSON.parse(row.resources) as DeviceResource[]) : undefined,
    agents: row.agents ? (JSON.parse(row.agents) as DeviceAgents) : undefined,
  };
}

/** One line of a message for lists and notifications. */
export function preview(message: Message): string {
  for (const part of message.parts) {
    if (part.type === "text" && part.text.trim())
      return part.text.trim().replace(/\s+/g, " ").slice(0, 160);
    if (part.type === "card") return part.card.title;
    if (part.type === "document") return part.title;
    if (part.type === "artifact") return part.title;
    if (part.type === "file") return part.file.name;
  }
  return "";
}
