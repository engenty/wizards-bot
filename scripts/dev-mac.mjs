#!/usr/bin/env node
// Builds the dev app, the Debug build of apps/mac, and opens it (docs/mac-app.md, "Develop the Mac
// app"). The dev app is bot.wizards.mac.dev with the LaunchAgents bot.wizards.home.dev and
// bot.wizards.link.dev, port 4790 and ~/.engenty/wizards-bot-dev: it runs beside the installed app
// and never reaches its Bot Server. Its Bot Server runs apps/home/src/cli.ts of this checkout with
// the Node that runs this script.
//
//   node scripts/dev-mac.mjs           build, start the dev Bot Server anew if it runs, open the app
//   node scripts/dev-mac.mjs --fresh   and before opening, forget everything of the dev app: its
//                                      LaunchAgents, ~/.engenty/wizards-bot-dev(-link) and its
//                                      settings, so that it starts as on a new Mac
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const fresh = process.argv.includes("--fresh");
const say = (text) => console.log(`\n${text}`);

// The dev app's names, as apps/mac/Core/Identity.swift has them. Nothing here names the
// installed app's.
const BUNDLE = "bot.wizards.mac.dev";
const LABELS = ["bot.wizards.home.dev", "bot.wizards.link.dev"];
const FOLDERS = [".engenty/wizards-bot-dev", ".engenty/wizards-bot-dev-link"];

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 24 || (major === 24 && minor < 11)) {
  console.error(`The dev app's Bot Server needs Node 24.11 or newer; this is ${process.version}.`);
  process.exit(1);
}

if (!existsSync(join(root, "apps/web/dist/index.html"))) {
  say("The web app …");
  execFileSync("pnpm", ["build"], { cwd: root, stdio: "inherit" });
}

say("The dev app …");
const derived = join(root, "apps/mac/build");
execFileSync(
  "xcodebuild",
  [
    "-project",
    "apps/mac/WizardsMac.xcodeproj",
    "-scheme",
    "wizards",
    "-configuration",
    "Debug",
    "-derivedDataPath",
    derived,
    "-destination",
    `platform=macOS,arch=${process.arch === "x64" ? "x86_64" : process.arch}`,
    "-quiet",
    `WIZARDS_DEV_NODE=${process.execPath}`,
    "build",
  ],
  { cwd: root, stdio: "inherit" },
);
const app = join(derived, "Build/Products/Debug/wizards.app");

// A running dev app would only come to the front: it quits, and the new build opens.
quit();

const domain = `gui/${process.getuid()}`;
const loaded = (label) => spawnSync("launchctl", ["print", `${domain}/${label}`]).status === 0;
if (fresh) {
  say("Forgetting the dev app …");
  // macOS forgets the LaunchAgents as the app itself registered them, which also stops them.
  execFileSync(join(app, "Contents/MacOS/wizards"), ["--forget"], { stdio: "inherit" });
  for (const label of LABELS) {
    if (!label.endsWith(".dev")) throw new Error(`${label} is not a LaunchAgent of the dev app.`);
    if (loaded(label)) spawnSync("launchctl", ["bootout", `${domain}/${label}`]);
  }
  for (const folder of FOLDERS) {
    if (!/-dev(-link)?$/.test(folder)) throw new Error(`${folder} is not a folder of the dev app.`);
    rmSync(join(homedir(), folder), { recursive: true, force: true });
  }
  spawnSync("defaults", ["delete", BUNDLE], { stdio: "ignore" });
  console.log(
    `LaunchAgents ${LABELS.join(", ")}, ~/${FOLDERS.join(", ~/")} and ${BUNDLE}'s settings are gone.`,
  );
} else if (loaded(LABELS[0])) {
  // The dev Bot Server runs the checkout's apps/home: started anew, it runs what changed.
  say("Starting the dev Bot Server anew …");
  execFileSync("launchctl", ["kickstart", "-k", `${domain}/${LABELS[0]}`], { stdio: "inherit" });
}

execFileSync("open", [app]);
say(`${app} is open.`);

/** Quits the dev app when it runs, found by its bundle id; the installed app stays as it is. */
function quit() {
  const pid = devAppPid();
  if (!pid) return;
  process.kill(pid, "SIGTERM");
  const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  for (let i = 0; i < 50 && devAppPid() === pid; i++) pause(100);
  if (devAppPid() === pid) process.kill(pid, "SIGKILL");
}

function devAppPid() {
  const info = spawnSync("lsappinfo", ["info", "-app", BUNDLE], { encoding: "utf8" }).stdout ?? "";
  if (!info.includes(`bundleID="${BUNDLE}"`)) return undefined;
  const pid = Number(/\bpid = (\d+)/.exec(info)?.[1]);
  return pid > 0 ? pid : undefined;
}
