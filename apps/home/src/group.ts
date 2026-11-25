import { createPublicKey, type KeyObject, verify, type webcrypto } from "node:crypto";
import { type HomePerson, Role } from "@wizards-bot/protocol";
import { z } from "zod";
import type { Home } from "./home.ts";
import { now } from "./ids.ts";

// A group home belongs to a team, not to one person (docs/network.md, "Group homes"). The
// Manage-App keeps who is in the team. The home asks it every minute with its gateway key, keeps
// them in `person`, and removes the devices of someone who is gone. The team's owners and admins
// run the home; its members and clients reach what is theirs. Someone's first device pairs with
// a pass: a short token the Manage-App signs with its own key for one person and this home
// (docs/hosted.md, Contracts 10 and 11).

/** What the Manage-App answers for this home's people. `group` is null for a personal team. */
const People = z.object({
  group: z.object({ name: z.string().trim().min(1).max(120) }).nullable(),
  people: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        name: z.string().trim().max(120),
        // A role this home does not know may do the least.
        role: Role.catch("client"),
      }),
    )
    .max(5000),
  // The runtime the team works in. Its studio shows this home's page inside its own.
  studio: z.object({ mcp: z.string().url() }).nullable().catch(null).default(null),
});

/** Whether someone runs the home. In a home of one person nobody is named, and they do. */
export const runsHome = (person: Pick<HomePerson, "role"> | undefined): boolean =>
  person === undefined || person.role === "owner" || person.role === "admin";

/** What the home lets someone do: owners and admins the same. */
const reach = (role: Role): string => (runsHome({ role }) ? "admin" : role);

/** The parts of a pass the home reads. */
const PassClaims = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  sub: z.string().min(1),
  exp: z.number(),
  jti: z.string().min(8).max(200),
  /** The page of another site the pass is for: the studio's. Without it, the home's own. */
  origin: z.string().max(300).optional(),
});

const JwkSet = z.object({
  keys: z.array(z.looseObject({ kid: z.string().optional(), kty: z.string() })),
});

const PULL_MS = 60_000;
/** A pass lives five minutes; a little more for the clocks of two computers. */
const SKEW_S = 60;
/** The keys are fetched again at most this often when a pass names one not known. */
const JWKS_MS = 60_000;
/** A browser paired from another site's page is forgotten when it was not seen this long. */
const UNSEEN_MS = 30 * 24 * 60 * 60_000;

/** A pass the home does not take. The message is for the person. */
export class PassRefused extends Error {}

export class Group {
  private readonly home: Home;
  private timer: NodeJS.Timeout | undefined;
  private keys = new Map<string, KeyObject>();
  private keysAt = 0;
  /** Called with the ids of devices that were removed. */
  private readonly removed = new Set<(deviceIds: string[]) => void>();

  constructor(home: Home) {
    this.home = home;
  }

  /**
   * The origin of the studio the team works in, as the Manage-App named it. That page may show
   * the home's own page inside itself.
   */
  studio(): string | undefined {
    return this.home.db.meta("studio.origin") || undefined;
  }

  /** The team's name when this is a group home. */
  name(): string | undefined {
    return this.home.db.meta("group.name") || undefined;
  }

  isGroup(): boolean {
    return this.name() !== undefined;
  }

  people(): HomePerson[] {
    return this.home.db.all<HomePerson>(
      "select id, name, role from person order by created_at, name",
    );
  }

  /** Who runs the home: the team's owners and admins. */
  admins(): HomePerson[] {
    return this.people().filter(runsHome);
  }

  person(id: string): HomePerson | undefined {
    return this.home.db.get<HomePerson>("select id, name, role from person where id = ?", id);
  }

  /** Who an id kept somewhere names, as they are now. Someone gone since may do the least. */
  known(id: unknown): HomePerson | undefined {
    if (typeof id !== "string") return undefined;
    return this.person(id) ?? { id, name: "", role: "client" };
  }

  /** Hears which devices are removed. Returns how to stop hearing it. */
  onRemoved(listener: (deviceIds: string[]) => void): () => void {
    this.removed.add(listener);
    return () => this.removed.delete(listener);
  }

  // ── Who is in the team ────────────────────────────────────────────────────

  /** Asks the Manage-App now and every minute from then on. */
  start(): void {
    if (this.timer) return;
    const tick = async () => {
      await this.pull().catch((error) => console.error("[group]", (error as Error).message));
      this.tidy();
      this.timer = setTimeout(tick, PULL_MS);
      this.timer.unref?.();
    };
    void tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /**
   * Asks the Manage-App who is in this home's team. `false` when it could not be asked: the home
   * then keeps the people it knew.
   */
  async pull(): Promise<boolean> {
    const { config, models } = this.home;
    const key = models.accountKey();
    if (!config.manageUrl || !key) return false;
    let response: Response;
    try {
      response = await this.home.hosted.fetch(`${config.manageUrl}/v1/homes/people`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return false;
    }
    if (!response.ok) return false;
    const parsed = People.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) return false;
    const studio = parsed.data.studio ? new URL(parsed.data.studio.mcp).origin : "";
    if (studio !== (this.home.db.meta("studio.origin") ?? "")) {
      this.home.db.setMeta("studio.origin", studio);
    }
    this.take(parsed.data);
    return true;
  }

  private take({ group, people }: z.infer<typeof People>): void {
    // A personal team's home stays one person's.
    if (!group) return;
    const { db, store } = this.home;
    const known = new Map(this.people().map((person) => [person.id, person]));
    const gone: string[] = [];
    db.transaction(() => {
      db.setMeta("group.name", group.name);
      // The agents speak of the group where a home of one person names that person.
      db.setMeta("person.name", group.name);
      // The setup asks no one's name: the group's is the team's.
      db.setMeta("person.named", "1");
      for (const { id, name, role } of people) {
        db.run(
          "insert into person (id, name, role, created_at) values (?, ?, ?, ?) on conflict(id) do update set name = excluded.name, role = excluded.role",
          id,
          name || id,
          role,
          now(),
        );
        // Someone who may do more or less than before pairs again as who they are now.
        const before = known.get(id);
        if (before && reach(before.role) !== reach(role)) gone.push(...store.removeDevicesOf(id));
        known.delete(id);
      }
      for (const id of known.keys()) {
        gone.push(...store.removeDevicesOf(id));
        db.run("delete from person where id = ?", id);
      }
    });
    this.tell(gone);
  }

  /** Forgets the browsers that were paired from another site's page and not seen for a while. */
  tidy(): void {
    this.tell(this.home.store.removeUnseen(new Date(Date.now() - UNSEEN_MS).toISOString()));
  }

  private tell(gone: string[]): void {
    if (!gone.length) return;
    this.home.events.emit({
      type: "devices.updated",
      devices: this.home.handoffs.publicDevices(),
    });
    for (const listener of this.removed) listener(gone);
  }

  // ── The pass ──────────────────────────────────────────────────────────────

  /**
   * Checks a pass and returns who it is for. The pass is a JWT the Manage-App signed (EdDSA): for
   * this home's address, not expired, used once, for someone who is in the team when the home
   * asks the Manage-App right now, and brought by the page it names (`from`, a request's origin).
   */
  async admit(pass: string, from?: string): Promise<{ person: HomePerson; origin?: string }> {
    const { config } = this.home;
    if (!config.manageUrl || !config.publicUrl)
      throw new PassRefused("This Bot Server takes no pass.");
    const [head, body, signature] = pass.split(".");
    if (!head || !body || !signature) throw new PassRefused("This link is not complete.");
    const header = decode(head) as { alg?: string; kid?: string } | undefined;
    if (header?.alg !== "EdDSA")
      throw new PassRefused("This link is not one the Bot Server takes.");
    const key = await this.key(header.kid);
    if (
      !key ||
      !verify(null, Buffer.from(`${head}.${body}`), key, Buffer.from(signature, "base64url"))
    )
      throw new PassRefused("This link is not signed by your wizards account.");
    const claims = PassClaims.safeParse(decode(body));
    if (!claims.success) throw new PassRefused("This link is not one the Bot Server takes.");
    const { iss, aud, sub, exp, jti } = claims.data;
    const origin = new URL(config.publicUrl).origin;
    if (iss !== config.manageUrl || !(Array.isArray(aud) ? aud : [aud]).includes(origin))
      throw new PassRefused("This link is for another Bot Server.");
    if (exp + SKEW_S < Date.now() / 1000)
      throw new PassRefused("This link is too old. Open the Bot Server again from your account.");
    // The home's own page names no origin of another site.
    const other = (page: string | undefined) => (page === origin ? undefined : page);
    const page = other(claims.data.origin);
    if (other(from) !== page) throw new PassRefused("This link is for another page.");
    const { db } = this.home;
    db.run("delete from used_pass where expires_at < ?", now());
    if (db.get("select jti from used_pass where jti = ?", jti))
      throw new PassRefused(
        "This link was used already. Open the Bot Server again from your account.",
      );
    db.run(
      "insert into used_pass (jti, expires_at) values (?, ?)",
      jti,
      new Date((exp + SKEW_S) * 1000).toISOString(),
    );
    await this.pull();
    const person = this.person(sub);
    if (!person) throw new PassRefused("You are not in the team of this Bot Server.");
    return { person, origin: page };
  }

  /** The Manage-App's key of that id, fetched again when it is not known yet. */
  private async key(kid: string | undefined) {
    const known = () => (kid ? this.keys.get(kid) : [...this.keys.values()][0]);
    if (known() || Date.now() - this.keysAt < JWKS_MS) return known();
    this.keysAt = Date.now();
    try {
      const response = await this.home.hosted.fetch(`${this.home.config.manageUrl}/api/auth/jwks`, {
        signal: AbortSignal.timeout(15_000),
      });
      const set = JwkSet.parse(await response.json());
      const keys = new Map<string, KeyObject>();
      for (const jwk of set.keys) {
        if (jwk.kty !== "OKP") continue;
        keys.set(
          jwk.kid ?? "",
          createPublicKey({ key: jwk as webcrypto.JsonWebKey, format: "jwk" }),
        );
      }
      this.keys = keys;
    } catch (error) {
      console.error("[group] The Manage-App's keys:", (error as Error).message);
    }
    return known();
  }
}

function decode(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}
