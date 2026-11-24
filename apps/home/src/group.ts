import { createPublicKey, type KeyObject, verify, type webcrypto } from "node:crypto";
import type { Admin } from "@wizards-bot/protocol";
import { z } from "zod";
import type { Home } from "./home.ts";
import { now } from "./ids.ts";

// A group home belongs to a team, not to one person (docs/network.md, "Group homes"). The
// Manage-App keeps who runs it: the team's owners and admins. The home asks it for them every
// minute with its gateway key, keeps them in `admin`, and removes the devices of an admin who
// is gone. An admin's first device pairs with a pass: a short token the Manage-App signs with
// its own key for one admin and this home (docs/hosted.md, Contracts 10 and 11).

/** What the Manage-App answers for this home's admins. `group` is null for a personal team. */
const Admins = z.object({
  group: z.object({ name: z.string().trim().min(1).max(120) }).nullable(),
  admins: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        name: z.string().trim().max(120),
        role: z.string().max(40),
      }),
    )
    .max(500),
});

/** The parts of a pass the home reads. */
const PassClaims = z.object({
  iss: z.string(),
  aud: z.union([z.string(), z.array(z.string())]),
  sub: z.string().min(1),
  exp: z.number(),
  jti: z.string().min(8).max(200),
});

const JwkSet = z.object({
  keys: z.array(z.looseObject({ kid: z.string().optional(), kty: z.string() })),
});

const PULL_MS = 60_000;
/** A pass lives five minutes; a little more for the clocks of two computers. */
const SKEW_S = 60;
/** The keys are fetched again at most this often when a pass names one not known. */
const JWKS_MS = 60_000;

/** A pass the home does not take. The message is for the person. */
export class PassRefused extends Error {}

export class Group {
  private readonly home: Home;
  private timer: NodeJS.Timeout | undefined;
  private keys = new Map<string, KeyObject>();
  private keysAt = 0;
  /** Called with the ids of devices that were removed because their admin is gone. */
  private readonly removed: ((deviceIds: string[]) => void)[] = [];

  constructor(home: Home) {
    this.home = home;
  }

  /** The team's name when this is a group home. */
  name(): string | undefined {
    return this.home.db.meta("group.name") || undefined;
  }

  isGroup(): boolean {
    return this.name() !== undefined;
  }

  admins(): Admin[] {
    return this.home.db.all<Admin>("select id, name from admin order by created_at, name");
  }

  admin(id: string): Admin | undefined {
    return this.home.db.get<Admin>("select id, name from admin where id = ?", id);
  }

  onRemoved(listener: (deviceIds: string[]) => void): void {
    this.removed.push(listener);
  }

  // ── Who the admins are ────────────────────────────────────────────────────

  /** Asks the Manage-App now and every minute from then on. */
  start(): void {
    if (this.timer) return;
    const tick = async () => {
      await this.pull().catch((error) => console.error("[group]", (error as Error).message));
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
   * Asks the Manage-App who runs this home. `false` when it could not be asked: the home then
   * keeps the admins it knew.
   */
  async pull(): Promise<boolean> {
    const { config, models } = this.home;
    const key = models.accountKey();
    if (!config.manageUrl || !key) return false;
    let response: Response;
    try {
      response = await this.home.hosted.fetch(`${config.manageUrl}/v1/homes/admins`, {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return false;
    }
    if (!response.ok) return false;
    const parsed = Admins.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) return false;
    this.take(parsed.data);
    return true;
  }

  private take({ group, admins }: z.infer<typeof Admins>): void {
    // A personal team's home stays one person's.
    if (!group) return;
    const { db, store } = this.home;
    const known = new Set(this.admins().map((admin) => admin.id));
    const gone: string[] = [];
    db.transaction(() => {
      db.setMeta("group.name", group.name);
      // The agents speak of the group where a home of one person names that person.
      db.setMeta("person.name", group.name);
      // The setup asks no one's name: the group's is the team's.
      db.setMeta("person.named", "1");
      for (const admin of admins) {
        db.run(
          "insert into admin (id, name, role, created_at) values (?, ?, ?, ?) on conflict(id) do update set name = excluded.name, role = excluded.role",
          admin.id,
          admin.name || admin.id,
          admin.role,
          now(),
        );
        known.delete(admin.id);
      }
      for (const id of known) {
        gone.push(...store.removeDevicesOf(id));
        db.run("delete from admin where id = ?", id);
      }
    });
    if (gone.length) {
      this.home.events.emit({
        type: "devices.updated",
        devices: this.home.handoffs.publicDevices(),
      });
      for (const listener of this.removed) listener(gone);
    }
  }

  // ── The pass ──────────────────────────────────────────────────────────────

  /**
   * Checks a pass and returns the admin it is for. The pass is a JWT the Manage-App signed
   * (EdDSA): for this home's address, not expired, used once, and for someone who is an admin
   * when the home asks the Manage-App right now.
   */
  async admit(pass: string): Promise<Admin> {
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
    const { db } = this.home;
    db.run("delete from admin_pass where expires_at < ?", now());
    if (db.get("select jti from admin_pass where jti = ?", jti))
      throw new PassRefused(
        "This link was used already. Open the Bot Server again from your account.",
      );
    db.run(
      "insert into admin_pass (jti, expires_at) values (?, ?)",
      jti,
      new Date((exp + SKEW_S) * 1000).toISOString(),
    );
    await this.pull();
    const admin = this.admin(sub);
    if (!admin) throw new PassRefused("You are not an admin of this team's Bot Server.");
    return admin;
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
