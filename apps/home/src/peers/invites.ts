import { EngentyKind, PROTOCOL_VERSION } from "@wizards-bot/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import { defineTool, ENDS_TURN, type Tool } from "../agent/tool.ts";
import type { TurnContext } from "../agent/turns.ts";
import type { Home } from "../home.ts";
import { sha256 } from "../identity.ts";
import { newId, now } from "../ids.ts";
import {
  closedPage,
  invitePage,
  langOf,
  PLAIN_POLICY,
  PUBLISHED_HEADERS,
} from "../sharing/page.ts";
import type { NewCard } from "../store/store.ts";
import { isPrivateHost } from "./a2a.ts";
import { Hears, heard, isHandle, isLocal, type Peers, urlOf } from "./peers.ts";
import { Refused } from "./rooms.ts";

// An invite is a link, shown with its QR code, that lets one person connect to this home,
// join one of its agents or join one of its rooms. The link names the home and carries a
// code that works once and a short print of the home's key: the home that opens it checks
// that the home behind the address is the one the link was made by. Who joins an agent or
// a room this way becomes a contact for that only.

const Lasts = z.enum(["day", "week", "month"]);
const LASTS_MS = { day: 86_400_000, week: 7 * 86_400_000, month: 30 * 86_400_000 } as const;
/** Invites of a home that still work at one time. */
const MAX_OPEN = 50;

const What = z.enum(["connect", "agent", "room"]);
type What = z.infer<typeof What>;

/** What a home says about one of its invites to whoever has the link. */
const Shown = z.object({
  protocol: z.number(),
  handle: z.string().max(200),
  name: z.string().max(80),
  publicKey: z.string().max(200),
  what: What,
  /** The agent's or the room's name; "" for an invite to connect. */
  title: z.string().max(80),
  about: z.string().max(400).optional(),
  expiresAt: z.string(),
});
type Shown = z.infer<typeof Shown>;

/** What the home answers when its invite was used. */
const Accepted = z.object({
  what: What,
  agent: z
    .object({
      id: z.string().max(80),
      name: z.string().max(80),
      kind: EngentyKind,
      about: z.string().max(400),
    })
    .optional(),
  room: z.object({ id: z.string().max(80), joined: z.unknown() }).optional(),
});

interface InviteRow {
  id: string;
  code: string;
  what: string;
  target: string | null;
  title: string;
  expires_at: string;
  used_by: string | null;
  used_at: string | null;
  taken_back_at: string | null;
  memory: string | null;
}

/** A short print of a home's key, to compare by eye: `7F3A 91C2 04BE D5E8`. */
export const keyPrint = (publicKey: string): string => sha256(publicKey).slice(0, 16);

const spaced = (print: string): string => (print.toUpperCase().match(/.{1,4}/g) ?? []).join(" ");

const over = (row: InviteRow): boolean =>
  row.used_at !== null || row.taken_back_at !== null || row.expires_at < now();

const day = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

export class Invites {
  private readonly home: Home;
  private readonly peers: Peers;

  constructor(home: Home, peers: Peers) {
    this.home = home;
    this.peers = peers;
    home.addTools((context) => this.tools(context));
    this.registerCards();
  }

  private byCode(code: string): InviteRow | undefined {
    return this.home.db.get<InviteRow>("select * from invite where code = ?", code);
  }

  /** The link of an invite: the home's address, the code, and the print of the home's key. */
  private link(code: string): string {
    return `${this.home.config.publicUrl}/i/${code}#k=${keyPrint(this.home.identity.publicKey)}`;
  }

  /** What an invite is for, when the agent or the room it names is still there. */
  private target(what: What, id: string | null): { title: string; about?: string } | undefined {
    if (what === "connect") return { title: "" };
    if (what === "agent") {
      const agent = this.home.store.agent(id ?? "");
      return agent?.origin === "own" && !agent.main
        ? { title: agent.name, about: agent.about }
        : undefined;
    }
    const room = this.peers.rooms.kept(id ?? "");
    return room ? { title: room.name } : undefined;
  }

  // ── Between homes ─────────────────────────────────────────────────────────

  routes(app: Hono): void {
    const { home } = this;

    // What a person sees who opened the link in a browser: what it is and what to do with it.
    app.get("/i/:code", (c) => {
      const lang = langOf(c.req.header("accept-language"));
      const page = (html: string, status: 200 | 404 | 410) =>
        c.body(html, status, { ...PUBLISHED_HEADERS, "content-security-policy": PLAIN_POLICY });
      const row = this.byCode(c.req.param("code"));
      if (!row) return page(closedPage("nothing", lang), 404);
      if (over(row) || !this.target(row.what as What, row.target))
        return page(closedPage("gone", lang), 410);
      return page(
        invitePage({
          title: this.heading(home.person(), row.what as What, row.title),
          link: this.link(row.code),
          lang,
        }),
        200,
      );
    });

    // What a home reads before it asks its person: who invites, to what, and the key.
    app.get("/peers/invite/:code", (c) => {
      const row = this.byCode(c.req.param("code"));
      const handle = home.handle();
      if (!row || !handle)
        return c.json({ error: "not_found", message: "This link opens nothing." }, 404);
      const target = this.target(row.what as What, row.target);
      if (over(row) || !target)
        return c.json({ error: "gone", message: "This invite does not work any more." }, 410);
      return c.json({
        protocol: PROTOCOL_VERSION,
        handle,
        name: home.person(),
        publicKey: home.identity.publicKey,
        what: row.what as What,
        title: target.title,
        about: target.about,
        expiresAt: row.expires_at,
      } satisfies Shown);
    });

    // A home uses an invite. It signs the request; a home not known yet is looked up at the
    // address its handle names, as with a request to connect.
    app.post("/peers/invite/accept", async (c) => {
      const refuse = (status: 400 | 401 | 403 | 404 | 409 | 410 | 429, message: string) =>
        c.json({ error: "refused", message }, status);
      const request = await this.peers.verified(c, true);
      if (!request) return refuse(401, "The request is not signed by the home it names.");
      if (request.contact?.state === "blocked")
        return refuse(403, "This home does not take the request.");
      let code: string;
      try {
        code = z.object({ code: z.string().max(80) }).parse(JSON.parse(request.body)).code;
      } catch {
        return refuse(400, "The request is not valid.");
      }
      const row = this.byCode(code);
      if (!row) return refuse(404, "This link opens nothing.");
      const what = row.what as What;
      const target = this.target(what, row.target);
      if (over(row) || !target) return refuse(410, "This invite does not work any more.");
      const name = request.card?.name ?? request.contact?.name ?? request.handle;
      const publicKey = request.card?.publicKey ?? request.contact?.publicKey ?? "";
      const url = request.card?.url ?? request.contact?.url ?? urlOf(request.handle);
      // The code works once: whoever comes second finds it used.
      home.db.run(
        "update invite set used_by = ?, used_at = ? where id = ? and used_at is null",
        request.handle,
        now(),
        row.id,
      );
      if (this.byCode(code)?.used_by !== request.handle)
        return refuse(410, "This invite does not work any more.");
      const main = home.store.mainAgent().conversationId;
      try {
        let accepted: z.input<typeof Accepted> = { what };
        if (what === "agent") {
          const agent = home.store.agent(row.target ?? "");
          if (!agent) return refuse(410, "This invite does not work any more.");
          home.db.run(
            "insert into share (id, agent_id, handle, mode, memory, created_at) values (?, ?, ?, 'talk', ?, ?) on conflict(agent_id, handle) do nothing",
            newId("shr"),
            agent.id,
            request.handle,
            row.memory ?? "none",
            now(),
          );
          accepted = {
            what,
            agent: { id: agent.id, name: agent.name, kind: agent.kind, about: agent.about },
          };
        }
        if (what === "room") {
          const room = this.peers.rooms.kept(row.target ?? "");
          if (!room) return refuse(410, "This invite does not work any more.");
          // The home is a contact before the room tells it who joined.
          this.peers.connectByInvite({ handle: request.handle, name, publicKey, url }, false);
          accepted = {
            what,
            room: { id: room.id, joined: this.peers.rooms.admit(room.id, request.handle, name) },
          };
        }
        this.peers.connectByInvite(
          { handle: request.handle, name, publicKey, url },
          what === "connect",
        );
        if (request.card) await this.peers.refreshContact(request.handle, request.card);
        home.tell(
          main,
          what === "connect"
            ? `${name} (${request.handle}) used your invite and is connected now. Say so in one sentence.`
            : `${name} (${request.handle}) used your invite and joined ${what === "room" ? `the room "${target.title}"` : target.title}. Say so in one sentence.`,
        );
        return c.json(accepted);
      } catch (error) {
        if (error instanceof Refused) return refuse(error.status, error.message);
        throw error;
      }
    });
  }

  /**
   * Reads an invite link: asks the home it leads to who invites and to what, and checks that
   * home against the handle and the key the link names. Gives the card that asks the person,
   * or says why there is none.
   */
  async read(link: string): Promise<NewCard | string> {
    const { home } = this;
    const own = home.handle();
    if (!own)
      return "Others do not know you yet: your home has no address, and you have no key. Make your key first, then open the invite again.";
    let url: URL;
    try {
      url = new URL(link.trim());
    } catch {
      return "That is not a link.";
    }
    const code = /^\/i\/([a-z0-9]{8,80})$/i.exec(url.pathname)?.[1];
    const local = isPrivateHost(url.host);
    if (!code || (url.protocol !== "https:" && !(url.protocol === "http:" && local)))
      return "That is not an invite link.";
    if (local && home.config.publicUrl && !isLocal(own))
      return "That link leads to a private address. This home does not call private addresses.";
    const print = /(?:^|[#&])k=([0-9a-f]{16})(?:&|$)/i.exec(url.hash)?.[1]?.toLowerCase();
    const response = await fetch(`${url.origin}/peers/invite/${code}`, {
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    }).catch(() => undefined);
    if (!response) return `The home at ${url.host} is out of reach.`;
    if (response.status === 404) return "That link opens nothing. Check that it is whole.";
    if (!response.ok) return "That invite does not work any more.";
    const shown = Shown.safeParse(await response.json().catch(() => undefined));
    if (!shown.success) return `The home at ${url.host} did not answer as a home does.`;
    const invite = shown.data;
    const handle = invite.handle.toLowerCase();
    // The handle has to lead to the home the link is at, and that home to the same key.
    const found = isHandle(handle)
      ? await this.peers.lookup(handle).catch(() => undefined)
      : undefined;
    if (found?.url !== url.origin || found.publicKey !== invite.publicKey)
      return `The home at ${url.host} is not where ${handle} leads. Do not use this link.`;
    if (handle === own) return "That is an invite of your own home.";
    if (print && print !== keyPrint(invite.publicKey))
      return `The home at ${url.host} is not the one this link was made by: its key is another. Do not use this link, and tell the person who sent it.`;
    if (this.peers.contact(handle)?.state === "blocked")
      return `${invite.name} (${handle}) is blocked.`;
    const gets = {
      connect:
        "Once connected, you can share agents and rooms with each other. Nothing is shared by connecting.",
      agent: `${invite.about ? `${invite.about}\n\n` : ""}${invite.title} stays in ${invite.name}'s home. What you write to it is kept there. ${invite.name}'s devices do not show it to them, but they run that home. It sees nothing of your home.`,
      room: `Everyone in the room reads what you write there. ${invite.name}'s home keeps the room. Nothing else of your home is shared.`,
    }[invite.what];
    const checked = print
      ? `Key ${spaced(keyPrint(invite.publicKey))}: it is the home the link was made by.`
      : `Key ${spaced(keyPrint(invite.publicKey))}. The link names no key to check it against.`;
    return {
      kind: "contact",
      level: "needs_you",
      title: this.heading(invite.name, invite.what, invite.title),
      // Written as code, so that Markdown does not make a mail address of the handle.
      body: `\`${handle}\`\n\n${checked}\n\n${gets}`,
      actions: [
        {
          id: "join",
          label: invite.what === "connect" ? "Connect" : "Join",
          style: "primary",
        },
        {
          id: "refuse",
          label: invite.what === "connect" ? "Don't connect" : "Don't join",
          style: "plain",
        },
      ],
      payload: {
        type: "invite_in",
        code,
        handle,
        name: invite.name,
        publicKey: invite.publicKey,
        url: url.origin,
        what: invite.what,
        title: invite.title,
      },
    };
  }

  /**
   * What a paired device asks: open an invite link the person scanned or opened on it. The
   * card that asks them stands in the main agent's conversation, as when the agent opens one.
   */
  deviceRoutes(app: Hono): void {
    app.post("/v1/invites/open", async (c) => {
      const body = z.object({ link: z.string().min(1).max(600) }).safeParse(await c.req.json());
      if (!body.success)
        return c.json({ error: "invalid", message: "The request is not valid." }, 400);
      const read = await this.read(body.data.link);
      if (typeof read === "string") return c.json({ opened: false, message: read });
      this.peers.cardInMain(read);
      return c.json({ opened: true });
    });
  }

  private heading(name: string, what: What, title: string): string {
    if (what === "connect") return `${name} invites you to connect`;
    return what === "room"
      ? `${name} invites you to the room “${title}”`
      : `${name} invites you to ${title}`;
  }

  // ── What the main agent can do ────────────────────────────────────────────

  private tools(context: TurnContext): Tool[] {
    const { home, agent, conversationId, draft } = context;
    if (!agent.main) return [];
    const where = { agentId: agent.id, conversationId, messageId: draft.id };
    return [
      defineTool({
        name: "invite_make",
        description:
          "Make an invite: a link with a QR code that works once. `connect`: the person who uses it becomes a contact. `agent`: they talk to one of the person's own agents (give its id). `room`: they join a room this home keeps (give its id). For someone who is not a contact yet; a contact is invited to a room with `room_invite`. `memory`, for an agent: `all` only when the person says that whoever joins may hear what the agent remembers; otherwise it tells them nothing of it. Asks the person first. Ends your turn.",
        input: z.object({
          what: What,
          id: z.string().optional(),
          lasts: Lasts.default("week"),
          memory: Hears.default("none"),
        }),
        label: () => "Asking to make an invite",
        run: async (input) => {
          if (!home.config.publicUrl || !home.handle())
            return "Your home has no address others reach. Only a home with one (WIZARDS_BOT_URL) makes invites: ask the other person for one of theirs.";
          const target = this.target(input.what, input.id ?? null);
          if (!target) {
            return input.what === "agent"
              ? `There is no agent of your own with the id ${input.id}, or it is the first agent, which is yours alone.`
              : `There is no room ${input.id} that this home keeps.`;
          }
          const open =
            home.db.get<{ n: number }>(
              "select count(*) as n from invite where used_at is null and taken_back_at is null and expires_at > ?",
              now(),
            )?.n ?? 0;
          if (open >= MAX_OPEN)
            return "There are too many invites that still work. Take some back with `invite_take_back`.";
          const gets = {
            connect:
              "Whoever uses it becomes a contact: you can share agents and rooms with each other. Nothing is shared by connecting.",
            agent: `Whoever uses it talks to ${target.title} in a conversation of their own. ${heard(target.title, "them", input.memory)} ${target.title} stays in your home and has none of your tools there. They see nothing else of your home, and what they write is theirs: it is not shown to you.`,
            room: `Whoever uses it reads everything written in the room from then on, and what your agents in it say. Nothing else of your home is shared.`,
          }[input.what];
          const card = home.store.createCard(
            {
              kind: "approval",
              level: "needs_you",
              title:
                input.what === "connect"
                  ? "Make an invite to connect?"
                  : input.what === "room"
                    ? `Make an invite to the room “${target.title}”?`
                    : `Make an invite to ${target.title}?`,
              body: `${gets}\n\nThe link works once, for one ${input.lasts}. Anyone who has it can use it, so send it only to the person you mean.`,
              actions: [
                { id: "make", label: "Make the invite", style: "primary" },
                { id: "keep", label: "Don't", style: "plain" },
              ],
              payload: {
                type: "invite_make",
                what: input.what,
                id: input.id ?? null,
                lasts: input.lasts,
                memory: input.memory,
              },
            },
            where,
          );
          draft.add({ type: "card", card });
          return ENDS_TURN;
        },
      }),
      defineTool({
        name: "invite_list",
        description:
          "List the invites this home made: what each is for and whether it still works.",
        input: z.object({}),
        label: () => "Looking at the invites",
        run: async () => {
          const rows = home.db.all<InviteRow>("select * from invite order by created_at desc");
          const lines = rows.map((row) => {
            const state = row.used_at
              ? `used by ${row.used_by}`
              : row.taken_back_at
                ? "taken back"
                : row.expires_at < now()
                  ? "ran out"
                  : `works until ${day(row.expires_at)}`;
            const what = row.what === "connect" ? "to connect" : `to ${row.title} (${row.what})`;
            return `- ${row.id}: ${what}, ${state}`;
          });
          return lines.join("\n") || "No invites.";
        },
      }),
      defineTool({
        name: "invite_take_back",
        description: "Take back an invite that was not used yet. Its link stops working.",
        input: z.object({ id: z.string() }),
        label: () => "Taking an invite back",
        run: async (input) => {
          const row = home.db.get<InviteRow>("select * from invite where id = ?", input.id);
          if (!row) return `There is no invite ${input.id}.`;
          if (row.used_at)
            return `That invite was used by ${row.used_by}. It cannot be taken back.`;
          home.db.run("update invite set taken_back_at = ? where id = ?", now(), row.id);
          return "The invite is taken back. Its link opens nothing any more.";
        },
      }),
      defineTool({
        name: "invite_open",
        description:
          "Open an invite link someone sent the person (it has `/i/` in it). Shows a card with who invites and to what; the person decides. Ends your turn.",
        input: z.object({ link: z.string() }),
        label: () => "Reading an invite",
        run: async (input) => {
          const read = await this.read(input.link);
          if (typeof read === "string") return read;
          const card = home.store.createCard(read, where);
          draft.add({ type: "card", card });
          return ENDS_TURN;
        },
      }),
    ];
  }

  private registerCards(): void {
    const { home } = this;

    home.onCard("invite_make", ({ card, action, payload }) => {
      if (action !== "make") return;
      const what = What.parse(payload.what);
      const id = typeof payload.id === "string" ? payload.id : null;
      const lasts = Lasts.parse(payload.lasts);
      const target = this.target(what, id);
      if (!target || !home.handle()) return;
      const code = newId("inv").slice(4) + newId("inv").slice(4);
      const expiresAt = new Date(Date.now() + LASTS_MS[lasts]).toISOString();
      home.db.run(
        "insert into invite (id, code, what, target, title, expires_at, memory, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)",
        newId("inv"),
        code,
        what,
        // A room is named by its own id, whichever of its two ids the agent gave.
        what === "room" ? (this.peers.rooms.kept(id ?? "")?.id ?? id) : id,
        target.title,
        expiresAt,
        Hears.catch("none").parse(payload.memory),
        now(),
      );
      const link = this.link(code);
      const message = home.store.addMessage({
        conversationId: card.conversationId,
        role: "agent",
        agentId: card.agentId,
        channel: "home",
        parts: [],
      });
      const shown = home.store.createCard(
        {
          kind: "contact",
          level: "update",
          title:
            what === "connect"
              ? "Invite to connect"
              : what === "room"
                ? `Invite to the room “${target.title}”`
                : `Invite to ${target.title}`,
          body: `Send this link to the person you invite, or let them scan the code. They give it to their agent. It works once, until ${day(expiresAt)}.\n\n\`${link}\``,
          qr: link,
          actions: [],
        },
        { agentId: card.agentId, conversationId: card.conversationId, messageId: message.id },
      );
      home.store.updateMessage(message.id, { parts: [{ type: "card", card: shown }] });
      home.tell(
        card.conversationId,
        "The invite is in the chat, as a link and a QR code. Say so in one sentence, and that it works once.",
      );
    });

    home.onCard("invite_in", async ({ card, action, payload }) => {
      if (action !== "join") return;
      const invite = z
        .object({
          code: z.string(),
          handle: z.string(),
          name: z.string(),
          publicKey: z.string(),
          url: z.string(),
          what: What,
          title: z.string(),
        })
        .parse(payload);
      // The other home is a contact before it answers: what it sends right after is heard.
      const before = this.peers.contact(invite.handle);
      this.peers.connectByInvite(invite, invite.what === "connect");
      let accepted: z.infer<typeof Accepted>;
      try {
        const response = await this.peers.post(invite.handle, "/peers/invite/accept", {
          code: invite.code,
        });
        accepted = Accepted.parse(await response.json());
      } catch (error) {
        if (!before) home.db.run("delete from contact where handle = ?", invite.handle);
        throw error;
      }
      await this.peers.refreshContact(invite.handle).catch(() => undefined);
      if (accepted.what === "connect") {
        return home.tell(
          card.conversationId,
          `${invite.name} (${invite.handle}) is connected now. Say so in one sentence.`,
        );
      }
      if (accepted.what === "agent" && accepted.agent) {
        const created = home.store.createAgent({
          name: accepted.agent.name,
          kind: accepted.agent.kind,
          about: accepted.agent.about,
          origin: "shared",
          from: invite.handle,
          remote: `/a2a/agents/${accepted.agent.id}`,
        });
        return home.tell(
          card.conversationId,
          `${created.name} is in the list of agents now. Say so in one sentence.`,
        );
      }
      if (accepted.what === "room" && accepted.room) {
        const name = await this.peers.rooms.enter(
          invite.handle,
          accepted.room.id,
          accepted.room.joined,
        );
        home.tell(
          card.conversationId,
          `The room "${name}" is in the list now. Say so in one sentence.`,
        );
      }
    });
  }
}
