import { RequestContext } from "@mastra/core/request-context";
import { EngentyKind, PROTOCOL_VERSION, SignedRecord } from "@wizards-bot/protocol";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { defineTool, type Tool } from "../agent/tool.ts";
import type { TurnContext } from "../agent/turns.ts";
import type { Home } from "../home.ts";
import { newId, now } from "../ids.ts";
import { ShareRefused } from "../sharing/sharing.ts";
import type { AgentRecord, NewCard } from "../store/store.ts";
import {
  A2A_ERROR,
  A2A_VERSION,
  A2AAgent,
  A2ARequest,
  agentCard,
  answer,
  answered,
  type Fetch,
  isPrivateHost,
  outsideUrl,
  rpcError,
  say,
  Tasks,
  taken,
  whenEnded,
} from "./a2a.ts";
import { Invites } from "./invites.ts";
import { Mailbox } from "./mailbox.ts";
import { Outside } from "./outside.ts";
import { isKeyHandle, keyDomain, Person, type Pin, readLog } from "./person.ts";
import { Rooms } from "./rooms.ts";
import { nonceOf, SIGNATURE_LASTS_MS, signer, signRequest, verifyRequest } from "./signature.ts";

// Other people's homes. A person is `name@host`; the host is where their home answers.
// Two homes connect once (a request the other person approves) and from then on sign what
// they send each other. An agent is shared with a contact to talk to (it stays in its
// home and answers over A2A) or as a copy of its instructions. A document or an artifact is
// sent as a copy (sharing/sharing.ts).
// What is wizards.bot's own is here: the handle, the request to connect and the signature. The
// A2A a shared agent answers in is in a2a.ts, and agents that are not homes are in outside.ts.

const ENDS_TURN =
  "The card is in the chat. End your turn now with at most one short sentence. The answer arrives as the next message.";
const MAX_OPEN_REQUESTS = 5;
/** Tasks Mastra keeps for one sender with one agent before the home starts a new list. */
const MAX_TASKS = 200;

export interface Contact {
  handle: string;
  name: string;
  url: string;
  publicKey: string;
  /** `requested`: we asked. `incoming`: they asked. */
  state: "requested" | "incoming" | "connected" | "blocked";
  /**
   * Connected by an invite to one agent or one room, and for that only: such a contact is
   * heard about what it joined, and sends no documents and offers no agents.
   */
  limited: boolean;
  /** The contact's person as this home saw their record last: their id, key and version. */
  person?: Pin;
}

interface ContactRow {
  handle: string;
  name: string;
  url: string;
  public_key: string;
  state: string;
  limited: number;
  person_id: string | null;
  person_key: string | null;
  person_seq: number | null;
}

const HomeCard = z.object({
  protocol: z.number(),
  handle: z.string(),
  name: z.string(),
  publicKey: z.string(),
  /** The record of the home's person, every version the home has. */
  person: z.object({ log: z.array(SignedRecord).max(50) }).optional(),
});
type HomeCard = z.infer<typeof HomeCard>;
/** A home's card, and the address the home was found at. */
export type Found = HomeCard & { url: string };

/** What a domain shows that is no home itself: the address of the home for each name. */
const Pointer = z.object({ names: z.record(z.string(), z.string().max(300)) });

/** What someone an agent is shared with hears of what the agent remembers. */
export const Hears = z.enum(["none", "all"]);
export type Hears = z.infer<typeof Hears>;

/** The sentence of a card that says what a guest hears of an agent's memory. */
export const heard = (agent: string, guest: string, memory: Hears): string =>
  memory === "all"
    ? `${agent} answers from its instructions and from everything it remembers: ${guest} can hear all of that.`
    : `${agent} answers from its instructions and tells ${guest} nothing of what it remembers.`;

/** How long one sentence may be that a contact asks an agent to remember, and how many may wait. */
const SUGGESTION_LIMIT = 300;
const SUGGESTIONS_OPEN = 5;
/** Longest memory of an agent, as its own tool keeps it. */
const MEMORY_LIMIT = 6000;

/** The header a home without an address sends its card in, and how long that may be. */
const CARD_HEADER = "wizards-card";
const CARD_LIMIT = 12_000;

/** Homes looked up in a minute for requests that name a handle unknown here. */
const LOOKUPS_A_MINUTE = 20;
/** How soon a contact that did not answer is looked for again in its person's record. */
const FOLLOW_AGAIN_MS = 30_000;

/** How long a contact's record counts as looked at. */
const LOOK_AGAIN_MS = 60 * 60_000;

const SharedAgent = z.object({
  id: z.string(),
  name: z.string().max(80),
  kind: EngentyKind,
  about: z.string().max(400),
  instructions: z.string().max(20_000).optional(),
});

const ShareBody = z.object({ mode: z.enum(["talk", "copy"]), agent: SharedAgent });

/** Whether a handle's host is this computer or a private network. */
export const isLocal = (handle: string): boolean =>
  /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[)/.test(
    handle.slice(handle.indexOf("@") + 1),
  );

/** Where the home of a handle answers. A local or private host is reached without TLS. */
export function urlOf(handle: string): string {
  const host = handle.slice(handle.indexOf("@") + 1);
  return `${isLocal(handle) ? "http" : "https"}://${host}`;
}

export const isHandle = (value: string): boolean => /^[a-z0-9._-]+@[a-z0-9.:[\]-]+$/i.test(value);

export class Peers {
  /** Agents that are not wizards.bot homes: the ones the person added, and the callers. */
  readonly outside: Outside;
  /** Conversations of several people and agents, from this home and others. */
  readonly rooms: Rooms;
  /** Links that let someone connect, or join one agent or one room. */
  readonly invites: Invites;
  /** The record of the person this home belongs to. */
  readonly person: Person;
  /** What is kept for contacts whose homes have no address, and asking for what is kept for this one. */
  readonly mailbox: Mailbox;
  /** When each contact's record was looked at last. */
  private readonly looked = new Map<string, number>();
  /** When homes were looked up for handles unknown here, within the last minute. */
  private lookedUp: number[] = [];
  /** When a contact that did not answer was last looked for in its person's record. */
  private readonly lookedFor = new Map<string, number>();
  private readonly home: Home;
  /** What Mastra's A2A handler keeps of each sender's tasks, by agent and sender. */
  private readonly tasks = new Map<string, Tasks>();
  /** The signed requests this home heard while their time counts: sender and nonce, until when. */
  private readonly heard = new Map<string, number>();
  /** Shared agents whose home took them back: that home is not told that they went. */
  private readonly takenBack = new Set<string>();
  /** Contacts by invite whose request to connect waits on a card. */
  private readonly asked = new Set<string>();

  constructor(home: Home) {
    this.home = home;
    home.addTools((context) => this.tools(context));
    this.registerCards();
    this.outside = new Outside(home);
    this.person = new Person(home);
    this.mailbox = new Mailbox(home, this);
    this.rooms = new Rooms(home, this);
    this.invites = new Invites(home, this);
  }

  /**
   * Makes a home a contact because an invite was used, on either side of it. An invite to
   * connect makes it a contact like any other; an invite to one agent or one room leaves a
   * contact that was none before limited to that.
   */
  connectByInvite(
    home: { handle: string; name: string; publicKey: string; url: string },
    full: boolean,
  ): void {
    const existing = this.contact(home.handle);
    if (existing?.state === "connected") {
      if (full && existing.limited)
        this.home.db.run("update contact set limited = 0 where handle = ?", existing.handle);
      return;
    }
    this.home.db.run(
      "insert into contact (handle, name, url, public_key, state, limited, created_at) values (?, ?, ?, ?, 'connected', ?, ?) on conflict(handle) do update set name = excluded.name, public_key = excluded.public_key, state = 'connected', limited = excluded.limited",
      home.handle.toLowerCase(),
      home.name,
      home.url,
      home.publicKey,
      full ? 0 : 1,
      now(),
    );
    this.mailbox.look();
  }

  contact(handle: string): Contact | undefined {
    const row = this.home.db.get<ContactRow>(
      "select * from contact where handle = ?",
      handle.toLowerCase(),
    );
    return row ? toContact(row) : undefined;
  }

  contacts(): Contact[] {
    return this.home.db.all<ContactRow>("select * from contact order by name").map(toContact);
  }

  /**
   * Says a text to an agent that lives in a contact's home, or outside, and writes its answer
   * as it arrives. Mastra's `A2AAgent` does the talking; to a contact's home each message is
   * signed with this home's key.
   */
  async ask(
    agent: AgentRecord,
    text: string,
    signal: AbortSignal,
    write: (text: string) => void,
  ): Promise<void> {
    if (this.outside.is(agent)) return this.outside.ask(agent, text, signal, write);
    const { from, remote } = agent;
    if (!from || !remote) throw new Error("This agent has no Bot Server to ask.");
    // The agent's home is where its person's record led last, or where the handle leads.
    const owner = this.contact(from) ?? (await this.lookup(from));
    const address = `${owner.url}${remote}`;
    const signed: Fetch = async (input, init) => {
      if (init?.method !== "POST") {
        const card = await fetch(input, init).catch(() => undefined);
        if (!card) throw new Error(`The Bot Server of ${from} is out of reach.`);
        return card;
      }
      // The message goes to the home the agent was shared from, wherever its card points.
      if (String(input) !== address || typeof init.body !== "string")
        throw new Error(`The Bot Server of ${from} names another address for this agent.`);
      const response = await this.signed(
        from,
        remote,
        init.body,
        init.signal ?? AbortSignal.timeout(30_000),
      );
      if (!response.ok) {
        const refused = (await response.json().catch(() => ({}))) as { message?: string };
        throw new Error(
          refused.message ?? `The Bot Server of ${from} answered ${response.status}.`,
        );
      }
      return response;
    };
    const home = new A2AAgent({
      url: `${address}/agent-card.json`,
      protocolVersion: A2A_VERSION,
      name: agent.name,
      fetch: signed,
    });
    await say(home, text, signal, write);
  }

  // ── Requests between homes ────────────────────────────────────────────────

  private own(): string {
    const handle = this.home.handle();
    if (!handle) {
      throw new Error(
        "Others do not know you yet: your Bot Server has no address, and you have no key. Make the key with `person_key`: other Bot Servers then know you by it.",
      );
    }
    return handle;
  }

  /** Reads what a home, or a domain that names homes, shows at its well-known address. */
  private async shown(url: string, redirects: boolean): Promise<unknown> {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      redirect: redirects ? "follow" : "error",
    }).catch(() => undefined);
    return response?.ok ? await response.json().catch(() => undefined) : undefined;
  }

  /** The card of the home at an address, when it answers as a home does. */
  private async cardAt(url: string): Promise<Found | undefined> {
    const card = HomeCard.safeParse(await this.shown(`${url}/.well-known/wizards.json`, false));
    return card.success ? { ...card.data, url } : undefined;
  }

  /**
   * Finds the home a handle names. The handle's domain answers for it: as that home itself,
   * or with the address of the home for that name. The home found must say that the handle
   * is its own, so the domain and the home name each other.
   */
  async lookup(handle: string): Promise<Found> {
    const name = handle.slice(0, handle.indexOf("@")).toLowerCase();
    const base = urlOf(handle);
    const first = await this.shown(
      `${base}/.well-known/wizards.json?name=${encodeURIComponent(name)}`,
      true,
    );
    const pointer = Pointer.safeParse(first);
    let found: Found | undefined;
    if (pointer.success) {
      const target = pointer.data.names[name];
      const own = this.home.config.publicUrl;
      try {
        // A domain on the internet does not send this home to a private address.
        const url = outsideUrl(target ?? "", own ? isPrivateHost(new URL(own).host) : true);
        found = await this.cardAt(url.origin);
      } catch {
        found = undefined;
      }
    } else {
      const card = HomeCard.safeParse(first);
      if (card.success) found = { ...card.data, url: base };
    }
    if (!found) throw new Error(`No Bot Server answers for ${handle}.`);
    if (found.handle.toLowerCase() !== handle.toLowerCase())
      throw new Error(`The Bot Server at that address is not ${handle}.`);
    return found;
  }

  /** Sends a signed request to a contact's home. Throws with a sentence when it did not arrive. */
  async post(handle: string, path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const response = await this.signed(
      handle,
      path,
      JSON.stringify(body),
      signal ?? AbortSignal.timeout(30_000),
    );
    if (!response.ok) {
      const message = ((await response.json().catch(() => ({}))) as { message?: string }).message;
      throw new Error(message ?? `The Bot Server of ${handle} answered ${response.status}.`);
    }
    return response;
  }

  /**
   * Signs a request body with this home's key and sends it to a contact's home. A home that
   * is not where it was, or no longer answers to its handle, is looked for in its person's
   * record: the request is sent once more to where and who the record says.
   */
  private async signed(
    handle: string,
    path: string,
    body: string,
    signal: AbortSignal,
  ): Promise<Response> {
    const send = (to: { handle: string; url: string }) =>
      fetch(`${to.url}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "a2a-version": A2A_VERSION,
          // A home nobody can look up says who it is with every request.
          ...(this.home.config.publicUrl ? {} : { [CARD_HEADER]: this.ownCard() }),
          ...signRequest({
            identity: this.home.identity,
            from: this.own(),
            to: to.handle,
            method: "POST",
            path,
            body,
          }),
        },
        body,
        signal,
      }).catch(() => undefined);
    const contact = this.contact(handle);
    if (contact && !contact.url) {
      // A home without an address is not called: it asks for what is kept for it.
      this.mailbox.keep(contact.handle, path, body);
      return Response.json({ state: "kept" }, { status: 202 });
    }
    let response = await send(contact ?? (await this.lookup(handle)));
    const lately = Date.now() - (this.lookedFor.get(handle) ?? 0) < FOLLOW_AGAIN_MS;
    if (contact?.person && !lately && (!response || response.status === 401)) {
      this.lookedFor.set(handle, Date.now());
      const followed = await this.refreshContact(contact.handle).catch(() => undefined);
      if (followed && (followed.url !== contact.url || followed.handle !== contact.handle))
        response = await send(followed);
    }
    if (!response) throw new Error(`The Bot Server of ${handle} is out of reach.`);
    return response;
  }

  /**
   * Checks who signed a request. A home we do not know yet is looked up through its handle,
   * so nobody can claim a handle whose domain they do not hold.
   */
  async verified(
    c: Context,
    allowUnknown: boolean,
  ): Promise<{ handle: string; body: string; contact?: Contact; card?: Found } | undefined> {
    const own = this.home.handle();
    const handle = signer(c.req.raw.headers)?.toLowerCase();
    if (!own || !handle || !isHandle(handle)) return undefined;
    const body = await c.req.text();
    let contact = this.contact(handle);
    let card: Found | undefined;
    if (!contact?.publicKey) {
      // A home on the internet does not go looking for a stranger's key on a private address.
      if (isLocal(handle) && !isLocal(own)) return undefined;
      if (isKeyHandle(handle)) card = this.presented(c.req.raw.headers, handle);
      else if (allowUnknown || this.mayLookUp())
        card = await this.lookup(handle).catch(() => undefined);
      else return undefined;
      // A handle this home does not know may be a contact's new one: their record says so.
      if (card && !contact) contact = this.underNewHandle(card);
      if (!contact && !allowUnknown) return undefined;
    }
    const publicKey = contact?.publicKey || card?.publicKey;
    if (!publicKey) return undefined;
    const signedWith = (key: string) =>
      verifyRequest({
        headers: c.req.raw.headers,
        publicKey: key,
        to: own,
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        body,
      });
    let known = contact;
    let ok = signedWith(publicKey);
    if (!ok && contact?.person) {
      // A key this home does not know: the record of the contact's person may name it, in a
      // version signed with the key this home remembers.
      const shown = isKeyHandle(handle) ? this.presented(c.req.raw.headers, handle) : undefined;
      known = shown ? this.follow(contact, shown) : await this.refreshContact(handle);
      ok = known !== undefined && known.publicKey !== publicKey && signedWith(known.publicKey);
    }
    if (!ok || !this.firstTime(handle, c.req.raw.headers)) return undefined;
    if (known && Date.now() - (this.looked.get(handle) ?? 0) > LOOK_AGAIN_MS) {
      // Now and then the record is read again, so a home taken out of it is no longer heard.
      void this.refreshContact(handle).catch(() => {});
    }
    return { handle, body, contact: known, card };
  }

  /** This home's card as it travels with the requests of a home without an address. */
  private ownCard(): string {
    const card: HomeCard = {
      protocol: PROTOCOL_VERSION,
      handle: this.own(),
      name: this.home.person(),
      publicKey: this.home.identity.publicKey,
      person: { log: this.person.log() },
    };
    return Buffer.from(JSON.stringify(card)).toString("base64url");
  }

  /**
   * The card a home without an address sent along. Nobody can look such a home up, so the
   * card has to speak for itself: its person's record holds, names the home's key and the
   * handle, and the handle is made from the id of that person, which comes from their key.
   */
  private presented(headers: Headers, handle: string): Found | undefined {
    const sent = headers.get(CARD_HEADER);
    if (!sent || sent.length > CARD_LIMIT) return undefined;
    try {
      const card = HomeCard.parse(JSON.parse(Buffer.from(sent, "base64url").toString("utf8")));
      const read = readLog(card.person?.log ?? []);
      if (
        !read ||
        card.handle.toLowerCase() !== handle ||
        read.record.handle?.toLowerCase() !== handle ||
        !handle.endsWith(`@${keyDomain(read.record.id)}`) ||
        !read.record.homes.some((named) => named.key === card.publicKey)
      )
        return undefined;
      return { ...card, url: "" };
    } catch {
      return undefined;
    }
  }

  /** Whether one more home may be looked up for a request that names a handle unknown here. */
  private mayLookUp(): boolean {
    const at = Date.now();
    this.lookedUp = this.lookedUp.filter((earlier) => at - earlier < 60_000);
    if (this.lookedUp.length >= LOOKUPS_A_MINUTE) return false;
    this.lookedUp.push(at);
    return true;
  }

  /** The contact whose person the record on a home's card is of, now under that card's handle. */
  private underNewHandle(card: Found): Contact | undefined {
    let id: unknown;
    try {
      id = (JSON.parse(card.person?.log.at(-1)?.payload ?? "") as { id?: unknown }).id;
    } catch {
      return undefined;
    }
    if (typeof id !== "string") return undefined;
    const row = this.home.db.get<ContactRow>(
      "select * from contact where person_id = ? and state != 'blocked'",
      id,
    );
    return row ? this.follow(toContact(row), card) : undefined;
  }

  /**
   * Reads the record a contact's home shows and remembers it. The home is looked for where
   * the contact's handle leads; when it leads nowhere, the home itself may name the person's
   * new handle, which counts when that handle leads back to it.
   */
  async refreshContact(handle: string, shown?: Found): Promise<Contact | undefined> {
    const contact = this.contact(handle);
    if (!contact || contact.state === "blocked") return undefined;
    this.looked.set(contact.handle, Date.now());
    let card = shown ?? (await this.lookup(contact.handle).catch(() => undefined));
    if (!card && contact.person) {
      const there = await this.cardAt(contact.url);
      const renamed = there && there.handle.toLowerCase() !== contact.handle;
      const back = renamed
        ? await this.lookup(there.handle.toLowerCase()).catch(() => undefined)
        : undefined;
      if (back && back.url === there?.url && back.publicKey === there.publicKey) card = back;
    }
    return card ? this.follow(contact, card) : undefined;
  }

  /**
   * Takes a contact's record from the home that shows it. A record seen for the first time
   * is taken only from the home this home already knows. Later versions must be signed with
   * the key remembered; what such a version says then counts: the home's key, also a new
   * one, the address the home answers at, and the person's handle.
   */
  private follow(contact: Contact, card: Found): Contact | undefined {
    if (!card.person) return undefined;
    let read: ReturnType<typeof readLog>;
    try {
      read = readLog(card.person.log, contact.person);
    } catch {
      return undefined;
    }
    const named = read?.record.homes.find((home) => home.key === card.publicKey);
    if (!read || !named) return undefined;
    const handle = card.handle.toLowerCase();
    const sameHome = card.url === contact.url;
    if (!contact.person) {
      const sameKey = !contact.publicKey || contact.publicKey === card.publicKey;
      if (!sameKey || !sameHome || handle !== contact.handle) return undefined;
    } else {
      if (!sameHome && (!named.url || new URL(named.url).origin !== card.url)) return undefined;
      if (handle !== contact.handle && read.record.handle?.toLowerCase() !== handle)
        return undefined;
    }
    const { pin } = read;
    try {
      this.home.db.transaction(() => {
        if (handle !== contact.handle) this.rename(contact.handle, handle);
        this.home.db.run(
          "update contact set url = ?, public_key = ?, person_id = ?, person_key = ?, person_seq = ? where handle = ?",
          card.url,
          card.publicKey,
          pin.id,
          pin.key,
          pin.seq,
          handle,
        );
      });
    } catch {
      // The new handle is another contact's already.
      return undefined;
    }
    if (handle !== contact.handle) this.rooms.membersChanged(handle);
    return this.contact(handle);
  }

  /** A contact has a new handle: everything this home keeps about them goes under it. */
  private rename(from: string, to: string): void {
    const { db } = this.home;
    db.run("update contact set handle = ? where handle = ?", to, from);
    db.run("update share set handle = ? where handle = ?", to, from);
    db.run("update agent set from_handle = ? where from_handle = ?", to, from);
    db.run("update conversation set guest = ? where guest = ?", to, from);
    db.run("update invite set used_by = ? where used_by = ?", to, from);
    this.rooms.renamed(from, to);
  }

  /**
   * Ends what is shared with a contact, one agent or all: the agent answers them no more,
   * and what they wrote to it is deleted.
   */
  private endShare(handle: string, agentId?: string): void {
    const { home } = this;
    if (agentId)
      home.db.run("delete from share where agent_id = ? and handle = ?", agentId, handle);
    else home.db.run("delete from share where handle = ?", handle);
    for (const id of home.store.removeGuestConversations(handle, agentId))
      void home.mastra.forget(id);
  }

  /** Whether a signed request is heard for the first time. A second one is a replay. */
  private firstTime(handle: string, headers: Headers): boolean {
    const at = Date.now();
    for (const [key, until] of this.heard) if (until < at) this.heard.delete(key);
    const key = `${handle} ${nonceOf(headers)}`;
    if (this.heard.has(key)) return false;
    this.heard.set(key, at + SIGNATURE_LASTS_MS);
    return true;
  }

  /**
   * A shared agent went from this home's list: the home it lives in is told, so that it no
   * longer counts this home among those it answers.
   */
  left(agent: AgentRecord): void {
    if (agent.origin !== "shared" || !agent.from || !agent.remote || !isHandle(agent.from)) return;
    if (this.takenBack.delete(agent.id)) return;
    const id = agent.remote.slice(agent.remote.lastIndexOf("/") + 1);
    void this.post(agent.from, "/peers/unshare", { agent: id }).catch(() => {});
  }

  routes(app: Hono): void {
    const { home } = this;
    const refuse = (c: Context, status: 401 | 403 | 404 | 429, message: string) =>
      c.json({ error: "refused", message }, status);

    app.get("/.well-known/wizards.json", (c) => {
      const handle = home.handle();
      if (!handle)
        return c.json(
          { error: "not_found", message: "This Bot Server has no public address." },
          404,
        );
      const log = this.person.log();
      return c.json({
        protocol: PROTOCOL_VERSION,
        handle,
        name: home.person(),
        publicKey: home.identity.publicKey,
        ...(log.length ? { person: { log } } : {}),
      } satisfies HomeCard);
    });

    app.post("/peers/request", async (c) => {
      const request = await this.verified(c, true);
      if (!request) return refuse(c, 401, "The request is not signed by the Bot Server it names.");
      const existing = request.contact;
      if (existing?.state === "blocked")
        return refuse(c, 403, "This Bot Server does not take the request.");
      const name = request.card?.name ?? existing?.name ?? request.handle;
      const ask = () =>
        this.cardInMain({
          kind: "contact",
          title: `${name} wants to connect`,
          body: `**${request.handle}**\n\nOnce connected, you can share agents with each other. Nothing is shared by connecting.`,
          actions: [
            { id: "connect", label: "Connect", style: "primary" },
            { id: "refuse", label: "Don't connect", style: "plain" },
            { id: "block", label: "Block", style: "danger" },
          ],
          payload: { type: "contact_request", handle: request.handle },
        });
      if (existing?.state === "connected") {
        // A contact by invite asks to be one like any other: that is the person's to say.
        if (!existing.limited) return c.json({ state: "connected" });
        if (!this.asked.has(request.handle)) ask();
        this.asked.add(request.handle);
        return c.json({ state: "waiting" });
      }
      if (existing?.state === "requested") {
        // Both asked each other: that is a yes from both.
        home.db.run("update contact set state = 'connected' where handle = ?", request.handle);
        home.tell(
          home.store.mainAgent().conversationId,
          `${name} (${request.handle}) is connected now. Say so in one sentence.`,
        );
        return c.json({ state: "connected" });
      }
      if (existing?.state === "incoming") return c.json({ state: "waiting" });
      const waiting = this.contacts().filter((contact) => contact.state === "incoming").length;
      if (waiting >= MAX_OPEN_REQUESTS)
        return refuse(c, 429, "This Bot Server has too many open requests.");
      home.db.run(
        "insert into contact (handle, name, url, public_key, state, created_at) values (?, ?, ?, ?, 'incoming', ?)",
        request.handle,
        name,
        request.card?.url ?? urlOf(request.handle),
        request.card?.publicKey ?? "",
        now(),
      );
      if (request.card) await this.refreshContact(request.handle, request.card);
      ask();
      return c.json({ state: "waiting" });
    });

    app.post("/peers/accept", async (c) => {
      const request = await this.verified(c, false);
      const waits =
        request?.contact?.state === "requested" ||
        (request?.contact?.state === "connected" && request.contact.limited);
      if (!request?.contact || !waits)
        return refuse(c, 401, "There is no open request to this Bot Server.");
      home.db.run(
        "update contact set state = 'connected', limited = 0 where handle = ?",
        request.handle,
      );
      home.tell(
        home.store.mainAgent().conversationId,
        `${request.contact.name} (${request.handle}) accepted the request. You are connected. Say so in one sentence.`,
      );
      void this.refreshContact(request.handle).catch(() => {});
      return c.json({ state: "connected" });
    });

    this.rooms.routes(app);
    this.invites.routes(app);
    this.mailbox.routes(app);

    app.post("/peers/share", async (c) => {
      const request = await this.verified(c, false);
      if (request?.contact?.state !== "connected" || request.contact.limited)
        return refuse(c, 401, "Only a connected home can share.");
      const share = ShareBody.parse(JSON.parse(request.body));
      this.cardInMain({
        kind: "contact",
        title: `${request.contact.name} shares “${share.agent.name}” with you`,
        body:
          share.mode === "talk"
            ? `${share.agent.about}\n\nThe agent stays on ${request.contact.name}'s Bot Server. What you write to it is kept there. ${request.contact.name}'s devices do not show it to them, but they run that Bot Server.`
            : `${share.agent.about}\n\nYou get a copy of its instructions. It then runs on your Bot Server, with your models.`,
        actions: [
          { id: "add", label: "Add agent", style: "primary" },
          { id: "refuse", label: "Don't add", style: "plain" },
        ],
        payload: { type: "share_in", handle: request.handle, ...share },
      });
      return c.json({ state: "waiting" });
    });

    // One share ends: the owner took the agent back, or the other person removed it.
    app.post("/peers/unshare", async (c) => {
      const request = await this.verified(c, false);
      if (request?.contact?.state !== "connected")
        return refuse(c, 401, "Only a connected home is heard.");
      const { contact } = request;
      const parsed = z.object({ agent: z.string().max(80) }).safeParse(safeJson(request.body));
      if (!parsed.success) return c.json({ error: "refused", message: "Not valid." }, 400);
      const main = home.store.mainAgent().conversationId;
      const own = home.store.agent(parsed.data.agent);
      const share =
        own &&
        home.db.get(
          "select 1 from share where agent_id = ? and handle = ?",
          own.id,
          contact.handle,
        );
      if (own && share) {
        this.endShare(contact.handle, own.id);
        home.tell(
          main,
          `${contact.name} removed ${own.name} from their list. It is no longer shared with them. Say so in one sentence.`,
        );
        return c.json({ state: "ended" });
      }
      const theirs = home.store
        .agents()
        .find(
          (agent) =>
            agent.origin === "shared" &&
            agent.from === contact.handle &&
            agent.remote === `/a2a/agents/${parsed.data.agent}`,
        );
      if (theirs) {
        this.takenBack.add(theirs.id);
        home.removeAgent(theirs.id);
        home.tell(
          main,
          `${contact.name} took ${theirs.name} back. It is gone from the list of agents. Say so in one sentence.`,
        );
      }
      // The same answer whether or not there was such a share.
      return c.json({ state: "ended" });
    });

    app.post("/peers/send", async (c) => {
      const request = await this.verified(c, false);
      if (request?.contact?.state !== "connected" || request.contact.limited)
        return refuse(c, 401, "Only a connected home can send.");
      try {
        await home.sharing.receive(request.contact, JSON.parse(request.body));
      } catch (error) {
        if (error instanceof ShareRefused) {
          return error.code === "too_many"
            ? refuse(c, 429, error.message)
            : c.json({ error: "refused", message: error.message }, 400);
        }
        if (error instanceof SyntaxError)
          return c.json({ error: "refused", message: "The request is not valid." }, 400);
        throw error;
      }
      return c.json({ state: "received" });
    });

    // An agent's card is public once someone outside may write to it: a contact or a caller.
    // It is the card of the A2A version the request names, as Mastra's own cards are.
    app.get("/a2a/agents/:id/agent-card.json", (c) => {
      const agent = home.store.agent(c.req.param("id"));
      const base = home.config.publicUrl;
      const open =
        agent &&
        (home.db.get("select 1 from share where agent_id = ? and mode = 'talk'", agent.id) ||
          this.outside.callers(agent.id).length > 0);
      if (!agent || !base || !open)
        return c.json({ error: "not_found", message: "There is no such agent." }, 404);
      const version = c.req.header("a2a-version")?.trim() === A2A_VERSION ? A2A_VERSION : "0.3";
      c.header("vary", "A2A-Version");
      return c.json(agentCard(agent, `${base}/a2a/agents/${agent.id}`, version));
    });

    // A contact's home signs its request; a caller from outside sends its access token.
    // Anyone else is refused before the request is read. What is asked is answered by
    // Mastra's A2A handler, in the sender's one conversation with the agent.
    app.post("/a2a/agents/:id", async (c) => {
      const signedBy = signer(c.req.raw.headers) ? await this.verified(c, false) : undefined;
      const contact = signedBy?.contact?.state === "connected" ? signedBy.contact : undefined;
      const caller = contact ? undefined : this.outside.callerOf(c.req.raw.headers);
      if (!contact && !caller) {
        c.header("www-authenticate", 'Bearer realm="a2a"');
        return refuse(c, 401, "This Bot Server does not know the sender.");
      }
      const agent = home.store.agent(c.req.param("id"));
      const allowed =
        agent &&
        (contact
          ? home.db.get(
              "select 1 from share where agent_id = ? and handle = ? and mode = 'talk'",
              agent.id,
              contact.handle,
            ) !== undefined
          : caller?.agentId === agent.id);
      // The same answer whether or not there is such an agent.
      if (!agent || !allowed)
        return refuse(c, 403, "This agent does not take messages from the sender.");

      const body = signedBy?.body ?? (await c.req.text());
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        return c.json(rpcError(null, A2A_ERROR.parseError, "The request is not JSON."));
      }
      const parsed = A2ARequest.safeParse(json);
      if (!parsed.success)
        return c.json(rpcError(null, A2A_ERROR.invalidRequest, "Not a valid request."));
      const rpc = parsed.data;
      const says = taken(rpc);
      if ("refused" in says) return c.json(says.refused);

      // Each sender has one conversation of its own with the agent, and its own tasks.
      const sender = contact?.handle ?? (caller?.id as string);
      const conversationId = home.store.guestConversation(agent.id, sender);
      const tasks = this.tasksOf(`${agent.id} ${sender}`);
      if (caller) this.outside.heard(caller.id);
      const asks = { mastra: home.mastra.instance, agentId: agent.id, request: c.req.raw, rpc };
      const { text, messageId } = says;
      // A request about a task starts no turn: Mastra answers it from what it kept.
      if (!text) return answer({ ...asks, context: new RequestContext(), tasks });

      const run = await home.turns.guestRun(
        conversationId,
        contact
          ? {
              name: contact.name,
              handle: contact.handle,
              hears:
                home.db.get<{ memory: string }>(
                  "select memory from share where agent_id = ? and handle = ?",
                  agent.id,
                  contact.handle,
                )?.memory === "all",
            }
          : { name: caller?.name ?? "" },
      );
      if (!run)
        return c.json(rpcError(rpc.id, A2A_ERROR.internalError, "No model can answer right now."));
      home.store.addMessage({
        conversationId,
        role: "you",
        channel: "home",
        parts: [{ type: "text", text }],
      });
      // The answer is kept in the conversation once the agent is done with the message.
      const keep = () => {
        void answered(tasks, agent.id, messageId ?? "")
          .then((reply) => run.close(reply?.text ?? "", reply?.failed))
          .catch(() => run.close("", true));
      };
      const response = await answer({ ...asks, context: run.context, tasks }).catch((error) => {
        run.close("", true);
        throw error;
      });
      return whenEnded(response, keep);
    });
  }

  /** The tasks of one sender with one agent. A sender never sees another's. */
  private tasksOf(key: string): Tasks {
    const known = this.tasks.get(key);
    // Mastra's store forgets nothing by itself: a full one is started anew.
    if (known && known.list({ agentId: key.split(" ")[0] as string }).length < MAX_TASKS)
      return known;
    const fresh = new Tasks();
    this.tasks.set(key, fresh);
    return fresh;
  }

  /** Puts a card that waits for the person into the main agent's conversation. */
  cardInMain(card: Omit<NewCard, "level">): void {
    const { home } = this;
    const main = home.store.mainAgent();
    const message = home.store.addMessage({
      conversationId: main.conversationId,
      role: "agent",
      agentId: main.id,
      channel: "home",
      parts: [],
    });
    const created = home.store.createCard(
      { ...card, level: "needs_you" },
      { agentId: main.id, conversationId: main.conversationId, messageId: message.id },
    );
    const updated = home.store.updateMessage(message.id, {
      parts: [{ type: "card", card: created }],
    });
    if (updated) void home.notifier.card(created, main.name);
  }

  // ── What the agent can do ─────────────────────────────────────────────────

  private tools(context: TurnContext): Tool[] {
    const { home, agent, conversationId, draft } = context;
    if (!agent.main) return [];
    const where = { agentId: agent.id, conversationId, messageId: draft.id };
    return [
      defineTool({
        name: "contact_connect",
        description:
          "Ask another person's Bot Server to connect, by their handle `name@host`. They approve it on their side.",
        input: z.object({ handle: z.string() }),
        label: (input) => `Asking ${String(input.handle ?? "")} to connect`,
        run: async (input) => {
          const handle = input.handle.trim().toLowerCase();
          if (!isHandle(handle)) return "A handle looks like name@host.";
          try {
            const own = this.own();
            if (handle === own) return "That is your own handle.";
            const existing = this.contact(handle);
            if (existing?.state === "connected") {
              if (!existing.limited) return `${existing.name} is connected already.`;
              // A contact by invite: the other person says whether it becomes one like any other.
              const answer = (await (
                await this.post(handle, "/peers/request", { name: home.person() })
              ).json()) as { state: string };
              if (answer.state !== "connected")
                return `${existing.name} got the request and has to approve it. You hear when they do.`;
              home.db.run("update contact set limited = 0 where handle = ?", handle);
              return `${existing.name} is connected.`;
            }
            const card = await this.lookup(handle);
            home.db.run(
              "insert into contact (handle, name, url, public_key, state, created_at) values (?, ?, ?, ?, 'requested', ?) on conflict(handle) do update set name = excluded.name, public_key = case when contact.person_id is null then excluded.public_key else contact.public_key end, state = case when contact.state = 'incoming' then 'connected' else 'requested' end",
              handle,
              card.name,
              card.url,
              card.publicKey,
              now(),
            );
            // A contact whose person this home remembers keeps its key unless their record names a new one.
            await this.refreshContact(handle, card);
            this.mailbox.look();
            const reply = (await (
              await this.post(handle, "/peers/request", { name: home.person() })
            ).json()) as { state: string };
            if (reply.state === "connected") {
              home.db.run("update contact set state = 'connected' where handle = ?", handle);
              return `${card.name} is connected.`;
            }
            return `${card.name} got the request and has to approve it. You hear when they do.`;
          } catch (error) {
            return (error as Error).message;
          }
        },
      }),
      defineTool({
        name: "contact_list",
        description:
          "List the person's contacts, your own handle and which agents are shared with whom.",
        input: z.object({}),
        label: () => "Looking at the contacts",
        run: async () => {
          const shares = home.db.all<{ agent_id: string; handle: string; mode: string }>(
            "select agent_id, handle, mode from share",
          );
          const lines = this.contacts().map((contact) => {
            const shared = shares
              .filter((share) => share.handle === contact.handle)
              .map(
                (share) =>
                  `${home.store.agent(share.agent_id)?.name ?? share.agent_id} (${share.mode})`,
              );
            return `- ${contact.name} (${contact.handle}): ${contact.limited ? "joined by an invite, for that only" : contact.state}${shared.length ? `; shared with them: ${shared.join(", ")}` : ""}`;
          });
          return `Your handle: ${home.handle() ?? "none yet, the Bot Server has no public address"}\n${lines.join("\n") || "No contacts."}`;
        },
      }),
      defineTool({
        name: "contact_remove",
        description:
          "Remove a contact. Agents shared with them stop answering them; agents they shared are removed.",
        input: z.object({ handle: z.string() }),
        label: (input) => `Removing ${String(input.handle ?? "")}`,
        run: async (input) => {
          const contact = this.contact(input.handle);
          if (!contact) return `There is no contact ${input.handle}.`;
          this.endShare(contact.handle);
          for (const shared of home.store
            .agents()
            .filter((other) => other.from === contact.handle)) {
            home.removeAgent(shared.id);
          }
          home.db.run("delete from contact where handle = ?", contact.handle);
          return `${contact.name} is removed.`;
        },
      }),
      defineTool({
        name: "agent_unshare",
        description:
          "Take back an agent that is shared with a contact to talk to. From then on it does not answer them, and it goes from their list.",
        input: z.object({ agentId: z.string(), handle: z.string() }),
        label: () => "Taking an agent back",
        run: async (input) => {
          const target = home.store.agent(input.agentId);
          const handle = input.handle.trim().toLowerCase();
          const shared =
            target &&
            home.db.get("select 1 from share where agent_id = ? and handle = ?", target.id, handle);
          if (!target || !shared) return `${input.agentId} is not shared with ${input.handle}.`;
          this.endShare(handle, target.id);
          const name = this.contact(handle)?.name ?? handle;
          try {
            await this.post(handle, "/peers/unshare", { agent: target.id });
            return `${target.name} is taken back from ${name}. It is gone from their list.`;
          } catch {
            return `${target.name} is taken back from ${name}: it no longer answers them. Their Bot Server is out of reach, so it still stands in their list.`;
          }
        },
      }),
      defineTool({
        name: "agent_share",
        description:
          "Share one of the person's agents with a connected contact. `talk`: the contact writes to the agent, which stays here and answers from its instructions, without the person's tools. `memory`: `none` (the default) and the agent tells the contact nothing of what it remembers; `all` only when the person says the contact may hear it. Call it again with another `memory` to change that. `copy`: the contact gets its instructions. Asks the person first. Ends your turn.",
        input: z.object({
          agentId: z.string(),
          handle: z.string(),
          mode: z.enum(["talk", "copy"]),
          memory: Hears.default("none"),
        }),
        label: () => "Asking to share an agent",
        run: async (input) => {
          const target = home.store.agent(input.agentId);
          const contact = this.contact(input.handle);
          if (target?.origin !== "own")
            return `There is no agent of your own with the id ${input.agentId}.`;
          if (target.main)
            return "The first agent of a Bot Server is yours alone. Make an agent for the task and share that one.";
          if (contact?.state !== "connected") return `${input.handle} is not a connected contact.`;
          if (contact.limited)
            return `${contact.name} joined by an invite, for that only. Connect with \`contact_connect\` first, or make an invite to the agent with \`invite_make\`.`;
          const card = home.store.createCard(
            {
              kind: "approval",
              level: "needs_you",
              title: `Share “${target.name}” with ${contact.name}?`,
              body:
                input.mode === "talk"
                  ? `${contact.name} can write to ${target.name}. ${heard(target.name, contact.name, input.memory)} It has none of your tools there. What ${contact.name} writes is theirs: it is not shown to you.`
                  : `${contact.name} gets a copy of ${target.name}'s instructions. Its memory and its conversation stay here.`,
              actions: [
                { id: "share", label: "Share", style: "primary" },
                { id: "keep", label: "Don't share", style: "plain" },
              ],
              payload: {
                type: "share_out",
                agentId: target.id,
                handle: contact.handle,
                mode: input.mode,
                memory: input.memory,
              },
            },
            where,
          );
          draft.add({ type: "card", card });
          return ENDS_TURN;
        },
      }),
    ];
  }

  /**
   * What an agent can do in a conversation someone else has with it. A contact may ask it to
   * remember something: that becomes one sentence for the agent's person to keep or to drop.
   * A caller from outside is no person, and the agent has no tool there at all.
   */
  guestTools(context: TurnContext): Tool[] {
    const { home, agent, trigger } = context;
    const guest = trigger.guest;
    if (!guest?.handle) return [];
    return [
      defineTool({
        name: "remember_suggest",
        description: `Ask ${home.person()} to let you keep one sentence for later. Call it when ${guest.name} asks you to remember something. You keep nothing from this conversation by yourself. Tell ${guest.name} that ${home.person()} reads the sentence and decides.`,
        input: z.object({ note: z.string().min(1).max(SUGGESTION_LIMIT) }),
        label: () => "Asking to keep a note",
        run: async (input) => {
          const waiting = home.store
            .openCards(agent.conversationId)
            .filter(
              (card) =>
                home.store.cardPayload<{ type?: string }>(card.id)?.type === "memory_suggest",
            );
          if (waiting.length >= SUGGESTIONS_OPEN)
            return `${home.person()} has not looked at the earlier suggestions yet. Say that you could not pass this one on now.`;
          const note = input.note.trim().replace(/\s+/g, " ");
          const message = home.store.addMessage({
            conversationId: agent.conversationId,
            role: "agent",
            agentId: agent.id,
            channel: "home",
            parts: [],
          });
          const card = home.store.createCard(
            {
              kind: "approval",
              level: "update",
              title: `${guest.name} asked ${agent.name} to keep this`,
              body: `> ${note}\n\nKept, it goes into what ${agent.name} remembers. Nothing else of what ${guest.name} wrote is shown to you.`,
              actions: [
                { id: "keep", label: "Keep", style: "primary" },
                { id: "drop", label: "Drop", style: "plain" },
              ],
              payload: { type: "memory_suggest", agentId: agent.id, note },
            },
            { agentId: agent.id, conversationId: agent.conversationId, messageId: message.id },
          );
          home.store.updateMessage(message.id, { parts: [{ type: "card", card }] });
          return `${home.person()} was asked. Tell ${guest.name} that ${home.person()} reads this one sentence and decides whether you keep it.`;
        },
      }),
    ];
  }

  private registerCards(): void {
    const { home } = this;
    home.onCard("contact_request", async ({ card, action, payload }) => {
      const contact = this.contact(String(payload.handle));
      if (!contact) return;
      if (action === "block") {
        home.db.run("update contact set state = 'blocked' where handle = ?", contact.handle);
        return;
      }
      this.asked.delete(contact.handle);
      if (action !== "connect") {
        // A contact by invite stays what it was.
        if (!contact.limited) home.db.run("delete from contact where handle = ?", contact.handle);
        return;
      }
      home.db.run(
        "update contact set state = 'connected', limited = 0 where handle = ?",
        contact.handle,
      );
      await this.post(contact.handle, "/peers/accept", {});
      await this.refreshContact(contact.handle).catch(() => undefined);
      home.tell(
        card.conversationId,
        `${contact.name} (${contact.handle}) is connected now. Say so in one sentence.`,
      );
    });

    home.onCard("share_out", async ({ card, action, payload }) => {
      if (action !== "share") return;
      const agent = home.store.agent(String(payload.agentId));
      const contact = this.contact(String(payload.handle));
      const mode = payload.mode === "copy" ? "copy" : "talk";
      if (!agent || contact?.state !== "connected") return;
      await this.post(contact.handle, "/peers/share", {
        mode,
        agent: {
          id: agent.id,
          name: agent.name,
          kind: agent.kind,
          about: agent.about,
          ...(mode === "copy" ? { instructions: agent.instructions } : {}),
        },
      });
      if (mode === "talk") {
        home.db.run(
          "insert into share (id, agent_id, handle, mode, memory, created_at) values (?, ?, ?, 'talk', ?, ?) on conflict(agent_id, handle) do update set memory = excluded.memory",
          newId("shr"),
          agent.id,
          contact.handle,
          Hears.catch("none").parse(payload.memory),
          now(),
        );
      }
      home.tell(
        card.conversationId,
        `${agent.name} is offered to ${contact.name}. They decide whether to add it. Say so in one sentence.`,
      );
    });

    // What a contact asked an agent to remember: kept, it is one more line of its memory.
    home.onCard("memory_suggest", ({ action, payload }) => {
      const agent = home.store.agent(String(payload.agentId));
      if (action !== "keep" || !agent) return;
      const memory = [agent.memory.trim(), String(payload.note)].filter(Boolean).join("\n");
      home.store.updateAgent(agent.id, { memory: memory.slice(0, MEMORY_LIMIT) });
    });

    home.onCard("share_in", ({ card, action, payload }) => {
      if (action !== "add") return;
      const share = ShareBody.parse(payload);
      const handle = String(payload.handle);
      const created =
        share.mode === "talk"
          ? home.store.createAgent({
              name: share.agent.name,
              kind: share.agent.kind,
              about: share.agent.about,
              origin: "shared",
              from: handle,
              remote: `/a2a/agents/${share.agent.id}`,
            })
          : home.store.createAgent({
              name: share.agent.name,
              kind: share.agent.kind,
              about: share.agent.about,
              instructions: share.agent.instructions ?? "",
            });
      home.tell(
        card.conversationId,
        `${created.name} is in the list of agents now. Say so in one sentence.`,
      );
    });
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function toContact(row: ContactRow): Contact {
  return {
    handle: row.handle,
    name: row.name,
    url: row.url,
    publicKey: row.public_key,
    state: row.state as Contact["state"],
    limited: row.limited === 1,
    person:
      row.person_id && row.person_key && row.person_seq
        ? { id: row.person_id, key: row.person_key, seq: row.person_seq }
        : undefined,
  };
}
