import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

/**
 * The home's version: the one of the root package.json, which `pnpm release` sets. The
 * tarball and the image carry that file at the same place.
 */
export const VERSION = (
  JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

export interface Config {
  /** Where the home keeps its database, keys and files. */
  dataDir: string;
  port: number;
  /** The address other homes and sign-in pages reach this home at, without a trailing slash. */
  publicUrl: string | undefined;
  ollamaUrl: string;
  /** The installed clients the home may use with the person's subscriptions. */
  subscriptions: string[];
  /**
   * A pairing code that does not run out and works again and again, for a demo home that App
   * Review pairs with (`WIZARDS_BOT_DEMO_CODE`, at least 8 letters and digits). Never set it on a
   * home with a person's data: anyone with the code reaches the home.
   */
  demoCode?: string;
  /**
   * A pairing code that pairs the first device of a hosted home and then ends
   * (`WIZARDS_BOT_SETUP_CODE`). The Manage-App sets it when it makes the home.
   */
  setupCode?: string;
  /** The Manage-App's address, for a home that runs on wizards.bot (`WIZARDS_BOT_MANAGE_URL`). */
  manageUrl?: string;
  /**
   * The token a hosted home claims its way to the gateway with, once (`WIZARDS_BOT_HOME_TOKEN`).
   * After the claim the home keeps what it got and does not use the token again.
   */
  homeToken?: string;
  /** Where the relay of wizards.host answers (`WIZARDS_TUNNEL_URL`); https://wizards.host otherwise. */
  tunnelUrl?: string;
  /** An frpc to use for the address instead of the one the home fetches (`WIZARDS_BOT_FRPC`). */
  frpc?: string;
}

/** Whether the home runs on wizards.bot, made and kept by the Manage-App. */
export const isHosted = (config: Pick<Config, "manageUrl">): boolean => Boolean(config.manageUrl);

/** A pairing code as it is compared: letters and digits only, in capitals. */
export const tidyCode = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Where a home keeps its data on a computer when `WIZARDS_BOT_DATA` names no folder. */
export const dataFolder = (home = homedir()): string => join(home, ".engenty", "wizards-bot");

/** Where homes kept it before: `~/.wizards-bot`. A home moves it over on its start. */
export const oldDataFolder = (home = homedir()): string => join(home, ".wizards-bot");

/**
 * The data folder when `WIZARDS_BOT_DATA` names none: `~/.engenty/wizards-bot`, or the
 * `~/.wizards-bot` of an earlier home as long as it has not been moved (`moveData`).
 */
export function defaultDataDir(home = homedir()): string {
  const now = dataFolder(home);
  const before = oldDataFolder(home);
  return !existsSync(now) && existsSync(before) ? before : now;
}

/**
 * Moves the data of an earlier home from `~/.wizards-bot` to `~/.engenty/wizards-bot`, once,
 * when the new folder is not there yet: one rename on the same disk, so nothing is copied and
 * nothing is half there. Says what it did, or that the old folder is still there beside the new
 * one; nothing when there was nothing to move. A folder that does not move stays in use where it
 * is.
 */
export function moveData(home = homedir()): string | undefined {
  const now = dataFolder(home);
  const before = oldDataFolder(home);
  if (!existsSync(before)) return undefined;
  if (existsSync(now)) {
    return `The Bot Server uses ${now}. ${before} of an earlier Bot Server is still there; delete it when you no longer need it.`;
  }
  try {
    mkdirSync(dirname(now), { recursive: true, mode: 0o700 });
    renameSync(before, now);
    return `The Bot Server's data moved from ${before} to ${now}.`;
  } catch (error) {
    return `The Bot Server's data stays in ${before}: it could not move to ${now} (${(error as Error).message}).`;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.WIZARDS_BOT_DATA ?? defaultDataDir();
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return {
    dataDir,
    port: Number(env.WIZARDS_BOT_PORT ?? 4747),
    publicUrl: env.WIZARDS_BOT_URL?.replace(/\/+$/, ""),
    ollamaUrl: (env.OLLAMA_HOST ?? "http://127.0.0.1:11434").replace(/\/+$/, ""),
    subscriptions: (env.WIZARDS_BOT_SUBSCRIPTIONS ?? "claude,codex")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
    demoCode:
      env.WIZARDS_BOT_DEMO_CODE && tidyCode(env.WIZARDS_BOT_DEMO_CODE).length >= 8
        ? tidyCode(env.WIZARDS_BOT_DEMO_CODE)
        : undefined,
    setupCode: env.WIZARDS_BOT_SETUP_CODE
      ? tidyCode(env.WIZARDS_BOT_SETUP_CODE) || undefined
      : undefined,
    manageUrl: env.WIZARDS_BOT_MANAGE_URL?.replace(/\/+$/, "") || undefined,
    homeToken: env.WIZARDS_BOT_HOME_TOKEN || undefined,
    tunnelUrl: env.WIZARDS_TUNNEL_URL?.replace(/\/+$/, "") || undefined,
    frpc: env.WIZARDS_BOT_FRPC?.trim() || undefined,
  };
}

/** Whether version `a` is older than `b` (`0.1.1` < `0.2.0`); what follows a `-` is ignored. */
export function olderVersion(a: string, b: string): boolean {
  const parts = (v: string) => (v.split("-")[0] ?? "").split(".").map((n) => Number(n) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const [p, q] = [x[i] ?? 0, y[i] ?? 0];
    if (p !== q) return p < q;
  }
  return false;
}

/** A home that is older than the one that last wrote its data folder, which it may not read. */
export class DataTooNew extends Error {}

/**
 * Notes in the data folder which version of the home starts on it, and refuses a home older than
 * the last one: a newer home may have changed the data in a way an older one does not know.
 */
export function claimData(dataDir: string, version = VERSION): void {
  const file = join(dataDir, "version");
  const last = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
  if (last && olderVersion(version, last)) {
    throw new DataTooNew(
      `The data in ${dataDir} was last used by Bot Server ${last}. This is ${version}: use ${last} or newer.`,
    );
  }
  if (last !== version) writeFileSync(file, `${version}\n`, { mode: 0o600 });
}

/**
 * Folders where the person's own programs are (`claude`, `codex`, `ollama`), in front of
 * `PATH`: from `WIZARDS_BOT_PATH` and from the file `path` in the data folder, which the Mac
 * app writes from the person's login shell. A home started by launchd has only the system's
 * folders otherwise.
 */
export function extendPath(dataDir: string, env: NodeJS.ProcessEnv = process.env): string {
  const file = join(dataDir, "path");
  const given = [env.WIZARDS_BOT_PATH ?? "", existsSync(file) ? readFileSync(file, "utf8") : ""]
    .flatMap((line) => line.trim().split(delimiter))
    .filter((dir) => dir && isAbsolute(dir));
  const all = [...given, ...(env.PATH ?? "").split(delimiter).filter(Boolean)];
  env.PATH = [...new Set(all)].join(delimiter);
  return env.PATH;
}
