import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSkillContent } from "@mastra/core/skills";
import { z } from "zod";
import { defineTool, type Tool } from "../agent/tool.ts";
import type { Trigger, TurnContext } from "../agent/turns.ts";
import type { Home } from "../home.ts";
import { appLinkTools } from "./app-links/tools.ts";
import { excelTools } from "./excel/tools.ts";
import { readingTools, registerDocumentCards } from "./office/documents.ts";
import { powerpointTools } from "./powerpoint/tools.ts";
import { wordTools } from "./word/tools.ts";

// A skill is what an agent needs for one kind of task: instructions, and tools of its own.
// It is a folder here with a `SKILL.md`: a name, a description of when it applies, and the
// instructions. What calls for it stands in `metadata`, on one line: the formatter of this
// repository does not know a file's head and would pull nested lines apart. An agent's instructions carry one line per skill. A skill's text and tools
// enter a conversation when it is loaded: by the agent with `skill_load`, or by the home when
// a message makes the need plain.

/** The tools a skill brings, by the skill's name. A skill without an entry is instructions only. */
const TOOLS: Record<string, (context: TurnContext) => Tool[]> = {
  "app-links": appLinkTools,
  word: wordTools,
  excel: excelTools,
  powerpoint: powerpointTools,
};

/** Messages of a conversation a loaded skill stays for, counted anew each time it is used. */
const KEEP = 6;

export interface Skill {
  name: string;
  /** One line: what it is for. */
  description: string;
  instructions: string;
  /** Endings of attached files that call for it, e.g. `docx`. */
  files: string[];
  /** Matches a message that names what the skill is for. */
  words: RegExp | undefined;
  /** The plugin that brought it; none for the home's own. */
  plugin?: string;
}

const list = (value: unknown): string[] =>
  (Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [])
    .map((entry) => String(entry).trim())
    .filter(Boolean);

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One pattern for a skill's words. A word with a capital letter is matched as it is written
 * (`Word` the program, not "a word"), every other one in any case; none inside a longer word.
 */
function wordPattern(words: string[]): RegExp | undefined {
  if (!words.length) return undefined;
  const each = words.map((word) =>
    /\p{Lu}/u.test(word)
      ? escaped(word)
      : [...word]
          .map((letter) => {
            const lower = letter.toLowerCase();
            const upper = letter.toUpperCase();
            return lower === upper ? escaped(letter) : `[${lower}${upper}]`;
          })
          .join(""),
  );
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${each.join("|")})(?![\\p{L}\\p{N}])`, "u");
}

/** Reads the skills of a folder: every folder in it that holds a `SKILL.md`. */
export function readSkills(dir: string): Skill[] {
  const skills: Skill[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name, "SKILL.md");
    if (!entry.isDirectory() || !existsSync(file)) continue;
    // Mastra reads and checks the file: a name that is the folder's, a description, the text.
    const checked = validateSkillContent({
      content: readFileSync(file, "utf8"),
      directoryName: entry.name,
    });
    if (!checked.valid || !checked.metadata || !checked.instructions)
      throw new Error(`The skill ${entry.name} is not valid: ${checked.errors.join("; ")}`);
    const more = (checked.metadata.metadata ?? {}) as Record<string, unknown>;
    skills.push({
      name: String(checked.metadata.name),
      description: String(checked.metadata.description).trim(),
      instructions: checked.instructions.trim(),
      files: list(more.files).map((ending) => ending.toLowerCase().replace(/^\./, "")),
      words: wordPattern(list(more.words)),
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export class Skills {
  /** The home's own skills. */
  private readonly own: Skill[];
  /** Per conversation: the loaded skills and how many more messages each stays for. */
  private readonly loaded = new Map<string, Map<string, number>>();
  /** The skills each skill tool belongs to, by the tool's name: it is shown while one is loaded. */
  private readonly owners = new Map<string, string[]>();

  private readonly home: Home;

  constructor(home: Home, dir = dirname(fileURLToPath(import.meta.url))) {
    this.home = home;
    this.own = readSkills(dir);
    home.addTools((context) => this.tools(context));
    registerDocumentCards(home);
  }

  /** The names of the home's own skills, which a plugin's may not take. */
  ownNames(): string[] {
    return this.own.map((skill) => skill.name);
  }

  /** The home's own skills and those of the plugins that are on. */
  private get skills(): Skill[] {
    const fromPlugins = this.home.plugins?.skills() ?? [];
    return fromPlugins.length
      ? [...this.own, ...fromPlugins].sort((a, b) => a.name.localeCompare(b.name))
      : this.own;
  }

  list(): Skill[] {
    return this.skills;
  }

  /** The skills a message calls for by what it says and what is attached to it. */
  matching(trigger: Pick<Trigger, "text" | "files">): Skill[] {
    const endings = (trigger.files ?? []).map(
      (file) => file.name.split(".").pop()?.toLowerCase() ?? "",
    );
    return this.skills.filter(
      (skill) =>
        skill.files.some((ending) => endings.includes(ending)) || skill.words?.test(trigger.text),
    );
  }

  /**
   * Called with every message an agent gets. Loads the skills the message calls for, so
   * that a model does not have to decide, and lets go of those that were not used for a while.
   */
  hear(conversationId: string, trigger: Pick<Trigger, "text" | "files">): void {
    const loaded = this.loaded.get(conversationId);
    for (const [name, left] of loaded ?? []) {
      if (left <= 1) loaded?.delete(name);
      else loaded?.set(name, left - 1);
    }
    for (const skill of this.matching(trigger)) this.load(conversationId, skill.name);
  }

  /** Loads a skill into a conversation, or keeps a loaded one for longer. */
  load(conversationId: string, name: string): Skill | undefined {
    const skill = this.skills.find((each) => each.name === name.trim().toLowerCase());
    if (!skill) return undefined;
    const loaded = this.loaded.get(conversationId) ?? new Map<string, number>();
    loaded.set(skill.name, KEEP);
    this.loaded.set(conversationId, loaded);
    return skill;
  }

  isLoaded(conversationId: string, name: string): boolean {
    return this.loaded.get(conversationId)?.has(name) === true;
  }

  /** Whether a model sees a tool now: a skill's tool only while the skill is loaded. */
  shows(conversationId: string, tool: string): boolean {
    const owners = this.owners.get(tool);
    return !owners?.length || owners.some((owner) => this.isLoaded(conversationId, owner));
  }

  /**
   * What an agent's instructions say about skills: one line each, and the text of those
   * loaded in this conversation.
   */
  prompt(conversationId: string): string {
    if (!this.skills.length) return "";
    const loaded = this.skills.filter((skill) => this.isLoaded(conversationId, skill.name));
    return [
      [
        "Skills: instructions and tools for one kind of task. Before such a task, load its skill with `skill_load`, then follow it.",
        ...this.skills.map(
          (skill) =>
            `- ${skill.name}${loaded.includes(skill) ? " (loaded, see below)" : ""}: ${skill.description}`,
        ),
      ].join("\n"),
      ...loaded.map((skill) => `Loaded skill "${skill.name}":\n${skill.instructions}`),
    ].join("\n\n");
  }

  private tools(context: TurnContext): Tool[] {
    const { conversationId } = context;
    const brought: Tool[] = [];
    const bring = (tool: Tool, skills: string[]) => {
      this.owners.set(tool.name, skills);
      brought.push(
        skills.length
          ? {
              ...tool,
              // Using a skill's tool keeps its skills loaded.
              run: (input, call) => {
                for (const skill of skills) this.load(conversationId, skill);
                return tool.run(input, call);
              },
            }
          : tool,
      );
    };
    for (const skill of this.own) {
      for (const tool of TOOLS[skill.name]?.(context) ?? []) bring(tool, [skill.name]);
    }
    // A plugin's tools come with its skills; a plugin without skills has them always.
    const fromPlugins = this.home.plugins?.tools(context) ?? [];
    for (const { tool, skills } of fromPlugins) bring(tool, skills);
    const toolsOf = (skill: string): string[] => [
      ...(TOOLS[skill]?.(context) ?? []).map((tool) => tool.name),
      ...fromPlugins.filter((each) => each.skills.includes(skill)).map((each) => each.tool.name),
    ];
    return [
      defineTool({
        name: "skill_load",
        description:
          "Load a skill by its name: you get its instructions now and its tools from your next step on. Your instructions list the skills.",
        input: z.object({ name: z.string() }),
        label: (input) => `Loading the ${String(input.name ?? "")} skill`,
        run: async (input) => {
          const skill = this.load(conversationId, input.name);
          if (!skill)
            return `There is no skill ${input.name}. Skills: ${this.skills.map((each) => each.name).join(", ")}.`;
          const names = toolsOf(skill.name).map((name) => `\`${name}\``);
          return `${skill.instructions}${names.length ? `\n\nIts tools are yours from your next step on: ${names.join(", ")}.` : ""}`;
        },
      }),
      ...readingTools(context),
      ...brought,
    ];
  }
}
