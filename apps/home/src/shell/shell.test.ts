import assert from "node:assert/strict";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import type { AppleContainerCommandRunner } from "@mastra/apple-container";
import type { Folder } from "@wizards-bot/protocol";
import { type TestHome, testHome } from "../test/fakes.ts";
import { agentOsUnavailable, networkRules } from "./agentos.ts";
import { AppleContainerEngine, LINUX_IMAGE } from "./apple-container.ts";
import { FolderDrive } from "./drive.ts";
import type { ShellCapabilities, ShellCommand, ShellEngine, ShellResult } from "./engine.ts";
import { report } from "./shell.ts";

/** An engine that runs nothing and remembers what it was asked. */
class FakeEngine implements ShellEngine {
  readonly name: string;
  readonly preparing = "nothing";
  readonly commands: ShellCommand[] = [];
  available = true;
  answer: Partial<ShellResult> = {};
  constructor(name: string) {
    this.name = name;
  }
  unavailable() {
    return this.available ? null : "not here";
  }
  ready() {
    return true;
  }
  async prepare() {}
  capabilities(): ShellCapabilities {
    return { label: this.name, notes: `${this.name} notes.`, network: "some", folders: "some" };
  }
  async run(command: ShellCommand): Promise<ShellResult> {
    this.commands.push(command);
    return {
      exitCode: 0,
      stdout: "done\n",
      stderr: "",
      timedOut: false,
      changes: [],
      ...this.answer,
    };
  }
  async stop() {}
}

describe("a connected folder in the light shell", () => {
  let root: string;
  let outside: string;
  const folder = (access: Folder["access"]): Folder => ({
    id: "f1",
    name: "data",
    path: root,
    access,
    allow: "ask",
    createdAt: "",
  });
  // The folder tools' rules, as `Folders.locate` applies them.
  const locate = (each: Folder, path: string) => {
    const parts = path.split("/").filter(Boolean);
    if (parts.some((part) => part === ".." || part.startsWith(".")))
      throw new Error(`“${path}” is not a path inside ${each.name}.`);
    return join(each.path, ...parts);
  };

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "wizards-bot-drive-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "wizards-bot-outside-")));
    writeFileSync(join(root, "plan.md"), "# Plan\n");
    writeFileSync(join(root, ".env"), "TOKEN=x");
    writeFileSync(join(outside, "private.txt"), "not yours");
    symlinkSync(join(outside, "private.txt"), join(root, "link.txt"));
    linkSync(join(outside, "private.txt"), join(root, "twin.txt"));
  });

  test("lists and reads what the folder tools show, nothing hidden and no link", async () => {
    const drive = new FolderDrive(folder("read"), false, locate);
    assert.deepEqual((await drive.readDir("/")).sort(), ["plan.md", "twin.txt"]);
    assert.equal(await drive.readTextFile("/plan.md"), "# Plan\n");
    await assert.rejects(drive.readFile("/.env"), /EACCES/);
    await assert.rejects(drive.readFile("/link.txt"), /EACCES: \/link.txt is a link/);
    assert.equal(await drive.exists("/link.txt"), false);
    assert.equal((await drive.stat("/plan.md")).mtimeMs % 1, 0);
  });

  test("changes nothing without the person's yes to the command", async () => {
    const drive = new FolderDrive(folder("write"), false, locate);
    await assert.rejects(drive.writeFile("/new.md", "x"), /EROFS/);
    const readOnly = new FolderDrive(folder("read"), true, locate);
    assert.equal(readOnly.writable, false, "a folder connected for reading stays read-only");
    assert.ok(!existsSync(join(root, "new.md")));
  });

  test("changes files when allowed, and names each change", async () => {
    const drive = new FolderDrive(folder("write"), true, locate);
    await drive.mkdir("/at/wien", { recursive: true });
    await drive.writeFile("/at/wien/bauordnung.md", "# Bauordnung\n");
    await drive.rename("/plan.md", "/plan-old.md");
    assert.equal(readFileSync(join(root, "at", "wien", "bauordnung.md"), "utf8"), "# Bauordnung\n");
    assert.deepEqual(drive.changes, [
      "made data/at/wien",
      "wrote data/at/wien/bauordnung.md",
      "moved data/plan.md → /plan-old.md",
    ]);
  });

  test("never writes through a link, a hard link or makes one", async () => {
    const drive = new FolderDrive(folder("write"), true, locate);
    await assert.rejects(drive.writeFile("/link.txt", "x"), /EACCES/);
    await assert.rejects(drive.writeFile("/twin.txt", "x"), /hard link/);
    await assert.rejects(drive.symlink(), /EACCES/);
    await assert.rejects(drive.writeFile("/run.command", "x"), /would be a program/);
    await assert.rejects(drive.writeFile("/../escape.txt", "x"), /EACCES/);
    assert.equal(readFileSync(join(outside, "private.txt"), "utf8"), "not yours");
  });
});

describe("the light shell's limits", () => {
  test("runs on macOS and glibc Linux only", () => {
    assert.equal(
      agentOsUnavailable("darwin", "arm64", () => false),
      null,
    );
    assert.equal(
      agentOsUnavailable("linux", "x64", () => true),
      null,
    );
    assert.match(agentOsUnavailable("linux", "arm64", () => false) ?? "", /glibc/);
    assert.match(agentOsUnavailable("win32", "x64", () => false) ?? "", /macOS and Linux/);
  });

  test("reaches the named sites and the package registries, nothing else", () => {
    const patterns = networkRules(["data.bka.gv.at"]).rules[0]?.patterns ?? [];
    assert.ok(patterns.includes("tcp://data.bka.gv.at:443"));
    assert.ok(patterns.includes("dns://pypi.org"));
    assert.equal(networkRules([]).default, "deny");
  });
});

describe("a command's output", () => {
  test("is cut for the model and kept whole in /work/.out", () => {
    const work = mkdtempSync(join(tmpdir(), "wizards-bot-work-"));
    const long = "x".repeat(25_000);
    const text = report(
      { exitCode: 0, stdout: long, stderr: "", timedOut: false, changes: [] },
      work,
      { seconds: 120 },
    );
    assert.match(text, /more characters in \/work\/\.out\/1\.txt/);
    assert.ok(readFileSync(join(work, ".out", "1.txt"), "utf8").includes(long));
    assert.ok(text.length < 21_000);
  });
});

describe("the full Linux on a Mac", () => {
  test("runs commands with Mastra's Apple container sandbox in /work", async () => {
    const calls: string[][] = [];
    const runner: AppleContainerCommandRunner = {
      async run(args) {
        calls.push(args);
        const ok = { success: true, exitCode: 0, stderr: "", executionTimeMs: 1 };
        if (args[0] === "inspect") {
          // No container before `run`, then one that runs with the labels `run` gave it.
          const created = calls.find((each) => each[0] === "run");
          const labels = Object.fromEntries(
            (created ?? [])
              .flatMap((arg, index) => (created?.[index - 1] === "--label" ? [arg] : []))
              .map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]),
          );
          return {
            ...ok,
            stdout: created
              ? JSON.stringify([
                  { status: "running", configuration: { id: "wizards-shell-c1", labels } },
                ])
              : "[]",
          };
        }
        return { ...ok, stdout: args[0] === "exec" ? "pdftotext version 24\n" : "" };
      },
    };
    const engine = new AppleContainerEngine({ runner, binary: () => "/usr/local/bin/container" });
    assert.equal(engine.unavailable(), null);
    const work = mkdtempSync(join(tmpdir(), "wizards-bot-linux-"));
    const result = await engine
      .run({
        key: "c1",
        command: "pdftotext -v",
        workDir: work,
        hosts: [],
        folders: [],
        locate: () => "",
        timeoutMs: 30_000,
      })
      .catch((error: Error) => error);
    const started = calls.find((each) => each[0] === "run");
    assert.ok(started, "the container was created");
    assert.ok(started.includes(LINUX_IMAGE));
    assert.ok(started.includes(`${work}:/work`));
    assert.ok(!(result instanceof Error), String(result));
    assert.equal(result.stdout, "pdftotext version 24\n");
    await engine.stop();
  });

  test("is not offered without Apple's container", () => {
    const engine = new AppleContainerEngine({ binary: () => undefined });
    assert.ok(engine.unavailable());
  });
});

describe("shell_run", () => {
  let t: TestHome;
  let light: FakeEngine;
  let full: FakeEngine;
  let root: string;

  before(async () => {
    t = await testHome("Ada");
    root = realpathSync(mkdtempSync(join(tmpdir(), "wizards-bot-shell-")));
    mkdirSync(join(root, "data"));
    mkdirSync(join(root, "notes"));
    t.home.folders.connect({ path: join(root, "data"), access: "write" });
    t.home.folders.connect({ path: join(root, "notes"), access: "read" });
  });
  after(() => t.stop());
  beforeEach(() => {
    light = new FakeEngine("light shell");
    full = new FakeEngine("full Linux");
    t.home.shell.engines.light = light;
    t.home.shell.engines.full = full;
  });

  /** What the tool told the model in the last request. */
  const told = () =>
    ((t.model.requests.at(-1)?.messages ?? []) as { role: string; content: string }[]).findLast(
      (message) => message.role === "tool",
    )?.content ?? "";
  const shell = (args: Record<string, unknown>) => ({
    calls: [{ name: "shell_run", arguments: args }],
  });

  test("asks before a command reaches a new site, and not again after always", async () => {
    t.model.script.push(
      shell({ command: "curl -sO https://data.bka.gv.at/x.json", hosts: ["data.bka.gv.at"] }),
    );
    await t.say("Fetch the law.");
    const card = t.item();
    assert.equal(card.title, "Let this command reach data.bka.gv.at?");
    assert.equal(light.commands.length, 0);
    t.model.script.push({ text: "Fetched." });
    await t.answer(card.id, "always");
    assert.equal(light.commands.length, 1);
    assert.deepEqual(light.commands[0]?.hosts, ["data.bka.gv.at"]);
    assert.match(told(), /Exit code 0\.\n--- output ---\ndone/);

    const items = t.home.store.items().length;
    t.model.script.push(
      shell({ command: "curl -s https://data.bka.gv.at/y.json", hosts: ["data.bka.gv.at"] }),
      {
        text: "Again.",
      },
    );
    await t.say("And the next one.");
    assert.equal(t.home.store.items().length, items, "no new card");
    assert.equal(light.commands.length, 2);
  });

  test("asks before every command that changes a connected folder, and the folder is writable only then", async () => {
    for (const round of [1, 2]) {
      t.model.script.push(shell({ command: "echo hi > /folders/data/a.md", write: ["data"] }));
      await t.say(`Write it, round ${round}.`);
      const card = t.item();
      assert.equal(card.title, "Let this command change files in data?");
      t.model.script.push({ text: "Written." });
      await t.answer(card.id, "once");
    }
    assert.equal(light.commands.length, 2);
    const folders = light.commands[0]?.folders ?? [];
    assert.deepEqual(
      folders.map((each) => [each.folder.name, each.writable]),
      [
        ["data", true],
        ["notes", false],
      ],
    );
  });

  test("refuses to change a folder connected for reading", async () => {
    t.model.script.push(shell({ command: "rm /folders/notes/x", write: ["notes"] }), {
      text: "No.",
    });
    await t.say("Delete it.");
    assert.match(told(), /notes is connected for reading only/);
    assert.equal(light.commands.length, 0);
  });

  test("does not run a command the person said no to", async () => {
    t.model.script.push(shell({ command: "curl https://example.org", hosts: ["example.org"] }));
    await t.say("Fetch example.org.");
    t.model.script.push({ text: "Understood." });
    await t.answer(t.item().id, "deny");
    assert.equal(light.commands.length, 0);
    assert.match(told(), /said no/);
  });

  test("starts the full Linux after one yes per conversation", async () => {
    t.model.script.push(shell({ command: "apt-get install -y poppler-utils", linux: true }));
    await t.say("Install pdftotext.");
    assert.equal(t.item().title, "Start a Linux computer for this conversation?");
    t.model.script.push({ text: "Installed." });
    await t.answer(t.item().id, "once");
    assert.equal(full.commands.length, 1);

    const items = t.home.store.items().length;
    t.model.script.push(shell({ command: "pdftotext -v", linux: true }), { text: "Done." });
    await t.say("Check it.");
    assert.equal(t.home.store.items().length, items);
    assert.equal(full.commands.length, 2);
    assert.equal(light.commands.length, 0);
  });

  test("is not there when no engine can run on this computer", async () => {
    light.available = false;
    full.available = false;
    t.model.script.push({ text: "No shell." });
    await t.say("Do you have a shell?");
    const tools = (t.model.requests.at(-1)?.tools ?? []) as {
      name?: string;
      function?: { name: string };
    }[];
    const names = tools.map((tool) => tool.function?.name ?? tool.name);
    assert.ok(names.includes("remember"), "the other tools are there");
    assert.ok(!names.includes("shell_run"));
  });
});

// Installs agentOS (about 320 MB) into a fresh data folder and runs real commands.
describe("shell_run with agentOS", { skip: !process.env.WIZARDS_BOT_SHELL_LIVE }, () => {
  let t: TestHome;
  let data: string;

  before(async () => {
    t = await testHome("Ada");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "wizards-bot-live-")));
    data = join(root, "data");
    mkdirSync(data);
    writeFileSync(join(data, "notes.txt"), "Bauordnung für Wien\n");
    writeFileSync(join(data, ".env"), "TOKEN=x\n");
    t.home.folders.connect({ path: data, access: "write" });
  });
  after(async () => {
    await t.home.shell.close();
    t.stop();
  });

  const told = () =>
    ((t.model.requests.at(-1)?.messages ?? []) as { role: string; content: string }[]).findLast(
      (message) => message.role === "tool",
    )?.content ?? "";

  test("downloads into /work, reads the folder without its hidden files, and writes after a yes", async () => {
    t.model.script.push({
      calls: [
        {
          name: "shell_run",
          arguments: {
            command:
              "curl -sS -o page.html -w '%{http_code}\\n' https://example.com/ && wc -c < page.html && cat /folders/data/notes.txt && cat /folders/data/.env; curl -s https://example.com/ | wc -c; python3 -c \"open('/folders/data/answer.txt', 'w').write(f'py {6*7}\\\\n')\"",
            hosts: ["example.com"],
            write: ["data"],
            timeout: 300,
          },
        },
      ],
    });
    await t.say("Fetch example.com and write the answer.");
    t.model.script.push({ text: "Done." });
    await t.answer(t.item().id, "once");
    const result = told();
    assert.match(result, /set up first/);
    assert.match(result, /200\n\d+\nBauordnung für Wien/);
    assert.match(result, /\.env: Permission denied/);
    assert.match(result, /wrote data\/answer\.txt/);
    assert.equal(readFileSync(join(data, "answer.txt"), "utf8"), "py 42\n");
    assert.ok(
      existsSync(join(t.home.shell.workDir(t.home.store.mainAgent().conversationId), "page.html")),
    );
  });
});
