import { PersonRecord, type PersonState, SignedRecord } from "@wizards-bot/protocol";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { defineTool, type Tool } from "../agent/tool.ts";
import type { TurnContext } from "../agent/turns.ts";
import type { Home } from "../home.ts";
import { Identity, sha256 } from "../identity.ts";
import { now } from "../ids.ts";
import { isHandle, urlOf } from "./peers.ts";

// A person is more than the home they use today. Their record names their key and the homes
// that speak for them, and it is signed with that key, which lives on a device of theirs and
// never in a home. A home keeps the versions of its person's record and shows them to other
// homes; a contact's home remembers the person's id, key and the version it saw (a pin), and
// takes a home's new key only when a later version, signed with the pinned key, names it.

/** What a home remembers of a contact's record: who they are, their key, and how new. */
export interface Pin {
  id: string;
  key: string;
  seq: number;
}

/** A record that does not hold: wrongly signed, of someone else, or not for this home. */
export class RecordRefused extends Error {}

/** Where the home keeps the handle the person asked for until a signed version names it. */
const NEXT_HANDLE = "person.handle.next";

/** The card a device opens to make the key or to sign: the web app and the phone know it. */
export const PERSON_CARD_URL = "wizardsbot://person";

/**
 * What stands for a domain in the handle of a person whose home has no address: it is made
 * from the person's id, so it leads nowhere and nobody else can make it theirs.
 */
export const keyDomain = (id: string): string => `k-${id.slice(0, 20)}`;

/** Whether a handle is one of a home without an address. */
export const isKeyHandle = (handle: string): boolean => /@k-[0-9a-f]{20}$/.test(handle);

/** The id of a person: derived from their first key, so whoever holds that key can name it. */
export const personId = (firstKey: string): string =>
  sha256(`wizards.bot person ${firstKey}`).slice(0, 40);

/** The text of a version as JSON, checked for its shape. */
function parse(payload: string): PersonRecord {
  try {
    return PersonRecord.parse(JSON.parse(payload));
  } catch {
    throw new RecordRefused("A version of the record is not written as a record is.");
  }
}

/**
 * Reads the versions of a record, oldest first, and returns the newest that holds with the
 * pin to remember. Without a pin the record is seen for the first time: its first version
 * shown must be signed with its own key. With a pin, every version after the pinned one must
 * be signed with the key in force before it, and all must be of the pinned person.
 */
export function readLog(
  log: SignedRecord[],
  pin?: Pin,
): { pin: Pin; record: PersonRecord } | undefined {
  const versions = log
    .map((signed) => ({ signed, record: parse(signed.payload) }))
    .sort((a, b) => a.record.seq - b.record.seq);
  let key = pin?.key;
  let id = pin?.id;
  let newest: PersonRecord | undefined;
  for (const { signed, record } of versions) {
    if (pin && record.seq <= pin.seq) {
      // The version the pin was made from: kept to answer with when nothing newer came.
      if (record.seq === pin.seq && record.id === pin.id) newest = record;
      continue;
    }
    if (!Identity.verify(key ?? record.key, signed.payload, signed.sig))
      throw new RecordRefused("A version of the record is not signed with the person's key.");
    if (id !== undefined && record.id !== id)
      throw new RecordRefused("The record is another person's.");
    id = record.id;
    key = record.key;
    newest = record;
  }
  if (!newest || !id || !key) return undefined;
  return { pin: { id, key, seq: newest.seq }, record: newest };
}

interface Row {
  seq: number;
  payload: string;
  sig: string;
}

/** The record of the person this home belongs to. */
export class Person {
  private readonly home: Home;

  constructor(home: Home) {
    this.home = home;
    home.addTools((context) => this.tools(context));
    // The card is done when a device handed in a signed version.
    home.onCard("person_sign", ({ card }) => {
      home.tell(
        card.conversationId,
        this.log().length === 1
          ? "The person made their key on a device of theirs and signed their record. Say so in one sentence, and that the recovery code is the only way back to the key."
          : "The person signed the new version of their record. Say so in one sentence.",
      );
    });
  }

  /** Every version this home has, oldest first, as it was signed. */
  log(): SignedRecord[] {
    return this.home.db
      .all<Row>("select * from person_record order by seq")
      .map((row) => ({ payload: row.payload, sig: row.sig }));
  }

  /** The version that counts. */
  current(): PersonRecord | undefined {
    const row = this.home.db.get<Row>("select * from person_record order by seq desc limit 1");
    return row ? parse(row.payload) : undefined;
  }

  /** This home as a record names it. */
  private thisHome(receives: boolean): PersonRecord["homes"][number] {
    return {
      ...(this.home.config.publicUrl ? { url: this.home.config.publicUrl } : {}),
      key: this.home.identity.publicKey,
      receives,
    };
  }

  /** What a record says besides its numbers: the part that makes a new version necessary. */
  private says(record: Pick<PersonRecord, "name" | "handle" | "homes">): string {
    return JSON.stringify([
      record.name,
      record.handle ?? null,
      record.homes.map((home) => [home.url ?? null, home.key, home.receives]),
    ]);
  }

  /**
   * The version the home asks to have signed, when the record no longer says what is so: the
   * person's name or handle changed, or this home is not in it with its address.
   */
  proposed(): { payload: string; why: string } | undefined {
    const current = this.current();
    if (!current) return undefined;
    const { home } = this;
    const listed = current.homes.some((known) => known.key === home.identity.publicKey);
    const homes = listed
      ? current.homes.map((known) =>
          known.key === home.identity.publicKey ? this.thisHome(known.receives) : known,
        )
      : [...current.homes, this.thisHome(!current.homes.some((known) => known.receives))];
    const wanted = home.db.meta(NEXT_HANDLE);
    const next = { name: home.person(), handle: wanted ?? home.handle(), homes };
    if (this.says(next) === this.says(current)) return undefined;
    const why = !listed
      ? "This home is not in your record yet."
      : next.name !== current.name
        ? "Your name changed."
        : next.handle !== current.handle
          ? wanted
            ? `Your handle becomes ${wanted}.`
            : "Your handle changed."
          : "This home's address changed.";
    const record: PersonRecord = {
      v: 1,
      id: current.id,
      seq: Math.max(Date.now(), current.seq + 1),
      name: next.name,
      ...(next.handle ? { handle: next.handle } : {}),
      key: current.key,
      homes,
      at: now(),
    };
    return { payload: JSON.stringify(record), why };
  }

  /**
   * The first version for this home, for a key a device made or brought back with its
   * recovery code. A person who had a record elsewhere keeps their id: it comes from the key.
   */
  start(key: string): string {
    const current = this.current();
    if (current) {
      if (current.key !== key)
        throw new RecordRefused("This home has your record with another key.");
      const proposed = this.proposed();
      if (!proposed) throw new RecordRefused("Your record is signed and says what is so.");
      return proposed.payload;
    }
    const id = personId(key);
    // A home without an address gets its handle with the key: it is made from the id.
    const handle = this.home.handleFor(id);
    const record: PersonRecord = {
      v: 1,
      id,
      seq: Date.now(),
      name: this.home.person(),
      ...(handle ? { handle } : {}),
      key,
      homes: [this.thisHome(true)],
      at: now(),
    };
    return JSON.stringify(record);
  }

  /**
   * Takes a signed version from a device. It must be of this home's person, newer than what
   * the home has, signed with the key in force, and name this home.
   */
  take(signed: SignedRecord, by: string): PersonRecord {
    const { home } = this;
    const record = parse(signed.payload);
    const current = this.current();
    if (current) {
      if (record.id !== current.id) throw new RecordRefused("That is another person's record.");
      if (record.seq <= current.seq)
        throw new RecordRefused("The home has a newer version of your record.");
    } else if (record.id !== personId(record.key)) {
      throw new RecordRefused("The record's id does not come from its key.");
    }
    if (!Identity.verify(current?.key ?? record.key, signed.payload, signed.sig))
      throw new RecordRefused("That version is not signed with your key.");
    if (!record.homes.some((known) => known.key === home.identity.publicKey))
      throw new RecordRefused("That version does not name this home.");
    home.db.run(
      "insert into person_record (seq, payload, sig) values (?, ?, ?)",
      record.seq,
      signed.payload,
      signed.sig,
    );
    this.takeHandle(record);
    // A home that is known under a handle only now keeps its rooms under it.
    home.peers.rooms.adopt();
    // The cards that asked for the key or the signature are done.
    for (const card of home.store.items()) {
      if (card.url === PERSON_CARD_URL) void home.answer(card.id, { action: "signed", by });
    }
    return record;
  }

  /**
   * The handle the person asked for counts from the version that names it: the home answers
   * to it from then on, and its places in rooms go under it.
   */
  private takeHandle(record: PersonRecord): void {
    const { home } = this;
    const wanted = home.db.meta(NEXT_HANDLE);
    if (!wanted || record.handle !== wanted) return;
    const at = wanted.indexOf("@");
    const domain = wanted.slice(at + 1);
    home.db.transaction(() => {
      home.db.setMeta("person.handle", wanted.slice(0, at));
      // A handle at the home's own address needs no domain of its own.
      if (home.config.publicUrl && domain === new URL(home.config.publicUrl).host)
        home.db.run("delete from meta where key = 'person.domain'");
      else home.db.setMeta("person.domain", domain);
      home.db.run("delete from meta where key = ?", NEXT_HANDLE);
    });
    home.peers.rooms.adopt();
    home.peers.rooms.membersChanged(wanted);
  }

  /** Puts the card on which a device makes the key or signs, unless one waits already. */
  private askToSign(where: { agentId: string; conversationId: string; messageId: string }) {
    const { home } = this;
    if (home.store.items().some((card) => card.url === PERSON_CARD_URL)) return undefined;
    const current = this.current();
    return home.store.createCard(
      {
        kind: "secret",
        level: "needs_you",
        title: current ? "Sign your record" : "Make your key",
        body: current
          ? `${this.proposed()?.why} A device that holds your key signs the new version.`
          : "Your key makes you the same person to other people's homes, also when this home is moved, replaced or lost. It is made on the device you open this card on and stays there, never in your home. You get a recovery code to write down.",
        url: PERSON_CARD_URL,
        actions: [],
        payload: { type: "person_sign" },
      },
      where,
    );
  }

  state(): PersonState {
    return { record: this.current(), proposed: this.proposed() };
  }

  /** What a paired device asks: the record, the text to sign, and handing in a signature. */
  deviceRoutes(app: Hono, deviceName: (c: Context) => string): void {
    const refused = (error: unknown) =>
      error instanceof RecordRefused || error instanceof z.ZodError || error instanceof SyntaxError;
    app.get("/v1/person", (c) => c.json(this.state()));
    app.post("/v1/person/start", async (c) => {
      try {
        const { key } = z.object({ key: z.string().min(40).max(100) }).parse(await c.req.json());
        return c.json({ payload: this.start(key) });
      } catch (error) {
        if (!refused(error)) throw error;
        return c.json({ error: "refused", message: (error as Error).message }, 409);
      }
    });
    app.post("/v1/person/records", async (c) => {
      try {
        this.take(SignedRecord.parse(await c.req.json()), deviceName(c));
        return c.json(this.state());
      } catch (error) {
        if (!refused(error)) throw error;
        const message =
          error instanceof RecordRefused ? error.message : "The request is not valid.";
        return c.json({ error: "refused", message }, 400);
      }
    });
  }

  private tools(context: TurnContext): Tool[] {
    const { home, agent, conversationId, draft } = context;
    if (!agent.main) return [];
    return [
      defineTool({
        name: "person_key",
        description:
          "The person's own key and record: what makes them the same person to other people's homes when a home is moved, replaced or lost. Shows a card on which a device makes the key, or signs the record when something in it changed; says how things stand when nothing is to do.",
        input: z.object({}),
        label: () => "Looking at your key",
        run: async () => {
          const current = this.current();
          const proposed = this.proposed();
          if (current && !proposed) {
            return `The person's record is signed and says what is so. Person id ${current.id}, ${current.homes.length} home${current.homes.length === 1 ? "" : "s"} in it. Nothing to do.`;
          }
          const card = this.askToSign({ agentId: agent.id, conversationId, messageId: draft.id });
          if (card) draft.add({ type: "card", card });
          return current
            ? "The card to sign the record is in the chat. A device that holds the key signs it."
            : "The card to make the key is in the chat. The person opens it on the device that shall keep the key.";
        },
      }),
      defineTool({
        name: "handle_set",
        description:
          "Give the person a handle on a domain of their own, e.g. `ada@example.com`, or another name at this home's address. The domain has to name this home for that name; when it does not yet, you get the file the person has to put there. The handle counts once the person's key signed it: contacts then follow it by themselves.",
        input: z.object({ handle: z.string() }),
        label: (input) => `Looking at ${String(input.handle ?? "")}`,
        run: async (input) => {
          const handle = input.handle.trim().toLowerCase();
          const address = home.config.publicUrl;
          if (!isHandle(handle)) return "A handle looks like name@domain.";
          if (!address)
            return "Your home has no public address yet. It needs one (WIZARDS_BOT_URL) before it has a handle.";
          if (handle === home.handle()) return "That is your handle already.";
          if (!this.current())
            return "The person has no key yet. A handle is signed with it, so that contacts can follow: make the key first with `person_key`.";
          const name = handle.slice(0, handle.indexOf("@"));
          const file = `${urlOf(handle)}/.well-known/wizards.json`;
          const here = new URL(address).origin;
          const names =
            urlOf(handle) === here
              ? here
              : await fetch(`${file}?name=${encodeURIComponent(name)}`, {
                  signal: AbortSignal.timeout(10_000),
                })
                  .then((response) => (response.ok ? response.json() : undefined))
                  .then((body) => (body as { names?: Record<string, unknown> })?.names?.[name])
                  .catch(() => undefined);
          if (typeof names !== "string" || new URL(names).origin !== here) {
            return `The domain does not name this home for "${name}" yet. The person has to put a file at ${file} with exactly this in it, then ask again:\n{"names":{"${name}":"${here}"}}`;
          }
          home.db.setMeta(NEXT_HANDLE, handle);
          const card = this.askToSign({ agentId: agent.id, conversationId, messageId: draft.id });
          if (card) draft.add({ type: "card", card });
          return `The domain names this home. The card to sign the record with the handle ${handle} is in the chat; the handle counts once it is signed.`;
        },
      }),
    ];
  }
}
