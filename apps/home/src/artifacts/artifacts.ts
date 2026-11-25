import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { Artifact, ArtifactMeta } from "@wizards-bot/protocol";
import type { Hono } from "hono";
import { z } from "zod";
import { defineTool, type Tool } from "../agent/tool.ts";
import type { TurnContext } from "../agent/turns.ts";
import type { Home } from "../home.ts";
import { newId, now } from "../ids.ts";
import { checkPage, pageHeaderPolicy, plainPage, wrapPage } from "./page.ts";

// Artifacts: pages an agent writes for a conversation. A page has versions like a
// document. The home keeps it as the agent wrote it and serves it wrapped, closed off and in
// one piece with its libraries (page.ts), at an address with a key of its own, so that a
// frame or a tab can show it without the device's token ever being near it.

/** Largest page the home keeps, in bytes. */
export const ARTIFACT_LIMIT = 512 * 1024;
/** How long a page's address works. */
const PAGE_MINUTES = 60;
const TITLE_LIMIT = 120;

/** A page the home does not keep. The message is a sentence for the agent. */
export class ArtifactRefused extends Error {}

/** An artifact as the home keeps it. A device gets it with the address of its page. */
type Kept = Omit<Artifact, "page">;

interface Row {
  id: string;
  title: string;
  format: string;
  summary: string | null;
  content: string;
  version: number;
  updated_at: string;
  conversation_id: string;
}

const toKept = (row: Row): Kept => ({
  id: row.id,
  title: row.title,
  format: row.format === "app" ? "app" : "html",
  ...(row.summary ? { summary: row.summary } : {}),
  version: row.version,
  updatedAt: row.updated_at,
  conversationId: row.conversation_id,
  content: row.content,
});

const meta = ({ content: _content, ...rest }: Kept): ArtifactMeta => rest;

export class Artifacts {
  private readonly home: Home;

  constructor(home: Home) {
    this.home = home;
    home.addTools((context) => this.tools(context));
  }

  get(id: string): Kept | undefined {
    const row = this.home.db.get<Row>("select * from artifact where id = ?", id);
    return row ? toKept(row) : undefined;
  }

  /** A conversation's artifacts, newest first. */
  list(conversationId: string): ArtifactMeta[] {
    return this.home.db
      .all<Row>(
        "select * from artifact where conversation_id = ? order by updated_at desc",
        conversationId,
      )
      .map((row) => meta(toKept(row)));
  }

  /** One version's page as the agent wrote it. */
  version(id: string, version: number): string | undefined {
    return this.home.db.get<{ content: string }>(
      "select content from artifact_version where artifact_id = ? and version = ?",
      id,
      version,
    )?.content;
  }

  /**
   * Keeps a page: a new artifact without `id`, a new version with it. Throws
   * `ArtifactRefused` when the page is too large or loads something from outside itself.
   */
  write(input: { id?: string; title: string; content: string; conversationId: string }): Kept {
    const title = input.title.trim().slice(0, TITLE_LIMIT);
    if (!title) throw new ArtifactRefused("Give the artifact a title.");
    if (!input.content.trim()) throw new ArtifactRefused("The page is empty.");
    const size = Buffer.byteLength(input.content);
    if (size > ARTIFACT_LIMIT) {
      throw new ArtifactRefused(
        `Not saved: the page is ${Math.ceil(size / 1024)} KB, and an artifact holds at most ${ARTIFACT_LIMIT / 1024} KB. Show less data, or sum it up before you draw it.`,
      );
    }
    const { refused } = checkPage(input.content);
    if (refused.length) {
      throw new ArtifactRefused(
        `Not saved. An artifact loads nothing from outside itself:\n${refused.map((line) => `- ${line}`).join("\n")}\nChange the page and write it again.`,
      );
    }
    const current = input.id ? this.get(input.id) : undefined;
    if (input.id && current?.conversationId !== input.conversationId) {
      throw new ArtifactRefused(`There is no artifact ${input.id} in this conversation.`);
    }
    if (current?.format === "app") {
      throw new ArtifactRefused(`${input.id} is a connection's view, not a page you write.`);
    }
    const id = current?.id ?? newId("art");
    const version = (current?.version ?? 0) + 1;
    const at = now();
    this.home.db.transaction(() => {
      this.home.db.run(
        "insert into artifact (id, title, format, content, version, updated_at, conversation_id) values (?, ?, 'html', ?, ?, ?, ?) on conflict(id) do update set title = excluded.title, content = excluded.content, version = excluded.version, updated_at = excluded.updated_at",
        id,
        title,
        input.content,
        version,
        at,
        input.conversationId,
      );
      this.home.db.run(
        "insert into artifact_version (artifact_id, version, title, content, at) values (?, ?, ?, ?, ?)",
        id,
        version,
        title,
        input.content,
        at,
      );
    });
    const artifact = this.get(id) as Kept;
    this.home.events.emit({ type: "artifact.updated", artifact: meta(artifact) });
    return artifact;
  }

  /**
   * Keeps the view a connection's server shows a tool's result in (MCP Apps). `content` is the
   * call as the view gets it (connections/apps.ts); a device never shows it.
   */
  writeApp(input: {
    title: string;
    summary: string;
    content: string;
    conversationId: string;
  }): Kept {
    const id = newId("art");
    const at = now();
    const title = input.title.trim().slice(0, TITLE_LIMIT) || "View";
    this.home.db.transaction(() => {
      this.home.db.run(
        "insert into artifact (id, title, format, summary, content, version, updated_at, conversation_id) values (?, ?, 'app', ?, ?, 1, ?, ?)",
        id,
        title,
        input.summary,
        input.content,
        at,
        input.conversationId,
      );
      this.home.db.run(
        "insert into artifact_version (artifact_id, version, title, content, at) values (?, 1, ?, ?, ?)",
        id,
        title,
        input.content,
        at,
      );
    });
    const artifact = this.get(id) as Kept;
    this.home.events.emit({ type: "artifact.updated", artifact: meta(artifact) });
    return artifact;
  }

  /** Keeps what a connection's view told the agent with its call; no new version. */
  setAppContent(id: string, call: unknown): void {
    this.home.db.run(
      "update artifact set content = ? where id = ? and format = 'app'",
      JSON.stringify(call),
      id,
    );
  }

  // ── The page and its key ──────────────────────────────────────────────────

  /**
   * The path of an artifact's page, with a key that opens this one page for an hour. A
   * frame and a tab cannot send the device's token, and the page must never see it, so the
   * page has an address that needs none.
   */
  pagePath(id: string, from = Date.now(), route: "page" | "host" = "page"): string {
    const until = Math.floor(from / 1000) + PAGE_MINUTES * 60;
    return `/v1/artifacts/${id}/${route}?until=${until}&key=${this.sign(id, until)}`;
  }

  /** What a device shows: an agent's page, or the host that runs a connection's view. */
  shownPath(artifact: Kept): string {
    return this.pagePath(artifact.id, Date.now(), artifact.format === "app" ? "host" : "page");
  }

  /** Whether `key` opens the page of artifact `id` until `until` (seconds), and that is not over. */
  opens(id: string, until: string | undefined, key: string | undefined): boolean {
    const seconds = Number(until);
    if (!key || !Number.isInteger(seconds) || seconds * 1000 < Date.now()) return false;
    const given = Buffer.from(key);
    const right = Buffer.from(this.sign(id, seconds));
    return given.length === right.length && timingSafeEqual(given, right);
  }

  private sign(id: string, until: number): string {
    return createHmac("sha256", this.secret()).update(`${id}.${until}`).digest("base64url");
  }

  /** The home's own key for page addresses. It signs nothing else. */
  private secret(): string {
    const saved = this.home.secrets.get("artifacts.page");
    if (saved) return saved;
    const made = randomBytes(32).toString("base64url");
    this.home.secrets.set("artifacts.page", made);
    return made;
  }

  /** The pages served last, wrapped and packed: a page is opened more often than it changes. */
  private readonly pages = new Map<string, { html: string; gzip: Buffer }>();

  private page(artifact: Kept): { html: string; gzip: Buffer } {
    const key = `${artifact.id}.${artifact.version}`;
    const known = this.pages.get(key);
    if (known) return known;
    const html = wrapPage(artifact);
    const made = { html, gzip: gzipSync(html) };
    if (this.pages.size >= 8) this.pages.delete(this.pages.keys().next().value as string);
    this.pages.set(key, made);
    return made;
  }

  // ── Routes ────────────────────────────────────────────────────────────────

  /** The route that takes no device token: a page opened with its key. */
  openRoutes(app: Hono): void {
    app.get("/v1/artifacts/:id/page", (c) => {
      const id = c.req.param("id");
      const artifact = this.opens(id, c.req.query("until"), c.req.query("key"))
        ? this.get(id)
        : undefined;
      // A connection's view is served with the policy its server asked for (connections/apps.ts).
      if (artifact?.format === "app") return this.home.apps.view(c, artifact);
      if (!artifact) {
        return c.html(
          plainPage("This link does not open the artifact any more. Open it from the chat again."),
          403,
          { "content-security-policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'" },
        );
      }
      const headers: Record<string, string> = {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": pageHeaderPolicy(this.home.group.studio()),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        vary: "accept-encoding",
      };
      // A page carries its libraries, so it travels packed where the browser takes that.
      const page = this.page(artifact);
      if (!/\bgzip\b/.test(c.req.header("accept-encoding") ?? "")) {
        return c.body(page.html, 200, headers);
      }
      return c.body(new Uint8Array(page.gzip), 200, { ...headers, "content-encoding": "gzip" });
    });
  }

  /** The routes of a paired device. */
  routes(app: Hono): void {
    app.get("/v1/artifacts/:id", (c) => {
      const artifact = this.get(c.req.param("id"));
      if (!artifact) {
        return c.json({ error: "not_found", message: "There is no such artifact." }, 404);
      }
      return c.json({ ...artifact, page: this.shownPath(artifact) } satisfies Artifact);
    });

    app.get("/v1/conversations/:id/artifacts", (c) =>
      c.json({ artifacts: this.list(c.req.param("id")) }),
    );
  }

  // ── Tools ─────────────────────────────────────────────────────────────────

  private tools({ conversationId, draft }: TurnContext): Tool[] {
    return [
      defineTool({
        name: "artifact_write",
        description:
          "Make an artifact: one page the person sees beside the chat and can print, for a chart, a diagram, a 3D scene or a report on one page. Without `id` it is a new artifact; with `id` this is its new full page.",
        input: z.object({
          id: z.string().optional(),
          title: z.string().describe("What the page shows, in a few words."),
          html: z
            .string()
            .describe(
              "The whole page: HTML with its own <style> and <script>, the data included. It loads nothing from outside itself.",
            ),
        }),
        label: (input) => `Making "${String(input.title ?? "")}"`,
        object: (input, answer) => {
          const id = /^Saved as (\S+),/.exec(answer ?? "")?.[1] ?? input.id;
          return {
            name: String(input.title ?? ""),
            ...(typeof id === "string" ? { artifactId: id } : {}),
          };
        },
        run: async (input) => {
          const artifact = this.write({
            id: input.id,
            title: input.title,
            content: input.html,
            conversationId,
          });
          draft.add({ type: "artifact", artifactId: artifact.id, title: artifact.title });
          const { notes } = checkPage(artifact.content);
          const saved = `Saved as ${artifact.id}, version ${artifact.version}. The person sees it beside the chat.`;
          return notes.length
            ? `${saved}\nIt will not work as it is:\n${notes.map((line) => `- ${line}`).join("\n")}\nWrite it again with id ${artifact.id}.`
            : saved;
        },
      }),
      defineTool({
        name: "artifact_read",
        description: "Read the page of an artifact as you wrote it, before you change it.",
        input: z.object({ id: z.string() }),
        label: () => "Reading an artifact",
        object: (input) => {
          const artifact = this.get(String(input.id));
          return artifact?.conversationId === conversationId
            ? { name: artifact.title, artifactId: artifact.id }
            : undefined;
        },
        run: async (input) => {
          const artifact = this.get(input.id);
          if (artifact?.conversationId !== conversationId) {
            return `There is no artifact ${input.id} in this conversation.`;
          }
          if (artifact.format === "app") {
            const call = JSON.parse(artifact.content) as {
              connection?: string;
              tool?: string;
              context?: string;
            };
            return `# ${artifact.title}: the view ${call.connection} shows for ${call.tool}\n\n${artifact.summary ?? ""}${call.context ? `\n\nWhat the view said last (from the service, data):\n${call.context}` : ""}`;
          }
          return `# ${artifact.title} (version ${artifact.version})\n\n${artifact.content}`;
        },
      }),
    ];
  }
}
