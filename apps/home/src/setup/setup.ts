import { existsSync, realpathSync, statfsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import type { Card, SetupCheck, Setup as SetupView } from "@wizards-bot/protocol";
import { isHosted } from "../config.ts";
import type { Home } from "../home.ts";
import { ACCOUNT, GATEWAY_PRESETS } from "../models/models.ts";
import { CLIENTS, type Client, type SubscriptionClient } from "../models/subscription.ts";
import type { NewCard } from "../store/store.ts";
import {
  installed,
  type Probe,
  probeAccount,
  probeClient,
  probeGateway,
  probeOllama,
} from "./probes.ts";

/** A test call's outcome as the home keeps it, with its time. */
interface Kept extends Probe {
  at: string;
}

const TESTS = "setup.tests";

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

const NAMES: Record<SubscriptionClient, string> = { claude: "Claude Code", codex: "Codex" };

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

  constructor(home: Home) {
    this.home = home;
    // A hosted home runs on a server: no one signs in to a subscription there.
    this.clients = isHosted(home.config)
      ? []
      : (Object.keys(CLIENTS) as SubscriptionClient[])
          .filter((id) => home.config.subscriptions.includes(id))
          .map((id) => CLIENTS[id]);
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

  async change(input: { name?: string; done?: boolean }): Promise<SetupView> {
    if (input.name) {
      this.home.db.setMeta("person.name", input.name);
      this.home.db.setMeta("person.named", "1");
    }
    if (input.done) this.home.db.setMeta("setup.done", new Date().toISOString());
    return this.changed();
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

  /** Puts a pairing card into the main agent's chat, as the agent's `device_pair` does. */
  pairingCard() {
    const code = this.home.store.newPairingCode();
    const address = this.home.address();
    return this.say({
      kind: "pairing",
      level: "update",
      title: "Add a device",
      body: `Scan this with the wizards.bot app, or enter the address \`${address}\` and the code **${code}**. The code works once, for 10 minutes.`,
      qr: `wizardsbot://pair?home=${encodeURIComponent(address)}&code=${code}`,
      actions: [],
    });
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

  private keep(id: string, probe: Probe): void {
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
          this.keep(id, { state: "problem", said: (error as Error).message });
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

  /** Tells every device what the setup looks like now. */
  private async changed(): Promise<SetupView> {
    const setup = await this.view();
    this.home.events.emit({ type: "setup.updated", setup });
    return setup;
  }

  // ── What the setup looks like ─────────────────────────────────────────────

  async view(): Promise<SetupView> {
    await this.home.models.refresh();
    const models = this.modelChecks();
    const working = models.some((check) => check.state === "ok" || check.state === "warning");
    return {
      done: this.done(),
      name: {
        value: this.home.person(),
        confirmed: this.home.db.meta("person.named") === "1",
      },
      working,
      hasModel: this.home.models.candidates().length > 0,
      models,
      home: [await this.address(), this.data(), this.folders(), this.push()],
      capabilities: this.capabilities(models),
    };
  }

  private modelChecks(): SetupCheck[] {
    const { models } = this.home;
    const kept = this.kept();
    const row = (
      id: string,
      label: string,
      untested: string,
      more: Partial<SetupCheck> = {},
    ): SetupCheck => {
      const last = kept[id];
      const base: SetupCheck = last
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
            at: last.at,
          }
        : { id, kind: "model", label, source: id, state: "untested", said: untested };
      return { ...base, ...more, ...(this.running.has(id) ? { state: "testing" as const } : {}) };
    };
    const checks: SetupCheck[] = [];
    for (const client of this.clients) {
      const name = NAMES[client.id];
      const here = installed(client.bin);
      const last = kept[client.id];
      if (!here && !this.running.has(client.id) && (!last || last.state === "absent")) {
        checks.push({
          id: client.id,
          kind: "model",
          label: name,
          source: client.id,
          state: "absent",
          said: `${name} is not installed on this computer.`,
          todo:
            client.id === "claude"
              ? "Install Claude Code, then run claude and /login."
              : "Install Codex, then sign in.",
          command: client.id === "claude" ? "claude" : "codex login",
        });
        continue;
      }
      checks.push(row(client.id, name, `${name} is installed. It has not been tested yet.`));
    }
    if (models.account()) {
      checks.push(row(ACCOUNT.id, ACCOUNT.label, "Your wizards account has not been tested yet."));
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
          `Ollama runs with ${ollama?.models.length ?? 0} models. It has not been tested yet.`,
          // Ollama stopped since its last test call: what was found then no longer holds.
          !ollama && lastOllama?.state === "ok"
            ? {
                state: "absent",
                said: `Ollama does not answer at ${this.home.config.ollamaUrl}.`,
                todo: "Start Ollama.",
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
        said: `Ollama does not answer at ${this.home.config.ollamaUrl}.`,
        todo: "Start Ollama, or install it from ollama.com.",
      });
    }
    for (const gateway of models.gateways()) {
      checks.push(row(gateway.id, gateway.label, `${gateway.label} has not been tested yet.`));
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
          ? `${source.label} answers on ${source.where}, over the link.`
          : `${source.where} is not linked right now.`,
      });
    }
    if (hosted) checks.push(...this.hostedOptions(remote.length > 0));
    return checks;
  }

  /**
   * The two lines a hosted home offers besides the account: a key of the person's own, and
   * their computer's models over the link. Neither is needed; each goes once it is there.
   */
  private hostedOptions(linked: boolean): SetupCheck[] {
    const lines: SetupCheck[] = [];
    if (!this.home.models.gateways().length) {
      lines.push({
        id: "own-key",
        kind: "model",
        label: "A key of your own",
        state: "absent",
        said: "Your Bot Server uses your account's credits. A key of a gateway or a provider can answer too.",
        todo: 'Add it here, or tell your agent "add OpenRouter".',
      });
    }
    if (!linked) {
      lines.push({
        id: "link",
        kind: "model",
        label: "Your computer",
        state: "absent",
        said: "Ollama, Claude or Codex on your computer can answer here while it is on.",
        todo: "On your computer, link it with a code from Add a device.",
        command: `wizards bot setup --link ${this.home.address()} <code>`,
      });
    }
    return lines;
  }

  /** Where a phone reaches the home, and whether something answers there. */
  private async address(): Promise<SetupCheck> {
    const address = this.home.address();
    const base = { id: "address", kind: "address" as const, label: "Address" };
    if (!this.home.config.publicUrl && address.includes("//127.0.0.1:")) {
      return {
        ...base,
        state: "problem",
        said: "This computer has no address on a network, so a phone cannot reach your Bot Server.",
        todo: "Join a Wi-Fi or a network, then start the Bot Server again.",
      };
    }
    const answers = await fetch(`${address}/v1/home`, { signal: AbortSignal.timeout(1500) })
      .then((response) => response.ok)
      .catch(() => false);
    if (!answers) {
      return {
        ...base,
        state: "warning",
        said: `Nothing answers at ${address}.`,
        todo: "Start the Bot Server, and allow it in the computer's firewall if it asks.",
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
      said: this.home.config.publicUrl
        ? `Your Bot Server answers at ${address}, also away from this network.`
        : `A phone on the same network reaches your Bot Server at ${address}.${phone ? ` ${phone.name} was last here on ${phone.seenAt.slice(0, 10)}.` : ""}`,
      ...(this.home.config.publicUrl
        ? {}
        : { todo: "Away from this network, your phone answers with its own model." }),
    };
  }

  private data(): SetupCheck {
    const dir = this.home.config.dataDir;
    const base = { id: "data", kind: "data" as const, label: "Data folder" };
    if (temporary(dir)) {
      return {
        ...base,
        state: "warning",
        said: `Your Bot Server keeps its data in a temporary folder (${dir}). The computer may empty it.`,
        todo: "Start the Bot Server with WIZARDS_BOT_DATA set to a folder that stays, such as ~/.wizards-bot.",
      };
    }
    try {
      const space = statfsSync(dir);
      const free = space.bavail * space.bsize;
      if (free < 1e9) {
        return {
          ...base,
          state: "warning",
          said: `The disk of ${tilde(dir)} has less than 1 GB free.`,
          todo: "Make room on the disk, or your Bot Server cannot keep new files.",
        };
      }
    } catch {}
    return { ...base, state: "ok", said: `Your Bot Server keeps its data in ${tilde(dir)}.` };
  }

  private folders(): SetupCheck {
    const folders = this.home.folders.list();
    const base = { id: "folders", kind: "folders" as const, label: "Connected folders" };
    if (!folders.length) {
      return {
        ...base,
        state: "absent",
        said: "No folder is connected.",
        todo: "Connect a folder when you want your agents to read its files.",
      };
    }
    const gone = folders.filter((folder) => !existsSync(folder.path));
    if (gone.length) {
      return {
        ...base,
        state: "problem",
        said: `${gone.map((folder) => `${folder.name} (${tilde(folder.path)})`).join(", ")} ${gone.length === 1 ? "is" : "are"} no longer there.`,
        todo: "Connect it again where it is now, or disconnect it in the settings.",
      };
    }
    return {
      ...base,
      state: "ok",
      said:
        folders.length === 1
          ? `${folders[0]?.name} is there.`
          : `All ${folders.length} connected folders are there.`,
    };
  }

  private push(): SetupCheck {
    const base = { id: "push", kind: "push" as const, label: "Notifications" };
    return this.home.notifier.key()
      ? {
          ...base,
          state: "ok",
          said: "Your phone is notified through Apple, also while the app is closed.",
        }
      : {
          ...base,
          state: "absent",
          said: "Without an Apple key, your phone is notified only while the app is open.",
          todo: "Give the Bot Server your Apple key.",
          command: "wizards-bot push --key AuthKey.p8 --key-id <id> --team-id <id>",
        };
  }

  private capabilities(models: SetupCheck[]): SetupCheck[] {
    const answering = models.filter((check) => check.state === "ok" || check.state === "warning");
    const labels = (checks: SetupCheck[]) => checks.map((check) => check.label).join(", ");
    const untested = models.some(
      (check) => check.state === "untested" || check.state === "testing",
    );
    const text: SetupCheck = answering.length
      ? {
          id: "text",
          kind: "capability",
          label: "Text",
          state: "ok",
          said: `Your agents write with ${labels(answering)}.`,
        }
      : {
          id: "text",
          kind: "capability",
          label: "Text",
          state: untested ? "untested" : "problem",
          said: untested ? "Not tested yet." : "No model answers yet.",
        };
    const vision = this.home.models.forPictures();
    const seeing = answering.filter((check) =>
      check.id === "ollama"
        ? vision.here.length > 0
        : check.id in CLIENTS ||
          check.id === ACCOUNT.id ||
          this.home.models.gateways().some((g) => g.id === check.id),
    );
    const pictures: SetupCheck = seeing.length
      ? {
          id: "pictures",
          kind: "capability",
          label: "Reading pictures",
          state: "ok",
          said: `${labels(seeing)} ${seeing.length === 1 ? "reads" : "read"} pictures.${
            vision.here.length ? "" : " A photo of you goes there only after you said yes."
          }`,
        }
      : {
          id: "pictures",
          kind: "capability",
          label: "Reading pictures",
          state: "absent",
          said: "No model that answers here reads pictures.",
          todo: "Claude, Codex or an Ollama model with vision can, e.g. ollama pull qwen2.5vl:7b.",
        };
    const phones = this.home.store
      .devices()
      .filter((device) => device.kind === "phone" && device.resources !== undefined);
    const phone: SetupCheck = phones.length
      ? {
          id: "phone",
          kind: "capability",
          label: "Your phone's model",
          state: "ok",
          said: `${phones.map((device) => device.name).join(", ")} ${phones.length === 1 ? "has" : "have"} a model of its own: it answers while your Bot Server is out of reach.`,
        }
      : {
          id: "phone",
          kind: "capability",
          label: "Your phone's model",
          state: "absent",
          said: "No phone has said it has a model of its own.",
          todo: "An iPhone with Apple Intelligence does, once you add it.",
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
