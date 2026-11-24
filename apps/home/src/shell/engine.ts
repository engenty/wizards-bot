import type { Folder } from "@wizards-bot/protocol";

// A way to run the shell on this computer. The home has one light engine that runs everywhere
// it can and, where the computer allows it, a full Linux for what the light one cannot run.
// Engines for more platforms (bubblewrap on Linux, Windows' execution containers, a sandbox
// in the cloud) are more entries in `engines.ts`; the tool and its rules stay the same.

/** A connected folder as a command sees it, at `/folders/<name>`. */
export interface ShellFolder {
  folder: Folder;
  /** Whether this command may change files in it: the person said yes to this command. */
  writable: boolean;
}

/** One command and everything it may reach. */
export interface ShellCommand {
  /** The conversation's machine: one per conversation, its `/work` kept on the disk. */
  key: string;
  command: string;
  /** The folder on the disk that is `/work` inside. */
  workDir: string;
  /** The internet addresses the command may reach, besides the package registries. */
  hosts: string[];
  folders: ShellFolder[];
  /** The folder rules of the folder tools: a path in a connected folder as a path on the disk. */
  locate: (folder: Folder, path: string) => string;
  timeoutMs: number;
}

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** What the command changed in connected folders, e.g. "wrote data/at/wien.md". */
  changes: string[];
}

/** What an engine really runs: the tool's description is written from it. */
export interface ShellCapabilities {
  /** Its name for the agent and the person. */
  label: string;
  /** What it is good for and what it cannot do, for the agent. */
  notes: string;
  /** What it reaches on the internet, for the agent. */
  network: string;
  /** How the connected folders are there, for the agent. */
  folders: string;
}

export interface ShellEngine {
  /** Its name in settings and logs: "agentos", "apple-container". */
  readonly name: string;
  /** Why it cannot run on this computer, or null when it can. */
  unavailable(): string | null;
  /** Whether what it needs is on the disk; `prepare` gets it otherwise. */
  ready(): boolean;
  /** Fetches and installs what it needs. Runs once; later calls wait for the first. */
  prepare(): Promise<void>;
  /** What preparing costs, for the label of the first command: "about 320 MB, once". */
  readonly preparing: string;
  capabilities(): ShellCapabilities;
  run(command: ShellCommand): Promise<ShellResult>;
  /** Stops what runs for `key`, or everything. */
  stop(key?: string): Promise<void>;
}

/** Always reachable: where Python and Node packages come from. */
export const REGISTRIES = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "cdn.jsdelivr.net",
];
