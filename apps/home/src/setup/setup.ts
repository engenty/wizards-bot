import { existsSync, realpathSync, statfsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { type Client, detectClient } from "@engenty/local-models/clients";
import { pullModel } from "@engenty/local-models/ollama";
import type { Card, SetupCheck, SetupPulling, Setup as SetupView } from "@wizards-bot/protocol";
import { isHosted } from "../config.ts";
import type { Home } from "../home.ts";
import { isSubscription, SUBSCRIPTIONS } from "../models/client-model.ts";
import { ACCOUNT, GATEWAY_PRESETS } from "../models/models.ts";
import { onThisComputer, SUGGESTED } from "../models/ollama.ts";
import type { NewCard } from "../store/store.ts";
import { type Probe, probeAccount, probeClient, probeGateway, probeOllama } from "./probes.ts";
import {
  greeting,
  type Lang,
  langOf,
  MAIN_ABOUT,
  MAIN_ABOUT_BEFORE,
  pairingLink,
  same,
  say,
  type Words,
  w,
} from "./words.ts";

/** A test call's outcome as the home keeps it, with its time. Kept text from before is English. */
interface Kept extends Omit<Probe, "said" | "todo"> {
  said: Words | string;
  todo?: Words | string;
  at: string;
}

/** A check as the home makes it: its sentences in both languages, shown in the person's. */
type Check = Omit<SetupCheck, "said" | "todo"> & { said: Words | string; todo?: Words | string };

const TESTS = "setup.tests";

/** A pull the home does not make: Ollama is not on its computer, or the model is not offered. */
export class PullRefused extends Error {}

/** A gateway's first model when the person adds it from the setup; they may name another. */
export const GATEWAY_MODELS: Record<string, string> = {
  openrouter: "openrouter/auto",
  vercel: "anthropic/claude-sonnet-4.5",
  openai: "gpt-5-mini",
  anthropic: "claude-sonnet-4-5",
};

/** Folders a computer empties by itself: a home's data there may be gone after a restart. */
function temporary(dir: string): boolean {
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch {}
  const roots = [tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
  return roots.some((root) => {
    let resolved = root;
    try {
      resolved = realpathSync(root);
    } catch {}
    return real === resolved || real.startsWith(`${resolved}/`);
  });
}

/** A path with the home folder as `~`. */
const tilde = (path: string) =>
  path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path;

/**
 * What the first start shows and `doctor` prints: each model source with its last test call,
 * and what the home has around it. Test calls cost tokens: they run when asked, never on a
 * timer, and their outcome is kept with its time.
 */
export class Setup {
  private readonly home: Home;
  /** Test calls that run now, by source. */
  private readonly running = new Map<string, Promise<void>>();
  /** The installed clients the setup tests; the home's own by default. */
  clients: Client[];
  /** How a gateway's test call reaches it; the network by default. */
  gatewayFetch: typeof fetch | undefined;
  /** How a pull reaches Ollama; the network by default. */
  ollamaFetch: typeof fetch | undefined;
  /** The model the home pulls into Ollama, or pulled last, while it runs. */
  private pulling: SetupPulling | undefined;
  private pullRun: Promise<void> = Promise.resolve();

  constructor(home: Home) {
    this.home = home;
    // A hosted home runs on a server: no one signs in to a subscription there.
    this.clients = isHosted(home.config)
      ? []
      : home.config.subscriptions.filter(isSubscription).map((id) => SUBSCRIPTIONS[id].client);
  }

  // ── What the person said ──────────────────────────────────────────────────

  /** The person finished the first start, or talked to their agent before there was one. */
  done(): boolean {
    if (this.home.db.meta("setup.done")) return true;
    if (this.home.db.get("select 1 from message where role = 'you' limit 1")) {
      this.home.db.setMeta("setup.done", new Date().toISOString());
      return true;
    }
    return false;
  }

  async change(input: { name?: string; done?: boolean; lang?: Lang }): Promise<SetupView> {
    if (input.lang) {
      this.home.db.setMeta("person.lang", input.lang);
      // The main agent's first words about itself follow the language, until someone changed them.
      const main = this.home.store.mainAgent();
      if ([MAIN_ABOUT.en, MAIN_ABOUT.de, MAIN_ABOUT_BEFORE].includes(main.about)) {
        this.home.store.updateAgent(main.id, { about: MAIN_ABOUT[input.lang] });
      }
    }
    if (input.name) {
      this.home.db.setMeta("person.name", input.name);
      this.home.db.setMeta("person.named", "1");
    }
    if (input.done && !this.home.db.meta("setup.done")) {
      this.home.db.setMeta("setup.done", new Date().toISOString());
      this.greet();
    }
    return this.changed();
  }

  /** The main agent says hello in a chat that has nothing in it yet. */
  private greet(): void {
    const { store, db } = this.home;
    const agent = store.mainAgent();
    if (store.messages(agent.conversationId, { limit: 1 }).messages.length) return;
    store.addMessage({
      conversationId: agent.conversationId,
      role: "agent",
      agentId: agent.id,
      channel: "home",
      parts: [{ type: "text", text: greeting(this.home.person(), agent.name, langOf(db)) }],
    });
  }

  /**
   * Puts the key card of a gateway into the main agent's chat, as the agent's `gateway_add`
   * does: the key goes from the card into the home's secrets, and the card's answer sets the
   * gateway up. It works while no model answers yet.
   */
  gatewayCard(provider: keyof typeof GATEWAY_MODELS) {
    const preset = GATEWAY_PRESETS[provider];
    if (!preset) throw new Error(`No such gateway: ${provider}`);
    return this.say({
      kind: "secret",
      level: "needs_you",
      title: `Key for ${preset.label}`,
      body: "The key stays on your Bot Server. No model reads it.",
      fields: [
        { id: "key", label: "API key", type: "secret", required: true },
        {
          id: "model",
          label: "Model",
          type: "text",
          value: GATEWAY_MODELS[provider],
          required: true,
        },
      ],
      actions: [
        { id: "save", label: "Save key", style: "primary" },
        { id: "cancel", label: "Not now", style: "plain" },
      ],
      payload: {
        type: "gateway",
        gateway: { ...preset, models: [GATEWAY_MODELS[provider]] },
        setup: true,
      },
    });
  }

  /**
   * A pairing code for the setup's last step, shown there and nowhere else: the chat starts
   * with the main agent's greeting, not with a card.
   */
  pairing(): { address: string; code: string; link: string } {
    const code = this.home.store.newPairingCode();
    const address = this.home.address();
    return { address, code, link: pairingLink(address, code) };
  }

  /** A card of the home itself in the main agent's chat. */
  private say(input: NewCard): Card {
    const { store } = this.home;
    const agent = store.mainAgent();
    const empty = store.addMessage({
      conversationId: agent.conversationId,
      role: "agent",
      agentId: agent.id,
      channel: "home",
      parts: [],
    });
    const card = store.createCard(input, {
      agentId: agent.id,
      conversationId: agent.conversationId,
      messageId: empty.id,
    });
    store.updateMessage(empty.id, { parts: [{ type: "card", card }] });
    return card;
  }

  // ── Test calls ────────────────────────────────────────────────────────────

  /** The kept outcome of each source's last test call. */
  private kept(): Record<string, Kept> {
    return JSON.parse(this.home.db.meta(TESTS) ?? "{}") as Record<string, Kept>;
  }

  private keep(id: string, probe: Omit<Kept, "at">): void {
    const all = this.kept();
    all[id] = { ...probe, at: new Date().toISOString() };
    this.home.db.setMeta(TESTS, JSON.stringify(all));
  }

  /** The test call of each source the home can test here. */
  private probes(): Map<string, () => Promise<Probe>> {
    const { models, config, secrets } = this.home;
    const probes = new Map<string, () => Promise<Probe>>();
    for (const client of this.clients) probes.set(client.id, () => probeClient(client));
    const account = models.account();
    if (account) {
      probes.set(ACCOUNT.id, () =>
        probeAccount(account, models.accountKey(), undefined, this.gatewayFetch),
      );
    }
    if (!isHosted(config)) probes.set("ollama", () => probeOllama(config.ollamaUrl, models.memory));
    for (const gateway of models.gateways()) {
      probes.set(gateway.id, () =>
        probeGateway(gateway, secrets.get(`gateway.${gateway.id}`), undefined, this.gatewayFetch),
      );
    }
    return probes;
  }

  /** Whether a test call runs now. */
  testing(): boolean {
    return this.running.size > 0;
  }

  /**
   * Makes the test calls again: of every source, or of one. A call that runs already is not
   * made twice. Resolves when they are done.
   */
  async test(source?: string): Promise<SetupView> {
    await this.home.models.refresh(true);
    const probes = [...this.probes()].filter(([id]) => !source || id === source);
    const runs = probes.map(([id, probe]) => {
      const already = this.running.get(id);
      if (already) return already;
      const run = (async () => {
        try {
          this.keep(id, await probe());
        } catch (error) {
          this.keep(id, { state: "problem", said: same((error as Error).message) });
        }
        // The sources may have changed with what was found: Ollama started, a client signed in.
        await this.home.models.refresh(true);
      })().finally(() => {
        this.running.delete(id);
        void this.changed().catch(() => {});
      });
      this.running.set(id, run);
      return run;
    });
    if (runs.length) void this.changed().catch(() => {});
    await Promise.all(runs);
    return this.view();
  }

  // ── A model for Ollama ────────────────────────────────────────────────────

  /**
   * Pulls one of the models the setup offers into this computer's Ollama, on the person's yes,
   * then tests Ollama. Answers at once; devices hear how far it is with `setup.updated`, about
   * once a second.
   */
  async pull(model: string): Promise<SetupView> {
    const { config } = this.home;
    if (isHosted(config) || !onThisComputer(config.ollamaUrl)) {
      throw new PullRefused("The Bot Server pulls models only into an Ollama on its own computer.");
    }
    if (!SUGGESTED.some((entry) => entry.model === model)) {
      throw new PullRefused(`The setup does not offer ${model}.`);
    }
    if (this.pulling?.state === "pulling") return this.view();
    this.pulling = { model, state: "pulling", done: 0, total: 0 };
    let told = 0;
    this.pullRun = pullModel(
      config.ollamaUrl,
      model,
      (done, total) => {
        this.pulling = { model, state: "pulling", done, total };
        if (Date.now() - told > 1000) {
          told = Date.now();
          void this.changed().catch(() => {});
        }
      },
      this.ollamaFetch ? { fetch: this.ollamaFetch } : {},
    )
      .then(
        async () => {
          const total = this.pulling?.total ?? 0;
          this.pulling = { model, state: "done", done: total, total };
          await this.test("ollama");
        },
        (error: Error) => {
          this.pulling = { model, state: "failed", done: 0, total: 0, error: error.message };
        },
      )
      .finally(() =>
        this.changed().then(
          () => {},
          () => {},
        ),
      );
    return this.changed();
  }

  /** Resolves when the pull that runs, and the test call after it, are done. */
  pulled(): Promise<void> {
    return this.pullRun;
  }

  /** Tells every device what the setup looks like now. */
  async changed(): Promise<SetupView> {
    const setup = await this.view();
    this.home.events.emit({ type: "setup.updated", setup });
    return setup;
  }

  // ── What the setup looks like ─────────────────────────────────────────────

  async view(): Promise<SetupView> {
    await this.home.models.refresh();
    const lang = langOf(this.home.db);
    const shown = ({ said, todo, ...check }: Check): SetupCheck => ({
      ...check,
      said: say(said, lang),
      ...(todo ? { todo: say(todo, lang) } : {}),
    });
    const found = await Promise.all(this.clients.map((client) => detectClient(client)));
    const installed = new Set(this.clients.filter((_, at) => found[at]?.version).map((c) => c.id));
    const models = this.modelChecks(installed).map(shown);
    const working = models.some((check) => check.state === "ok" || check.state === "warning");
    return {
      done: this.done(),
      name: {
        value: this.home.person(),
        confirmed: this.home.db.meta("person.named") === "1",
      },
      working,
      hasModel: this.home.models.candidates().length > 0,
      hosted: isHosted(this.home.config),
      models,
      home: [await this.address(), this.data(), this.folders(), this.push()].map(shown),
      capabilities: this.capabilities(models).map(shown),
      ...(this.pulling ? { pulling: this.pulling } : {}),
      ...(this.home.tunnel.available() ? { address: this.home.tunnel.view(lang) } : {}),
    };
  }

  /** `installed`: the clients found on this computer. */
  private modelChecks(installed: Set<string>): Check[] {
    const { models } = this.home;
    const kept = this.kept();
    const row = (id: string, label: string, untested: Words, more: Partial<Check> = {}): Check => {
      const last = kept[id];
      const base: Check = last
        ? {
            id,
            kind: "model",
            label,
            source: id,
            state: last.state,
            said: last.said,
            ...(last.todo ? { todo: last.todo } : {}),
            ...(last.command ? { command: last.command } : {}),
            ...(last.model ? { model: last.model } : {}),
            ...(last.pull ? { pull: last.pull } : {}),
            at: last.at,
          }
        : { id, kind: "model", label, source: id, state: "untested", said: untested };
      return { ...base, ...more, ...(this.running.has(id) ? { state: "testing" as const } : {}) };
    };
    const checks: Check[] = [];
    for (const client of this.clients) {
      const { name } = client;
      const here = installed.has(client.id);
      const last = kept[client.id];
      if (!here && !this.running.has(client.id) && (!last || last.state === "absent")) {
        checks.push({
          id: client.id,
          kind: "model",
          label: name,
          source: client.id,
          state: "absent",
          said: w(
            `${name} is not installed on this computer.`,
            `${name} ist auf diesem Computer nicht installiert.`,
          ),
          todo:
            client.id === "claude"
              ? w(
                  "Install Claude Code, then run claude and /login.",
                  "Installiere Claude Code, dann starte claude und /login.",
                )
              : w("Install Codex, then sign in.", "Installiere Codex, dann melde dich an."),
          command: client.id === "claude" ? "claude" : "codex login",
        });
        continue;
      }
      checks.push(
        row(
          client.id,
          name,
          w(
            `${name} is installed. It has not been tested yet.`,
            `${name} ist installiert, aber noch nicht getestet.`,
          ),
        ),
      );
    }
    if (models.account()) {
      checks.push(
        row(
          ACCOUNT.id,
          ACCOUNT.label,
          w(
            "Your wizards account has not been tested yet.",
            "Dein wizards-Konto ist noch nicht getestet.",
          ),
        ),
      );
    }
    const ollama = models.localSources().find((source) => source.id === "ollama");
    const lastOllama = kept.ollama;
    // A server has no Ollama of its own; the person's computer brings it over the link.
    const hosted = isHosted(this.home.config);
    if (!hosted && (ollama || lastOllama || this.running.has("ollama"))) {
      checks.push(
        row(
          "ollama",
          "Ollama",
          w(
            `Ollama runs with ${ollama?.models.length ?? 0} models. It has not been tested yet.`,
            `Ollama läuft mit ${ollama?.models.length ?? 0} Modellen, aber noch nicht getestet.`,
          ),
          // Ollama stopped since its last test call: what was found then no longer holds.
          !ollama && lastOllama?.state === "ok"
            ? {
                state: "absent",
                said: w(
                  `Ollama does not answer at ${this.home.config.ollamaUrl}.`,
                  `Ollama antwortet nicht unter ${this.home.config.ollamaUrl}.`,
                ),
                todo: w("Start Ollama.", "Starte Ollama."),
              }
            : {},
        ),
      );
    } else if (!hosted) {
      checks.push({
        id: "ollama",
        kind: "model",
        label: "Ollama",
        source: "ollama",
        state: "absent",
        said: w(
          `Ollama does not answer at ${this.home.config.ollamaUrl}.`,
          `Ollama antwortet nicht unter ${this.home.config.ollamaUrl}.`,
        ),
        todo: w(
          "Start Ollama, or install it from ollama.com.",
          "Starte Ollama, oder installiere es von ollama.com.",
        ),
      });
    }
    for (const gateway of models.gateways()) {
      checks.push(
        row(
          gateway.id,
          gateway.label,
          w(
            `${gateway.label} has not been tested yet.`,
            `${gateway.label} ist noch nicht getestet.`,
          ),
        ),
      );
    }
    const remote = models.remote?.sources() ?? [];
    for (const source of remote) {
      checks.push({
        id: source.id,
        kind: "model",
        label: source.label,
        source: source.id,
        state: source.online ? "ok" : "absent",
        said: source.online
          ? w(
              `${source.label} answers on ${source.where}, over the link.`,
              `${source.label} antwortet auf ${source.where}, über die Verbindung.`,
            )
          : w(
              `${source.where} is not linked right now.`,
              `${source.where} ist gerade nicht verbunden.`,
            ),
      });
    }
    if (hosted) checks.push(...this.hostedOptions(remote.length > 0));
    return checks;
  }

  /**
   * The two lines a hosted home offers besides the account: a key of the person's own, and
   * their computer's models over the link. Neither is needed; each goes once it is there.
   */
  private hostedOptions(linked: boolean): Check[] {
    const lines: Check[] = [];
    if (!this.home.models.gateways().length) {
      lines.push({
        id: "own-key",
        kind: "model",
        label: "A key of your own",
        state: "absent",
        said: w(
          "Your Bot Server uses your account's credits. A key of a gateway or a provider can answer too.",
          "Dein Bot Server nutzt die Credits deines Kontos. Ein Schlüssel eines Gateways oder Anbieters kann auch antworten.",
        ),
        todo: w(
          'Add it here, or tell your agent "add OpenRouter".',
          "Gib ihn hier ein, oder sag deinem Wizard „OpenRouter hinzufügen“.",
        ),
      });
    }
    if (!linked) {
      lines.push({
        id: "link",
        kind: "model",
        label: "Your computer",
        state: "absent",
        said: w(
          "Ollama, Claude or Codex on your computer can answer here while it is on.",
          "Ollama, Claude oder Codex auf deinem Computer können hier antworten, solange er läuft.",
        ),
        todo: w(
          "On your computer, link it with a code from Add a device.",
          "Verbinde ihn auf deinem Computer mit einem Code aus „Gerät hinzufügen“.",
        ),
        command: `wizards bot setup --link ${this.home.address()} <code>`,
      });
    }
    return lines;
  }

  /** Where a phone reaches the home, and whether something answers there. */
  private async address(): Promise<Check> {
    const address = this.home.address();
    const base = { id: "address", kind: "address" as const, label: "Address" };
    // Reached also away from this network: an address of its own, or the one at wizards.host.
    const away = Boolean(this.home.config.publicUrl || this.home.tunnel.address());
    if (!away && address.includes("//127.0.0.1:")) {
      return {
        ...base,
        state: "problem",
        said: w(
          "This computer has no address on a network, so a phone cannot reach your Bot Server.",
          "Dieser Computer hat keine Adresse in einem Netzwerk, daher erreicht ein Telefon deinen Bot Server nicht.",
        ),
        todo: w(
          "Join a Wi-Fi or a network, then start the Bot Server again.",
          "Verbinde dich mit einem WLAN oder Netzwerk, dann starte den Bot Server neu.",
        ),
      };
    }
    const answers = await fetch(`${address}/v1/home`, { signal: AbortSignal.timeout(1500) })
      .then((response) => response.ok)
      .catch(() => false);
    if (!answers) {
      return {
        ...base,
        state: "warning",
        said: w(`Nothing answers at ${address}.`, `Unter ${address} antwortet nichts.`),
        todo: w(
          "Start the Bot Server, and allow it in the computer's firewall if it asks.",
          "Starte den Bot Server, und erlaube ihn in der Firewall des Computers, wenn sie fragt.",
        ),
        command: "wizards-bot start",
      };
    }
    const phone = this.home.store
      .devices()
      .filter((device) => device.kind === "phone")
      .sort((a, b) => b.seenAt.localeCompare(a.seenAt))[0];
    return {
      ...base,
      state: "ok",
      said: away
        ? w(
            `Your Bot Server answers at ${address}, also away from this network.`,
            `Dein Bot Server antwortet unter ${address}, auch außerhalb dieses Netzwerks.`,
          )
        : w(
            `A phone on the same network reaches your Bot Server at ${address}.${phone ? ` ${phone.name} was last here on ${phone.seenAt.slice(0, 10)}.` : ""}`,
            `Ein Telefon im selben Netzwerk erreicht deinen Bot Server unter ${address}.${phone ? ` ${phone.name} war zuletzt am ${phone.seenAt.slice(0, 10)} hier.` : ""}`,
          ),
      ...(away
        ? {}
        : {
            todo: w(
              "Away from this network, your phone answers with its own model.",
              "Außerhalb dieses Netzwerks antwortet dein Telefon mit seinem eigenen Modell.",
            ),
          }),
    };
  }

  private data(): Check {
    const dir = this.home.config.dataDir;
    const base = { id: "data", kind: "data" as const, label: "Data folder" };
    if (temporary(dir)) {
      return {
        ...base,
        state: "warning",
        said: w(
          `Your Bot Server keeps its data in a temporary folder (${dir}). The computer may empty it.`,
          `Dein Bot Server legt seine Daten in einem temporären Ordner ab (${dir}). Der Computer leert ihn vielleicht.`,
        ),
        todo: w(
          "Start the Bot Server with WIZARDS_BOT_DATA set to a folder that stays, such as ~/.engenty/wizards-bot.",
          "Starte den Bot Server mit WIZARDS_BOT_DATA auf einem Ordner, der bleibt, etwa ~/.engenty/wizards-bot.",
        ),
      };
    }
    try {
      const space = statfsSync(dir);
      const free = space.bavail * space.bsize;
      if (free < 1e9) {
        return {
          ...base,
          state: "warning",
          said: w(
            `The disk of ${tilde(dir)} has less than 1 GB free.`,
            `Auf dem Laufwerk von ${tilde(dir)} ist weniger als 1 GB frei.`,
          ),
          todo: w(
            "Make room on the disk, or your Bot Server cannot keep new files.",
            "Schaff Platz auf dem Laufwerk, sonst kann dein Bot Server keine neuen Dateien behalten.",
          ),
        };
      }
    } catch {}
    return {
      ...base,
      state: "ok",
      said: w(
        `Your Bot Server keeps its data in ${tilde(dir)}.`,
        `Dein Bot Server legt seine Daten in ${tilde(dir)} ab.`,
      ),
    };
  }

  private folders(): Check {
    const folders = this.home.folders.list();
    const base = { id: "folders", kind: "folders" as const, label: "Connected folders" };
    if (!folders.length) {
      return {
        ...base,
        state: "absent",
        said: w("No folder is connected.", "Kein Ordner ist verbunden."),
        todo: w(
          "Connect a folder when you want your agents to read its files.",
          "Verbinde einen Ordner, wenn deine Wizards seine Dateien lesen sollen.",
        ),
      };
    }
    const gone = folders.filter((folder) => !existsSync(folder.path));
    const goneNames = gone.map((folder) => `${folder.name} (${tilde(folder.path)})`).join(", ");
    if (gone.length) {
      return {
        ...base,
        state: "problem",
        said: w(
          `${goneNames} ${gone.length === 1 ? "is" : "are"} no longer there.`,
          `${goneNames} ${gone.length === 1 ? "ist" : "sind"} nicht mehr da.`,
        ),
        todo: w(
          "Connect it again where it is now, or disconnect it in the settings.",
          "Verbinde ihn dort neu, wo er jetzt ist, oder trenne ihn in den Einstellungen.",
        ),
      };
    }
    return {
      ...base,
      state: "ok",
      said:
        folders.length === 1
          ? w(`${folders[0]?.name} is there.`, `${folders[0]?.name} ist da.`)
          : w(
              `All ${folders.length} connected folders are there.`,
              `Alle ${folders.length} verbundenen Ordner sind da.`,
            ),
    };
  }

  private push(): Check {
    const base = { id: "push", kind: "push" as const, label: "Notifications" };
    return this.home.notifier.key()
      ? {
          ...base,
          state: "ok",
          said: w(
            "Your phone is notified through Apple, also while the app is closed.",
            "Dein Telefon wird über Apple benachrichtigt, auch wenn die App geschlossen ist.",
          ),
        }
      : {
          ...base,
          state: "absent",
          said: w(
            "Without an Apple key, your phone is notified only while the app is open.",
            "Ohne Apple-Schlüssel wird dein Telefon nur benachrichtigt, solange die App offen ist.",
          ),
          todo: w(
            "Give the Bot Server your Apple key.",
            "Gib dem Bot Server deinen Apple-Schlüssel.",
          ),
          command: "wizards-bot push --key AuthKey.p8 --key-id <id> --team-id <id>",
        };
  }

  private capabilities(models: SetupCheck[]): Check[] {
    const answering = models.filter((check) => check.state === "ok" || check.state === "warning");
    const labels = (checks: SetupCheck[]) => checks.map((check) => check.label).join(", ");
    const untested = models.some(
      (check) => check.state === "untested" || check.state === "testing",
    );
    const text: Check = answering.length
      ? {
          id: "text",
          kind: "capability",
          label: "Text",
          state: "ok",
          said: w(
            `Your agents write with ${labels(answering)}.`,
            `Deine Wizards schreiben mit ${labels(answering)}.`,
          ),
        }
      : {
          id: "text",
          kind: "capability",
          label: "Text",
          state: untested ? "untested" : "problem",
          said: untested
            ? w("Not tested yet.", "Noch nicht getestet.")
            : w("No model answers yet.", "Noch antwortet kein Modell."),
        };
    const vision = this.home.models.forPictures();
    const seeing = answering.filter((check) =>
      check.id === "ollama"
        ? vision.here.length > 0
        : isSubscription(check.id) ||
          check.id === ACCOUNT.id ||
          this.home.models.gateways().some((g) => g.id === check.id),
    );
    const pictures: Check = seeing.length
      ? {
          id: "pictures",
          kind: "capability",
          label: "Reading pictures",
          state: "ok",
          said: w(
            `${labels(seeing)} ${seeing.length === 1 ? "reads" : "read"} pictures.${
              vision.here.length ? "" : " A photo of you goes there only after you said yes."
            }`,
            `${labels(seeing)} ${seeing.length === 1 ? "liest" : "lesen"} Bilder.${
              vision.here.length
                ? ""
                : " Ein Foto von dir geht erst dorthin, wenn du Ja gesagt hast."
            }`,
          ),
        }
      : {
          id: "pictures",
          kind: "capability",
          label: "Reading pictures",
          state: "absent",
          said: w(
            "No model that answers here reads pictures.",
            "Kein Modell, das hier antwortet, liest Bilder.",
          ),
          todo: w(
            "Claude, Codex or an Ollama model with vision can, e.g. ollama pull qwen2.5vl:7b.",
            "Claude, Codex oder ein Ollama-Modell mit Bildern kann es, z. B. ollama pull qwen2.5vl:7b.",
          ),
        };
    const phones = this.home.store
      .devices()
      .filter((device) => device.kind === "phone" && device.resources !== undefined);
    const phoneNames = phones.map((device) => device.name).join(", ");
    const phone: Check = phones.length
      ? {
          id: "phone",
          kind: "capability",
          label: "Your phone's model",
          state: "ok",
          said: w(
            `${phoneNames} ${phones.length === 1 ? "has" : "have"} a model of its own: it answers while your Bot Server is out of reach.`,
            `${phoneNames} ${phones.length === 1 ? "hat" : "haben"} ein eigenes Modell: Es antwortet, wenn dein Bot Server nicht erreichbar ist.`,
          ),
        }
      : {
          id: "phone",
          kind: "capability",
          label: "Your phone's model",
          state: "absent",
          said: w(
            "No phone has said it has a model of its own.",
            "Kein Telefon hat gesagt, dass es ein eigenes Modell hat.",
          ),
          todo: w(
            "An iPhone with Apple Intelligence does, once you add it.",
            "Ein iPhone mit Apple Intelligence hat eines, sobald du es hinzufügst.",
          ),
        };
    return [text, pictures, phone];
  }
}

/** One line: what answers, and what is wrong. */
export function summary(setup: SetupView): string {
  const answering = setup.models.filter(
    (check) => check.state === "ok" || check.state === "warning",
  );
  const problems = [...setup.models, ...setup.home].filter((check) => check.state === "problem");
  const warnings = setup.home.filter((check) => check.state === "warning");
  const tested = setup.models
    .map((check) => check.at)
    .filter((at): at is string => Boolean(at))
    .sort()
    .at(-1);
  const parts = [
    answering.length
      ? `${answering.map((check) => check.label).join(", ")} ${answering.length === 1 ? "answers" : "answer"}`
      : tested
        ? "no model answers"
        : "not tested yet",
    ...(problems.length
      ? [
          `${problems.length} ${problems.length === 1 ? "problem" : "problems"} (${problems.map((check) => check.label).join(", ")})`,
        ]
      : []),
    ...(warnings.length
      ? [`look at: ${warnings.map((check) => check.label.toLowerCase()).join(", ")}`]
      : []),
    ...(tested ? [`tested ${tested.slice(0, 16).replace("T", " ")} UTC`] : []),
  ];
  return parts.join(" · ");
}
