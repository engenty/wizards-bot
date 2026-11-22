import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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
