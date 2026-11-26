import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Client } from "@engenty/model-providers/clients";
import { installedModels } from "@engenty/model-providers/ollama";
import { CLIENT_TIMEOUT, PROMPT, probe, SERVER_TIMEOUT } from "@engenty/model-providers/probe";
import { fits, SERVERS, type ServerId } from "@engenty/model-providers/servers";
import type { LanguageModel } from "ai";
import { generateText } from "ai";
import type { Account, Gateway } from "../models/models.ts";
import { ACCOUNT, accountModel, gatewayModel } from "../models/models.ts";
import { chatModels, MEMORY_SHARE, onThisComputer, suggestedModel } from "../models/ollama.ts";
import {
  claudeSignedOut,
  clientSignedOut,
  codexSignedOut,
  explainAccount,
  explainClaude,
  explainClient,
  explainCodex,
  explainGateway,
  explainOllama,
  type Finding,
  silent,
} from "./explain.ts";
import { type Words, w } from "./words.ts";

// One test call per model source: a tiny prompt, a timeout, and what came of it. Each call
// costs a few tokens, so the home makes them when the person asks and at the first start,
// never on a timer. The calls to a client and to Ollama are `@engenty/model-providers`' probe;
// what they mean for the person is said here.

export type ProbeState = "ok" | "warning" | "problem" | "absent";

export interface Probe extends Finding {
  state: ProbeState;
  /** The model that was asked. */
  model?: string;
  /** A model the home can pull into this computer's Ollama itself. */
  pull?: { model: string; size: number };
}

export const GATEWAY_TIMEOUT = 30_000;

/** The model `~/.codex/config.toml` sets, and whether it goes through Ollama. */
export function codexSetting(home = process.env.CODEX_HOME ?? join(homedir(), ".codex")): {
  model?: string;
  ollama: boolean;
} {
  const file = join(home, "config.toml");
  if (!existsSync(file)) return { ollama: false };
  // Only the top of the file sets the default; a [section] starts what is not.
  const top = (readFileSync(file, "utf8").split(/^\s*\[/m)[0] ?? "").split("\n");
  const value = (key: string) =>
    top
      .map((line) => line.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`))?.[1])
      .find((found) => found !== undefined);
  const model = value("model");
  const provider = value("model_provider");
  return {
    model,
    ollama: /ollama/i.test(provider ?? "") || /:cloud$|-cloud$/.test(model ?? ""),
  };
}

/** How a client that is not there gets there: the setup installs it and signs it in. */
export function clientMissing({ id, name, bin }: Client): { todo: Words; command: string } {
  if (id === "claude") {
    return {
      todo: w(
        "Install Claude Code, then run claude and /login.",
        "Installiere Claude Code, dann starte claude und /login.",
      ),
      command: "claude",
    };
  }
  return {
    todo: w(`Install ${name}, then sign in.`, `Installiere ${name}, dann melde dich an.`),
    command: id === "antigravity" ? bin : `${bin} login`,
  };
}

/** What a client is signed in with again. */
function signedOut(client: Client): Finding {
  switch (client.id) {
    case "claude":
      return claudeSignedOut();
    case "codex":
      return codexSignedOut();
    default:
      return clientSignedOut(client);
  }
}

/** A test call to an installed client on this computer. */
export async function probeClient(
  client: Client,
  timeout = CLIENT_TIMEOUT,
  /** The model the person named; `default` and none: the client picks. */
  named?: string,
): Promise<Probe> {
  const { name } = client;
  const install = clientMissing(client);
  const notInstalled = w(
    `${name} is not installed on this computer.`,
    `${name} ist auf diesem Computer nicht installiert.`,
  );
  const codex = client.id === "codex" ? codexSetting() : undefined;
  const model = named && named !== "default" ? { model: named } : {};
  const result = await probe({ kind: "client", client, ...model, timeoutMs: timeout });
  if (result.state === "ok") {
    return client.tools
      ? {
          ...model,
          state: "ok",
          said: w(`${name} answers on your subscription.`, `${name} antwortet über dein Abo.`),
        }
      : {
          ...model,
          state: "warning",
          said: w(
            `${name} answers on your subscription, but takes no tools: an agent with it can talk, not act.`,
            `${name} antwortet über dein Abo, nimmt aber keine Werkzeuge: Ein Wizard damit kann reden, nicht handeln.`,
          ),
        };
  }
  if (result.state === "absent") {
    return { state: "absent", said: notInstalled, ...install };
  }
  if (result.timedOut) {
    return {
      state: "problem",
      said: w(
        `${name} did not answer within ${Math.round(timeout / 1000)} seconds.`,
        `${name} hat nicht innerhalb von ${Math.round(timeout / 1000)} Sekunden geantwortet.`,
      ),
      todo: w(
        `Run ${client.bin} once in a terminal to see what it asks for.`,
        `Starte ${client.bin} einmal in einem Terminal, um zu sehen, was es braucht.`,
      ),
      command: client.bin,
    };
  }
  // Signed out without a call: the client's own status said so.
  if (result.state === "signed_out" && !result.detail) {
    return { state: "problem", ...signedOut(client) };
  }
  const detail = result.detail ?? "";
  const finding =
    client.id === "claude"
      ? explainClaude(detail)
      : client.id === "codex"
        ? explainCodex(detail, codex?.ollama ? codex.model : undefined)
        : explainClient(client, detail);
  return { state: "problem", ...finding };
}

const gb = (bytes: number) => `${Math.round(bytes / 1e9)} GB`;

/** A test call to the model the home would ask first on this computer's Ollama. */
export async function probeOllama(
  baseUrl: string,
  memory: number,
  doFetch: typeof fetch = fetch,
  timeout = SERVER_TIMEOUT,
  /** The model the person named; the one the home would ask first otherwise. */
  named?: string,
): Promise<Probe> {
  const local = onThisComputer(baseUrl);
  // On this computer the model has to leave it room; elsewhere the home cannot tell.
  const result = await probe({
    kind: "server",
    server: "ollama",
    url: baseUrl,
    ...(named ? { model: named } : {}),
    fetch: doFetch,
    timeoutMs: timeout,
    ...(local ? { memory, share: MEMORY_SHARE } : {}),
  });
  if (result.state === "absent") {
    return {
      state: "absent",
      said: w(`Ollama does not answer at ${baseUrl}.`, `Ollama antwortet nicht unter ${baseUrl}.`),
      todo: w(
        "Start Ollama, or install it from ollama.com.",
        "Starte Ollama, oder installiere es von ollama.com.",
      ),
      command: "ollama serve",
    };
  }
  // On this computer the home pulls a model itself, the largest that leaves the computer room.
  const suggested = suggestedModel(local ? memory : Number.POSITIVE_INFINITY);
  const pull = local ? { pull: suggested } : {};
  const model = result.model ?? "";
  if (result.state === "no_model") {
    return {
      state: "problem",
      said: w(
        "Ollama runs, but it has no model to talk with.",
        "Ollama läuft, hat aber kein Modell zum Sprechen.",
      ),
      todo: w(
        `Pull a model with tools, e.g. ollama pull ${suggested.model}.`,
        `Lade ein Modell mit Werkzeugen, z. B. ollama pull ${suggested.model}.`,
      ),
      command: `ollama pull ${suggested.model}`,
      ...pull,
    };
  }
  const asked = (await installedModels(baseUrl, { fetch: doFetch })).find((m) => m.name === model);
  if (result.state === "too_big") {
    const size = asked?.size ?? 0;
    return {
      state: "problem",
      model,
      said: w(
        `${model} needs ${gb(size)}. On this computer the Bot Server takes a model of up to ${gb(memory * MEMORY_SHARE)}, a little over half of its ${gb(memory)} of memory, so the computer stays quick.`,
        `${model} braucht ${gb(size)}. Auf diesem Computer nimmt der Bot Server ein Modell bis ${gb(memory * MEMORY_SHARE)}, gut die Hälfte seiner ${gb(memory)} Arbeitsspeicher, damit der Computer flüssig bleibt.`,
      ),
      todo: w(
        `Pull a smaller model with tools, e.g. ollama pull ${suggested.model}.`,
        `Lade ein kleineres Modell mit Werkzeugen, z. B. ollama pull ${suggested.model}.`,
      ),
      command: `ollama pull ${suggested.model}`,
      ...pull,
    };
  }
  if (result.state !== "ok") {
    return {
      state: "problem",
      model,
      ...(result.timedOut
        ? {
            said: w(
              `${model} did not answer within ${Math.round(timeout / 1000)} seconds.`,
              `${model} hat nicht innerhalb von ${Math.round(timeout / 1000)} Sekunden geantwortet.`,
            ),
            todo: w(
              "The computer may be short of memory. Try a smaller model.",
              "Dem Computer fehlt vielleicht Arbeitsspeicher. Versuch ein kleineres Modell.",
            ),
          }
        : explainOllama(result.detail ?? "", model)),
    };
  }
  const tools = asked?.tools ?? false;
  return {
    state: tools ? "ok" : "warning",
    model,
    said: tools
      ? w(
          `${model} answers on ${local ? "this computer" : baseUrl}.`,
          `${model} antwortet ${local ? "auf diesem Computer" : `unter ${baseUrl}`}.`,
        )
      : w(
          `${model} answers, but takes no tools: an agent with it can talk, not act.`,
          `${model} antwortet, nimmt aber keine Werkzeuge: Ein Wizard damit kann reden, nicht handeln.`,
        ),
    ...(tools
      ? {}
      : {
          todo: w(
            `Pull a model with tools, e.g. ollama pull ${suggested.model}.`,
            `Lade ein Modell mit Werkzeugen, z. B. ollama pull ${suggested.model}.`,
          ),
          command: `ollama pull ${suggested.model}`,
          ...pull,
        }),
  };
}

/** A test call to a model of this computer's LM Studio or MLX, which loads it. */
export async function probeServer(
  server: Exclude<ServerId, "ollama">,
  baseUrl: string,
  memory: number,
  named?: string,
  doFetch: typeof fetch = fetch,
  timeout = SERVER_TIMEOUT,
): Promise<Probe> {
  const local = server === "mlx" || onThisComputer(baseUrl);
  const { name } = SERVERS[server];
  const result = await probe({
    kind: "server",
    server,
    url: baseUrl,
    ...(named ? { model: named } : {}),
    fetch: doFetch,
    timeoutMs: timeout,
    ...(local ? { memory, share: MEMORY_SHARE } : {}),
  });
  const model = result.model ?? "";
  const problem = (said: Words, todo: Words): Probe => ({
    state: "problem",
    ...(model ? { model } : {}),
    said,
    todo,
  });
  if (result.state === "absent") {
    return {
      state: "absent",
      said: w(`${name} does not answer.`, `${name} antwortet nicht.`),
      todo: w("Start it in the setup.", "Starte es in der Einrichtung."),
    };
  }
  if (result.trouble === "locked") {
    return problem(
      w(`${name} asks for an API token.`, `${name} verlangt ein API-Token.`),
      w(
        "Switch that off in its server settings.",
        "Schalte das in seinen Server-Einstellungen ab.",
      ),
    );
  }
  if (result.trouble === "old") {
    return problem(
      w(`This ${name} is too old.`, `Dieses ${name} ist zu alt.`),
      w(`Update ${name}.`, `Aktualisiere ${name}.`),
    );
  }
  if (result.state === "no_model") {
    return problem(
      w(`${name} has no model to talk with yet.`, `${name} hat noch kein Modell zum Sprechen.`),
      w("Download one in the setup.", "Lade eines in der Einrichtung."),
    );
  }
  if (result.state === "too_big") {
    return problem(
      w(
        `${model} is too large for this computer's memory. The Bot Server takes a model of up to ${gb(memory * MEMORY_SHARE)} here.`,
        `${model} ist zu groß für den Arbeitsspeicher dieses Computers. Der Bot Server nimmt hier ein Modell bis ${gb(memory * MEMORY_SHARE)}.`,
      ),
      w("Choose a smaller model.", "Wähle ein kleineres Modell."),
    );
  }
  if (result.state !== "ok") {
    return result.timedOut
      ? problem(
          w(
            `${model} did not answer within ${Math.round(timeout / 1000)} seconds.`,
            `${model} hat nicht innerhalb von ${Math.round(timeout / 1000)} Sekunden geantwortet.`,
          ),
          w(
            "The computer may be short of memory. Try a smaller model.",
            "Dem Computer fehlt vielleicht Arbeitsspeicher. Versuch ein kleineres Modell.",
          ),
        )
      : { state: "problem", model, said: silent(model, result.detail ?? "") };
  }
  const held = await SERVERS[server].models(baseUrl, { fetch: doFetch });
  return held.find((entry) => entry.name === model)?.tools
    ? {
        state: "ok",
        model,
        said: w(`${model} answers on this computer.`, `${model} antwortet auf diesem Computer.`),
      }
    : {
        state: "warning",
        model,
        said: w(
          `${model} answers, but takes no tools: an agent with it can talk, not act.`,
          `${model} antwortet, nimmt aber keine Werkzeuge: Ein Wizard damit kann reden, nicht handeln.`,
        ),
      };
}

/**
 * An Ollama nobody picked, looked at without a call, so that no model is loaded: what is wrong
 * with it, or nothing when it has a model the person can use.
 */
export async function lookAtOllama(
  baseUrl: string,
  memory: number,
  doFetch: typeof fetch = fetch,
): Promise<Probe | undefined> {
  const local = onThisComputer(baseUrl);
  const first = (await chatModels(baseUrl, local ? memory : undefined, doFetch))[0];
  if (first && (!local || fits(first, memory, MEMORY_SHARE))) return undefined;
  // Without a model that fits, the test call ends before it asks one.
  return probeOllama(baseUrl, memory, doFetch);
}

/** A test call through a gateway with its key. */
export async function probeGateway(
  gateway: Gateway,
  key: string | undefined,
  timeout = GATEWAY_TIMEOUT,
  doFetch?: typeof fetch,
  /** The model the person named; the gateway's first otherwise. */
  named?: string,
): Promise<Probe> {
  const model = named ?? gateway.models[0];
  if (!key) {
    return {
      state: "problem",
      said: w(`${gateway.label} has no key.`, `${gateway.label} hat keinen Schlüssel.`),
      todo: w(
        `Tell your agent "add ${gateway.label}", or add the key in the setup.`,
        `Sag deinem Wizard „${gateway.label} hinzufügen“, oder gib den Schlüssel in der Einrichtung ein.`,
      ),
    };
  }
  if (!model) {
    return {
      state: "problem",
      said: w(`${gateway.label} has no model.`, `${gateway.label} hat kein Modell.`),
      todo: w(
        `Tell your agent "add ${gateway.label}" with a model.`,
        `Sag deinem Wizard „${gateway.label} hinzufügen“ mit einem Modell.`,
      ),
    };
  }
  return probeModel(gateway.label, model, gatewayModel(gateway, key, model, doFetch), timeout);
}

/** A test call to the wizards account's gateway with the home's key. */
export async function probeAccount(
  account: Account,
  key: string | undefined,
  timeout = GATEWAY_TIMEOUT,
  doFetch?: typeof fetch,
  /** The class the person named; the first otherwise. */
  model: string = ACCOUNT.models[0],
): Promise<Probe> {
  if (!key) {
    return {
      state: "problem",
      said: w(
        "Your Bot Server has no key for your wizards account.",
        "Dein Bot Server hat keinen Schlüssel für dein wizards-Konto.",
      ),
      todo: w(
        "Ask for help at wizards.bot: the Bot Server could not fetch its key.",
        "Frag bei wizards.bot nach Hilfe: Der Bot Server konnte seinen Schlüssel nicht holen.",
      ),
    };
  }
  return probeModel(
    "Your wizards account",
    model,
    accountModel(account, key, model, doFetch),
    timeout,
    explainAccount,
  );
}

/** One short call to a model of the cloud, and what came of it. */
async function probeModel(
  label: string,
  model: string,
  chat: LanguageModel,
  timeout: number,
  explain: typeof explainGateway = explainGateway,
): Promise<Probe> {
  try {
    await generateText({
      model: chat,
      prompt: PROMPT,
      maxOutputTokens: 16,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(timeout),
    });
    return {
      state: "ok",
      model,
      said: w(`${label} answers with ${model}.`, `${label} antwortet mit ${model}.`),
    };
  } catch (error) {
    const failure = error as Error & { statusCode?: number; responseBody?: string };
    if (failure.name === "TimeoutError" || failure.name === "AbortError") {
      return {
        state: "problem",
        model,
        said: w(
          `${label} did not answer within ${Math.round(timeout / 1000)} seconds.`,
          `${label} hat nicht innerhalb von ${Math.round(timeout / 1000)} Sekunden geantwortet.`,
        ),
        todo: w("Test again later.", "Teste später noch einmal."),
      };
    }
    return {
      state: "problem",
      model,
      ...explain(
        label,
        `${failure.message} ${failure.responseBody ?? ""}`,
        failure.statusCode,
        model,
      ),
    };
  }
}
