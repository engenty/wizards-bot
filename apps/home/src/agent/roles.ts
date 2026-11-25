import type { HomePerson } from "@wizards-bot/protocol";
import { runsHome } from "../group.ts";
import type { Tool } from "./tool.ts";

/**
 * The tools an agent of a group home has for a member of the team: those that stay in the
 * conversation. What its admins connected (accounts, folders, the Vault, the shell), what starts
 * work that answers to nobody here (tasks, other agents) and what changes the home stay theirs.
 */
const MEMBER = new Set([
  "ask",
  "remember",
  "skill_load",
  "go_on",
  "document_read",
  "document_write",
  "artifact_read",
  "artifact_write",
  "file_read",
  "excel_make",
  "excel_edit",
  "word_make",
  "word_edit",
  "powerpoint_make",
  "powerpoint_edit",
]);
/** For a client of the team: a question back, and nothing the agent keeps. */
const CLIENT = new Set(["ask"]);

/** What of an agent's tools a turn has for who wrote to it. All of them outside a group home. */
export function toolsFor(writer: HomePerson | undefined, tools: Tool[]): Tool[] {
  if (runsHome(writer)) return tools;
  const allowed = writer?.role === "member" ? MEMBER : CLIENT;
  return tools.filter((tool) => allowed.has(tool.name));
}
