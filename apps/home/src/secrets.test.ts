import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { SecretEntry } from "@wizards-bot/protocol";
import { type TestHome, testHome } from "./test/fakes.ts";

describe("the secrets in the settings", () => {
  let t: TestHome;

  before(async () => {
    t = await testHome("Ada");
    const { home } = t;
    home.models.setGateway(
      { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.test/v1", models: [] },
      "sk-or-gateway-value",
    );
    home.db.run(
      "insert into connection (id, name, url, state, created_at) values ('con_1', 'linear', 'https://mcp.linear.test', 'connected', '2026-11-22T00:00:00.000Z')",
    );
    home.secrets.set("connection.con_1.key", "lin-api-key-value");
    home.secrets.set("connection.con_gone.key", "gone-key-value");
    home.secrets.set("channel.slack", JSON.stringify({ token: "xoxb-channel-value" }));
    home.secrets.set("apns.key", "apns-private-value");
    home.secrets.set("artifacts.page", "page-key-value");
  });
  after(() => t.stop());

  test("list what uses each secret and when it was set, never a value", async () => {
    const response = await t.request("/v1/secrets");
    assert.equal(response.status, 200);
    const text = await response.text();
    for (const value of ["sk-or-gateway-value", "lin-api-key-value", "xoxb-channel-value"]) {
      assert.ok(!text.includes(value), `the answer holds ${value}`);
    }
    const { secrets } = JSON.parse(text) as { secrets: SecretEntry[] };
    assert.deepEqual(
      secrets.map(({ name, kind, label }) => ({ name, kind, label })),
      [
        { name: "channel.slack", kind: "channel", label: "Slack" },
        { name: "connection.con_1.key", kind: "connection", label: "linear" },
        { name: "gateway.openrouter", kind: "gateway", label: "OpenRouter" },
      ],
    );
    assert.ok(secrets.every((s) => !Number.isNaN(Date.parse(s.setAt))));
  });

  test("are for paired devices only", async () => {
    assert.equal((await t.request("/v1/secrets", { token: "not-a-device" })).status, 401);
  });
});
