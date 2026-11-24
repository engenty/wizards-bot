import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type AppleContainerCommandRunner, AppleContainerSandbox } from "@mastra/apple-container";
import type { ShellCapabilities, ShellCommand, ShellEngine, ShellResult } from "./engine.ts";

// The full Linux on a Mac: a Debian container in a virtual machine of its own, through Apple's
// `container` (macOS 26 and newer, Apple silicon) and Mastra's `AppleContainerSandbox`, which
// starts the container and runs the commands in it. One container per conversation, kept
// while the conversation uses it and removed after ten idle minutes; `/work` is the same
// folder as in the light shell. It is there for what WebAssembly cannot run: pdftotext,
// ffmpeg, ImageMagick, LibreOffice, pip packages with C code.
//
// What it does not do yet: connected folders are not inside (a whole folder in a virtual
// machine would show its hidden files), and the network is open while it runs. Both are why
// the person says yes to it once per conversation.

const run = promisify(execFile);

export const LINUX_IMAGE = "docker.io/library/python:3.13-slim";
const IDLE_MS = 10 * 60_000;
/** Where Apple's installer puts `container`. */
const CONTAINER_PATHS = ["/usr/local/bin/container", "/opt/homebrew/bin/container"];

/** The `container` program, when Apple's container is installed. */
export function findContainer(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const named = env.WIZARDS_BOT_CONTAINER;
  if (named) return existsSync(named) ? named : undefined;
  for (const dir of (env.PATH ?? "").split(":")) {
    if (dir && existsSync(join(dir, "container"))) return join(dir, "container");
  }
  return CONTAINER_PATHS.find((path) => existsSync(path));
}

/** macOS 26 is Darwin 25. */
const darwinMajor = (): number => Number(release().split(".")[0]);

export class AppleContainerEngine implements ShellEngine {
  readonly name = "apple-container";
  readonly preparing = "about 50 MB, once";
  private readonly binary: () => string | undefined;
  private readonly runner: AppleContainerCommandRunner | undefined;
  private readonly machines = new Map<
    string,
    { sandbox: AppleContainerSandbox; idle?: NodeJS.Timeout }
  >();
  private checked: { at: number; reason: string | null } | undefined;
  private pulled = false;
  private pulling: Promise<void> | undefined;

  /** `runner` replaces the `container` program, for tests. */
  constructor(
    options: { binary?: () => string | undefined; runner?: AppleContainerCommandRunner } = {},
  ) {
    this.binary = options.binary ?? (() => findContainer());
    this.runner = options.runner;
  }

  unavailable(): string | null {
    if (this.checked && Date.now() - this.checked.at < 60_000) return this.checked.reason;
    const reason = this.check();
    this.checked = { at: Date.now(), reason };
    return reason;
  }

  private check(): string | null {
    if (this.runner) return null;
    if (process.platform !== "darwin" || process.arch !== "arm64")
      return "The full Linux needs a Mac with Apple silicon.";
    if (darwinMajor() < 25) return "The full Linux needs macOS 26 or newer.";
    const binary = this.binary();
    if (!binary) return "The full Linux needs Apple's container, which is not installed.";
    try {
      execFileSync(binary, ["system", "status"], { stdio: "ignore", timeout: 5000 });
      return null;
    } catch {
      return "Apple's container is installed but not started.";
    }
  }

  ready(): boolean {
    return this.pulled || Boolean(this.runner);
  }

  prepare(): Promise<void> {
    if (this.ready()) return Promise.resolve();
    this.pulling ??= (async () => {
      const binary = this.binary();
      if (!binary) throw new Error(this.unavailable() ?? "Apple's container is not installed.");
      await run(binary, ["image", "pull", LINUX_IMAGE], { timeout: 15 * 60_000 });
      this.pulled = true;
    })().finally(() => {
      this.pulling = undefined;
    });
    return this.pulling;
  }

  capabilities(): ShellCapabilities {
    return {
      label: "full Linux",
      notes:
        "Debian with bash, python3 and pip, curl and apt-get. Install what a job needs, e.g. `apt-get update && apt-get install -y poppler-utils ffmpeg imagemagick libreoffice-core`, `pip install pdfplumber`. It is a virtual machine of the conversation: what you install stays until the conversation has been quiet for ten minutes.",
      network: "the whole internet while it runs",
      folders:
        "connected folders are not here. Copy files in with the light shell (`cp /folders/<name>/x.pdf /work/`) and the results back the same way: /work is the same folder in both.",
    };
  }

  async run(command: ShellCommand): Promise<ShellResult> {
    await this.prepare();
    mkdirSync(command.workDir, { recursive: true });
    const machine = this.machine(command);
    clearTimeout(machine.idle);
    try {
      const result = await machine.sandbox.executeCommand(command.command, [], {
        cwd: "/work",
        timeout: command.timeoutMs,
      });
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: Boolean(result.timedOut),
        changes: [],
      };
    } finally {
      machine.idle = setTimeout(() => void this.stop(command.key), IDLE_MS).unref();
    }
  }

  private machine(command: ShellCommand) {
    let machine = this.machines.get(command.key);
    if (!machine) {
      const binary = this.binary();
      machine = {
        sandbox: new AppleContainerSandbox({
          id: `wizards-shell-${command.key}`.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
          image: LINUX_IMAGE,
          volumes: { [command.workDir]: "/work" },
          workingDir: "/work",
          env: { HOME: "/work" },
          memory: "2G",
          cpus: 2,
          labels: { "wizards-bot.shell": command.key },
          deleteOnDestroy: true,
          ...(binary ? { containerBinary: binary } : {}),
          ...(this.runner ? { runner: this.runner } : {}),
        }),
      };
      this.machines.set(command.key, machine);
    }
    return machine;
  }

  async stop(key?: string): Promise<void> {
    const keys = key ? [key] : [...this.machines.keys()];
    await Promise.all(
      keys.map(async (each) => {
        const machine = this.machines.get(each);
        if (!machine) return;
        this.machines.delete(each);
        clearTimeout(machine.idle);
        await machine.sandbox.destroy().catch(() => undefined);
      }),
    );
  }
}
