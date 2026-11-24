import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

// frpc (github.com/fatedier/frp, Apache-2.0) dials out from this computer to the relay and ends
// TLS here with its https2http plugin. It is not part of the app: the home fetches it the first
// time the address is switched on, at the version the relay runs, checked against the release's
// own checksum.

/** The frp release the relay runs. */
export const FRP_VERSION = "0.72.0";

/** sha256 of frp's release files, from the release's frp_sha256_checksums.txt. */
export const FRP_SHA256: Record<string, string> = {
  darwin_amd64: "60439dc6bf794c4182a1a4cac147d642f839d55201607208979eb23aecd09be9",
  darwin_arm64: "6e8576c5b6b9914a86850f6ff4fb81c5a09e706f91f70f64d5f398558bdc9db8",
  linux_amd64: "daf719b32ca2778770bb92955e231a07414d754378b9af328aa2642862479804",
  linux_arm64: "02180b857480302fd934e9ddbd50fe2f73229f99062f88756abc6de9df5e95cf",
};

/** frp's name for a computer: `darwin_arm64`, `linux_amd64` and so on. */
export const frpMachine = (platform: string = process.platform, arch: string = process.arch) =>
  `${platform === "win32" ? "windows" : platform}_${arch === "x64" ? "amd64" : arch}`;

/** frpc could not be fetched or checked. */
export class FrpcMissing extends Error {}

const run = promisify(execFile);

/**
 * frpc in `<dir>/frp/<version>/frpc`, fetched from frp's release on GitHub the first time and
 * kept only when its sha256 is the one in FRP_SHA256.
 */
export async function ensureFrpc(
  dir: string,
  fetcher: typeof fetch = (input, init) => fetch(input, init),
): Promise<string> {
  const home = join(dir, "frp", FRP_VERSION);
  const frpc = join(home, "frpc");
  if (existsSync(frpc)) return frpc;
  const machine = frpMachine();
  const checksum = FRP_SHA256[machine];
  if (!checksum) throw new FrpcMissing(`There is no frpc ${FRP_VERSION} for ${machine}.`);
  const name = `frp_${FRP_VERSION}_${machine}`;
  const url = `https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${name}.tar.gz`;
  let bytes: Buffer;
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new FrpcMissing(`frpc could not be downloaded: ${(error as Error).message}.`);
  }
  if (createHash("sha256").update(bytes).digest("hex") !== checksum) {
    throw new FrpcMissing("The downloaded frpc is not the one frp published. It was not kept.");
  }
  mkdirSync(join(dir, "frp"), { recursive: true, mode: 0o700 });
  const tmp = mkdtempSync(join(dir, "frp", ".download-"));
  try {
    const tarball = join(tmp, "frp.tar.gz");
    await writeFile(tarball, bytes);
    await run("tar", ["-xzf", tarball, "-C", tmp, `${name}/frpc`]);
    mkdirSync(home, { recursive: true });
    renameSync(join(tmp, name, "frpc"), frpc);
    chmodSync(frpc, 0o755);
  } catch (error) {
    throw new FrpcMissing(`frpc could not be unpacked: ${(error as Error).message}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return frpc;
}

/** What frpc.toml is made of. */
export interface FrpcSettings {
  name: string;
  key: string;
  server: string;
  serverPort: number;
  /** The home's port on 127.0.0.1. */
  port: number;
  adminPort: number;
  adminPassword: string;
  certFile: string;
  keyFile: string;
}

const toml = (text: string | number) => JSON.stringify(String(text));

/**
 * frpc.toml for a home: one https proxy for the name, TLS ended here by the https2http plugin,
 * the control connection over wss to the relay, the relay's key as metadata, and frpc's admin
 * API on 127.0.0.1 so `frpc reload` reads a renewed certificate.
 */
export function frpcConfig(settings: FrpcSettings): string {
  return [
    `serverAddr = ${toml(settings.server)}`,
    `serverPort = ${Number(settings.serverPort)}`,
    "loginFailExit = false",
    'transport.protocol = "wss"',
    "transport.tls.useSystemCa = true",
    "transport.heartbeatInterval = 30",
    "transport.heartbeatTimeout = 90",
    "log.disablePrintColor = true",
    `metadatas.token = ${toml(settings.key)}`,
    'webServer.addr = "127.0.0.1"',
    `webServer.port = ${Number(settings.adminPort)}`,
    'webServer.user = "wizards"',
    `webServer.password = ${toml(settings.adminPassword)}`,
    "",
    "[[proxies]]",
    `name = ${toml(settings.name)}`,
    'type = "https"',
    `customDomains = [${toml(settings.name)}]`,
    "",
    "[proxies.plugin]",
    'type = "https2http"',
    `localAddr = ${toml(`127.0.0.1:${Number(settings.port)}`)}`,
    `crtPath = ${toml(settings.certFile)}`,
    `keyPath = ${toml(settings.keyFile)}`,
    "",
  ].join("\n");
}

/** What a line of frpc's log says about the proxy, if anything. */
export type FrpcSays =
  | { state: "on" }
  | { state: "refused"; reason: string }
  | { state: "starting"; reason: string };

/** Reads one line of frpc's log. */
export function readFrpcLine(raw: string): FrpcSays | undefined {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape of a terminal colour
  const line = raw.replace(/\u001b\[[0-9;]*m/g, "").trim();
  if (/start proxy success/i.test(line)) return { state: "on" };
  const refused = line.match(/start error: (.+)$/i);
  if (refused?.[1]) return { state: "refused", reason: refused[1].trim() };
  const login = line.match(/(?:login to (?:the )?server failed|connect to server error): (.+)$/i);
  if (login?.[1]) return { state: "starting", reason: login[1].trim() };
  if (/try to reconnect/i.test(line)) return { state: "starting", reason: "reconnecting" };
  return undefined;
}
