import assert from "node:assert/strict";
import { test } from "node:test";
import { clientEnv } from "./models.ts";

test("an installed client runs on its own sign-in, not on keys this home was started with", () => {
  const env = clientEnv(
    {
      PATH: "/usr/bin",
      HOME: "/Users/ada",
      ANTHROPIC_API_KEY: "sk-ant-x",
      ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
      OPENAI_API_KEY: "sk-x",
      CLAUDE_CODE_SESSION_ID: "s",
      CLAUDE_CODE_ENTRYPOINT: "desktop",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    },
    { WIZARDS_BOT_MCP_KEY: "t" },
  );
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    HOME: "/Users/ada",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    WIZARDS_BOT_MCP_KEY: "t",
  });
});
