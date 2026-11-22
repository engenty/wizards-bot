import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

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
}

/** Whether the home runs on wizards.bot, made and kept by the Manage-App. */
export const isHosted = (config: Pick<Config, "manageUrl">): boolean => Boolean(config.manageUrl);

/** A pairing code as it is compared: letters and digits only, in capitals. */
export const tidyCode = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.WIZARDS_BOT_DATA ?? join(homedir(), ".wizards-bot");
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
