import {
  EngentyKind,
  type Message,
  ROOM_AGENT_TURNS,
  ROOM_AGENTS,
  ROOM_MESSAGE_LIMIT,
} from "@wizards-bot/protocol";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { defineTool, ENDS_TURN, type Tool } from "../agent/tool.ts";
import type { TurnContext } from "../agent/turns.ts";
import type { Home } from "../home.ts";
import { newId, now } from "../ids.ts";
import type { AgentRecord } from "../store/store.ts";
import type { Peers } from "./peers.ts";

// A room is a conversation of several people and agents, from one home or several. One home
// keeps it: that home numbers every message, knows who is in the room and says which agent
// answers next. Every other member's home holds a copy for its own devices and agents and
// asks the keeping home for what it missed. In each home the room stands in the list beside
// the agents, as an agent row of origin `room` with the conversation the devices read.
//
// An agent answers a room in its own home, with its own models. It brings what is its own
// (its task, its memory, the documents, artifacts and files of its conversation) and none of
// the person's tools.

/** How long an agent has to answer before the next one named gets its turn. */
const FLOOR_WAIT_MS = 180_000;
/** Messages a home hands over at once: on joining, and to a home that missed some. */
const HANDED_OVER = 200;
/** Messages of the room an agent reads when it is named. */
const READ_BACK = 40;

const WireMember = z.object({
  id: z.string().max(200),
  kind: z.enum(["person", "agent"]),
  handle: z.string().max(200),
  name: z.string().max(80),
  agentKind: EngentyKind.optional(),
  role: z.enum(["owner", "member", "invited"]),
});
type Member = z.infer<typeof WireMember>;

const WireSaid = z.object({
  seq: z.number().int().positive(),
  id: z.string().max(80),
  /** The member who wrote it; "" for a line of the room itself. */
  from: z.string().max(200),
  kind: z.enum(["person", "agent", "note"]),
  name: z.string().max(80),
  agentKind: EngentyKind.optional(),
  /** Whose agent it is. */
  of: z.string().max(80).optional(),
  text: z.string().max(ROOM_MESSAGE_LIMIT),
  at: z.string(),
});
type Said = z.infer<typeof WireSaid>;

const Told = z.object({
  room: z.string(),
  name: z.string().max(80).optional(),
  messages: z.array(WireSaid).max(HANDED_OVER).default([]),
  members: z.array(WireMember).max(200).optional(),
  /** The room was closed, or this home was taken out of it. */
  closed: z.boolean().optional(),
});

const Joined = z.object({
  name: z.string().max(80),
  /** The number before the first message handed over. */
  after: z.number().int().min(0),
  messages: z.array(WireSaid).max(HANDED_OVER),
  members: z.array(WireMember).max(200),
});

export interface Room {
  id: string;
  name: string;
  /** The handle of the home that keeps the room. */
  keeper: string;
  /** The agent row the room stands in the list with. */
  agentId: string;
  seq: number;
}

interface RoomRow {
  id: string;
  name: string;
  keeper: string;
  agent_id: string;
  seq: number;
}

interface MemberRow {
  id: string;
  kind: string;
  handle: string;
  name: string;
  agent_kind: string | null;
  role: string;
  seen: number;
}

interface SaidRow {
  seq: number;
  id: string;
  member_id: string;
  kind: string;
  name: string;
  agent_kind: string | null;
  of_name: string | null;
  text: string;
  at: string;
}

/** Whose turn it is in a room this home keeps. */
interface Floor {
  /** The agents named and not yet asked, in the order they were named. */
  queue: string[];
  /** Messages agents may still write before a person has to write again. */
  left: number;
  holder?: string;
  timer?: NodeJS.Timeout;
}

const toRoom = (row: RoomRow): Room => ({
  id: row.id,
  name: row.name,
  keeper: row.keeper,
  agentId: row.agent_id,
  seq: row.seq,
});

const toMember = (row: MemberRow): Member => ({
  id: row.id,
  kind: row.kind as Member["kind"],
  handle: row.handle,
  name: row.name,
  agentKind: (row.agent_kind as EngentyKind | null) ?? undefined,
  role: row.role as Member["role"],
});

const toSaid = (row: SaidRow): Said => ({
  seq: row.seq,
  id: row.id,
  from: row.member_id,
  kind: row.kind as Said["kind"],
  name: row.name,
  agentKind: (row.agent_kind as EngentyKind | null) ?? undefined,
  of: row.of_name ?? undefined,
  text: row.text,
  at: row.at,
});

const textOf = (message: Message): string =>
  message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();

/** A problem a person can read, for the home that asked. */
export class Refused extends Error {
  readonly status: 400 | 403 | 404 | 409 | 429;
  constructor(status: Refused["status"], message: string) {
    super(message);
    this.status = status;
  }
}

export class Rooms {
  private readonly home: Home;
  private readonly peers: Peers;
  private readonly floors = new Map<string, Floor>();
  /** What is sent to one home goes out in order: one request after the other. */
  private readonly lines = new Map<string, Promise<void>>();
  private readonly pending = new Set<Promise<void>>();

  constructor(home: Home, peers: Peers) {
    this.home = home;
    this.peers = peers;
    home.addTools((context) => this.setupTools(context));
    this.registerCards();
    this.adopt();
  }

  /** Who this home is in a room: its handle, or `me` while it has no address. */
  private me(): string {
    return this.home.handle() ?? "me";
  }

  /**
   * The home is known under a handle, or under another one than before: its rooms and its
   * places in rooms go under it. Before a home has a handle it stands in its rooms as `me`.
   */
  adopt(): void {
    const { db } = this.home;
    const handle = this.home.handle();
    const known = db.meta("rooms.handle") ?? "me";
    if (!handle || handle === known) return;
    db.transaction(() => {
      this.renamed(known, handle);
      db.setMeta("rooms.handle", handle);
    });
  }

  /**
   * A home is known under another handle: its person's, and its agents', places in the rooms
   * go under it. Runs inside the change that renames the home everywhere else.
   */
  renamed(from: string, to: string): void {
    const { db } = this.home;
    const agents = `${from}/`;
    db.run("update room set keeper = ? where keeper = ?", to, from);
    // The entry of the list names the home that keeps the room.
    db.run("update agent set from_handle = ? where origin = 'room' and from_handle = ?", to, from);
    db.run("update room_member set id = ?, handle = ? where id = ?", to, to, from);
    db.run(
      "update room_member set id = ? || substr(id, ?), handle = ? where handle = ? and substr(id, 1, ?) = ?",
      to,
      from.length + 1,
      to,
      from,
      agents.length,
      agents,
    );
    db.run("update room_message set member_id = ? where member_id = ?", to, from);
    db.run(
      "update room_message set member_id = ? || substr(member_id, ?) where substr(member_id, 1, ?) = ?",
      to,
      from.length + 1,
      agents.length,
      agents,
    );
  }

  /** Tells the rooms this home keeps that one of the homes in them is known under a new handle. */
  membersChanged(handle: string): void {
    for (const room of this.rooms()) {
      if (!this.keeps(room)) continue;
      if (this.members(room.id).some((member) => member.handle === handle))
        this.spread(room, { messages: [] });
    }
  }

  private keeps(room: Room): boolean {
    return room.keeper === this.me();
  }

  room(id: string): Room | undefined {
    const row = this.home.db.get<RoomRow>("select * from room where id = ?", id);
    return row ? toRoom(row) : undefined;
  }

  /** The room of that id, or of that entry of the list, when this home keeps it. */
  kept(id: string): Room | undefined {
    const room = this.byAgent(id) ?? this.room(id);
    return room && this.keeps(room) ? room : undefined;
  }

  /**
   * Takes a person's home into a room this home keeps, and returns what that home needs to
   * hold its copy: the name, the members and the last messages.
   */
  admit(roomId: string, handle: string, name: string): z.input<typeof Joined> {
    const room = this.room(roomId);
    if (!room || !this.keeps(room)) throw new Refused(404, "There is no such room here.");
    const members = this.members(room.id);
    const known = members.find((member) => member.id === handle);
    if (!known || known.role === "invited") {
      this.setMembers(room.id, [
        ...members.filter((member) => member.id !== handle),
        { id: handle, kind: "person", handle, name, role: "member" },
      ]);
      this.announce(room, `${name} joined the room.`);
    }
    const current = this.room(room.id) as Room;
    const after = Math.max(0, current.seq - HANDED_OVER);
    return {
      name: current.name,
      after,
      messages: this.since(room.id, after),
      members: this.members(room.id),
    };
  }

  /**
   * This home was taken into a room another home keeps: the room gets its entry in the list
   * and its copy here. Returns the room's name.
   */
  async enter(keeper: string, roomId: string, answer: unknown): Promise<string> {
    const { home } = this;
    const joined = Joined.parse(answer);
    const known = this.room(roomId);
    if (known) {
      if (known.keeper !== keeper) throw new Error("This home knows that room already.");
      return known.name;
    }
    const carrier = home.store.createAgent({
      name: joined.name,
      kind: "pebble",
      origin: "room",
      from: keeper,
    });
    home.db.run(
      "insert into room (id, name, keeper, agent_id, seq, created_at) values (?, ?, ?, ?, ?, ?)",
      roomId,
      joined.name,
      keeper,
      carrier.id,
      joined.after,
      now(),
    );
    this.setMembers(roomId, joined.members);
    await this.apply(this.room(roomId) as Room, joined.messages);
    return joined.name;
  }

  /** The room an agent row of origin `room` stands for. */
  byAgent(agentId: string): Room | undefined {
    const row = this.home.db.get<RoomRow>("select * from room where agent_id = ?", agentId);
    return row ? toRoom(row) : undefined;
  }

  rooms(): Room[] {
    return this.home.db.all<RoomRow>("select * from room order by created_at").map(toRoom);
  }

  members(roomId: string): Member[] {
    return this.home.db
      .all<MemberRow>("select * from room_member where room_id = ? order by rowid", roomId)
      .map(toMember);
  }

  /** The members that are in the room: not the ones only invited. */
  private inRoom(roomId: string): Member[] {
    return this.members(roomId).filter((member) => member.role !== "invited");
  }

  /** Resolves when nothing is on its way to another home and no agent is being asked. */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.all(this.pending);
  }

  private track(work: Promise<void>): void {
    const tracked: Promise<void> = work
      .catch((error) => console.error("[room]", (error as Error).message))
      .finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  /** Does something for one home after everything that was started for it before. */
  private inLine(handle: string, work: () => Promise<void>): void {
    const next = (this.lines.get(handle) ?? Promise.resolve()).then(work, work);
    this.lines.set(
      handle,
      next.catch(() => {}),
    );
    this.track(next);
  }

  // ── Keeping a room ────────────────────────────────────────────────────────

  /** Opens a room this home keeps, with the person in it. */
  open(name: string): AgentRecord {
    const { home } = this;
    const me = this.me();
    const carrier = home.store.createAgent({
      name,
      kind: "pebble",
      origin: "room",
      from: me,
    });
    const id = newId("rom");
    home.db.run(
      "insert into room (id, name, keeper, agent_id, seq, created_at) values (?, ?, ?, ?, 0, ?)",
      id,
      name,
      me,
      carrier.id,
      now(),
    );
    this.setMembers(id, [
      { id: me, kind: "person", handle: me, name: home.person(), role: "owner" },
    ]);
    return home.store.agent(carrier.id) as AgentRecord;
  }

  /** Writes who is in the room, and says so in the line below the room's name. */
  private setMembers(roomId: string, members: Member[]): void {
    const { db, store } = this.home;
    const seen = new Map(
      db
        .all<MemberRow>("select * from room_member where room_id = ?", roomId)
        .map((row) => [row.id, row.seen]),
    );
    db.transaction(() => {
      db.run("delete from room_member where room_id = ?", roomId);
      for (const member of members) {
        db.run(
          "insert into room_member (room_id, id, kind, handle, name, agent_kind, role, seen) values (?, ?, ?, ?, ?, ?, ?, ?)",
          roomId,
          member.id,
          member.kind,
          member.handle,
          member.name,
          member.agentKind ?? null,
          member.role,
          seen.get(member.id) ?? 0,
        );
      }
    });
    const room = this.room(roomId);
    if (!room) return;
    const here = members.filter((member) => member.role !== "invited");
    const names = (kind: Member["kind"]) =>
      here
        .filter((member) => member.kind === kind)
        .map((member) => member.name)
        .join(", ");
    store.updateAgent(room.agentId, {
      about: [names("person"), names("agent")].filter(Boolean).join(" · "),
    });
  }

  /**
   * Takes a message into a room this home keeps: gives it its number, shows it here, sends it
   * to every other home in the room and looks whose turn it is. A message that came before
   * (the same id) is answered with what was kept.
   */
  private accept(
    room: Room,
    from: Pick<Said, "from" | "kind" | "name" | "agentKind" | "of">,
    id: string,
    text: string,
  ): Said {
    const { db } = this.home;
    const known = db.get<SaidRow>(
      "select * from room_message where room_id = ? and id = ?",
      room.id,
      id,
    );
    if (known) return toSaid(known);
    const said = db.transaction(() => {
      const seq =
        (db.get<{ seq: number }>("select seq from room where id = ?", room.id)?.seq ?? 0) + 1;
      const made: Said = { ...from, seq, id, text, at: now() };
      this.keep(room.id, made);
      return made;
    });
    this.show(room, said);
    this.spread(room, { messages: [said] });
    this.afterSaid(room, said);
    return said;
  }

  /** Writes one message of a room into this home's copy and moves the room's number on. */
  private keep(roomId: string, said: Said): void {
    const { db } = this.home;
    db.run(
      "insert into room_message (room_id, seq, id, member_id, kind, name, agent_kind, of_name, text, at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      roomId,
      said.seq,
      said.id,
      said.from,
      said.kind,
      said.name,
      said.agentKind ?? null,
      said.of ?? null,
      said.text,
      said.at,
    );
    db.run("update room set seq = ? where id = ?", said.seq, roomId);
  }

  /** Puts a message of the room into the conversation this home's devices read. */
  private show(room: Room, said: Said): void {
    const { store } = this.home;
    const carrier = store.agent(room.agentId);
    if (!carrier) return;
    // What the person wrote here already stands in the conversation, as their own message.
    if (said.kind === "person" && said.from === this.me()) return;
    store.addMessage({
      conversationId: carrier.conversationId,
      role: said.kind === "note" ? "note" : "agent",
      agentId: carrier.id,
      channel: "home",
      parts: [{ type: "text", text: said.text }],
      from:
        said.kind === "note" ? undefined : { name: said.name, kind: said.agentKind, of: said.of },
      createdAt: said.at,
    });
  }

  /** Sends something about a room to every other home in it, each in its own order. */
  private spread(room: Room, told: Omit<z.input<typeof Told>, "room" | "name" | "members">): void {
    const me = this.me();
    const members = this.members(room.id);
    const homes = new Set(
      members.filter((member) => member.role !== "invited").map((member) => member.handle),
    );
    homes.delete(me);
    for (const handle of homes) {
      this.inLine(handle, async () => {
        await this.peers.post(handle, "/peers/rooms/told", {
          room: room.id,
          name: room.name,
          members,
          ...told,
        });
      });
    }
  }

  /** A line of the room itself, e.g. that someone joined. */
  private announce(room: Room, text: string): void {
    this.accept(room, { from: "", kind: "note", name: "" }, newId("msg"), text);
  }

  // ── Whose turn it is ──────────────────────────────────────────────────────

  /** The agents a text names with @ and their name, in the order it names them. */
  private named(room: Room, text: string, by: string): string[] {
    const lower = text.toLowerCase();
    return this.inRoom(room.id)
      .filter((member) => member.kind === "agent" && member.id !== by)
      .map((member) => ({ id: member.id, at: lower.indexOf(`@${member.name.toLowerCase()}`) }))
      .filter((found) => found.at >= 0)
      .sort((a, b) => a.at - b.at)
      .map((found) => found.id);
  }

  private afterSaid(room: Room, said: Said): void {
    const floor = this.floors.get(room.id) ?? { queue: [], left: 0 };
    this.floors.set(room.id, floor);
    if (said.kind === "person") {
      floor.left = ROOM_AGENT_TURNS;
      floor.queue = this.named(room, said.text, said.from);
    } else if (said.kind === "agent") {
      if (floor.holder === said.from) this.release(floor);
      floor.left -= 1;
      for (const id of this.named(room, said.text, said.from)) {
        if (!floor.queue.includes(id)) floor.queue.push(id);
      }
    }
    this.next(room, floor);
  }

  private release(floor: Floor): void {
    clearTimeout(floor.timer);
    floor.holder = undefined;
    floor.timer = undefined;
  }

  /** Gives the turn to the next agent named, when no agent is answering. */
  private next(room: Room, floor: Floor): void {
    if (floor.holder || floor.left <= 0) return;
    const members = this.inRoom(room.id);
    let member: Member | undefined;
    while (!member && floor.queue.length) {
      const id = floor.queue.shift();
      member = members.find((candidate) => candidate.id === id);
    }
    if (!member) return;
    const asked = member;
    floor.holder = asked.id;
    floor.timer = setTimeout(() => {
      if (floor.holder !== asked.id) return;
      this.release(floor);
      this.next(room, floor);
    }, FLOOR_WAIT_MS);
    floor.timer.unref();
    if (asked.handle === this.me()) {
      this.track(this.turn(room, asked));
      return;
    }
    this.inLine(asked.handle, async () => {
      try {
        await this.peers.post(asked.handle, "/peers/rooms/floor", {
          room: room.id,
          agent: asked.id,
        });
      } catch {
        this.passed(room, asked.id);
      }
    });
  }

  /** The agent whose turn it was has nothing to say, or cannot answer. */
  private passed(room: Room, memberId: string): void {
    const floor = this.floors.get(room.id);
    if (floor?.holder !== memberId) return;
    this.release(floor);
    this.next(room, floor);
  }

  // ── Saying something ──────────────────────────────────────────────────────

  /** What the person wrote in a room: it goes to everyone in it. */
  async said(carrier: AgentRecord, text: string): Promise<void> {
    const room = this.byAgent(carrier.id);
    const problem = (line: string) =>
      this.home.store.addMessage({
        conversationId: carrier.conversationId,
        role: "note",
        channel: "home",
        parts: [{ type: "text", text: line }],
      });
    if (!room) return void problem("This room is closed. What you wrote stays here.");
    if (text.length > ROOM_MESSAGE_LIMIT)
      return void problem("That is too long for a room. It was not sent.");
    try {
      await this.say(room, this.me(), text);
    } catch (error) {
      problem(`Not sent: ${(error as Error).message}`);
    }
  }

  /** Says something in a room as one of this home's members. No text: the agent passes. */
  private async say(room: Room, memberId: string, text: string): Promise<void> {
    const id = newId("msg");
    if (this.keeps(room)) {
      this.heard(room, this.me(), { id, as: memberId, text });
      return;
    }
    const response = await this.peers.post(room.keeper, "/peers/rooms/say", {
      room: room.id,
      id,
      as: memberId,
      text,
    });
    const answer = z
      .object({ said: WireSaid.optional() })
      .parse(await response.json().catch(() => ({})));
    if (answer.said) await this.apply(room, [answer.said]);
  }

  /** The keeping home hears a member's home say something. */
  private heard(
    room: Room,
    handle: string,
    input: { id: string; as: string; text: string },
  ): Said | undefined {
    const members = this.inRoom(room.id);
    const member = members.find(
      (candidate) => candidate.id === input.as && candidate.handle === handle,
    );
    if (!member) throw new Refused(403, "This home is not in the room as that member.");
    const text = input.text.trim();
    if (member.kind === "agent") {
      // An agent writes when it is its turn, and only then.
      if (this.floors.get(room.id)?.holder !== member.id)
        throw new Refused(409, "It is not this agent's turn in the room.");
      if (!text) return void this.passed(room, member.id);
    }
    if (!text) throw new Refused(400, "The message is empty.");
    return this.accept(
      room,
      {
        from: member.id,
        kind: member.kind,
        name: member.name,
        agentKind: member.agentKind,
        of:
          member.kind === "agent"
            ? members.find((owner) => owner.id === member.handle)?.name
            : undefined,
      },
      input.id,
      text,
    );
  }

  // ── A room another home keeps ─────────────────────────────────────────────

  /**
   * Takes messages the keeping home sent. They are kept in order: a message that is not the
   * next one means some were missed, and the home asks for everything after what it has.
   */
  private async apply(room: Room, messages: Said[]): Promise<void> {
    for (const said of [...messages].sort((a, b) => a.seq - b.seq)) {
      const current = this.room(room.id);
      if (!current || said.seq <= current.seq) continue;
      if (said.seq !== current.seq + 1) return this.catchUp(current);
      this.home.db.transaction(() => this.keep(room.id, said));
      this.show(current, said);
    }
  }

  /** Asks the keeping home for everything after the last message this home has. */
  private async catchUp(room: Room): Promise<void> {
    if (this.keeps(room)) return;
    for (;;) {
      const current = this.room(room.id);
      if (!current) return;
      const response = await this.peers.post(room.keeper, "/peers/rooms/since", {
        room: room.id,
        after: current.seq,
      });
      const told = Told.parse(await response.json());
      if (told.members) this.setMembers(room.id, told.members);
      for (const said of told.messages) {
        if (said.seq !== (this.room(room.id)?.seq ?? 0) + 1) continue;
        this.home.db.transaction(() => this.keep(room.id, said));
        this.show(current, said);
      }
      if (told.messages.length < HANDED_OVER) return;
    }
  }

  /** Looks, for every room another home keeps, whether this home missed something. */
  catchUpAll(): void {
    for (const room of this.rooms()) {
      if (!this.keeps(room)) this.track(this.catchUp(room));
    }
  }

  /** The room is over for this home: it was closed, or the home was taken out of it. */
  private over(room: Room, line: string): void {
    const carrier = this.home.store.agent(room.agentId);
    this.home.db.run("delete from room where id = ?", room.id);
    if (!carrier) return;
    this.home.store.addMessage({
      conversationId: carrier.conversationId,
      role: "note",
      channel: "home",
      parts: [{ type: "text", text: line }],
    });
  }

  // ── An agent answers a room ───────────────────────────────────────────────

  /**
   * It is the turn of one of this home's agents: it reads what was said in the room since it
   * last answered and writes one message. It runs in a conversation of its own, which the
   * person's devices do not list.
   */
  private async turn(room: Room, member: Member): Promise<void> {
    const { home } = this;
    const agent = home.store.agent(member.id.slice(member.id.lastIndexOf("/") + 1));
    const pass = () => this.say(room, member.id, "").catch(() => {});
    if (agent?.origin !== "own") return pass();
    const seen =
      home.db.get<{ seen: number }>(
        "select seen from room_member where room_id = ? and id = ?",
        room.id,
        member.id,
      )?.seen ?? 0;
    const lines = home.db
      .all<SaidRow>(
        "select * from (select * from room_message where room_id = ? and seq > ? and kind != 'note' order by seq desc limit ?) order by seq",
        room.id,
        seen,
        READ_BACK,
      )
      .map(toSaid);
    const upTo = this.room(room.id)?.seq ?? room.seq;
    home.db.run(
      "update room_member set seen = ? where room_id = ? and id = ?",
      upTo,
      room.id,
      member.id,
    );
    const who = (said: Said) =>
      said.from === member.id
        ? "You"
        : said.kind === "agent"
          ? `${said.name} (${said.of ? `${said.of}'s agent` : "an agent"})`
          : said.name;
    const members = this.inRoom(room.id).map((other) =>
      other.id === member.id
        ? "you"
        : other.kind === "agent"
          ? `${other.name} (an agent, written to as @${other.name})`
          : other.name,
    );
    let answer: string | undefined;
    await home.turns.enqueue({
      conversationId: home.store.guestConversation(agent.id, `room:${room.id}`),
      text: [
        `⟦outside⟧ Said in the room "${room.name}" since you last answered:`,
        ...lines.map((said) => `${who(said)}: ${said.text}`),
        "⟦outside⟧",
        "You were named. Write your one message to the room.",
      ].join("\n"),
      channel: "home",
      guest: { name: room.name },
      room: { name: room.name, members },
      outside: true,
      done: (message) => {
        answer = message.state === "done" ? textOf(message) : "";
      },
    });
    // An answer that came too late, after the turn went on to the next agent, is dropped.
    await this.say(room, member.id, (answer ?? "").slice(0, ROOM_MESSAGE_LIMIT)).catch(() => {});
  }

  /** What an agent can read in a room: what is beside its own conversation with the person. */
  tools(context: TurnContext): Tool[] {
    const { home, agent } = context;
    const own = agent.conversationId;
    return [
      defineTool({
        name: "document_read",
        description: "Read one of your documents.",
        input: z.object({ id: z.string() }),
        label: () => "Reading a document",
        run: async (input) => {
          const document = home.store.document(input.id);
          if (document?.conversationId !== own) return `You have no document ${input.id}.`;
          return `# ${document.title}\n\n${document.content}`;
        },
      }),
      defineTool({
        name: "artifact_read",
        description: "Read the page of one of your artifacts.",
        input: z.object({ id: z.string() }),
        label: () => "Reading an artifact",
        run: async (input) => {
          const artifact = home.artifacts.get(input.id);
          if (artifact?.conversationId !== own) return `You have no artifact ${input.id}.`;
          return `# ${artifact.title}\n\n${artifact.content}`;
        },
      }),
      defineTool({
        name: "file_read",
        description: "Read a file the person sent you: its text, or the picture.",
        input: z.object({ id: z.string() }),
        label: () => "Reading a file",
        run: async (input) => {
          const file = home.store.sentFiles(own).find((sent) => sent.id === input.id);
          if (!file) return `You have no file ${input.id}.`;
          const read = await home.files.forModel([file]);
          return {
            text: read.text || file.name,
            pictures: read.pictures,
          };
        },
      }),
    ];
  }

  // ── Leaving ───────────────────────────────────────────────────────────────

  /**
   * The person removes a room from their list. Returns what is to be told to the other homes
   * once the room is gone here: that it is closed, or that this home left.
   */
  leaving(carrier: AgentRecord): (() => void) | undefined {
    const room = this.byAgent(carrier.id);
    if (!room) return undefined;
    const me = this.me();
    if (!this.keeps(room)) {
      return () =>
        this.inLine(room.keeper, async () => {
          await this.peers.post(room.keeper, "/peers/rooms/leave", { room: room.id });
        });
    }
    const homes = new Set(this.inRoom(room.id).map((member) => member.handle));
    homes.delete(me);
    const floor = this.floors.get(room.id);
    if (floor) this.release(floor);
    this.floors.delete(room.id);
    return () => {
      for (const handle of homes) {
        this.inLine(handle, async () => {
          await this.peers.post(handle, "/peers/rooms/told", { room: room.id, closed: true });
        });
      }
    };
  }

  /** One of the person's agents is removed: it leaves the rooms it was in. */
  agentRemoved(agentId: string): void {
    const memberId = `${this.me()}/${agentId}`;
    for (const room of this.rooms()) {
      if (!this.members(room.id).some((member) => member.id === memberId)) continue;
      if (this.keeps(room)) this.takeOut(room, [memberId]);
      else
        this.inLine(room.keeper, async () => {
          await this.peers.post(room.keeper, "/peers/rooms/agent", {
            room: room.id,
            remove: agentId,
          });
        });
    }
  }

  /** Takes members out of a room this home keeps and tells the room. */
  private takeOut(room: Room, ids: string[]): void {
    const members = this.members(room.id);
    const gone = members.filter((member) => ids.includes(member.id));
    if (!gone.length) return;
    this.setMembers(
      room.id,
      members.filter((member) => !ids.includes(member.id)),
    );
    for (const member of gone) this.passed(room, member.id);
    const names = gone.filter((member) => member.role !== "invited").map((member) => member.name);
    if (names.length) this.announce(room, `${names.join(" and ")} left the room.`);
  }

  // ── Adding an agent ───────────────────────────────────────────────────────

  /** Puts an agent of a member's home into a room this home keeps. */
  private addAgent(
    room: Room,
    handle: string,
    agent: { id: string; name: string; kind: EngentyKind },
  ): void {
    const members = this.members(room.id);
    const owner = members.find((member) => member.id === handle && member.role !== "invited");
    if (!owner) throw new Refused(403, "This home is not in the room.");
    const id = `${handle}/${agent.id}`;
    if (members.some((member) => member.id === id)) return;
    if (members.filter((member) => member.kind === "agent").length >= ROOM_AGENTS)
      throw new Refused(409, `A room takes ${ROOM_AGENTS} agents at most.`);
    if (
      members.some(
        (member) =>
          member.kind === "agent" && member.name.toLowerCase() === agent.name.toLowerCase(),
      )
    )
      throw new Refused(409, `There is an agent called ${agent.name} in the room already.`);
    this.setMembers(room.id, [
      ...members,
      {
        id,
        kind: "agent",
        handle,
        name: agent.name,
        agentKind: agent.kind,
        role: "member",
      },
    ]);
    this.announce(room, `${owner.name} added ${agent.name}. Write @${agent.name} to ask it.`);
  }

  // ── Between homes ─────────────────────────────────────────────────────────

  routes(app: Hono): void {
    const { home } = this;
    const refuse = (c: Context, status: 400 | 401 | 403 | 404 | 409 | 429, message: string) =>
      c.json({ error: "refused", message }, status);

    /** Runs what a connected contact's home asks about a room, with its body. */
    const from = (
      path: string,
      work: (input: { handle: string; name: string; body: unknown }) => unknown,
    ) =>
      app.post(path, async (c) => {
        const request = await this.peers.verified(c, false);
        if (request?.contact?.state !== "connected")
          return refuse(c, 401, "Only a connected home is heard.");
        try {
          const body: unknown = JSON.parse(request.body);
          const answer = await work({ handle: request.handle, name: request.contact.name, body });
          return c.json(answer ?? { state: "ok" });
        } catch (error) {
          if (error instanceof Refused) return refuse(c, error.status, error.message);
          if (error instanceof SyntaxError || error instanceof z.ZodError)
            return refuse(c, 400, "The request is not valid.");
          throw error;
        }
      });

    /** The room a request names, when this home keeps it. The same answer when it does not. */
    const kept = (id: string): Room => {
      const room = this.room(id);
      if (!room || !this.keeps(room)) throw new Refused(404, "There is no such room here.");
      return room;
    };

    /** The room a request names, when the home that asks keeps it. */
    const keptBy = (id: string, handle: string): Room | undefined => {
      const room = this.room(id);
      return room && room.keeper === handle && !this.keeps(room) ? room : undefined;
    };

    from("/peers/rooms/invite", ({ handle, name, body }) => {
      const invite = z
        .object({
          room: z.object({ id: z.string().max(80), name: z.string().min(1).max(80) }),
          members: z.array(z.string().max(80)).max(50).default([]),
        })
        .parse(body);
      const known = this.room(invite.room.id);
      if (known) {
        if (known.keeper !== handle) throw new Refused(409, "This home knows that room already.");
        return { state: "joined" };
      }
      const main = home.store.mainAgent();
      const message = home.store.addMessage({
        conversationId: main.conversationId,
        role: "agent",
        agentId: main.id,
        channel: "home",
        parts: [],
      });
      const card = home.store.createCard(
        {
          kind: "contact",
          level: "needs_you",
          title: `${name} invites you to the room “${invite.room.name}”`,
          body: [
            invite.members.length ? `In it: ${invite.members.join(", ")}.` : "",
            `Everyone in the room reads what you write there. ${name}'s home keeps the room. Nothing else of your home is shared.`,
          ]
            .filter(Boolean)
            .join("\n\n"),
          actions: [
            { id: "join", label: "Join", style: "primary" },
            { id: "refuse", label: "Don't join", style: "plain" },
          ],
          payload: { type: "room_invite_in", handle, room: invite.room },
        },
        { agentId: main.id, conversationId: main.conversationId, messageId: message.id },
      );
      home.store.updateMessage(message.id, { parts: [{ type: "card", card }] });
      void home.notifier.card(card, main.name);
      return { state: "waiting" };
    });

    from("/peers/rooms/join", ({ handle, name, body }) => {
      const room = kept(z.object({ room: z.string() }).parse(body).room);
      if (!this.members(room.id).some((member) => member.id === handle))
        throw new Refused(403, "This home was not invited to the room.");
      return this.admit(room.id, handle, name);
    });

    from("/peers/rooms/say", ({ handle, body }) => {
      const input = z
        .object({
          room: z.string(),
          id: z.string().min(1).max(80),
          as: z.string().max(200),
          text: z.string().max(ROOM_MESSAGE_LIMIT),
        })
        .parse(body);
      return { said: this.heard(kept(input.room), handle, input) };
    });

    from("/peers/rooms/since", ({ handle, body }) => {
      const input = z.object({ room: z.string(), after: z.number().int().min(0) }).parse(body);
      const room = kept(input.room);
      if (!this.inRoom(room.id).some((member) => member.id === handle))
        throw new Refused(403, "This home is not in the room.");
      return {
        room: room.id,
        name: room.name,
        messages: this.since(room.id, input.after),
        members: this.members(room.id),
      };
    });

    from("/peers/rooms/agent", ({ handle, body }) => {
      const input = z
        .object({
          room: z.string(),
          agent: z
            .object({ id: z.string().max(80), name: z.string().min(1).max(80), kind: EngentyKind })
            .optional(),
          remove: z.string().max(80).optional(),
        })
        .parse(body);
      const room = kept(input.room);
      if (input.agent) this.addAgent(room, handle, input.agent);
      if (input.remove) this.takeOut(room, [`${handle}/${input.remove}`]);
      return { members: this.members(room.id) };
    });

    from("/peers/rooms/leave", ({ handle, body }) => {
      const room = kept(z.object({ room: z.string() }).parse(body).room);
      const theirs = this.members(room.id)
        .filter((member) => member.handle === handle)
        .map((member) => member.id);
      // The person's own name stands last in the line that says who left.
      this.takeOut(room, theirs.reverse());
      return { state: "left" };
    });

    from("/peers/rooms/told", async ({ handle, body }) => {
      const told = Told.parse(body);
      const room = keptBy(told.room, handle);
      if (!room) throw new Refused(404, "There is no such room here.");
      if (told.closed) return void this.over(room, "The room was closed.");
      if (told.members) {
        if (!told.members.some((member) => member.id === this.me()))
          return void this.over(room, "You are no longer in this room.");
        this.setMembers(room.id, told.members);
      }
      await this.apply(room, told.messages);
      return { state: "ok" };
    });

    from("/peers/rooms/floor", ({ handle, body }) => {
      const input = z.object({ room: z.string(), agent: z.string().max(200) }).parse(body);
      const room = keptBy(input.room, handle);
      const member = room && this.members(room.id).find((found) => found.id === input.agent);
      if (!room || member?.kind !== "agent" || member.handle !== this.me())
        throw new Refused(404, "There is no such agent in that room here.");
      // The answer is sent to the room when the agent has written it, not with this request.
      this.track(this.turn(room, member));
      return { state: "asked" };
    });
  }

  private since(roomId: string, after: number): Said[] {
    return this.home.db
      .all<SaidRow>(
        "select * from room_message where room_id = ? and seq > ? order by seq limit ?",
        roomId,
        after,
        HANDED_OVER,
      )
      .map(toSaid);
  }

  // ── What the main agent can do ────────────────────────────────────────────

  private setupTools(context: TurnContext): Tool[] {
    const { home, agent, conversationId, draft } = context;
    if (!agent.main) return [];
    const where = { agentId: agent.id, conversationId, messageId: draft.id };
    const roomOf = (id: string): Room | undefined => this.byAgent(id) ?? this.room(id);
    return [
      defineTool({
        name: "room_open",
        description:
          "Open a room: a conversation of several people and agents, which stands in the list beside the agents. Everyone in it reads everything written there. Afterwards add agents with `room_add` and invite contacts with `room_invite`.",
        input: z.object({ name: z.string().min(1).max(80) }),
        label: (input) => `Opening the room “${String(input.name ?? "")}”`,
        run: async (input) => {
          const carrier = this.open(input.name.trim());
          return `The room "${carrier.name}" is open (${carrier.id}). The person is in it. It stands in the list beside the agents.`;
        },
      }),
      defineTool({
        name: "room_list",
        description: "List the person's rooms: who keeps each and who is in it.",
        input: z.object({}),
        label: () => "Looking at the rooms",
        run: async () => {
          const lines = this.rooms().map((room) => {
            const members = this.members(room.id).map((member) =>
              member.role === "invited"
                ? `${member.name} (invited)`
                : member.kind === "agent"
                  ? `${member.name} (agent)`
                  : member.name,
            );
            return `- ${room.name} (${room.agentId}), kept by ${this.keeps(room) ? "this home" : room.keeper}: ${members.join(", ")}`;
          });
          return lines.join("\n") || "No rooms.";
        },
      }),
      defineTool({
        name: "room_invite",
        description:
          "Invite a connected contact to a room this home keeps. Asks the person first; the contact then decides on their side. Ends your turn.",
        input: z.object({ room: z.string(), handle: z.string() }),
        label: () => "Asking to invite someone to a room",
        run: async (input) => {
          const room = roomOf(input.room);
          const contact = this.peers.contact(input.handle.trim());
          if (!room) return `There is no room ${input.room}.`;
          if (!this.keeps(room))
            return `${room.keeper} keeps that room. Only that home invites to it.`;
          if (!home.config.publicUrl)
            return "Your home has no address others reach. Only a home with one (WIZARDS_BOT_URL) keeps a room for other people: join a room of theirs with an invite.";
          if (contact?.state !== "connected")
            return `${input.handle} is not a connected contact. Connect first with \`contact_connect\`.`;
          if (this.members(room.id).some((member) => member.id === contact.handle))
            return `${contact.name} is in the room, or invited, already.`;
          const card = home.store.createCard(
            {
              kind: "approval",
              level: "needs_you",
              title: `Invite ${contact.name} to “${room.name}”?`,
              body: `${contact.name} reads everything written in the room from then on, and what your agents in it say. Nothing else of your home is shared.`,
              actions: [
                { id: "invite", label: "Invite", style: "primary" },
                { id: "keep", label: "Don't invite", style: "plain" },
              ],
              payload: { type: "room_invite_out", roomId: room.id, handle: contact.handle },
            },
            where,
          );
          draft.add({ type: "card", card });
          return ENDS_TURN;
        },
      }),
      defineTool({
        name: "room_add",
        description:
          "Put one of the person's own agents into a room. It answers there when someone names it with @ and its name. Asks the person first. Ends your turn.",
        input: z.object({ room: z.string(), agentId: z.string() }),
        label: () => "Asking to add an agent to a room",
        run: async (input) => {
          const room = roomOf(input.room);
          const target = home.store.agent(input.agentId);
          if (!room) return `There is no room ${input.room}.`;
          if (target?.origin !== "own")
            return `There is no agent of your own with the id ${input.agentId}.`;
          if (target.main)
            return "The first agent of a home is yours alone. Make an agent for the task and add that one.";
          if (this.members(room.id).some((member) => member.id === `${this.me()}/${target.id}`))
            return `${target.name} is in the room already.`;
          const card = home.store.createCard(
            {
              kind: "approval",
              level: "needs_you",
              title: `Add ${target.name} to “${room.name}”?`,
              body: `Everyone in the room can ask ${target.name}. It answers with what is its own: its task, what it remembers, and the documents, artifacts and files of its conversation with you. Your accounts, your folders, your devices and your other agents stay closed to the room.`,
              actions: [
                { id: "add", label: "Add", style: "primary" },
                { id: "keep", label: "Don't add", style: "plain" },
              ],
              payload: { type: "room_add", roomId: room.id, agentId: target.id },
            },
            where,
          );
          draft.add({ type: "card", card });
          return ENDS_TURN;
        },
      }),
    ];
  }

  private registerCards(): void {
    const { home } = this;

    home.onCard("room_invite_out", async ({ card, action, payload }) => {
      if (action !== "invite") return;
      const room = this.room(String(payload.roomId));
      const contact = this.peers.contact(String(payload.handle));
      if (!room || !this.keeps(room) || contact?.state !== "connected") return;
      const members = this.members(room.id);
      if (!members.some((member) => member.id === contact.handle)) {
        this.setMembers(room.id, [
          ...members,
          {
            id: contact.handle,
            kind: "person",
            handle: contact.handle,
            name: contact.name,
            role: "invited",
          },
        ]);
      }
      await this.peers.post(contact.handle, "/peers/rooms/invite", {
        room: { id: room.id, name: room.name },
        members: this.inRoom(room.id).map((member) => member.name),
      });
      home.tell(
        card.conversationId,
        `${contact.name} is invited to the room "${room.name}" and decides whether to join. Say so in one sentence.`,
      );
    });

    home.onCard("room_invite_in", async ({ card, action, payload }) => {
      if (action !== "join") return;
      const handle = String(payload.handle);
      const invite = z.object({ id: z.string(), name: z.string() }).parse(payload.room);
      if (this.room(invite.id)) return;
      const response = await this.peers.post(handle, "/peers/rooms/join", { room: invite.id });
      const name = await this.enter(handle, invite.id, await response.json());
      home.tell(
        card.conversationId,
        `The room "${name}" is in the list now. Say so in one sentence.`,
      );
    });

    home.onCard("room_add", async ({ card, action, payload }) => {
      if (action !== "add") return;
      const room = this.room(String(payload.roomId));
      const agent = home.store.agent(String(payload.agentId));
      if (!room || agent?.origin !== "own" || agent.main) return;
      const added = { id: agent.id, name: agent.name, kind: agent.kind };
      if (this.keeps(room)) this.addAgent(room, this.me(), added);
      else {
        const response = await this.peers.post(room.keeper, "/peers/rooms/agent", {
          room: room.id,
          agent: added,
        });
        const answer = z.object({ members: z.array(WireMember) }).parse(await response.json());
        this.setMembers(room.id, answer.members);
      }
      home.tell(
        card.conversationId,
        `${agent.name} is in the room "${room.name}" now and answers when someone writes @${agent.name}. Say so in one sentence.`,
      );
    });
  }
}
