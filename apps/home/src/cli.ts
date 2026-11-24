#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { serve } from "@hono/node-server";
import type { Event, PairResponse, Setup, SetupCheck } from "@wizards-bot/protocol";
import qrcode from "qrcode-terminal";
import { exportData, importData, MIN_PASSPHRASE } from "./backup.ts";
import { claimData, extendPath, isHosted, loadConfig, moveData, VERSION } from "./config.ts";
import { Home } from "./home.ts";
import { Secrets } from "./identity.ts";
import { LinkedComputer } from "./link/computer.ts";
import { LinkHub } from "./link/hub.ts";
import { Models } from "./models/models.ts";
import { createServer } from "./server.ts";
import { summary } from "./setup/setup.ts";
import { Db } from "./store/db.ts";

const HELP = `wizards.bot ${VERSION}: your own agent, on your own Bot Server.

  wizards-bot start              Start the Bot Server on this computer.
  wizards-bot pair               Show a code and a QR to add a phone or a computer.
                                With --json: the address, the code and the link as JSON.
  wizards-bot link <address> <code>
                                Offer this computer's models (Ollama, Claude, Codex) to your
                                Bot Server on another computer or server. Later: wizards-bot link
  wizards-bot status             Say what the Bot Server has: devices, models, agents.
  wizards-bot doctor             Test each model with a short call and check the Bot Server: its
                                address, its data folder, folders, notifications. Says what
                                to do about each problem.
  wizards-bot say "<text>"       Send one message from this terminal and print the answer.
  wizards-bot chat               Talk to your agent in this terminal.
  wizards-bot push --key <file.p8> --key-id <id> --team-id <id>
                                Give the Bot Server your Apple key, so it can notify your phone.
  wizards-bot export <file>      Write the Bot Server's data, encrypted with a passphrase, to a file.
  wizards-bot import <file>      Bring an export into an empty data folder. Stop the Bot Server first.
                                The passphrase is asked, or read from --passphrase-file <file>
                                or WIZARDS_BOT_PASSPHRASE.

  WIZARDS_BOT_DATA   where the Bot Server keeps its data (default ~/.engenty/wizards-bot; an
                     earlier ~/.wizards-bot moves there when the Bot Server starts)
  WIZARDS_BOT_PORT   the port it listens on (default 4747)
  WIZARDS_BOT_URL    its public address, when it has one (https://…)
  WIZARDS_TUNNEL_URL where the address at wizards.host is claimed (default https://wizards.host)
  WIZARDS_BOT_FRPC   an frpc for that address, instead of the one the Bot Server downloads
  WIZARDS_BOT_SUBSCRIPTIONS   the signed-in apps it may use (default claude,codex)
  WIZARDS_BOT_PATH   folders to look for claude, codex and ollama in, before PATH (also the
                     file path in the data folder)
`;

const [command = "help", ...rest] = process.argv.slice(2);
// A home that starts moves the data of an earlier one to the new default folder first.
const moved = command === "start" && !process.env.WIZARDS_BOT_DATA ? moveData() : undefined;
const config = loadConfig();
extendPath(config.dataDir);

function option(name: string): string | undefined {
  const index = rest.indexOf(`--${name}`);
  return index >= 0 ? rest[index + 1] : undefined;
}

const openHome = (): Home => new Home(config);

async function start(): Promise<void> {
  if (moved) console.log(moved);
  claimData(config.dataDir);
  const home = openHome();
  const app = createServer(home);
  const server = serve({ fetch: app.fetch, port: config.port, hostname: "0.0.0.0" });
  new LinkHub(home).attach(server as import("node:http").Server);
  home.tasks.start();
  // A hosted home claims its way to the gateway on its first start.
  await home.hosted.start();
  // The address at wizards.host comes up again when the person had switched it on.
  home.tunnel.start();
  // A home without an address asks its contacts' homes for what they keep for it.
  home.peers.mailbox.start();
  await home.channels.start();
  await home.models.refresh(true);
  const current = home.models.candidates()[0];
  console.log(
    home.person()
      ? `Your Bot Server ${VERSION} runs for ${home.person()}.`
      : `Your Bot Server ${VERSION} runs. Its setup asks for your name.`,
  );
  console.log(`Address: ${home.address()}`);
  console.log(
    current
      ? `Model: ${current}`
      : "No model yet. Start Ollama, or sign in to Claude or Codex on this computer.",
  );
  if (!home.store.devices().length) {
    // A hosted Bot Server's person comes with the setup code from the Manage-App; a code in its
    // log would let in whoever reads the log.
    if (isHosted(config)) {
      console.log("No device yet. Its person opens the setup with the link from wizards.bot.");
    } else {
      const code = home.store.newPairingCode();
      console.log(`No device yet. Open the setup: ${home.address()}/#code=${code}`);
      console.log("The link works once, for 10 minutes. A new one: wizards-bot pair");
    }
  }
  const stop = () => {
    server.close();
    home.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

function pair(): void {
  const home = openHome();
  const code = home.store.newPairingCode();
  const address = home.address();
  if (rest.includes("--json")) {
    const link = `wizardsbot://pair?home=${encodeURIComponent(address)}&code=${code}`;
    console.log(JSON.stringify({ address, code, link }));
    home.close();
    return;
  }
  qrcode.generate(`wizardsbot://pair?home=${encodeURIComponent(address)}&code=${code}`, {
    small: true,
  });
  console.log(`Address: ${address}`);
  console.log(`Code:    ${code}`);
  console.log(`Browser: ${address}/#code=${code}`);
  console.log(
    "Scan the QR with the wizards.bot app, type both in, or open the browser link. The code works once, for 10 minutes.",
  );
  home.close();
}

async function status(): Promise<void> {
  const home = openHome();
  await home.models.refresh(true);
  console.log(
    `Bot Server${home.person() ? ` of ${home.person()}` : ""} at ${home.address()}${home.handle() ? ` (${home.handle()})` : ""}`,
  );
  console.log(`Setup: ${summary(await home.setup.view())} (details: wizards-bot doctor)`);
  console.log("\nAgents");
  for (const agent of home.store.agents())
    console.log(`  ${agent.name} (${agent.kind}): ${agent.open} waiting for you`);
  console.log("\nDevices");
  for (const device of home.store.devices())
    console.log(`  ${device.name} (${device.kind}), last seen ${device.seenAt}`);
  if (!home.store.devices().length) console.log("  none");
  console.log("\nModels, in the order the Bot Server tries them");
  for (const ref of home.models.candidates()) console.log(`  ${ref}`);
  if (!home.models.candidates().length) console.log("  none");
  console.log(
    `\nNotifications to your phone: ${home.notifier.key() ? "set up" : "not set up (wizards-bot push)"}`,
  );
  home.close();
}

const MARK: Record<SetupCheck["state"], string> = {
  ok: "✓",
  warning: "!",
  problem: "✗",
  absent: "·",
  untested: "?",
  testing: "…",
};

/** The checks as lines for a terminal: what was found, and below it what to do. */
function printSetup(setup: Setup): void {
  const group = (title: string, checks: SetupCheck[]) => {
    console.log(`\n${title}`);
    for (const check of checks) {
      console.log(`  ${MARK[check.state]} ${check.label.padEnd(20)} ${check.said}`);
      if (check.todo && check.state !== "ok") console.log(`    ${"".padEnd(20)} ${check.todo}`);
      if (check.command && check.state !== "ok")
        console.log(`    ${"".padEnd(20)} $ ${check.command}`);
    }
  };
  group("Models", setup.models);
  group("Bot Server", setup.home);
  group("What your agents can do", setup.capabilities);
  console.log(
    setup.working
      ? "\nA model answers. Your Bot Server is ready to talk."
      : "\nNo model answers yet. Set up one of the models above, then run wizards-bot doctor again.",
  );
}

/**
 * Tests each model with a short call and checks the home. A running home makes the calls
 * itself, so its devices see the outcome; otherwise this terminal makes them.
 */
async function doctor(): Promise<void> {
  const base = `http://127.0.0.1:${config.port}`;
  const runs = await fetch(`${base}/v1/home`, { signal: AbortSignal.timeout(1500) })
    .then((response) => response.ok)
    .catch(() => false);
  console.log("Testing each model with a short call. This takes up to two minutes.");
  let setup: Setup;
  if (runs) {
    const link = await terminal();
    const response = await fetch(`${base}/v1/setup/test`, {
      method: "POST",
      headers: { authorization: `Bearer ${link.token}`, "content-type": "application/json" },
      body: "{}",
    });
    if (!response.ok) throw new Error(((await response.json()) as { message: string }).message);
    setup = (await response.json()) as Setup;
  } else {
    const home = openHome();
    try {
      setup = await home.setup.test();
    } finally {
      home.close();
    }
  }
  printSetup(setup);
  const problems = [...setup.models, ...setup.home].some((check) => check.state === "problem");
  if (!setup.working || problems) process.exitCode = 1;
}

function push(): void {
  const file = option("key");
  const keyId = option("key-id");
  const teamId = option("team-id");
  if (!file || !keyId || !teamId || !existsSync(file)) {
    console.error(
      "Give the key file, its key id and your team id: wizards-bot push --key AuthKey_ABC.p8 --key-id ABC --team-id XYZ",
    );
    process.exit(1);
  }
  const home = openHome();
  home.notifier.setKey({ key: readFileSync(file, "utf8"), keyId, teamId });
  console.log("Saved. Restart the Bot Server so it uses the key.");
  home.close();
}

/** Joins this computer to a home somewhere else and serves its models until stopped. */
async function link(): Promise<void> {
  const file = join(config.dataDir, "link.json");
  const [address, code] = rest;
  let saved = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as { home: string; token: string })
    : undefined;
  if (address && code) {
    const home = address.replace(/\/+$/, "");
    const response = await fetch(`${home}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name: hostname().replace(/\.local$/, ""), kind: "computer" }),
    }).catch(() => undefined);
    if (!response) throw new Error(`Nothing answers at ${home}.`);
    if (!response.ok) throw new Error(((await response.json()) as { message: string }).message);
    saved = { home, token: ((await response.json()) as PairResponse).token };
    writeFileSync(file, JSON.stringify(saved), { mode: 0o600 });
  }
  if (!saved)
    throw new Error(
      "Give your Bot Server's address and a code from it: wizards-bot link https://me.example.com K7QM-2RXD",
    );
  const db = new Db(config.dataDir);
  const models = new Models(config, db, new Secrets(db, config.dataDir), hostname());
  // Where the link stands, for the Mac app, which shows it: link-state.json beside link.json.
  const home = saved.home;
  const note = (state: string) =>
    writeFileSync(
      join(config.dataDir, "link-state.json"),
      JSON.stringify({ state, home, at: new Date().toISOString() }),
      { mode: 0o600 },
    );
  note("connecting");
  const stop = () => {
    computer.stop();
    db.close();
    process.exit(0);
  };
  const computer = new LinkedComputer({
    ...saved,
    models,
    log: (line) => console.log(line),
    onState: (state) => {
      note(state);
      // A Bot Server that removed this computer will not take it back: the link ends, and a
      // service manager that starts it again on a failure leaves it ended.
      if (state === "refused") stop();
    },
  });
  computer.start();
  console.log(`Linking this computer to ${saved.home}. Leave this running.`);
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

/** This terminal as a device of the running home. */
async function terminal(): Promise<{ base: string; token: string }> {
  const base = `http://127.0.0.1:${config.port}`;
  const file = join(config.dataDir, "terminal.token");
  if (existsSync(file)) {
    const token = readFileSync(file, "utf8").trim();
    const check = await fetch(`${base}/v1/agents`, {
      headers: { authorization: `Bearer ${token}` },
    }).catch(() => undefined);
    if (!check) throw new Error("The Bot Server does not run. Start it with `wizards-bot start`.");
    if (check.ok) return { base, token };
  }
  const home = openHome();
  const code = home.store.newPairingCode();
  home.close();
  const response = await fetch(`${base}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name: "Terminal", kind: "computer" }),
  }).catch(() => undefined);
  if (!response?.ok)
    throw new Error("The Bot Server does not run. Start it with `wizards-bot start`.");
  const { token } = (await response.json()) as PairResponse;
  writeFileSync(file, token, { mode: 0o600 });
  return { base, token };
}

/** Sends one message and prints the reply as it is written. Resolves when the agent is done. */
async function exchange(
  link: { base: string; token: string },
  conversationId: string,
  text: string,
): Promise<void> {
  const headers = { authorization: `Bearer ${link.token}`, "content-type": "application/json" };
  const controller = new AbortController();
  const stream = await fetch(`${link.base}/v1/events`, { headers, signal: controller.signal });
  await fetch(`${link.base}/v1/conversations/${conversationId}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text }),
  });
  const decoder = new TextDecoder();
  let buffer = "";
  let wrote = false;
  try {
    for await (const bytes of stream.body as ReadableStream<Uint8Array>) {
      buffer += decoder.decode(bytes, { stream: true });
      let end = buffer.indexOf("\n\n");
      while (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf("\n\n");
        const data = block.split("\n").find((line) => line.startsWith("data:"));
        if (!data) continue;
        const event = JSON.parse(data.slice(5)) as Event;
        if (event.type === "message.delta" && event.conversationId === conversationId) {
          process.stdout.write(event.text);
          wrote = true;
        } else if (
          event.type === "message.updated" &&
          event.message.conversationId === conversationId &&
          event.message.role === "agent" &&
          event.message.state !== "streaming"
        ) {
          for (const part of event.message.parts) {
            if (part.type === "text" && !wrote) process.stdout.write(part.text);
            if (part.type === "activity") console.log(`\n  · ${part.label}`);
            if (part.type === "document") console.log(`\n  ▤ ${part.title} (${part.documentId})`);
            if (part.type === "artifact") console.log(`\n  ◫ ${part.title} (${part.artifactId})`);
            if (part.type === "card") {
              console.log(
                `\n  ▢ ${part.card.title}${part.card.body ? `\n    ${part.card.body}` : ""}`,
              );
              if (part.card.qr) qrcode.generate(part.card.qr, { small: true });
              if (part.card.actions.length) {
                console.log(
                  `    ${part.card.actions.map((action) => `[${action.label}]`).join(" ")}`,
                );
              }
            }
          }
          console.log(`\n  (${event.message.model ?? "no model"})`);
          controller.abort();
          return;
        }
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  }
}

async function mainConversation(link: { base: string; token: string }): Promise<string> {
  const response = await fetch(`${link.base}/v1/agents`, {
    headers: { authorization: `Bearer ${link.token}` },
  });
  const { agents } = (await response.json()) as { agents: { conversationId: string }[] };
  return (agents[0] as { conversationId: string }).conversationId;
}

async function say(): Promise<void> {
  const text = rest.join(" ").trim();
  if (!text) throw new Error('Say what: wizards-bot say "What needs me today?"');
  const link = await terminal();
  await exchange(link, await mainConversation(link), text);
}

async function chat(): Promise<void> {
  const link = await terminal();
  const conversationId = await mainConversation(link);
  const input = createInterface({ input: process.stdin, output: process.stdout, prompt: "\n> " });
  input.prompt();
  for await (const line of input) {
    if (line.trim()) await exchange(link, conversationId, line.trim());
    input.prompt();
  }
}

/** Asks for a line without showing it. */
async function hidden(question: string): Promise<string> {
  const input = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const shown = input as unknown as { _writeToOutput(text: string): void };
  shown._writeToOutput = (text) => {
    if (text.startsWith(question)) process.stdout.write(question);
  };
  const answer = await new Promise<string>((resolve) => input.question(question, resolve));
  input.close();
  process.stdout.write("\n");
  return answer;
}

/** The passphrase of an export: from a file, the environment, or asked in the terminal. */
async function passphrase(twice: boolean): Promise<string> {
  const file = option("passphrase-file");
  if (file) return readFileSync(file, "utf8").replace(/\r?\n$/, "");
  if (process.env.WIZARDS_BOT_PASSPHRASE) return process.env.WIZARDS_BOT_PASSPHRASE;
  if (!process.stdin.isTTY)
    throw new Error("Give the passphrase with --passphrase-file <file> or WIZARDS_BOT_PASSPHRASE.");
  const first = await hidden(
    twice ? `Passphrase (at least ${MIN_PASSPHRASE} characters, keep it apart): ` : "Passphrase: ",
  );
  if (twice && (await hidden("Once more: ")) !== first)
    throw new Error("The two passphrases differ.");
  return first;
}

async function exportCommand(): Promise<void> {
  const file = rest[0];
  if (!file) throw new Error("Say where: wizards-bot export wizards-bot.export");
  await exportData(config.dataDir, file, await passphrase(true));
  console.log(`The Bot Server's data is in ${file}. Without the passphrase nobody can read it.`);
}

async function importCommand(): Promise<void> {
  const file = rest[0];
  if (!file || !existsSync(file))
    throw new Error("Say which file: wizards-bot import wizards-bot.export");
  const runs = await fetch(`http://127.0.0.1:${config.port}/health`, {
    signal: AbortSignal.timeout(1500),
  })
    .then((response) => response.ok)
    .catch(() => false);
  if (runs) throw new Error("A Bot Server runs on this computer. Stop it first, then import.");
  await importData(file, config.dataDir, await passphrase(false));
  console.log(`The Bot Server is back in ${config.dataDir}. Start it with wizards-bot start.`);
}

const commands: Record<string, () => void | Promise<void>> = {
  start,
  pair,
  link,
  status,
  doctor,
  push,
  say,
  chat,
  export: exportCommand,
  import: importCommand,
};
const run = commands[command];
if (!run) {
  console.log(HELP);
} else {
  try {
    await run();
  } catch (error) {
    console.error((error as Error).message);
    process.exit(1);
  }
}
