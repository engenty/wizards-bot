import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Artifact } from "@wizards-bot/protocol";
import { pageHeaderPolicy } from "../artifacts/page.ts";
import { FakeMcp } from "../test/fake-mcp.ts";
import { type TestHome, testHome } from "../test/fakes.ts";
import { hostPolicy, viewPolicy } from "./apps.ts";

/** A JSON answer of the host's routes, as the test reads it. */
type Json = {
  input?: unknown;
  isError?: boolean;
  structuredContent?: unknown;
  content: { text: string }[];
  result: { _meta: Record<string, unknown> };
};

const VIEW = "ui://studio/flow-1.html";

describe("a connection's MCP Apps view", () => {
  let t: TestHome;
  let studio: FakeMcp;
  let artifact: Artifact;
  const app = (path: string, init?: RequestInit) =>
    fetch(new URL(artifact.page.replace("/host?", `/${path}?`), t.url), init);

  before(async () => {
    t = await testHome("Ada");
    studio = new FakeMcp("modern", {
      run: {
        title: "Run wizard",
        meta: { ui: { resourceUri: VIEW } },
        run: () => ({
          text: "The run waits for a page.",
          structured: { runId: "r1" },
          meta: { "engenty/flow": { run: { runId: "r1" } } },
        }),
      },
      get: { readOnly: true, run: () => ({ text: "still waiting", structured: { runId: "r1" } }) },
      wipe: { run: () => ({ text: "gone" }) },
    });
    studio.views[VIEW] = {
      html: "<!doctype html><p>flow</p>",
      csp: {
        connectDomains: ["https://studio.example"],
        resourceDomains: ["https://fonts.example"],
      },
    };
    await studio.start();
    await t.home.connections.add({ name: "studio", url: studio.url });
    // A tool that changes something for good, as its server says.
    const connection = t.home.connections.byName("studio");
    for (const tool of connection?.tools ?? [])
      if (tool.name === "wipe") Object.assign(tool, { destructive: true });
    t.home.db.run(
      "update connection set tools = ? where id = ?",
      JSON.stringify(connection?.tools),
      connection?.id ?? "",
    );
    assert.ok(connection);
    t.home.connections.setPolicy(connection, "run", "always");
  });
  after(() => {
    studio.stop();
    t.stop();
  });

  test("a result with a view stands in the chat as an app artifact", async () => {
    t.model.script.push({
      calls: [
        {
          name: "connection_call",
          arguments: { name: "studio", tool: "run", arguments: { wizardId: "w1" }, why: "Run" },
        },
      ],
    });
    t.model.script.push({ text: "There it is." });
    const message = await t.say("run the wizard");
    const all = t.home.store.messages(message.conversationId, { limit: 5 }).messages;
    const part = all.flatMap((m) => m.parts).find((p) => p.type === "artifact");
    assert.ok(part && part.type === "artifact");
    const response = await t.request(`/v1/artifacts/${part.artifactId}`);
    artifact = (await response.json()) as Artifact;
    assert.equal(artifact.format, "app");
    assert.equal(artifact.title, "Run wizard");
    assert.equal(artifact.summary, "The run waits for a page.");
    assert.match(artifact.page, /^\/v1\/artifacts\/art_[^/]+\/host\?until=\d+&key=/);
    assert.match(JSON.stringify(t.model.requests.at(-1)), /shows this in a view of its own/);
  });

  test("the view comes from its server, under the policy it named", async () => {
    const response = await app("page");
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "<!doctype html><p>flow</p>");
    const policy = response.headers.get("content-security-policy") ?? "";
    assert.match(policy, /^sandbox allow-scripts allow-forms;/);
    assert.match(policy, /connect-src https:\/\/studio\.example/);
    assert.match(policy, /font-src data: https:\/\/fonts\.example/);
    assert.doesNotMatch(policy, /allow-same-origin/);
  });

  test("the host gets the call, and the view's tools of the same connection", async () => {
    const call = (await (await app("app/call")).json()) as Json;
    assert.deepEqual(call.input, { wizardId: "w1" });
    assert.deepEqual(call.result._meta["engenty/flow"], { run: { runId: "r1" } });
    const used = await app("app/tool", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "get", arguments: { runId: "r1" } }),
    });
    assert.equal(used.headers.get("access-control-allow-origin"), "null");
    const answer = (await used.json()) as Json;
    assert.equal(answer.content[0]?.text, "still waiting");
    assert.deepEqual(answer.structuredContent, { runId: "r1" });
  });

  test("a tool that changes something for good asks the person in the chat", async () => {
    const before = studio.calls.length;
    const used = (await (
      await app("app/tool", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "wipe", arguments: {} }),
      })
    ).json()) as Json;
    assert.equal(used.isError, true);
    assert.equal(studio.calls.length, before);
    assert.match(t.item().title, /wants to use wipe/);
  });

  test("what the view tells the agent is kept with the artifact", async () => {
    await app("app/context", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "The person answered the first page." }),
    });
    const kept = t.home.artifacts.get(artifact.id);
    assert.match(kept?.content ?? "", /The person answered the first page\./);
  });

  test("without the key nothing opens", async () => {
    for (const path of ["page", "app/call"]) {
      const response = await fetch(
        new URL(`/v1/artifacts/${artifact.id}/${path}?until=9999999999&key=x`, t.url),
      );
      assert.equal(response.status, 403);
    }
  });

  test("a view's policy names only https origins its server gave", () => {
    const policy = viewPolicy({ connectDomains: ["javascript:alert(1)", "https://ok.example"] });
    assert.match(policy, /connect-src https:\/\/ok\.example;/);
    assert.doesNotMatch(policy, /javascript/);
  });

  test("the host page and an agent's page show inside the studio's frame, and nowhere else", () => {
    const frames = (policy: string) => /frame-ancestors ([^;]+)/.exec(policy)?.[1];
    const studio = "https://studio.example";
    assert.equal(frames(hostPolicy("https://home.example", studio)), `'self' ${studio}`);
    assert.equal(frames(pageHeaderPolicy(studio)), `'self' ${studio}`);
    // A home no studio shows keeps both to its own page.
    assert.equal(frames(hostPolicy("https://home.example")), "'self'");
    assert.equal(frames(pageHeaderPolicy()), "'self'");
  });
});
