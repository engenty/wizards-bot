import type { Hono } from "hono";
import { z } from "zod";
import type { Home } from "../home.ts";
import { now } from "../ids.ts";
import type { Peers } from "./peers.ts";
import { signRequest } from "./signature.ts";

// A home on a laptop has no address others reach: it calls out, and nobody calls it. What a
// contact's home has to tell it is therefore kept there, and the home without an address
// asks for it: one request that waits until something is there. What it gets is signed anew
// at that moment and heard here exactly as a request that arrived by itself.

/** How long a home holds a request that asks for what is kept, in seconds. */
const LONGEST_WAIT = 25;
/** What a home hands over at once. */
const AT_ONCE = 50;
/** What a home keeps for one contact, and for how long. */
const KEPT_AT_MOST = 1000;
const KEPT_FOR_MS = 7 * 86_400_000;
/** How long a home without an address waits before it asks a home again that did not answer: at first, and at most. */
const FIRST_PAUSE_MS = 250;
const TRY_AGAIN_MS = 10_000;

const Asked = z.object({
  /** The last request this home got: everything up to it is taken. */
  after: z.number().int().min(0).default(0),
  wait: z.number().min(0).max(LONGEST_WAIT).default(0),
});

const Handed = z.object({
  items: z
    .array(
      z.object({
        id: z.number().int(),
        path: z.string().max(200),
        headers: z.record(z.string(), z.string().max(2000)),
        body: z.string(),
      }),
    )
    .max(AT_ONCE),
});

interface Row {
  id: number;
  path: string;
  body: string;
}

export class Mailbox {
  private readonly home: Home;
  private readonly peers: Peers;
  /** Homes that wait for something to be kept for them: handle → wake. */
  private readonly waiting = new Map<string, () => void>();
  /** The homes this home asks, while it runs: handle → the loop that asks. */
  private readonly asking = new Map<string, Promise<void>>();
  private app: Hono | undefined;
  private running = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(home: Home, peers: Peers) {
    this.home = home;
    this.peers = peers;
  }

  /** Keeps a request for a contact whose home has no address, until that home asks for it. */
  keep(handle: string, path: string, body: string): void {
    const { db } = this.home;
    db.run(
      "delete from outbox where created_at < ?",
      new Date(Date.now() - KEPT_FOR_MS).toISOString(),
    );
    db.run(
      "insert into outbox (handle, path, body, created_at) values (?, ?, ?, ?)",
      handle,
      path,
      body,
      now(),
    );
    db.run(
      "delete from outbox where handle = ? and id <= (select max(id) from outbox where handle = ?) - ?",
      handle,
      handle,
      KEPT_AT_MOST,
    );
    this.waiting.get(handle)?.();
  }

  /** How many requests wait for a contact's home to ask for them. */
  kept(handle: string): number {
    return (
      this.home.db.get<{ n: number }>("select count(*) as n from outbox where handle = ?", handle)
        ?.n ?? 0
    );
  }

  routes(app: Hono): void {
    this.app = app;
    const { home } = this;
    // A contact's home asks for what is kept for it. What it says it got is dropped; the
    // rest is signed for it now and handed over, in the order it was kept.
    app.post("/peers/mailbox", async (c) => {
      const request = await this.peers.verified(c, false);
      const own = home.handle();
      if (!own || !request?.contact || request.contact.state === "blocked")
        return c.json({ error: "refused", message: "Only a contact's Bot Server is heard." }, 401);
      const asked = Asked.safeParse(JSON.parse(request.body || "{}"));
      if (!asked.success) return c.json({ error: "refused", message: "Not valid." }, 400);
      const { handle } = request.contact;
      home.db.run("delete from outbox where handle = ? and id <= ?", handle, asked.data.after);
      const take = () =>
        home.db.all<Row>(
          "select id, path, body from outbox where handle = ? order by id limit ?",
          handle,
          AT_ONCE,
        );
      let rows = take();
      if (!rows.length && asked.data.wait > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, asked.data.wait * 1000);
          timer.unref();
          this.waiting.set(handle, () => {
            clearTimeout(timer);
            resolve();
          });
        });
        this.waiting.delete(handle);
        rows = take();
      }
      return c.json({
        items: rows.map((row) => ({
          id: row.id,
          path: row.path,
          body: row.body,
          headers: {
            "content-type": "application/json",
            ...signRequest({
              identity: home.identity,
              from: own,
              to: handle,
              method: "POST",
              path: row.path,
              body: row.body,
            }),
          },
        })),
      } satisfies z.input<typeof Handed>);
    });
  }

  /**
   * Asks one contact's home for what it keeps for this home and hears each request as if it
   * had arrived by itself. Returns how many there were.
   */
  async collectFrom(handle: string, wait = 0): Promise<number> {
    const { home } = this;
    const key = `mailbox.after.${handle}`;
    const after = Number(home.db.meta(key) ?? 0);
    const response = await this.peers.post(
      handle,
      "/peers/mailbox",
      { after, wait },
      AbortSignal.timeout((wait + 10) * 1000),
    );
    const { items } = Handed.parse(await response.json());
    for (const item of items) {
      // Only what one home tells another is taken: nothing a device would ask.
      if (this.app && item.path.startsWith("/peers/") && item.path !== "/peers/mailbox") {
        await this.app.request(`http://mailbox${item.path}`, {
          method: "POST",
          headers: item.headers,
          body: item.body,
        });
      }
      home.db.setMeta(key, String(item.id));
    }
    return items.length;
  }

  /** The contacts whose homes have an address: the ones this home can ask. */
  private reachable(): string[] {
    return this.peers
      .contacts()
      .filter((contact) => contact.url && contact.state !== "blocked")
      .map((contact) => contact.handle);
  }

  /** Asks every contact's home once. For a home without an address. */
  async collect(wait = 0): Promise<number> {
    const counts = await Promise.all(
      this.reachable().map((handle) => this.collectFrom(handle, wait).catch(() => 0)),
    );
    return counts.reduce((sum, count) => sum + count, 0);
  }

  /**
   * A home without an address keeps asking while it runs: each contact's home in a loop of
   * its own, with requests that wait there until something is kept.
   */
  start(): void {
    if (this.home.config.publicUrl || this.running) return;
    this.running = true;
    this.look();
    // A contact that was missed is asked soon after.
    this.timer = setInterval(() => this.look(), 5000);
    this.timer.unref();
  }

  /** Starts asking the contacts' homes that are not asked yet: at the start, and when a contact is made. */
  look(): void {
    if (!this.running || !this.home.handle()) return;
    for (const handle of this.reachable()) {
      if (this.asking.has(handle)) continue;
      const loop = (async () => {
        // A home that does not answer, or does not know this one yet, is asked again after a
        // pause that grows: short at first, for a contact that is only just being made.
        let pause = FIRST_PAUSE_MS;
        while (this.running && this.peers.contact(handle)?.url) {
          try {
            await this.collectFrom(handle, LONGEST_WAIT);
            pause = FIRST_PAUSE_MS;
          } catch {
            const wait = pause;
            await new Promise<void>((resolve) => {
              setTimeout(resolve, wait).unref();
            });
            pause = Math.min(pause * 2, TRY_AGAIN_MS);
          }
        }
      })().finally(() => this.asking.delete(handle));
      this.asking.set(handle, loop);
    }
  }

  stop(): void {
    this.running = false;
    clearInterval(this.timer);
    for (const wake of this.waiting.values()) wake();
  }
}
