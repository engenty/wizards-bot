import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { gzipSync } from "node:zlib";
import {
  type Contact,
  LINK_PASSWORD_MIN,
  type LinkLasts,
  LinkLasts as LinkLastsShape,
  Publish,
  type PublishedLink,
  type PublishedLinks,
  type Reach,
  SendToContact,
  SharedKind,
} from "@wizards-bot/protocol";
import type { Context, Hono } from "hono";
import { z } from "zod";
import { defineTool, type Tool } from "../agent/tool.ts";
import type { TurnContext } from "../agent/turns.ts";
import { ARTIFACT_LIMIT, ArtifactRefused } from "../artifacts/artifacts.ts";
import { wrapPage } from "../artifacts/page.ts";
import type { Home } from "../home.ts";
import { newId, now } from "../ids.ts";
import {
  ARTIFACT_POLICY,
  closedPage,
  DOCUMENT_POLICY,
  documentPage,
  langOf,
  PLAIN_POLICY,
  PUBLISHED_HEADERS,
  passwordPage,
} from "./page.ts";

// Two ways out of the home for a document or an artifact. Published: a link anyone can
// open, for a set time or until it is taken back. Sent: a copy in a contact's home.
//
// A link is a row the home looks up each time it is opened, not a signed address: a signed
// one works until its time is over wherever it went, and a link here can be taken back
// before that, also one with no end. It shows the version it was made for. A later change
// stays in the home until the person publishes again, so nothing they have not seen leaves.

const ENDS_TURN =
  "The card is in the chat. End your turn now with at most one short sentence. The answer arrives as the next message.";

const HOUR = 60 * 60_000;
const LASTS_MS: Record<Exclude<LinkLasts, "always">, number> = {
  hour: HOUR,
  day: 24 * HOUR,
  week: 7 * 24 * HOUR,
  month: 30 * 24 * HOUR,
};
/** How long a link that no longer works still answers "gone" before its row is dropped. */
const KEPT_AFTER_MS = 30 * 24 * HOUR;

/** Wrong passwords one link takes in `GUESS_WINDOW_MS` before it stops listening. */
const GUESSES = 5;
const GUESS_WINDOW_MS = 10 * 60_000;
/** Largest form a password page sends back, in bytes. */
const FORM_LIMIT = 2048;

/** Copies one contact may send in an hour. */
const RECEIVED_PER_HOUR = 20;
const TITLE_LIMIT = 120;

/** Something the home does not publish, send or take. The message is a sentence for a person. */
export class ShareRefused extends Error {
  readonly code: "not_found" | "invalid" | "not_contact" | "too_many";

  constructor(code: ShareRefused["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** What a contact's home sends: a copy of a document or an artifact. */
const Sent = z.object({
  kind: SharedKind,
  title: z.string().trim().min(1).max(TITLE_LIMIT),
  content: z.string().min(1).max(ARTIFACT_LIMIT),
});

interface LinkRow {
  id: string;
  token: string;
  kind: string;
  source_id: string;
  version: number;
  title: string;
  password: string | null;
  expires_at: string | null;
  created_at: string;
  taken_back_at: string | null;
}

/** One version of a document or an artifact, as it leaves the home. */
interface Source {
  kind: SharedKind;
  id: string;
  version: number;
  title: string;
  content: string;
  conversationId: string;
}

/**
 * Who reaches an address: everyone, the devices of one private network, or this computer
 * alone. A name without a dot and the private ranges of IPv4 and IPv6 are a private network.
 */
export function reachOf(address: string): Reach {
  const host = new URL(address).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\./.test(host))
    return "computer";
  const privateV4 =
    /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;
  const privateV6 = host.includes(":") && /^(f[cd]|fe[89ab])/.test(host);
  const privateName = !host.includes(".") || /\.(local|lan|internal|home\.arpa)$/.test(host);
  return privateV4.test(host) || privateV6 || (!host.includes(":") && privateName)
    ? "network"
    : "internet";
}

/** What to say where a link is made on a home the internet does not reach. Empty: it does. */
const reachNote = (reach: Reach): string =>
  reach === "computer"
    ? "Your home has no address others can reach. The link opens on this computer only."
    : reach === "network"
      ? "Your home is on a private network. The link opens only on devices in the same network."
      : "";

const lastsText = (lasts: LinkLasts): string =>
  lasts === "always" ? "until you take it back" : `for ${lasts === "hour" ? "an" : "a"} ${lasts}`;

const untilText = (link: PublishedLink): string =>
  link.expiresAt ? `until ${link.expiresAt}` : "until it is taken back";

function hashPassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, 32, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export class Sharing {
  private readonly home: Home;
  /** When each link last heard a wrong password. */
  private readonly guesses = new Map<string, number[]>();
  /** When each contact last sent a copy. */
  private readonly received = new Map<string, number[]>();
  /** The last few artifact pages that were opened, by link: a link's page never changes. */
  private readonly pages = new Map<string, { html: string; gzip: Buffer }>();

  constructor(home: Home) {
    this.home = home;
    home.addTools((context) => this.tools(context));
    this.registerCards();
  }

  /** Who reaches the address the home makes its links at. */
  reach(): Reach {
    return reachOf(this.home.address());
  }

  /** A document or an artifact at one version, the newest without `version`. */
  private source(kind: SharedKind, id: string, version?: number): Source | undefined {
    const { home } = this;
    if (kind === "document") {
      const document = home.store.document(id);
      if (!document) return undefined;
      const content =
        version === undefined || version === document.version
          ? document.content
          : home.db.get<{ content: string }>(
              "select content from document_version where document_id = ? and version = ?",
              id,
              version,
            )?.content;
      if (content === undefined) return undefined;
      return {
        kind,
        id,
        version: version ?? document.version,
        title: document.title,
        content,
        conversationId: document.conversationId,
      };
    }
    const artifact = home.artifacts.get(id);
    if (!artifact) return undefined;
    const content =
      version === undefined || version === artifact.version
        ? artifact.content
        : home.artifacts.version(id, version);
    if (content === undefined) return undefined;
    return {
      kind,
      id,
      version: version ?? artifact.version,
      title: artifact.title,
      content,
      conversationId: artifact.conversationId,
    };
  }

  // ── Published links ───────────────────────────────────────────────────────

  private toLink(row: LinkRow): PublishedLink {
    return {
      id: row.id,
      kind: row.kind as SharedKind,
      sourceId: row.source_id,
      version: row.version,
      title: row.title,
      url: `${this.home.address()}/p/${row.token}`,
      ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
      password: row.password !== null,
      createdAt: row.created_at,
    };
  }

  /**
   * Makes a link to a document or an artifact as it is now, or at `version`. Throws
   * `ShareRefused` when there is no such thing or the password is too short.
   */
  async publish(input: {
    kind: SharedKind;
    id: string;
    lasts: LinkLasts;
    password?: string;
    version?: number;
  }): Promise<PublishedLink> {
    const source = this.source(input.kind, input.id, input.version);
    if (!source) throw new ShareRefused("not_found", `There is no such ${input.kind}.`);
    if (input.password !== undefined && input.password.length < LINK_PASSWORD_MIN) {
      throw new ShareRefused("invalid", `A password has at least ${LINK_PASSWORD_MIN} characters.`);
    }
    let password: string | null = null;
    if (input.password !== undefined) {
      const salt = randomBytes(16);
      const key = await hashPassword(input.password, salt);
      password = `scrypt$${salt.toString("base64url")}$${key.toString("base64url")}`;
    }
    const id = newId("lnk");
    const at = Date.now();
    this.home.db.run(
      "insert into link (id, token, kind, source_id, version, title, password, expires_at, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id,
      randomBytes(18).toString("base64url"),
      source.kind,
      source.id,
      source.version,
      source.title,
      password,
      input.lasts === "always" ? null : new Date(at + LASTS_MS[input.lasts]).toISOString(),
      new Date(at).toISOString(),
    );
    // A link that stopped working long ago answers "nothing" from now on.
    const longAgo = new Date(at - KEPT_AFTER_MS).toISOString();
    this.home.db.run(
      "delete from link where taken_back_at < ? or expires_at < ?",
      longAgo,
      longAgo,
    );
    return this.toLink(this.row(id) as LinkRow);
  }

  private row(id: string): LinkRow | undefined {
    return this.home.db.get<LinkRow>("select * from link where id = ?", id);
  }

  private working(where: string, ...params: string[]): PublishedLink[] {
    return this.home.db
      .all<LinkRow>(
        `select * from link where ${where} and taken_back_at is null and (expires_at is null or expires_at > ?) order by created_at desc, rowid desc`,
        ...params,
        now(),
      )
      .map((row) => this.toLink(row));
  }

  /** The links to one document or artifact that still work, newest first. */
  links(kind: SharedKind, id: string): PublishedLink[] {
    return this.working("kind = ? and source_id = ?", kind, id);
  }

  /** One link, while it works. */
  link(id: string): PublishedLink | undefined {
    return this.working("id = ?", id)[0];
  }

  /** Takes a link back: from now on it opens nothing. False when there is no such link. */
  takeBack(id: string): boolean {
    if (!this.row(id)) return false;
    this.home.db.run(
      "update link set taken_back_at = ? where id = ? and taken_back_at is null",
      now(),
      id,
    );
    this.guesses.delete(id);
    this.pages.delete(id);
    return true;
  }

  // ── Sending to a contact ──────────────────────────────────────────────────

  /** The contacts a copy can go to. */
  contacts(): Contact[] {
    return this.home.peers
      .contacts()
      .filter((contact) => contact.state === "connected" && !contact.limited)
      .map(({ handle, name }) => ({ handle, name }));
  }

  /**
   * Sends a copy of a document or an artifact to a connected contact's home. Throws when the
   * handle is no connected contact, when there is no such thing or when that home refuses.
   */
  async send(input: {
    kind: SharedKind;
    id: string;
    handle: string;
    version?: number;
  }): Promise<Contact> {
    const contact = this.home.peers.contact(input.handle.trim());
    if (contact?.state !== "connected" || contact.limited) {
      throw new ShareRefused("not_contact", `${input.handle} is not a connected contact.`);
    }
    const source = this.source(input.kind, input.id, input.version);
    if (!source) throw new ShareRefused("not_found", `There is no such ${input.kind}.`);
    if (source.content.length > ARTIFACT_LIMIT) {
      throw new ShareRefused(
        "invalid",
        `This ${source.kind} is too large to send: a copy holds at most ${ARTIFACT_LIMIT / 1024} KB.`,
      );
    }
    await this.home.peers.post(contact.handle, "/peers/send", {
      kind: source.kind,
      title: source.title.slice(0, TITLE_LIMIT),
      content: source.content,
    });
    return { handle: contact.handle, name: contact.name };
  }

  /**
   * Takes a copy a connected contact sent. It is kept in the main agent's conversation, and
   * the person reads there who it is from. The agent reads the same line in its next turn;
   * no turn starts for it.
   */
  async receive(contact: { handle: string; name: string }, raw: unknown): Promise<void> {
    const { home } = this;
    const sent = Sent.safeParse(raw);
    if (!sent.success) throw new ShareRefused("invalid", "This is no document and no artifact.");
    const hourAgo = Date.now() - HOUR;
    const times = (this.received.get(contact.handle) ?? []).filter((time) => time > hourAgo);
    if (times.length >= RECEIVED_PER_HOUR) {
      throw new ShareRefused("too_many", "This home took enough for now. Try again in an hour.");
    }
    this.received.set(contact.handle, [...times, Date.now()]);

    const main = home.store.mainAgent();
    const { kind, title, content } = sent.data;
    let part:
      | { type: "document"; documentId: string; title: string }
      | { type: "artifact"; artifactId: string; title: string };
    if (kind === "document") {
      const document = home.store.createDocument({
        title,
        content,
        conversationId: main.conversationId,
      });
      part = { type: "document", documentId: document.id, title: document.title };
    } else {
      try {
        const artifact = home.artifacts.write({
          title,
          content,
          conversationId: main.conversationId,
        });
        part = { type: "artifact", artifactId: artifact.id, title: artifact.title };
      } catch (error) {
        if (error instanceof ArtifactRefused) {
          throw new ShareRefused("invalid", "This home does not keep that page.");
        }
        throw error;
      }
    }
    const message = home.store.addMessage({
      conversationId: main.conversationId,
      role: "agent",
      agentId: main.id,
      channel: "home",
      parts: [
        { type: "text", text: `${contact.name} (${contact.handle}) sent you this ${kind}.` },
        part,
      ],
    });
    const id = part.type === "document" ? part.documentId : part.artifactId;
    void home.notifier.replied(message, {
      conversationId: main.conversationId,
      text: "",
      channel: "home",
    });
    await home.mastra
      .append({
        conversationId: main.conversationId,
        agentId: main.id,
        role: "assistant",
        text: `[home] ${contact.name} (${contact.handle}) sent ${home.person()} the ${kind} “${title}” (${id}). It is in this conversation.`,
        id: message.id,
        createdAt: new Date(message.createdAt),
      })
      .catch((error) => console.error("[sharing]", error));
  }

  // ── Routes ────────────────────────────────────────────────────────────────

  /** The route that takes no device token: a published link, opened by anyone who has it. */
  openRoutes(app: Hono): void {
    const page = (c: Context, html: string, status: 200 | 401 | 404 | 410 | 429, policy: string) =>
      c.body(html, status, { ...PUBLISHED_HEADERS, "content-security-policy": policy });

    /** The link's row while it works, or the page that says why it opens nothing. */
    const find = (c: Context): LinkRow | Response => {
      const lang = langOf(c.req.header("accept-language"));
      const row = this.home.db.get<LinkRow>(
        "select * from link where token = ?",
        c.req.param("token") ?? "",
      );
      if (!row) return page(c, closedPage("nothing", lang), 404, PLAIN_POLICY);
      if (row.taken_back_at || (row.expires_at && row.expires_at <= now())) {
        return page(c, closedPage("gone", lang), 410, PLAIN_POLICY);
      }
      return row;
    };

    const show = (c: Context, row: LinkRow): Response => {
      const lang = langOf(c.req.header("accept-language"));
      const source = this.source(row.kind as SharedKind, row.source_id, row.version);
      // The document or the artifact is gone from the home: so is what the link showed.
      if (!source) return page(c, closedPage("gone", lang), 410, PLAIN_POLICY);
      if (source.kind === "document") {
        return page(
          c,
          documentPage({ title: row.title, content: source.content, lang }),
          200,
          DOCUMENT_POLICY,
        );
      }
      // An artifact's page carries its libraries, so it travels packed where the browser takes that.
      let made = this.pages.get(row.id);
      if (!made) {
        const html = wrapPage({ title: row.title, content: source.content });
        made = { html, gzip: gzipSync(html) };
        if (this.pages.size >= 8) this.pages.delete(this.pages.keys().next().value as string);
        this.pages.set(row.id, made);
      }
      const headers = {
        ...PUBLISHED_HEADERS,
        "content-security-policy": ARTIFACT_POLICY,
        vary: "accept-encoding",
      };
      return /\bgzip\b/.test(c.req.header("accept-encoding") ?? "")
        ? c.body(new Uint8Array(made.gzip), 200, { ...headers, "content-encoding": "gzip" })
        : c.body(made.html, 200, headers);
    };

    app.get("/p/:token", (c) => {
      const row = find(c);
      if (row instanceof Response) return row;
      if (row.password) {
        return page(c, passwordPage(langOf(c.req.header("accept-language"))), 401, PLAIN_POLICY);
      }
      return show(c, row);
    });

    // The password comes in the form's body and is answered with the page itself: no cookie
    // and no key in the address, so nothing a browser keeps opens the link later.
    app.post("/p/:token", async (c) => {
      const row = find(c);
      if (row instanceof Response) return row;
      if (!row.password) return show(c, row);
      const lang = langOf(c.req.header("accept-language"));
      const since = Date.now() - GUESS_WINDOW_MS;
      const wrong = (this.guesses.get(row.id) ?? []).filter((time) => time > since);
      if (wrong.length >= GUESSES) return page(c, passwordPage(lang, "slow"), 429, PLAIN_POLICY);
      const tooLarge = Number(c.req.header("content-length") ?? 0) > FORM_LIMIT;
      const form = tooLarge ? undefined : await c.req.parseBody().catch(() => undefined);
      const given = typeof form?.password === "string" ? form.password : "";
      if (given && (await this.passwordFits(row.password, given))) return show(c, row);
      this.guesses.set(row.id, [...wrong, Date.now()]);
      return page(c, passwordPage(lang, "wrong"), 401, PLAIN_POLICY);
    });
  }

  private async passwordFits(stored: string, given: string): Promise<boolean> {
    const [, salt, key] = stored.split("$");
    if (!salt || !key || given.length > 200) return false;
    const right = Buffer.from(key, "base64url");
    const made = await hashPassword(given, Buffer.from(salt, "base64url"));
    return made.length === right.length && timingSafeEqual(made, right);
  }

  /** The routes of a paired device. What the person does here themselves needs no card. */
  routes(app: Hono): void {
    const refused = (c: Context, error: unknown) => {
      if (error instanceof ShareRefused) {
        const status = error.code === "not_found" ? 404 : error.code === "too_many" ? 429 : 400;
        return c.json({ error: error.code, message: error.message }, status);
      }
      // What is left is the contact's home: out of reach, or it refused.
      return c.json({ error: "not_sent", message: (error as Error).message }, 502);
    };

    app.get("/v1/contacts", (c) => c.json({ contacts: this.contacts() }));

    // A document as the page a link shows: to keep as an HTML file or to print as a PDF.
    app.get("/v1/documents/:id/page", (c) => {
      const source = this.source("document", c.req.param("id"));
      if (!source) {
        return c.json({ error: "not_found", message: "There is no document with this id." }, 404);
      }
      const lang = langOf(c.req.header("accept-language"));
      return c.body(documentPage({ title: source.title, content: source.content, lang }), 200, {
        ...PUBLISHED_HEADERS,
        "content-security-policy": DOCUMENT_POLICY,
      });
    });

    app.get("/v1/links", (c) => {
      const kind = SharedKind.safeParse(c.req.query("kind"));
      const id = c.req.query("id") ?? "";
      if (!kind.success || !this.source(kind.data, id)) {
        return c.json({ error: "not_found", message: "There is nothing with this id." }, 404);
      }
      return c.json({
        links: this.links(kind.data, id),
        reach: this.reach(),
      } satisfies PublishedLinks);
    });

    app.post("/v1/links", async (c) => {
      const body = Publish.parse(await c.req.json());
      try {
        return c.json(await this.publish(body));
      } catch (error) {
        if (error instanceof ShareRefused) return refused(c, error);
        throw error;
      }
    });

    app.delete("/v1/links/:id", (c) =>
      this.takeBack(c.req.param("id"))
        ? c.body(null, 204)
        : c.json({ error: "not_found", message: "There is no such link." }, 404),
    );

    app.post("/v1/send", async (c) => {
      const body = SendToContact.parse(await c.req.json());
      try {
        return c.json({ contact: await this.send(body) });
      } catch (error) {
        return refused(c, error);
      }
    });
  }

  // ── What the agent can do ─────────────────────────────────────────────────

  private tools(context: TurnContext): Tool[] {
    const { home, agent, conversationId, draft } = context;
    const where = { agentId: agent.id, conversationId, messageId: draft.id };
    /** A document or an artifact of this conversation: an agent shares nothing of another's. */
    const own = (kind: SharedKind, id: string): Source | undefined => {
      const source = this.source(kind, id);
      return source?.conversationId === conversationId ? source : undefined;
    };
    const what = { kind: SharedKind, id: z.string().describe("The document's or artifact's id.") };

    return [
      defineTool({
        name: "link_publish",
        description:
          "Publish a document or an artifact of this conversation: a link anyone can open without signing in. It works for an hour, a day, a week, a month, or until it is taken back (`always`). The link shows the version of now; a later change needs a new link. Asks the person first with a card, where they can also set a password. Ends your turn.",
        input: z.object({ ...what, lasts: LinkLastsShape }),
        label: () => "Asking to publish",
        run: async (input) => {
          const source = own(input.kind, input.id);
          if (!source) return `There is no ${input.kind} ${input.id} in this conversation.`;
          const note = reachNote(this.reach());
          const card = home.store.createCard(
            {
              kind: "question",
              level: "needs_you",
              title: `Publish “${source.title}”?`,
              body: [
                `Anyone who has the link can open this ${source.kind}, ${lastsText(input.lasts)}. It shows the ${source.kind} as it is now.`,
                note,
              ]
                .filter(Boolean)
                .join("\n\n"),
              fields: [{ id: "password", label: "Password (optional)", type: "secret" }],
              actions: [
                { id: "publish", label: "Publish", style: "primary" },
                { id: "keep", label: "Don't publish", style: "plain" },
              ],
              payload: {
                type: "link_publish",
                kind: source.kind,
                id: source.id,
                version: source.version,
                lasts: input.lasts,
              },
            },
            where,
          );
          draft.add({ type: "card", card });
          return ENDS_TURN;
        },
      }),
      defineTool({
        name: "link_list",
        description:
          "List the published links of this conversation's documents and artifacts that still work.",
        input: z.object({}),
        label: () => "Looking at the published links",
        run: async () => {
          const links = [
            ...home.store
              .documents(conversationId)
              .flatMap((document) => this.links("document", document.id)),
            ...home.artifacts
              .list(conversationId)
              .flatMap((artifact) => this.links("artifact", artifact.id)),
          ];
          if (!links.length) return "Nothing of this conversation is published.";
          const note = reachNote(this.reach());
          return [
            ...links.map(
              (link) =>
                `- ${link.id}: “${link.title}” (${link.kind} ${link.sourceId}, version ${link.version}) ${link.url}, ${untilText(link)}${link.password ? ", with a password" : ""}`,
            ),
            note,
          ]
            .filter(Boolean)
            .join("\n");
        },
      }),
      defineTool({
        name: "link_take_back",
        description:
          "Take a published link back, by its id from `link_list`. From then on it opens nothing.",
        input: z.object({ linkId: z.string() }),
        label: () => "Taking a link back",
        run: async (input) => {
          const link = this.link(input.linkId);
          if (!link || !own(link.kind, link.sourceId)) {
            return `There is no working link ${input.linkId} in this conversation.`;
          }
          this.takeBack(link.id);
          return `The link to “${link.title}” is taken back. It opens nothing any more.`;
        },
      }),
      defineTool({
        name: "contact_send",
        description:
          "Send a copy of a document or an artifact of this conversation to a connected contact, by their handle `name@host`. It arrives in their home, in the chat of their main agent. Asks the person first. Ends your turn.",
        input: z.object({ ...what, handle: z.string() }),
        label: (input) => `Asking to send to ${String(input.handle ?? "a contact")}`,
        run: async (input) => {
          const source = own(input.kind, input.id);
          if (!source) return `There is no ${input.kind} ${input.id} in this conversation.`;
          const contact = home.peers.contact(input.handle.trim());
          if (contact?.state !== "connected" || contact.limited) {
            const known = this.contacts()
              .map((other) => `${other.name} (${other.handle})`)
              .join(", ");
            return `${input.handle} is not a connected contact. Connected: ${known || "nobody yet"}.`;
          }
          const card = home.store.createCard(
            {
              kind: "approval",
              level: "needs_you",
              title: `Send “${source.title}” to ${contact.name}?`,
              body: `${contact.name} (${contact.handle}) gets a copy in their home. What you change here later does not reach it.`,
              actions: [
                { id: "send", label: "Send", style: "primary" },
                { id: "keep", label: "Don't send", style: "plain" },
              ],
              payload: {
                type: "contact_send",
                kind: source.kind,
                id: source.id,
                version: source.version,
                handle: contact.handle,
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

  private registerCards(): void {
    const { home } = this;
    const Asked = z.object({ kind: SharedKind, id: z.string(), version: z.number() });

    home.onCard("link_publish", async ({ card, action, values, payload }) => {
      if (action !== "publish") return;
      const asked = Asked.extend({ lasts: LinkLastsShape }).parse(payload);
      // The password goes from the card into its hash. No model reads it.
      const password = typeof values.password === "string" ? values.password : "";
      const link = await this.publish({ ...asked, password: password || undefined });
      const note = reachNote(this.reach());
      home.tell(
        card.conversationId,
        `“${link.title}” is published${link.password ? " with the password the person set" : ""}, ${untilText(link)}: ${link.url}${note ? `\n${note}` : ""}\nGive the person the link${note ? " and say where it opens" : ""}, in one or two sentences.`,
      );
    });

    home.onCard("contact_send", async ({ card, action, payload }) => {
      if (action !== "send") return;
      const asked = Asked.extend({ handle: z.string() }).parse(payload);
      const contact = await this.send(asked);
      home.tell(
        card.conversationId,
        `The ${asked.kind} was sent to ${contact.name} (${contact.handle}). Say so in one sentence.`,
      );
    });
  }
}
