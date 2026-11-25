import type { StepKind, StepObject, StepTopic } from "@wizards-bot/protocol";
import type { Tool } from "./tool.ts";

/**
 * What a call of a tool is for the chat: its kind and what it is about, from which every device
 * says the step in the person's language (`lib/steps.ts` of the web app). A tool that is not
 * here, of a plugin or a connection, is shown by its label.
 */

/** A step as its part of the message keeps it. */
export interface Step {
  kind?: StepKind;
  object?: StepObject;
}

interface Entry {
  kind: StepKind;
  /** The input that names what it is about; the first that is given. */
  name?: string[];
  /** The input that lists several. */
  list?: string;
  topic?: StepTopic;
}

const of = (kind: StepKind, ...name: string[]): Entry => ({
  kind,
  ...(name.length ? { name } : {}),
});
const list = (kind: StepKind, input: string): Entry => ({ kind, list: input });
const look = (topic: StepTopic): Entry => ({ kind: "look", topic });
const set = (topic: StepTopic): Entry => ({ kind: "set", topic });
/** A tool that shows the person a card and ends the turn. */
const ASKS: Entry = { kind: "ask" };

const STEPS: Record<string, Entry> = {
  ask: of("ask", "title"),
  show_view: of("ask", "title"),
  go_on: of("go_on", "next"),
  remember: of("memory"),
  remember_suggest: ASKS,
  skill_load: of("skill", "name"),
  tool_search: of("tool_search", "query"),
  shell_run: of("command", "command"),

  document_read: of("document_read"),
  document_write: of("document_write", "title"),
  artifact_read: of("artifact_read"),
  artifact_write: of("artifact_write", "title"),
  file_read: of("file_read", "file"),
  word_make: of("file_write", "name"),
  word_edit: of("file_edit", "path", "file"),
  excel_make: of("file_write", "name"),
  excel_edit: of("file_edit", "path", "file"),
  powerpoint_make: of("file_write", "name"),
  powerpoint_edit: of("file_edit", "path", "file"),

  folder_list: of("folder_look", "folder"),
  folder_info: of("look", "path"),
  folder_read: of("file_read", "path"),
  folder_look: list("picture_look", "paths"),
  folder_search: of("search", "query"),
  folder_write: of("file_write", "path"),
  folder_edit: of("file_edit", "path"),
  folder_make: of("folder_make", "path"),
  folder_copy: of("file_copy", "from"),
  folder_move: list("file_move", "moves"),
  folder_delete: list("file_delete", "paths"),
  folder_connect: ASKS,
  folder_disconnect: set("folders"),

  browser_open: of("page_read"),
  browser_snapshot: of("page_read"),
  browser_scroll: of("page_read"),
  browser_back: of("page_read"),
  browser_wait: of("page_read"),
  browser_tabs: of("page_read"),
  browser_close: of("page_read"),
  browser_click: of("page_use"),
  browser_type: of("page_use"),
  browser_press: of("page_use"),
  browser_select: of("page_use"),
  vault_logins: look("vault"),
  vault_sign_in: of("sign_in"),
  vault_code: of("sign_in"),

  agent_create: of("agent_make", "name"),
  agent_update: set("agents"),
  agent_remove: ASKS,
  agent_message: of("agent_ask"),
  agent_share: ASKS,
  agent_unshare: set("agents"),
  device_ask: of("device_ask", "device"),

  schedule_set: of("task_set", "title"),
  when_set: of("task_set", "title"),
  task_list: look("tasks"),
  task_remove: set("tasks"),
  task_resume: set("tasks"),

  link_open: of("draft", "title"),
  call_start: of("draft", "to"),
  message_draft: of("draft", "to"),
  contact_send: ASKS,
  contact_connect: set("contacts"),
  contact_list: look("contacts"),
  contact_remove: set("contacts"),
  invite_make: ASKS,
  invite_list: look("invites"),
  invite_open: look("invites"),
  invite_take_back: set("invites"),
  room_open: set("rooms"),
  room_list: look("rooms"),
  room_add: ASKS,
  room_invite: ASKS,
  link_publish: ASKS,
  link_list: look("links"),
  link_take_back: set("links"),
  outside_agent_add: look("outside"),
  outside_agent_let_in: ASKS,
  outside_list: look("outside"),
  outside_shut_out: set("outside"),

  models: look("models"),
  models_order: set("models"),
  gateway_add: set("models"),
  home_check: look("models"),
  address_switch: set("address"),
  device_pair: set("devices"),
  channel_connect: set("channels"),
  channel_list: look("channels"),
  channel_remove: set("channels"),
  plugin_list: look("plugins"),
  plugin_switch: set("plugins"),
  connection_tools: { kind: "look", name: ["name"], topic: "connections" },
  connection_find: of("search", "query"),
  connection_add: set("connections"),
  connection_remove: set("connections"),
  person_name: set("name"),
  person_key: look("key"),
  handle_set: set("handle"),
  avatar_set: set("avatar"),
};

/** The tools a step is known of. */
export const KNOWN_STEPS = Object.keys(STEPS);

/** A name stays a line: a command may be a whole script. */
const NAME = 200;

/** A call as a step: what the tool is for, and of what its input, or its answer, says. */
export function stepOf(tool: Tool, input: Record<string, unknown>, answer?: string): Step {
  const entry = STEPS[tool.name];
  const given = entry?.list ? input[entry.list] : undefined;
  const several = Array.isArray(given) ? given.length : 0;
  const first = entry?.name?.map((each) => input[each]).find((each) => typeof each === "string");
  let own: StepObject | undefined;
  try {
    own = tool.object?.(input, answer);
  } catch {}
  const object: StepObject = {
    ...(typeof first === "string" ? { name: first } : {}),
    ...(entry?.topic ? { topic: entry.topic } : {}),
    ...(several > 1 ? { count: several } : {}),
    ...own,
  };
  if (object.name !== undefined) {
    const name = object.name.replace(/\s+/g, " ").trim();
    object.name = name.length > NAME ? `${name.slice(0, NAME)}…` : name;
    if (!name) delete object.name;
  }
  return {
    ...(entry ? { kind: entry.kind } : {}),
    ...(Object.keys(object).length ? { object } : {}),
  };
}

/** A page's address as a step keeps it: the web's only, without a sign-in in it. */
export function pageUrl(address: unknown): string | undefined {
  if (typeof address !== "string") return;
  try {
    const url = new URL(address);
    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    url.username = "";
    url.password = "";
    return url.href.length > 2000 ? undefined : url.href;
  } catch {}
}
