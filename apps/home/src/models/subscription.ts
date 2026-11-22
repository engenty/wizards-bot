// How an installed, signed-in client (Claude Code, Codex) answers one turn. Ported from
// engenty wizards (apps/runtime/src/agents/chat-clients.ts): the client runs its own steps,
// reaches only the home's tools over MCP (named `home`) and keeps the conversation itself.

export type SubscriptionClient = "claude" | "codex";

export interface ClientCall {
  system: string;
  message: string;
  /** The conversation to continue, as the client named it last time. */
  session: string | null;
  /** The home's MCP endpoint for this turn. */
  mcpUrl: string;
  /** Claude: the MCP config file. */
  mcpConfigFile: string;
  /** Pictures for this turn: base64 for Claude, files for Codex. */
  images: { mime: string; base64: string; file: string }[];
  model?: string;
}

export type ClientEvent =
  | { kind: "text"; text: string }
  | { kind: "delta"; text: string }
  | { kind: "tool"; name: string; started: boolean }
  | { kind: "session"; id: string }
  | { kind: "failure"; detail: string }
  /** The client's own summary of the answer, used where no text came before it. */
  | { kind: "result"; text: string };

export interface Client {
  id: SubscriptionClient;
  name: string;
  bin: string;
  /** Models the person can name; the first is what the home uses. */
  models: { id: string; label: string }[];
  args(call: ClientCall): string[];
  stdin(call: ClientCall): string;
  /** A parser for one turn's output lines. */
  parser(): (line: string) => ClientEvent[];
  /** Whether a failure the client reports means its sign-in is missing or expired. */
  signedOut(detail: string): boolean;
}

/** The environment variable Codex reads the turn's bearer token from. */
export const CODEX_KEY_VAR = "WIZARDS_BOT_MCP_KEY";

// biome-ignore lint/suspicious/noExplicitAny: the clients' output lines are untyped JSON
function parse(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

const claude: Client = {
  id: "claude",
  name: "Claude",
  bin: process.env.CLAUDE_BIN?.trim() || "claude",
  models: [
    { id: "default", label: "Claude (your subscription's default)" },
    { id: "opus", label: "Claude Opus" },
    { id: "sonnet", label: "Claude Sonnet" },
    { id: "haiku", label: "Claude Haiku" },
  ],
  args: (call) => [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    // No built-in tools: `--allowedTools` alone would not take them away.
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    call.mcpConfigFile,
    "--allowedTools",
    "mcp__home",
    "--disable-slash-commands",
    "--setting-sources",
    "",
    "--system-prompt",
    call.system,
    ...(call.model && call.model !== "default" ? ["--model", call.model] : []),
    ...(call.session ? ["--resume", call.session] : []),
  ],
  stdin: (call) =>
    `${JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: call.message },
          ...call.images.map((image) => ({
            type: "image",
            source: { type: "base64", media_type: image.mime, data: image.base64 },
          })),
        ],
      },
    })}\n`,
  parser() {
    // Text streams as deltas; the whole message that follows repeats it.
    let streamed = false;
    return (line) => {
      const event = parse(line);
      if (!event) return [];
      if (event.type === "stream_event") {
        const e = event.event ?? {};
        if (e.type === "content_block_start" && e.content_block?.type === "tool_use") {
          return [{ kind: "tool", name: String(e.content_block.name ?? ""), started: false }];
        }
        if (e.type === "content_block_delta" && e.delta?.type === "text_delta" && e.delta.text) {
          streamed = true;
          return [{ kind: "delta", text: String(e.delta.text) }];
        }
        return [];
      }
      if (event.type === "assistant") {
        // A failed API call comes as a message Claude Code makes itself ("API Error: …"):
        // it is a failure, so the home asks the next model instead of showing it as the answer.
        if (event.message?.model === "<synthetic>") {
          const said = (event.message.content ?? [])
            .map((block: { text?: string }) => block.text ?? "")
            .join(" ")
            .trim();
          streamed = false;
          return [{ kind: "failure", detail: said || "error" }];
        }
        const out: ClientEvent[] = [];
        for (const block of event.message?.content ?? []) {
          if (block.type === "text" && block.text && !streamed) {
            out.push({ kind: "text", text: block.text });
          } else if (block.type === "tool_use") {
            out.push({ kind: "tool", name: String(block.name ?? ""), started: true });
          }
        }
        streamed = false;
        return out;
      }
      if (event.type === "result") {
        const out: ClientEvent[] = [];
        if (event.session_id) out.push({ kind: "session", id: String(event.session_id) });
        if (event.is_error) out.push({ kind: "failure", detail: String(event.result ?? "error") });
        else if (typeof event.result === "string") out.push({ kind: "result", text: event.result });
        return out;
      }
      return [];
    };
  },
  signedOut: (detail) => /authenticat|log ?in|oauth|credential/i.test(detail),
};

/** The Codex features that bring tools of their own; the turn works through MCP only. */
const CODEX_TOOLS_OFF = [
  "shell_tool",
  "unified_exec",
  "apps",
  "plugins",
  "browser_use",
  "in_app_browser",
  "computer_use",
  "image_generation",
  "multi_agent",
  "goals",
  "sleep_tool",
  "tool_suggest",
  "skill_search",
  "memories",
];

const codex: Client = {
  id: "codex",
  name: "Codex",
  bin: process.env.CODEX_BIN?.trim() || "codex",
  models: [{ id: "default", label: "Codex (your subscription's default)" }],
  args(call) {
    const options = [
      "--json",
      "--skip-git-repo-check",
      ...(call.model && call.model !== "default" ? ["-m", call.model] : []),
      // Only the home's tools: none of the person's own MCP servers start.
      "--ignore-user-config",
      "-c",
      'sandbox_mode="read-only"',
      "-c",
      'approval_policy="never"',
      "-c",
      'web_search="disabled"',
      // `-c features.…` rather than `--disable`: a feature a later Codex drops is only ignored.
      ...CODEX_TOOLS_OFF.flatMap((feature) => ["-c", `features.${feature}=false`]),
      // A JSON string is a TOML basic string: the instructions travel as one config value.
      "-c",
      `developer_instructions=${JSON.stringify(call.system)}`,
      "-c",
      `mcp_servers.home.url=${JSON.stringify(call.mcpUrl)}`,
      // The key comes from the environment, not the command line, where any process could read it.
      "-c",
      `mcp_servers.home.bearer_token_env_var="${CODEX_KEY_VAR}"`,
      "-c",
      "mcp_servers.home.startup_timeout_sec=30",
      "-c",
      "mcp_servers.home.tool_timeout_sec=600",
      "-c",
      'mcp_servers.home.default_tools_approval_mode="approve"',
    ];
    // `-i` takes several files, so the pictures come last, after the prompt ("-" = stdin).
    const images = call.images.flatMap((image) => ["-i", image.file]);
    return call.session
      ? ["exec", "resume", call.session, "-", ...options, ...images]
      : ["exec", "-", ...options, ...images];
  },
  stdin: (call) => call.message,
  parser() {
    return (line) => {
      const event = parse(line);
      if (!event) return [];
      const item = event.item ?? {};
      if (event.type === "thread.started" && event.thread_id) {
        return [{ kind: "session", id: String(event.thread_id) }];
      }
      if (item.type === "mcp_tool_call" && event.type === "item.started") {
        return [{ kind: "tool", name: String(item.tool ?? ""), started: true }];
      }
      if (event.type === "item.completed" && item.type === "agent_message" && item.text?.trim()) {
        return [{ kind: "text", text: String(item.text).trim() }];
      }
      if (event.type === "turn.failed") {
        const error = event.error;
        return [
          {
            kind: "failure",
            detail: typeof error === "string" ? error : String(error?.message ?? "error"),
          },
        ];
      }
      // A top-level `error` is often a retry ("Reconnecting... 1/5"); turn.failed ends the turn.
      return [];
    };
  },
  signedOut: (detail) =>
    /\b401\b|unauthori[sz]ed|not logged in|codex login|authenticat|log ?in/i.test(detail),
};

export const CLIENTS: Record<SubscriptionClient, Client> = { claude, codex };
