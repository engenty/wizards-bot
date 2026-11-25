import { type ChildProcess, execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { SetupAddress } from "@wizards-bot/protocol";
import { z } from "zod";
import { defineTool } from "../agent/tool.ts";
import { isHosted } from "../config.ts";
import type { Home } from "../home.ts";
import { type Lang, langOf, same, say, type Words, w } from "../setup/words.ts";
import { ensureFrpc, frpcConfig, readFrpcLine } from "./frpc.ts";
import { claimKey, csrFor, makeKey, nameOf, needsRenewal, writeAtomic } from "./keys.ts";
import { type Claimed, RELAY_URL, Relay, RelayError } from "./relay.ts";

// The address at <name>.wizards.host: switched on by the person, never by itself. The home
// claims its name with a key of its own, gets a certificate for it from the relay, and runs frpc
// as its child, which keeps a connection to the relay open and ends TLS on this computer. Its
// files are in `<data>/tunnel`:
//
//   claim.pem     the Ed25519 claim key (0600): the name is made from it; losing it loses the name
//   tunnel.json   the relay's key for this home, the name and where frpc connects (0600)
//   key.pem       the certificate's private key (0600); it never leaves this computer
//   cert.pem      the certificate for the name, from Let's Encrypt through wizards.host
//   frpc.toml     frpc's settings (0600: it holds the relay's key)
//   frp/<version>/frpc   frpc, fetched the first time

const ON = "address.on";
/** How often a running address looks at its certificate. */
const CHECK_EVERY = 12 * 3600_000;
/** frpc that ran this long is started again at once when it ends. */
const STEADY = 5 * 60_000;

export type AddressState = SetupAddress["state"];

/** Switching the address is refused: a hosted home, or one with an address of its own. */
export class AddressRefused extends Error {}

const run = promisify(execFile);

/** A free port on 127.0.0.1, for frpc's admin API. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

export class Tunnel {
  private readonly home: Home;
  readonly dir: string;
  /** The relay's API; tests give it a fetch of their own. */
  relay: Relay;
  /** How frpc is downloaded; the network by default. */
  fetch: typeof fetch = (input, init) => fetch(input, init);
  private state: AddressState = "off";
  private reason: Words | string | undefined;
  private child: ChildProcess | undefined;
  private restartTimer: NodeJS.Timeout | undefined;
  private checkTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private wait = 1000;
  private retryWait = 30_000;
  /** Counts the switches: work started before the last one leaves the state alone. */
  private round = 0;
  private readonly settling = new Set<() => void>();

  constructor(home: Home) {
    this.home = home;
    this.dir = join(home.config.dataDir, "tunnel");
    this.relay = new Relay(home.config.tunnelUrl ?? RELAY_URL);
    home.addTools((context) => (context.agent.main && this.available() ? [this.tool()] : []));
  }

  // ── What the person sees ──────────────────────────────────────────────────

  /** Whether this home offers the address: not on wizards.bot, not with an address of its own. */
  available(): boolean {
    return !isHosted(this.home.config) && !this.home.config.publicUrl;
  }

  /** Whether the person switched the address on. */
  wanted(): boolean {
    return this.available() && this.home.db.meta(ON) === "1";
  }

  /** The name, once the claim key is made; the relay's answer once it claimed. */
  name(): string | undefined {
    const saved = this.saved();
    if (saved) return saved.name;
    const file = join(this.dir, "claim.pem");
    return existsSync(file) ? nameOf(claimKey(file), this.relay.domain) : undefined;
  }

  /**
   * The address a phone reaches the home at through the relay: once switched on, claimed and
   * certified. frpc may be connecting again just now; the address stays the same.
   */
  address(): string | undefined {
    if (!this.wanted()) return undefined;
    const saved = this.saved();
    return saved && existsSync(join(this.dir, "cert.pem")) ? `https://${saved.name}` : undefined;
  }

  view(lang: Lang = langOf(this.home.db)): SetupAddress {
    const name = this.name();
    return {
      on: this.wanted(),
      state: this.wanted() ? this.state : "off",
      ...(name ? { name } : {}),
      ...(this.reason && this.wanted() ? { reason: say(this.reason, lang) } : {}),
    };
  }

  /** Resolves when the address is on, refused or failed, or after `ms`. */
  settled(ms: number): Promise<AddressState> {
    if (this.state !== "starting") return Promise.resolve(this.state);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.settling.delete(done);
        resolve(this.state);
      };
      const timer = setTimeout(done, ms);
      this.settling.add(done);
    });
  }

  // ── Switching ─────────────────────────────────────────────────────────────

  /** On the home's start: brings the address up again when the person had switched it on. */
  start(): void {
    if (this.wanted()) void this.bring(++this.round);
  }

  /** Switches the address on or off. Off stops frpc; the claim key and the name stay. */
  async set(on: boolean): Promise<SetupAddress> {
    if (!this.available()) {
      throw new AddressRefused(
        isHosted(this.home.config)
          ? "A Bot Server on wizards.bot has its address already."
          : "This Bot Server has an address of its own (WIZARDS_BOT_URL).",
      );
    }
    const round = ++this.round;
    this.halt();
    this.home.db.setMeta(ON, on ? "1" : "0");
    if (on) {
      void this.bring(round);
    } else {
      this.to("off");
    }
    return this.view();
  }

  /** Stops frpc and the timers; what the person switched stays. */
  stop(): void {
    this.round++;
    this.halt();
  }

  private halt(): void {
    clearTimeout(this.restartTimer);
    clearTimeout(this.checkTimer);
    clearTimeout(this.retryTimer);
    this.restartTimer = this.checkTimer = this.retryTimer = undefined;
    const child = this.child;
    this.child = undefined;
    if (child && child.exitCode === null) child.kill("SIGTERM");
    this.wait = 1000;
  }

  private to(state: AddressState, reason?: Words | string): void {
    const changed =
      state !== this.state || say(reason ?? "", "en") !== say(this.reason ?? "", "en");
    this.state = state;
    this.reason = reason;
    if (state !== "starting") for (const done of [...this.settling]) done();
    if (changed) void this.home.setup.changed().catch(() => {});
  }

  // ── Bringing it up ────────────────────────────────────────────────────────

  private async bring(round: number): Promise<void> {
    const current = () => round === this.round;
    this.to("starting");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      const frpc = this.home.config.frpc ?? (await ensureFrpc(this.dir, this.fetch));
      if (!current()) return;
      const key = claimKey(join(this.dir, "claim.pem"));
      let saved = this.saved() ?? (await this.claim(key));
      if (!current()) return;
      saved = await this.certify(saved, key);
      if (!current()) return;
      const config = join(this.dir, "frpc.toml");
      writeAtomic(
        config,
        frpcConfig({
          ...saved,
          port: this.home.config.port,
          adminPort: await freePort(),
          adminPassword: randomBytes(18).toString("base64url"),
          certFile: join(this.dir, "cert.pem"),
          keyFile: join(this.dir, "key.pem"),
        }),
        true,
      );
      if (!current()) return;
      await this.endEarlier();
      this.retryWait = 30_000;
      this.launch(frpc, config, round);
      this.checkTimer = setTimeout(() => void this.check(frpc, config, round), CHECK_EVERY);
    } catch (error) {
      if (!current()) return;
      if (error instanceof RelayError && error.refused) {
        this.to("refused", same(error.message));
        return;
      }
      this.to("failed", same((error as Error).message));
      // Without a network the relay does not answer: try again, waiting longer each time.
      this.retryTimer = setTimeout(() => {
        if (current()) void this.bring(round);
      }, this.retryWait);
      this.retryWait = Math.min(this.retryWait * 2, 15 * 60_000);
    }
  }

  /** Claims the name and keeps the relay's key for it. */
  private async claim(key: ReturnType<typeof claimKey>): Promise<Claimed> {
    const claimed = await this.relay.claim(key);
    writeAtomic(join(this.dir, "tunnel.json"), `${JSON.stringify(claimed, null, 2)}\n`, true);
    return claimed;
  }

  /**
   * A certificate for the name when there is none or it ends within 30 days. When the relay no
   * longer knows the home's key (it gave a newer one to the same claim key), it claims again.
   */
  private async certify(saved: Claimed, key: ReturnType<typeof claimKey>): Promise<Claimed> {
    const certFile = join(this.dir, "cert.pem");
    const current = existsSync(certFile) ? readFileSync(certFile, "utf8") : undefined;
    if (!needsRenewal(current)) return saved;
    const keyFile = join(this.dir, "key.pem");
    if (!existsSync(keyFile)) writeAtomic(keyFile, makeKey(), true);
    const csr = csrFor(saved.name, readFileSync(keyFile, "utf8"));
    let cert: string;
    try {
      cert = await this.relay.certificate(saved.key, csr);
    } catch (error) {
      if (!(error instanceof RelayError) || error.status !== 401) throw error;
      saved = await this.claim(key);
      cert = await this.relay.certificate(saved.key, csr);
    }
    writeAtomic(certFile, cert);
    return saved;
  }

  /** Renews the certificate when it is due, and has frpc read it. */
  private async check(frpc: string, config: string, round: number): Promise<void> {
    if (round !== this.round) return;
    const saved = this.saved();
    try {
      if (saved) {
        const certFile = join(this.dir, "cert.pem");
        const before = existsSync(certFile) ? readFileSync(certFile, "utf8") : undefined;
        await this.certify(saved, claimKey(join(this.dir, "claim.pem")));
        const after = readFileSync(certFile, "utf8");
        if (round === this.round && after !== before) {
          await run(frpc, ["reload", "-c", config]).catch(() => this.child?.kill("SIGTERM"));
        }
      }
    } catch (error) {
      console.error(`[address] The certificate was not renewed: ${(error as Error).message}`);
    }
    if (round === this.round) {
      this.checkTimer = setTimeout(() => void this.check(frpc, config, round), CHECK_EVERY);
    }
  }

  // ── frpc ──────────────────────────────────────────────────────────────────

  /** Runs frpc, started again when it ends: after 1 s, then longer, up to a minute. */
  private launch(frpc: string, config: string, round: number): void {
    const started = Date.now();
    const child = spawn(frpc, ["-c", config], { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    if (child.pid) writeAtomic(join(this.dir, "frpc.pid"), String(child.pid));
    let last = "";
    for (const stream of [child.stdout, child.stderr]) {
      createInterface({ input: stream }).on("line", (line) => {
        if (round !== this.round) return;
        if (line.trim()) last = line.trim();
        const said = readFrpcLine(line);
        if (!said) return;
        if (said.state === "on") this.to("on");
        else if (said.state === "refused") this.to("refused", same(said.reason));
        else this.to("starting", reasonOf(said.reason));
      });
    }
    child.on("error", (error) => {
      if (round !== this.round || this.child !== child) return;
      this.child = undefined;
      this.to("failed", same(`frpc did not start: ${error.message}`));
    });
    child.on("exit", (code, signal) => {
      if (round !== this.round || this.child !== child) return;
      this.child = undefined;
      rmSync(join(this.dir, "frpc.pid"), { force: true });
      this.wait = Date.now() - started > STEADY ? 1000 : Math.min(this.wait * 2, 60_000);
      this.to(
        "starting",
        w(
          `frpc ended (${signal ?? code}${last ? `: ${last}` : ""}). It starts again.`,
          `frpc wurde beendet (${signal ?? code}${last ? `: ${last}` : ""}). Es startet neu.`,
        ),
      );
      this.restartTimer = setTimeout(() => {
        if (round === this.round) this.launch(frpc, config, round);
      }, this.wait);
    });
  }

  /** Ends an frpc an earlier run of the home left behind: the relay takes one per name. */
  private async endEarlier(): Promise<void> {
    const file = join(this.dir, "frpc.pid");
    if (!existsSync(file)) return;
    const pid = Number(readFileSync(file, "utf8"));
    rmSync(file, { force: true });
    if (!Number.isInteger(pid) || pid <= 0) return;
    const { stdout } = await run("ps", ["-o", "comm=", "-p", String(pid)]).catch(() => ({
      stdout: "",
    }));
    if (stdout.trim().endsWith("frpc")) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
  }

  // ── What is kept ──────────────────────────────────────────────────────────

  private saved(): Claimed | undefined {
    try {
      const data = JSON.parse(readFileSync(join(this.dir, "tunnel.json"), "utf8")) as Claimed;
      return data.key && data.name && data.server ? data : undefined;
    } catch {
      return undefined;
    }
  }

  // ── The main agent's tool ─────────────────────────────────────────────────

  private tool() {
    return defineTool({
      name: "address_switch",
      description:
        "Switch on or off the address at wizards.host that lets the person's phone reach this Bot Server away from home. On asks the person first with a card and ends your turn. Off keeps the name for later.",
      input: z.object({ on: z.boolean() }),
      label: (input) => (input.on ? "Switching on the address" : "Switching off the address"),
      asks: true,
      run: async (input, call) => {
        if (!input.on) {
          await this.set(false);
          return "The address is off. Its name stays for when it is switched on again.";
        }
        if (this.wanted() && this.state === "on")
          return `The address is on: https://${this.name()}.`;
        const lang = langOf(this.home.db);
        if (!call.answer)
          return call.ask({
            kind: "approval",
            level: "needs_you",
            title: say(
              w("Reach your Bot Server away from home?", "Deinen Bot Server unterwegs erreichen?"),
              lang,
            ),
            body: say(
              w(
                "Your Bot Server gets a name at wizards.host and keeps a connection to it open, so your phone reaches it also away from home. What leaves this computer: the name and the connection. The encryption ends on this computer, so wizards.host does not read what passes through.",
                "Dein Bot Server bekommt einen Namen bei wizards.host und hält eine Verbindung dorthin offen, damit dein Telefon ihn auch unterwegs erreicht. Was diesen Computer verlässt: der Name und die Verbindung. Die Verschlüsselung endet auf diesem Computer, daher liest wizards.host nicht, was hindurchgeht.",
              ),
              lang,
            ),
            actions: [
              { id: "on", label: say(w("Switch on", "Einschalten"), lang), style: "primary" },
              { id: "deny", label: say(w("Don't", "Nicht jetzt"), lang), style: "plain" },
            ],
          });
        if (call.answer.action !== "on") return "The person left the address off.";
        await this.set(true);
        const state = await this.settled(120_000);
        const view = this.view("en");
        if (state === "on") return `The address is on: https://${view.name}.`;
        if (state === "starting")
          return `The address is being set up${view.name ? ` at https://${view.name}` : ""}. The setup shows when it is on.`;
        return `The address did not come on: ${view.reason ?? state}.`;
      },
    });
  }
}

/** What frpc said while it connects, as the person reads it. */
function reasonOf(said: string): Words {
  return said === "reconnecting"
    ? w(
        "The connection to wizards.host was lost. It is made again.",
        "Die Verbindung zu wizards.host ist abgerissen. Sie wird neu aufgebaut.",
      )
    : w(
        `wizards.host is not reached yet: ${said}`,
        `wizards.host ist noch nicht erreicht: ${said}`,
      );
}
