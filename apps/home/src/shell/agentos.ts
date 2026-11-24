import { execFile } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { FolderDrive } from "./drive.ts";
import {
  REGISTRIES,
  type ShellCapabilities,
  type ShellCommand,
  type ShellEngine,
  type ShellResult,
} from "./engine.ts";

// The light shell: agentOS (Rivet, Apache-2.0), a Linux userland compiled to WebAssembly, Node
// in V8 isolates and Python as Pyodide, all in one helper process of the home. Each command
// runs in a VM of its own that starts in milliseconds and is gone when the command ends; what
// stays is `/work`, a folder of the conversation in the home's data folder. It needs nothing
// from the person: the first command installs it into the data folder.

const run = promisify(execFile);

export const AGENTOS_VERSION = "0.4.9";
const CORE = "@rivet-dev/agentos-core";
/** Where agentOS keeps its programs, compiled to WebAssembly. */
const COMMANDS = join("node_modules", "@rivet-dev", "agentos-runtime-core", "commands");
/**
 * Programs agentOS ships but leaves off the PATH. Not its `curl` and `wget`: their sockets
 * cannot connect, ours (`commands/`) take their place. Not `git`: it cannot write its objects
 * into `/work`.
 */
const EXTRA_COMMANDS = ["jq", "yq", "sqlite3", "rg", "fd", "tree", "file", "zip", "unzip"];
const OWN_COMMANDS = ["curl", "wget"];
/** Written last: a folder without it is an install that did not finish. */
const MARKER = "engine.json";
/** The helper process is stopped after this long without a command. */
const IDLE_MS = 10 * 60_000;
/**
 * Python starts in $HOME, whatever directory the shell is in. Before each command, `python3`
 * becomes a function that hands it the shell's directory as HOME.
 */
const PYTHON_FOLLOWS_CD =
  'python3() { HOME="$PWD" command python3 "$@"; }; python() { python3 "$@"; }\n';

/** The part of agentOS's API the engine uses. */
interface AgentOsResult {
  outcome: string;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  error?: { message: string };
}
interface AgentOsVm {
  process: {
    exec(command: string, options: Record<string, unknown>): Promise<AgentOsResult>;
  };
  dispose(): Promise<void>;
}
interface AgentOsSidecar {
  dispose(): Promise<void>;
}
interface AgentOsModule {
  AgentOs: {
    createSidecar(): Promise<AgentOsSidecar>;
    create(options: Record<string, unknown>): Promise<AgentOsVm>;
  };
  hostDirMount(path: string, hostPath: string, options?: { readOnly?: boolean }): unknown;
}

/** Whether this Linux has glibc. Asked once: Node's report takes seconds to make. */
let glibcFound: boolean | undefined;
function hasGlibc(): boolean {
  glibcFound ??= Boolean(
    (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)
      ?.header?.glibcVersionRuntime,
  );
  return glibcFound;
}

/** agentOS ships its helper for macOS and glibc Linux, on arm64 and x64. */
export function agentOsUnavailable(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  glibc: () => boolean = hasGlibc,
): string | null {
  if (!["darwin", "linux"].includes(platform) || !["arm64", "x64"].includes(arch))
    return `The shell runs on macOS and Linux (arm64, x64), not on ${platform} ${arch}.`;
  if (platform === "linux" && !glibc())
    return "The shell needs a Linux with glibc; this one (Alpine, musl) has none.";
  return null;
}

/** The network rules of one command: its hosts and the package registries, nothing else. */
export function networkRules(hosts: string[]) {
  return {
    default: "deny",
    rules: [
      {
        mode: "allow",
        operations: ["*"],
        patterns: [...new Set([...REGISTRIES, ...hosts])].flatMap((host) => [
          `dns://${host}`,
          `tcp://${host}:443`,
          `tcp://${host}:80`,
        ]),
      },
    ],
  };
}

export class AgentOsEngine implements ShellEngine {
  readonly name = "agentos";
  readonly preparing = "about 320 MB, once";
  private readonly dir: string;
  private installing: Promise<void> | undefined;
  private runtime: Promise<{ module: AgentOsModule; sidecar: AgentOsSidecar }> | undefined;
  private idle: NodeJS.Timeout | undefined;
  private running = 0;

  /** `dir`: where it is installed, `engines/agentos` in the data folder. */
  constructor(dir: string) {
    this.dir = dir;
  }

  unavailable(): string | null {
    return agentOsUnavailable();
  }

  ready(): boolean {
    try {
      return JSON.parse(readFileSync(join(this.dir, MARKER), "utf8")).version === AGENTOS_VERSION;
    } catch {
      return false;
    }
  }

  prepare(): Promise<void> {
    if (this.ready()) return Promise.resolve();
    this.installing ??= this.install().finally(() => {
      this.installing = undefined;
    });
    return this.installing;
  }

  capabilities(): ShellCapabilities {
    return {
      label: "light shell",
      notes:
        "bash with coreutils, grep, sed, awk, find, tar, gzip, zip, unzip, jq, yq, sqlite3, rg, fd, tree, file, node (JavaScript, not TypeScript) and python3 (Pyodide 3.13: numpy and pandas are there; a pure-Python package is added at the top of the same program, `import micropip; await micropip.install('pypdf')`, and is gone with the command; no pip command, nothing with C code). curl and wget are small versions over fetch: the usual options (-o, -O, -L, -s, -f, -H, -d, -X, -w), no others. No git, ffmpeg, ImageMagick, pdftotext or LibreOffice. What node and python3 print reaches you, but not a pipe or a `>` file: let such a program write its files itself (open() in Python, fs.writeFileSync in Node). Each command starts fresh: only files in /work and in connected folders stay.",
      network:
        "only the sites named in `hosts` that the person allowed, and the Python and npm package registries",
      folders:
        "each connected folder is at /folders/<name>, read-only; with the folder in `write` (the person says yes to that command) the command may change files there. Hidden files and links are not there.",
    };
  }

  async run(command: ShellCommand): Promise<ShellResult> {
    await this.prepare();
    this.running++;
    clearTimeout(this.idle);
    const drives = command.folders.map(
      ({ folder, writable }) => new FolderDrive(folder, writable, command.locate),
    );
    try {
      const { module, sidecar } = await this.start();
      mkdirSync(command.workDir, { recursive: true });
      const vm = await module.AgentOs.create({
        sidecar: { kind: "explicit", handle: sidecar },
        software: [{ packagePath: join(this.dir, "extras") }],
        // The person's own user: files in /work and in connected folders are theirs.
        user: { uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 },
        mounts: [
          module.hostDirMount("/work", command.workDir, { readOnly: false }),
          ...drives.map((drive) => ({
            path: `/folders/${drive.folder.name}`,
            driver: drive,
            readOnly: !drive.writable,
          })),
        ],
        permissions: {
          fs: "allow",
          childProcess: "allow",
          process: "allow",
          env: "allow",
          network: networkRules(command.hosts),
        },
      });
      try {
        const result = await vm.process.exec(PYTHON_FOLLOWS_CD + command.command, {
          cwd: "/work",
          env: { HOME: "/work" },
          timeoutMs: command.timeoutMs,
          output: { capture: "all" },
        });
        const timedOut = result.outcome === "timed_out";
        let stderr = result.stderr ?? "";
        if (result.outcome !== "succeeded" && !timedOut && !result.stdout && !stderr)
          stderr = result.error?.message ?? result.outcome;
        return {
          exitCode: result.exitCode ?? (result.outcome === "succeeded" ? 0 : 1),
          stdout: result.stdout ?? "",
          stderr,
          timedOut,
          changes: drives.flatMap((drive) => drive.changes),
        };
      } finally {
        await vm.dispose().catch(() => undefined);
      }
    } finally {
      this.running--;
      if (!this.running) this.idle = setTimeout(() => void this.stop(), IDLE_MS).unref();
    }
  }

  async stop(): Promise<void> {
    clearTimeout(this.idle);
    const current = this.runtime;
    this.runtime = undefined;
    await (await current?.catch(() => undefined))?.sidecar.dispose().catch(() => undefined);
  }

  // ── The helper process ────────────────────────────────────────────────────

  private start(): Promise<{ module: AgentOsModule; sidecar: AgentOsSidecar }> {
    this.runtime ??= (async () => {
      // agentOS reads the helper's path from the environment when it starts the helper.
      // The extra programs are packed anew, so a new home brings its own curl and wget.
      packExtras(this.dir);
      const wrapper = join(this.dir, "sidecar.sh");
      if (existsSync(wrapper)) process.env.AGENTOS_SIDECAR_BIN = wrapper;
      const entry = join(
        this.dir,
        "node_modules",
        "@rivet-dev",
        "agentos-core",
        "dist",
        "index.js",
      );
      const module = (await import(pathToFileURL(entry).href)) as AgentOsModule;
      return { module, sidecar: await module.AgentOs.createSidecar() };
    })();
    this.runtime.catch(() => {
      this.runtime = undefined;
    });
    return this.runtime;
  }

  // ── Installing ────────────────────────────────────────────────────────────

  private async install(): Promise<void> {
    const reason = this.unavailable();
    if (reason) throw new Error(reason);
    const next = `${this.dir}.new`;
    rmSync(next, { recursive: true, force: true });
    mkdirSync(next, { recursive: true });
    writeFileSync(
      join(next, "package.json"),
      `${JSON.stringify({ private: true, dependencies: { [CORE]: AGENTOS_VERSION } }, null, 2)}\n`,
    );
    const [command, args] = npm();
    await run(
      command,
      [
        ...args,
        "install",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
      ],
      {
        cwd: next,
        timeout: 15 * 60_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    packExtras(next);
    writeSidecarWrapper(next, this.dir);
    writeFileSync(join(next, MARKER), `${JSON.stringify({ version: AGENTOS_VERSION })}\n`);
    await this.stop();
    rmSync(this.dir, { recursive: true, force: true });
    renameSync(next, this.dir);
  }
}

/**
 * How to run npm: the one that came with the home's Node (the Mac app carries it beside
 * `bin/node`), else the one on the PATH.
 */
function npm(): [string, string[]] {
  const beside = join(
    dirname(process.execPath),
    "..",
    "lib",
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  return existsSync(beside) ? [process.execPath, [beside]] : ["npm", []];
}

/** An agentOS package of the extra programs: a manifest and the programs in `bin/`. */
function packExtras(dir: string): void {
  const extras = join(dir, "extras");
  const bin = join(extras, "bin");
  rmSync(extras, { recursive: true, force: true });
  mkdirSync(bin, { recursive: true });
  for (const name of EXTRA_COMMANDS) {
    const source = join(dir, COMMANDS, name);
    if (!existsSync(source)) continue;
    copyFileSync(source, join(bin, name));
    // Without the mode, the VM finds the program and refuses to run it.
    chmodSync(join(bin, name), 0o755);
  }
  for (const name of OWN_COMMANDS) {
    copyFileSync(join(import.meta.dirname, "commands", `${name}.cjs`), join(bin, name));
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(
    join(extras, "agentos-package.json"),
    `${JSON.stringify({ name: "wizards-bot-shell", version: AGENTOS_VERSION })}\n`,
  );
}

/**
 * The helper prints a line on stderr for every engine it keeps warm, which would fill the
 * home's log. The wrapper leaves those lines out.
 */
function writeSidecarWrapper(dir: string, installed: string): void {
  const bash = ["/bin/bash", "/usr/bin/bash"].find((path) => existsSync(path));
  const modules = join("node_modules", "@rivet-dev");
  const platform = readdirSync(join(dir, modules)).find((name) =>
    name.startsWith("agentos-runtime-sidecar-"),
  );
  const helper = platform && join(modules, platform, "agentos-native-sidecar");
  if (!bash || !helper || !existsSync(join(dir, helper))) return;
  // The folder is renamed into place after this, so the wrapper names the helper there.
  const quoted = `'${join(installed, helper).replaceAll("'", `'\\''`)}'`;
  writeFileSync(
    join(dir, "sidecar.sh"),
    `#!${bash}\n# agentOS's helper without the lines it prints for every engine it keeps warm.\nexec ${quoted} "$@" 2> >(grep --line-buffered -v -e '^agentos-v8-runtime: ' -e 'vfs::posix::tar_fs' -e 'blocking executor' -e 'agentos_native_sidecar::execution' >&2)\n`,
  );
  chmodSync(join(dir, "sidecar.sh"), 0o755);
}
