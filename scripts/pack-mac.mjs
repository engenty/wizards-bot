#!/usr/bin/env node
// Builds the Mac app with its own Bot Server inside (docs/mac-app.md): the shell of apps/mac, the
// official Node and the release tarball installed for macOS, signed inside out.
//
//   node scripts/pack-mac.mjs                 dist/mac/wizards.app, signed for this Mac
//   node scripts/pack-mac.mjs --no-build      take dist/wizards-bot-<version>.tgz as it is
//   node scripts/pack-mac.mjs --dmg           also dist/mac/wizards-bot-mac-<arch>.dmg
//
// Updates: SPARKLE_PUBLIC_KEY goes into the app (without it the app does not look for updates);
// with SPARKLE_PRIVATE_KEY the script also writes the update, wizards-bot-mac-<arch>.zip, and
// appcast.xml, which the release attaches. The app asks the appcast of the newest release.
//
// Signing: MAC_SIGN_IDENTITY names the certificate ("Developer ID Application: …" for a
// release); without it the first "Apple Development" certificate of the keychain, or none ("-").
// Notarization runs when APPLE_API_KEY_PATH, APPLE_API_KEY_ID and APPLE_API_ISSUER are set.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const run = (command, list, cwd = root, env = process.env) =>
  execFileSync(command, list, { cwd, env, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
const say = (text) => console.log(`\n${text}`);

// The Node the app carries: a release of the line `engines` asks for (Node ≥ 24.11).
const NODE = option("node", "24.22.3");
const ARCH = option("arch", "arm64");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const out = join(root, "dist", "mac");
const cache = join(out, "cache");
const app = join(out, "wizards.app");
mkdirSync(cache, { recursive: true });

// ── The home, installed for macOS ───────────────────────────────────────────────────────────
const tarball = option("tarball", join(root, "dist", `wizards-bot-${version}.tgz`));
if (!args.includes("--no-build") || !existsSync(tarball)) {
  say("The tarball …");
  run("node", ["scripts/pack.mjs", ...(args.includes("--no-build") ? ["--no-build"] : [])]);
}
const stage = join(out, "stage");
rmSync(stage, { recursive: true, force: true });
const bot = join(stage, "bot");
mkdirSync(bot, { recursive: true });
run("tar", ["-xzf", tarball, "-C", bot, "--strip-components=1"]);
say(`Installing the home's packages for darwin-${ARCH} …`);
run(
  "npm",
  ["install", "--omit=dev", "--no-audit", "--no-fund", "--os=darwin", `--cpu=${ARCH}`],
  bot,
);

// What the home does not need when it runs: source maps, types, tests and the Markdown of
// packages. Not `examples`: three.js keeps its addons there, which artifacts import. The home is
// started from the bundle once after it is signed.
const PRUNE_NAMES = new Set(["__tests__", "test", "tests", ".github"]);
const PRUNE_FILE = /\.(map|d\.ts|d\.mts|d\.cts|md|markdown|tsbuildinfo)$/i;
let pruned = 0;
const prune = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (PRUNE_NAMES.has(entry.name)) {
        pruned += size(path);
        rmSync(path, { recursive: true, force: true });
      } else prune(path);
    } else if (PRUNE_FILE.test(entry.name) && !/^(license|licence|notice)/i.test(entry.name)) {
      pruned += statSync(path).size;
      rmSync(path);
    }
  }
};
const size = (path) => {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((sum, name) => sum + size(join(path, name)), 0);
};
prune(join(bot, "node_modules"));
console.log(
  `Pruned ${(pruned / 1e6).toFixed(0)} MB; the home is ${(size(bot) / 1e6).toFixed(0)} MB.`,
);

// ── Node ────────────────────────────────────────────────────────────────────────────────────
const nodeName = `node-v${NODE}-darwin-${ARCH}`;
const nodeArchive = join(cache, `${nodeName}.tar.xz`);
if (!existsSync(nodeArchive)) {
  say(`Node ${NODE} …`);
  run("curl", ["-fsSL", "-o", nodeArchive, `https://nodejs.org/dist/v${NODE}/${nodeName}.tar.xz`]);
}
const sums = run("curl", ["-fsSL", `https://nodejs.org/dist/v${NODE}/SHASUMS256.txt`]);
const expected = sums
  .split("\n")
  .find((line) => line.endsWith(`  ${nodeName}.tar.xz`))
  ?.split(" ")[0];
const actual = createHash("sha256").update(readFileSync(nodeArchive)).digest("hex");
if (!expected || expected !== actual) {
  rmSync(nodeArchive);
  throw new Error(`${nodeName}.tar.xz does not match nodejs.org's SHASUMS256.txt.`);
}
const node = join(stage, "node");
mkdirSync(join(node, "bin"), { recursive: true });
run("tar", ["-xJf", nodeArchive, "-C", stage, `${nodeName}/bin/node`, `${nodeName}/LICENSE`]);
cpSync(join(stage, nodeName, "bin/node"), join(node, "bin/node"));
cpSync(join(stage, nodeName, "LICENSE"), join(node, "LICENSE"));
rmSync(join(stage, nodeName), { recursive: true });

// ── The shell ───────────────────────────────────────────────────────────────────────────────
say("The shell …");
const derived = join(out, "build");
run("xcodebuild", [
  "-project",
  "apps/mac/WizardsMac.xcodeproj",
  "-scheme",
  "wizards",
  "-configuration",
  "Release",
  "-derivedDataPath",
  derived,
  `ARCHS=${ARCH}`,
  `MARKETING_VERSION=${version}`,
  `CURRENT_PROJECT_VERSION=${buildNumber(version)}`,
  `SPARKLE_PUBLIC_KEY=${process.env.SPARKLE_PUBLIC_KEY ?? ""}`,
  "CODE_SIGNING_ALLOWED=NO",
  "build",
]);
rmSync(app, { recursive: true, force: true });
cpSync(join(derived, "Build/Products/Release/wizards.app"), app, {
  recursive: true,
  verbatimSymlinks: true,
});
cpSync(node, join(app, "Contents/Resources/node"), { recursive: true });
cpSync(bot, join(app, "Contents/Resources/bot"), { recursive: true, verbatimSymlinks: true });
chmodSync(join(app, "Contents/Resources/node/bin/node"), 0o755);

// ── Signing, inside out ─────────────────────────────────────────────────────────────────────
const identity = process.env.MAC_SIGN_IDENTITY ?? developmentIdentity() ?? "-";
const release = identity.startsWith("Developer ID");
say(`Signing with ${identity === "-" ? "no certificate (ad hoc)" : identity} …`);
const entitlements = join(stage, "entitlements");
mkdirSync(entitlements, { recursive: true });
writeFileSync(
  join(entitlements, "node.plist"),
  plist({
    // V8 compiles JavaScript while it runs.
    "com.apple.security.cs.allow-jit": true,
    "com.apple.security.cs.allow-unsigned-executable-memory": true,
  }),
);
const sign = (path, extra = []) =>
  run("codesign", [
    "--force",
    "--sign",
    identity,
    "--options",
    "runtime",
    release ? "--timestamp" : "--timestamp=none",
    ...extra,
    path,
  ]);
const machO = findMachO(join(app, "Contents/Resources/bot"));
for (const file of machO) sign(file);
sign(join(app, "Contents/Resources/node/bin/node"), [
  "--entitlements",
  join(entitlements, "node.plist"),
]);
for (const framework of existsSync(join(app, "Contents/Frameworks"))
  ? readdirSync(join(app, "Contents/Frameworks"))
  : []) {
  signFramework(join(app, "Contents/Frameworks", framework));
}
sign(app, ["--entitlements", join(root, "apps/mac/Config/wizards.entitlements")]);
run("codesign", ["--verify", "--deep", "--strict", app]);
console.log(`Signed ${machO.length} native modules, Node and the app.`);

// ── The home starts from the bundle, and leaves it as it was ────────────────────────────────
say("Starting the home from the bundle …");
await startsFromBundle();
run("codesign", ["--verify", "--deep", "--strict", app]);
console.log(`The app is ${(size(app) / 1e6).toFixed(0)} MB: ${app}`);

// ── Notarization and the DMG ────────────────────────────────────────────────────────────────
const notary = notaryArguments();
if (notary) {
  say("Notarizing the app …");
  const zip = join(stage, "wizards-notarize.zip");
  run("ditto", ["-c", "-k", "--keepParent", app, zip]);
  run("xcrun", ["notarytool", "submit", zip, "--wait", ...notary]);
  run("xcrun", ["stapler", "staple", app]);
}
if (args.includes("--dmg")) {
  say("The DMG …");
  const dmg = join(out, `wizards-bot-mac-${ARCH}.dmg`);
  const folder = join(stage, "dmg");
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder);
  cpSync(app, join(folder, "wizards.app"), { recursive: true, verbatimSymlinks: true });
  run("ln", ["-s", "/Applications", join(folder, "Applications")]);
  rmSync(dmg, { force: true });
  // A plain image first, then LZMA: 63 MB, where LZFSE (ULFO) made 163 MB and LZMA straight
  // from the folder 140 MB. macOS opens it since 10.15.
  const plain = join(stage, "plain.dmg");
  rmSync(plain, { force: true });
  run("hdiutil", [
    "create",
    "-volname",
    "wizards.bot",
    "-srcfolder",
    folder,
    "-format",
    "UDRO",
    "-ov",
    plain,
  ]);
  run("hdiutil", ["convert", plain, "-format", "ULMO", "-o", dmg]);
  rmSync(plain, { force: true });
  if (identity !== "-")
    run("codesign", [
      "--force",
      "--sign",
      identity,
      release ? "--timestamp" : "--timestamp=none",
      dmg,
    ]);
  if (notary) {
    run("xcrun", ["notarytool", "submit", dmg, "--wait", ...notary]);
    run("xcrun", ["stapler", "staple", dmg]);
  }
  console.log(`${dmg} (${(statSync(dmg).size / 1e6).toFixed(0)} MB)`);
}

// ── The update for Sparkle ──────────────────────────────────────────────────────────────────
if (process.env.SPARKLE_PRIVATE_KEY) {
  say("The update and appcast.xml …");
  const zipName = `wizards-bot-mac-${ARCH}.zip`;
  const zip = join(out, zipName);
  rmSync(zip, { force: true });
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
  const signUpdate = join(derived, "SourcePackages/artifacts/sparkle/Sparkle/bin/sign_update");
  const signature = execFileSync(signUpdate, ["--ed-key-file", "-", "-p", zip], {
    input: process.env.SPARKLE_PRIVATE_KEY,
    encoding: "utf8",
  }).trim();
  const base = `https://github.com/engenty/wizards-bot/releases`;
  writeFileSync(
    join(out, "appcast.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle">
  <channel>
    <title>wizards.bot</title>
    <item>
      <title>${version}</title>
      <pubDate>${new Date().toUTCString()}</pubDate>
      <sparkle:version>${buildNumber(version)}</sparkle:version>
      <sparkle:shortVersionString>${version}</sparkle:shortVersionString>
      <sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>
      <sparkle:releaseNotesLink>${base}/tag/v${version}</sparkle:releaseNotesLink>
      <enclosure url="${base}/download/v${version}/${zipName}" length="${statSync(zip).size}" type="application/octet-stream" sparkle:edSignature="${signature}"/>
    </item>
  </channel>
</rss>
`,
  );
  console.log(`${zip}\n${join(out, "appcast.xml")}`);
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────

/** 0.2.0 → 2000, 1.4.12 → 1004012: a build number that grows with the version, for Sparkle. */
function buildNumber(text) {
  const [major = 0, minor = 0, patch = 0] = text.split("-")[0].split(".").map(Number);
  return String(major * 1_000_000 + minor * 1_000 + patch);
}

function developmentIdentity() {
  const list = run("security", ["find-identity", "-v", "-p", "codesigning"]);
  return /"(Apple Development: [^"]+)"/.exec(list)?.[1];
}

/** Every Mach-O file under `dir`: native modules and programs that came with packages. */
function findMachO(dir) {
  const found = [];
  const walk = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (isMachO(full)) found.push(full);
    }
  };
  walk(dir);
  return found;
}

function isMachO(file) {
  const fd = readFileSync(file, { flag: "r" }).subarray(0, 4);
  if (fd.length < 4) return false;
  const magic = fd.readUInt32BE(0);
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic);
}

function signFramework(path) {
  // Sparkle's helpers first, then the framework.
  const versions = join(path, "Versions/B");
  for (const helper of [
    "XPCServices/Installer.xpc",
    "XPCServices/Downloader.xpc",
    "Autoupdate",
    "Updater.app",
  ]) {
    const full = join(versions, helper);
    if (existsSync(full))
      sign(
        full,
        helper.startsWith("XPCServices/Downloader") ? ["--preserve-metadata=entitlements"] : [],
      );
  }
  sign(path);
}

function plist(entries) {
  const body = Object.entries(entries)
    .map(([key, value]) => `\t<key>${key}</key>\n\t<${value ? "true" : "false"}/>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}\n</dict>\n</plist>\n`;
}

function notaryArguments() {
  const { APPLE_API_KEY_PATH: key, APPLE_API_KEY_ID: id, APPLE_API_ISSUER: issuer } = process.env;
  if (!key || !id || !issuer) return null;
  return ["--key", key, "--key-id", id, "--issuer", issuer];
}

/** Starts the bundle's launcher on a port of its own and a data folder of its own, asks /health. */
async function startsFromBundle() {
  const { spawn } = await import("node:child_process");
  const { mkdtempSync } = await import("node:fs");
  const data = mkdtempSync(join(tmpdir(), "wizards-mac-data-"));
  const port = "4798";
  const child = spawn(join(app, "Contents/MacOS/wizards"), ["--home", "start"], {
    env: {
      ...process.env,
      WIZARDS_BOT_DATA: data,
      WIZARDS_BOT_PORT: port,
      OLLAMA_HOST: "http://127.0.0.1:9",
      WIZARDS_BOT_SUBSCRIPTIONS: "",
    },
    stdio: "ignore",
  });
  try {
    for (let i = 0; i < 40; i++) {
      const answer = await fetch(`http://127.0.0.1:${port}/health`)
        .then((r) => r.json())
        .catch(() => null);
      if (answer?.ok) {
        console.log(`It answers: ${JSON.stringify(answer)}`);
        return;
      }
      await new Promise((done) => setTimeout(done, 500));
    }
    const log = join(data, "logs/home.log");
    throw new Error(
      `The home from the bundle did not answer.\n${existsSync(log) ? readFileSync(log, "utf8").slice(-3000) : ""}`,
    );
  } finally {
    child.kill("SIGTERM");
    rmSync(data, { recursive: true, force: true });
  }
}
