import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { generateText } from "ai";
import type { Account, Gateway } from "../models/models.ts";
import { ACCOUNT, accountModel, clientEnv } from "../models/models.ts";
import { ollamaModels } from "../models/ollama.ts";
import type { Client } from "../models/subscription.ts";
import {
  explainAccount,
  explainClaude,
  explainCodex,
  explainGateway,
  explainOllama,
  type Finding,
} from "./explain.ts";

// One test call per model source: a tiny prompt, a timeout, and what came of it. Each call
// costs a few tokens, so the home makes them when the person asks and at the first start,
// never on a timer.

export type ProbeState = "ok" | "warning" | "problem" | "absent";

export interface Probe extends Finding {
  state: ProbeState;
  /** The model that was asked. */
  model?: string;
}

const PROMPT = "Answer with the single word ok.";
const SYSTEM = "You check whether you can answer. Answer with one word.";

export const CLIENT_TIMEOUT = 90_000;
export const OLLAMA_TIMEOUT = 120_000;
export const GATEWAY_TIMEOUT = 30_000;

/** Whether a program is installed: on the PATH, or at its path. */
export function installed(bin: string): boolean {
  if (bin.includes("/")) return existsSync(bin);
  return spawnSync("which", [bin], { stdio: "ignore" }).status === 0;
}

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

/** The arguments of a turn, without the home's MCP server: a test call needs no tools. */
function withoutTools(args: string[]): string[] {
  const kept: string[] = [];
  for (let at = 0; at < args.length; at++) {
    if (args[at] === "-c" && args[at + 1]?.startsWith("mcp_servers.")) {
      at++;
      continue;
    }
    kept.push(args[at] as string);
  }
  return kept;
}

/** What one run of an installed client said: its answer, or why there is none. */
export async function runOnce(
  client: Client,
  timeout: number,
): Promise<{ answer: string } | { failure: string; timedOut?: boolean; missing?: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), "wizards-bot-check-"));
  const mcpConfigFile = join(dir, "mcp.json");
  writeFileSync(mcpConfigFile, JSON.stringify({ mcpServers: {} }), { mode: 0o600 });
  const call = {
    system: SYSTEM,
    message: PROMPT,
    session: null,
    mcpUrl: "http://127.0.0.1:9/mcp",
    mcpConfigFile,
    images: [],
  };
  try {
    return await new Promise((resolve) => {
      const child = spawn(client.bin, withoutTools(client.args(call)), {
        cwd: dir,
        env: clientEnv(process.env, {}),
        stdio: ["pipe", "pipe", "pipe"],
      });
      const parse = client.parser();
      let answer = "";
      let failed: string | undefined;
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeout);
      child.stdin.on("error", () => {});
      child.stdin.end(client.stdin(call));
      createInterface({ input: child.stdout }).on("line", (line) => {
        for (const event of parse(line)) {
          if (event.kind === "failure") failed = event.detail;
          else if (event.kind === "text" || event.kind === "delta") answer += event.text;
          else if (event.kind === "result" && !answer) answer = event.text;
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4000);
      });
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        resolve({ failure: error.message, missing: error.code === "ENOENT" });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) return resolve({ failure: "", timedOut: true });
        if (failed !== undefined) return resolve({ failure: failed });
        if (answer.trim()) return resolve({ answer: answer.trim() });
        // Some failures reach only the error output, with a code or without.
        resolve({ failure: stderr.trim() || `${client.name} ended with code ${code}.` });
      });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A test call to Claude Code or Codex on this computer. */
export async function probeClient(client: Client, timeout = CLIENT_TIMEOUT): Promise<Probe> {
  const name = client.id === "claude" ? "Claude Code" : "Codex";
  const install =
    client.id === "claude"
      ? { todo: "Install Claude Code, then run claude and /login.", command: "claude" }
      : { todo: "Install Codex, then sign in.", command: "codex login" };
  if (!installed(client.bin)) {
    return { state: "absent", said: `${name} is not installed on this computer.`, ...install };
  }
  const codex = client.id === "codex" ? codexSetting() : undefined;
  const run = await runOnce(client, timeout);
  if ("answer" in run) return { state: "ok", said: `${name} answers on your subscription.` };
  if (run.missing) {
    return { state: "absent", said: `${name} is not installed on this computer.`, ...install };
  }
  if (run.timedOut) {
    return {
      state: "problem",
      said: `${name} did not answer within ${Math.round(timeout / 1000)} seconds.`,
      todo: `Run ${client.bin} once in a terminal to see what it asks for.`,
      command: client.bin,
    };
  }
  const finding =
    client.id === "claude"
      ? explainClaude(run.failure)
      : explainCodex(run.failure, codex?.ollama ? codex.model : undefined);
  return { state: "problem", ...finding };
}

/** Whether an address is this computer's own. */
export function onThisComputer(url: string): boolean {
  return URL.canParse(url) && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
}

/**
 * A model larger than this share of the computer's memory leaves too little for the rest: the
 * computer swaps, and an answer takes minutes. The same share the home uses to pick a model.
 */
const ROOM = 0.5;

const gb = (bytes: number) => `${Math.round(bytes / 1e9)} GB`;

/** A test call to the model the home would ask first on this computer's Ollama. */
export async function probeOllama(
  baseUrl: string,
  memory: number,
  doFetch: typeof fetch = fetch,
  timeout = OLLAMA_TIMEOUT,
): Promise<Probe> {
  const running = await doFetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) })
    .then((response) => response.ok)
    .catch(() => false);
  if (!running) {
    return {
      state: "absent",
      said: `Ollama does not answer at ${baseUrl}.`,
      todo: "Start Ollama, or install it from ollama.com.",
      command: "ollama serve",
    };
  }
  const local = onThisComputer(baseUrl);
  const models = await ollamaModels(baseUrl, doFetch, local ? memory : undefined);
  const first = models[0];
  if (!first) {
    return {
      state: "problem",
      said: "Ollama runs, but it has no model to talk with.",
      todo: "Pull a model with tools, e.g. ollama pull qwen3:8b.",
      command: "ollama pull qwen3:8b",
    };
  }
  if (local && first.size > memory * ROOM) {
    return {
      state: "problem",
      model: first.id,
      said: `${first.id} needs ${gb(first.size)}, too much for this computer's ${gb(memory)} of memory.`,
      todo: "Pull a smaller model with tools, e.g. ollama pull qwen3:8b.",
      command: "ollama pull qwen3:8b",
    };
  }
  try {
    const response = await doFetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: first.id,
        messages: [{ role: "user", content: PROMPT }],
        stream: false,
        ...(first.thinking ? { think: false } : {}),
        options: { num_predict: 16 },
      }),
      signal: AbortSignal.timeout(timeout),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok || body.error) {
      return {
        state: "problem",
        model: first.id,
        ...explainOllama(body.error ?? `status ${response.status}`, first.id),
      };
    }
  } catch (error) {
    const timedOut = (error as Error).name === "TimeoutError";
    return {
      state: "problem",
      model: first.id,
      ...(timedOut
        ? {
            said: `${first.id} did not answer within ${Math.round(timeout / 1000)} seconds.`,
            todo: "The computer may be short of memory. Try a smaller model.",
          }
        : explainOllama((error as Error).message, first.id)),
    };
  }
  return {
    state: first.tools ? "ok" : "warning",
    model: first.id,
    said: first.tools
      ? `${first.id} answers on ${local ? "this computer" : baseUrl}.`
      : `${first.id} answers, but takes no tools: an agent with it can talk, not act.`,
    ...(first.tools ? {} : { todo: "Pull a model with tools, e.g. ollama pull qwen3:8b." }),
  };
}

/** A test call through a gateway with its key. */
export async function probeGateway(
  gateway: Gateway,
  key: string | undefined,
  timeout = GATEWAY_TIMEOUT,
  doFetch?: typeof fetch,
): Promise<Probe> {
  const model = gateway.models[0];
  if (!key) {
    return {
      state: "problem",
      said: `${gateway.label} has no key.`,
      todo: `Tell your agent "add ${gateway.label}", or add the key in the setup.`,
    };
  }
  if (!model) {
    return {
      state: "problem",
      said: `${gateway.label} has no model.`,
      todo: `Tell your agent "add ${gateway.label}" with a model.`,
    };
  }
  return probeModel(
    gateway.label,
    model,
    createOpenAICompatible({
      name: gateway.id,
      baseURL: gateway.baseUrl,
      apiKey: key,
      ...(doFetch ? { fetch: doFetch } : {}),
    })(model),
    timeout,
  );
}

/** A test call to the wizards account's gateway with the home's key. */
export async function probeAccount(
  account: Account,
  key: string | undefined,
  timeout = GATEWAY_TIMEOUT,
  doFetch?: typeof fetch,
): Promise<Probe> {
  const model = ACCOUNT.models[0];
  if (!key) {
    return {
      state: "problem",
      said: "Your home has no key for your wizards account.",
      todo: "Ask for help at wizards.bot: the home could not fetch its key.",
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
    return { state: "ok", model, said: `${label} answers with ${model}.` };
  } catch (error) {
    const failure = error as Error & { statusCode?: number; responseBody?: string };
    if (failure.name === "TimeoutError" || failure.name === "AbortError") {
      return {
        state: "problem",
        model,
        said: `${label} did not answer within ${Math.round(timeout / 1000)} seconds.`,
        todo: "Test again later.",
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
