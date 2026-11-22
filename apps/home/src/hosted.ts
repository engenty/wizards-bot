import { z } from "zod";
import { isHosted, tidyCode } from "./config.ts";
import type { Home } from "./home.ts";

// A hosted home runs on wizards.bot. The Manage-App makes it with its address, a setup code
// and a token that works once (docs/hosted.md, Contract 3). With the token the home claims its
// way to the gateway and its handle on its first start; it keeps both and never claims again.

/** What the Manage-App answers to the claim. */
const Claimed = z.object({
  gatewayUrl: z.url(),
  gatewayKey: z.string().min(1),
  handle: z.string().regex(/^[a-z0-9][a-z0-9-]*@[a-z0-9.-]+$/i),
  /** The person's name in their wizards account, when it has one. */
  name: z.string().trim().max(80).optional(),
});

/** How a claim ended: kept from before, made now, refused for good, or to try again later. */
export type ClaimResult = "kept" | "claimed" | "refused" | "later" | "none";

const SETUP_CODE_ENDED = "setup.code.ended";
const RETRY_MS = 30_000;
const TRIES = 20;

export class Hosted {
  private readonly home: Home;
  private timer: NodeJS.Timeout | undefined;
  /** How the claim reaches the Manage-App; the network by default. */
  fetch: typeof fetch = (input, init) => fetch(input, init);

  constructor(home: Home) {
    this.home = home;
  }

  // ── The setup code ────────────────────────────────────────────────────────

  /** Whether the setup code still pairs: until it paired one device, and while none is paired. */
  setupCodeOpen(): boolean {
    return (
      this.home.config.setupCode !== undefined &&
      !this.home.db.meta(SETUP_CODE_ENDED) &&
      this.home.store.devices().length === 0
    );
  }

  /** Uses the setup code up when it is this one. */
  redeemSetupCode(code: string): boolean {
    if (!this.setupCodeOpen() || tidyCode(code) !== this.home.config.setupCode) return false;
    this.home.db.setMeta(SETUP_CODE_ENDED, new Date().toISOString());
    return true;
  }

  // ── The claim ─────────────────────────────────────────────────────────────

  /**
   * Claims once; on a failure that may pass, tries again every 30 seconds for ten minutes.
   * Resolves with the first try.
   */
  async start(): Promise<ClaimResult> {
    let tries = 0;
    const attempt = async () => {
      this.timer = undefined;
      const result = await this.claim();
      if (result === "later" && ++tries < TRIES) this.timer = setTimeout(attempt, RETRY_MS);
      return result;
    };
    return attempt();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /**
   * Sends the token to the Manage-App, keeps the gateway's key in the home's secrets and takes
   * the handle. A home that has the key already does not claim again.
   */
  async claim(): Promise<ClaimResult> {
    const { config, models } = this.home;
    if (!isHosted(config) || !config.homeToken) return "none";
    if (models.account() && models.accountKey()) return "kept";
    let response: Response;
    try {
      response = await this.fetch(`${config.manageUrl}/v1/homes/claim`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.homeToken}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      console.error(`[hosted] The Manage-App does not answer: ${(error as Error).message}`);
      return "later";
    }
    if (response.status === 401 || response.status === 403 || response.status === 409) {
      console.error(
        `[hosted] The Manage-App refused the Bot Server's token (${response.status}). It works once; without the gateway's key this Bot Server has no account. Ask the Manage-App for a new token.`,
      );
      return "refused";
    }
    if (!response.ok) {
      console.error(`[hosted] The claim failed with ${response.status}. Trying again later.`);
      return "later";
    }
    const parsed = Claimed.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
      console.error("[hosted] The Manage-App's answer to the claim is not what it should be.");
      return "later";
    }
    const { gatewayUrl, gatewayKey, handle, name } = parsed.data;
    models.setAccount({ gatewayUrl: gatewayUrl.replace(/\/+$/, "") }, gatewayKey);
    this.takeHandle(handle.toLowerCase());
    // The setup shows it for the person to confirm; a name they said already stays.
    if (name && !this.home.db.meta("person.named")) this.home.db.setMeta("person.name", name);
    // The gateway is green when the person lands: one short test call, as at a first start.
    void this.home.setup.test("wizards").catch(() => {});
    return "claimed";
  }

  /**
   * The handle the Manage-App gave, `ada@wizards.bot`: wizards.bot names this home for it in
   * its `/.well-known/wizards.json`. Before the person has a key there is no record to sign, so
   * the home takes it as it takes the handle at its own address.
   */
  private takeHandle(handle: string): void {
    const { db, config } = this.home;
    const at = handle.indexOf("@");
    const domain = handle.slice(at + 1);
    db.transaction(() => {
      db.setMeta("person.handle", handle.slice(0, at));
      if (config.publicUrl && domain === new URL(config.publicUrl).host)
        db.run("delete from meta where key = 'person.domain'");
      else db.setMeta("person.domain", domain);
    });
  }
}
