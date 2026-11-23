import { join } from "node:path";
import { modelToolName, type PluginToolInfo } from "@engenty/plugins";
import {
  discoverPlugins,
  type PluginProblem,
  type PluginProcess,
  type PluginSource,
  skillsDir,
  startPluginProcess,
} from "@engenty/plugins/node";
import type { Plugin, PluginsView } from "@wizards-bot/protocol";
import { z } from "zod";
import { defineTool, type Tool } from "../agent/tool.ts";
import type { TurnContext } from "../agent/turns.ts";
import type { Home } from "../home.ts";
import { readSkills, type Skill } from "../skills/skills.ts";

// A plugin is a folder in `<data folder>/plugins` with an `engenty.plugin.json` (the contract of
// @engenty/plugins, the same engenty wizards loads). It brings skills (`skills/<name>/SKILL.md`,
// read by the home like its own) and tools (its server half). The tools run in a Node process
// of the plugin's own: it reads its folder, writes only `<data folder>/plugin-data/<id>`, starts
// no process and gets none of the home's environment, so no key of the home. A plugin is off
// until the person switches it on; a tool that is not marked read-only asks first, like a
// connection's.

/** Where the on switches and the tools allowed always are kept. */
const STATE = "plugins";
/** A plugin whose process ended is started again at most this often. */
const RESTART_MS = 60_000;
/** What a tool's answer may hold before it is cut. */
const MAX_ANSWER = 20_000;

interface State {
  on: string[];
  /** `<plugin>.<tool>` the person allowed always. */
  always: string[];
}

interface Running {
  process?: PluginProcess;
  starting?: Promise<void>;
  problem?: string;
  startedAt: number;
}

/** A tool of a plugin, and the plugin's skills it comes with: none, and it is always offered. */
export interface PluginTool {
  tool: Tool;
  skills: string[];
}

export class Plugins {
  readonly dir: string;
  private sources: PluginSource[] = [];
  private problems: PluginProblem[] = [];
  private readonly skillsOf = new Map<string, Skill[]>();
  private readonly running = new Map<string, Running>();

  private readonly home: Home;
  /** The names of the home's own skills, which a plugin's skill may not take. */
  private readonly taken: () => string[];

  constructor(home: Home, taken: () => string[]) {
    this.home = home;
    this.taken = taken;
    this.dir = join(home.config.dataDir, "plugins");
    this.scan();
    home.addTools((context) => (context.agent.main ? this.switchTools() : []));
  }

  // ── The folder ────────────────────────────────────────────────────────────

  /** Looks into the folder again: new plugins show up off, those gone stop. */
  scan(): void {
    const { found, problems } = discoverPlugins([this.dir]);
    this.sources = found;
    this.problems = problems;
    this.skillsOf.clear();
    const names = new Set(this.taken());
    for (const source of found) {
      const dir = skillsDir(source);
      if (!dir) continue;
      try {
        const skills = readSkills(dir).filter((skill) => {
          if (!names.has(skill.name)) return names.add(skill.name);
          this.problems.push({
            path: join(dir, skill.name),
            message: `A skill "${skill.name}" is already there.`,
          });
          return false;
        });
        this.skillsOf.set(
          source.id,
          skills.map((skill) => ({ ...skill, plugin: source.id })),
        );
      } catch (error) {
        this.problems.push({ path: dir, message: (error as Error).message });
      }
    }
    for (const id of this.running.keys()) {
      if (!this.isOn(id)) void this.stop(id);
    }
    for (const source of found) {
      if (this.isOn(source.id) && !this.running.has(source.id)) void this.start(source);
    }
  }

  private source(id: string): PluginSource | undefined {
    return this.sources.find((source) => source.id === id);
  }

  // ── On and off ────────────────────────────────────────────────────────────

  private state(): State {
    try {
      const saved = JSON.parse(this.home.db.meta(STATE) ?? "{}") as Partial<State>;
      return { on: saved.on ?? [], always: saved.always ?? [] };
    } catch {
      return { on: [], always: [] };
    }
  }

  private save(state: State): void {
    this.home.db.setMeta(STATE, JSON.stringify(state));
  }

  isOn(id: string): boolean {
    return this.state().on.includes(id) && this.source(id) !== undefined;
  }

  /** Switches a plugin on or off; on, it answers once its tools are ready or failed. */
  async setOn(id: string, on: boolean): Promise<boolean> {
    this.scan();
    const source = this.source(id);
    if (!source) return false;
    const state = this.state();
    const others = state.on.filter((each) => each !== id);
    this.save({
      on: on ? [...others, id] : others,
      // What was allowed always is asked again after the plugin was off.
      always: on ? state.always : state.always.filter((key) => !key.startsWith(`${id}.`)),
    });
    if (on) {
      await this.start(source);
    } else {
      await this.stop(id);
    }
    return true;
  }

  // ── The process ───────────────────────────────────────────────────────────

  private start(source: PluginSource): Promise<void> {
    const current = this.running.get(source.id);
    if (current?.starting) return current.starting;
    if (current?.process?.running()) return Promise.resolve();
    const entry: Running = { startedAt: Date.now() };
    this.running.set(source.id, entry);
    if (!source.entry) return Promise.resolve();
    entry.starting = startPluginProcess({
      source,
      dataDir: join(this.home.config.dataDir, "plugin-data", source.id),
      log: (level, line) =>
        console[level === "info" ? "log" : level](`[plugin ${source.id}]`, line),
      onExit: (reason) => {
        if (this.running.get(source.id) === entry) entry.problem = `It stopped (${reason}).`;
      },
    }).then(
      (process) => {
        entry.starting = undefined;
        // Switched off while it started.
        if (this.running.get(source.id) !== entry) {
          void process.stop();
          return;
        }
        entry.process = process;
        entry.problem = undefined;
      },
      (error: Error) => {
        entry.starting = undefined;
        entry.problem = error.message;
      },
    );
    return entry.starting;
  }

  private async stop(id: string): Promise<void> {
    const entry = this.running.get(id);
    this.running.delete(id);
    await entry?.starting;
    await entry?.process?.stop();
  }

  /** Waits until every plugin that is starting is ready or failed. */
  async ready(): Promise<void> {
    await Promise.all([...this.running.values()].map((entry) => entry.starting));
  }

  close(): void {
    for (const id of [...this.running.keys()]) void this.stop(id);
  }

  // ── What the agents get ───────────────────────────────────────────────────

  /** The skills of the plugins that are on. */
  skills(): Skill[] {
    return this.sources
      .filter((s) => this.isOn(s.id))
      .flatMap((s) => this.skillsOf.get(s.id) ?? []);
  }

  /** The tools of the plugins that are on and ready. One whose process ended starts again. */
  tools(context: TurnContext): PluginTool[] {
    const out: PluginTool[] = [];
    for (const source of this.sources) {
      if (!this.isOn(source.id)) continue;
      const entry = this.running.get(source.id);
      if (!entry?.process?.running()) {
        if (source.entry && !entry?.starting && Date.now() - (entry?.startedAt ?? 0) > RESTART_MS)
          void this.start(source);
        continue;
      }
      const skills = (this.skillsOf.get(source.id) ?? []).map((skill) => skill.name);
      for (const info of entry.process.tools) {
        out.push({ tool: this.tool(context, source, entry.process, info), skills });
      }
    }
    return out;
  }

  private tool(
    context: TurnContext,
    source: PluginSource,
    process: PluginProcess,
    info: PluginToolInfo,
  ): Tool {
    const key = `${source.id}.${info.name}`;
    const label = `${source.manifest.name}: ${info.title ?? info.name}`;
    const go = async (input: unknown): Promise<string> => {
      const value = await process.call(info.name, input);
      const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
      return text.length > MAX_ANSWER
        ? `${text.slice(0, MAX_ANSWER)}\n[cut at ${MAX_ANSWER} characters]`
        : text;
    };
    return defineTool({
      name: modelToolName(source.id, info.name),
      description: info.readOnly
        ? info.description
        : `${info.description} It changes something: the person is asked first, and your turn ends.`,
      input: inputOf(info),
      label: () => label,
      ...(info.readOnly ? {} : { asks: true as const }),
      run: async (input, call) => {
        if (info.readOnly) return go(input);
        if (!call.answer) {
          // In a turn that read data from outside the home, "always" does not count.
          if (this.state().always.includes(key) && !context.outside()) return go(input);
          return call.ask(
            {
              kind: "approval",
              level: "needs_you",
              title: label,
              body: `**${source.manifest.name}** · \`${info.name}\`\n\n\`\`\`json\n${JSON.stringify(input, null, 2).slice(0, 1500)}\n\`\`\``,
              actions: [
                { id: "once", label: "Allow once", style: "primary" },
                { id: "always", label: "Always allow", style: "plain" },
                { id: "deny", label: "Don't", style: "plain" },
              ],
            },
            { plugin: source.id },
          );
        }
        if (call.answer.action === "deny")
          return `The person said no to "${label}". Do not try it another way.`;
        if (call.answer.action === "always") {
          const state = this.state();
          if (!state.always.includes(key)) this.save({ ...state, always: [...state.always, key] });
        }
        return go(input);
      },
    });
  }

  // ── The person's view ─────────────────────────────────────────────────────

  view(): PluginsView {
    this.scan();
    return {
      folder: this.dir,
      plugins: this.sources.map((source) => this.viewOf(source)),
      problems: this.problems.map(({ path, message }) => ({ path, message })),
    };
  }

  private viewOf(source: PluginSource): Plugin {
    const on = this.isOn(source.id);
    const entry = this.running.get(source.id);
    const state: Plugin["state"] = !on
      ? "off"
      : entry?.starting
        ? "starting"
        : entry?.problem
          ? "failed"
          : "ready";
    return {
      id: source.id,
      name: source.manifest.name,
      version: source.manifest.version,
      ...(source.manifest.description ? { description: source.manifest.description } : {}),
      on,
      state,
      ...(on && entry?.problem ? { problem: entry.problem } : {}),
      skills: (this.skillsOf.get(source.id) ?? []).map(({ name, description }) => ({
        name,
        description,
      })),
      tools: (entry?.process?.tools ?? []).map((info) => ({
        name: modelToolName(source.id, info.name),
        description: info.description,
        readOnly: info.readOnly,
      })),
    };
  }

  // ── The main agent's tools ────────────────────────────────────────────────

  private switchTools(): Tool[] {
    return [
      defineTool({
        name: "plugin_list",
        description:
          "List the plugins in the plugins folder of the Bot Server: whether each is on, its skills and its tools.",
        input: z.object({}),
        label: () => "Looking at the plugins",
        run: async () => {
          const { folder, plugins } = this.view();
          if (!plugins.length)
            return `There is no plugin. A plugin is a folder the person puts into ${folder}.`;
          return plugins
            .map(
              (plugin) =>
                `- ${plugin.id} (${plugin.name} ${plugin.version}): ${plugin.state}${plugin.problem ? ` — ${plugin.problem}` : ""}. Skills: ${plugin.skills.map((s) => s.name).join(", ") || "none"}. Tools: ${plugin.tools.map((t) => t.name).join(", ") || "none"}.`,
            )
            .join("\n");
        },
      }),
      defineTool({
        name: "plugin_switch",
        description:
          "Switch a plugin on or off. On asks the person first with a card and ends your turn: its code runs on the Bot Server.",
        input: z.object({ id: z.string(), on: z.boolean() }),
        label: (input) =>
          `${input.on ? "Switching on" : "Switching off"} ${String(input.id ?? "")}`,
        asks: true,
        run: async (input, call) => {
          this.scan();
          const source = this.source(input.id);
          if (!source)
            return `There is no plugin ${input.id}. Plugins: ${this.sources.map((s) => s.id).join(", ") || "none"}.`;
          if (!input.on) {
            await this.setOn(source.id, false);
            return `${source.manifest.name} is off.`;
          }
          if (this.isOn(source.id)) return `${source.manifest.name} is on already.`;
          if (!call.answer)
            return call.ask({
              kind: "approval",
              level: "needs_you",
              title: `Switch on ${source.manifest.name}?`,
              body: `${source.manifest.description ?? ""}\n\nIts code runs on your Bot Server, in a process that reads only its own folder and gets none of your keys. Tools that change something ask you first.`,
              actions: [
                { id: "on", label: "Switch on", style: "primary" },
                { id: "deny", label: "Don't", style: "plain" },
              ],
            });
          if (call.answer.action !== "on") return `The person left ${source.manifest.name} off.`;
          await this.setOn(source.id, true);
          const plugin = this.viewOf(source);
          return plugin.state === "failed"
            ? `${source.manifest.name} did not start: ${plugin.problem}`
            : `${source.manifest.name} is on.`;
        },
      }),
    ];
  }
}

/** A tool's input as zod, from the JSON Schema its plugin reported. */
function inputOf(info: PluginToolInfo): z.ZodType {
  try {
    return z.fromJSONSchema(info.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    return z.record(z.string(), z.unknown());
  }
}
