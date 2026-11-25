import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { type Message, Part } from "@wizards-bot/protocol";
import { z } from "zod";
import { type TestHome, testHome } from "../test/fakes.ts";
import { KNOWN_TOOLS } from "./harness.ts";
import { KNOWN_STEPS, pageUrl, stepOf } from "./steps.ts";
import { defineTool } from "./tool.ts";

const steps = (message: Message) =>
  message.parts.flatMap((part) => (part.type === "activity" ? [part] : []));

const tool = (name: string) =>
  defineTool({ name, description: "", input: z.object({}), run: async () => "" });

describe("the steps of a turn", () => {
  let t: TestHome;
  before(async () => {
    t = await testHome("Ada");
    t.home.folders.connect({
      path: mkdtempSync(join(tmpdir(), "wizards-bot-steps-")),
      access: "write",
      own: true,
    });
  });
  after(() => t.stop());

  test("every tool of the home says what its step is", () => {
    // What a plugin or a connection's tool does, its label says.
    const bare = KNOWN_TOOLS.filter((name) => !KNOWN_STEPS.includes(name));
    assert.deepEqual(bare, ["connection_call"]);
  });

  test("a step says what it is about and its times, beside the line of before", async () => {
    const own = t.home.folders.own();
    t.home.folders.setAllow(String(own?.id), "always");
    const write = { path: "law//notes.md", content: "One", why: "Keeps it." };
    t.model.script.push(
      { calls: [{ name: "folder_write", arguments: write }] },
      { calls: [{ name: "document_write", arguments: { title: "Plan", content: "Go." } }] },
      { calls: [{ name: "folder_read", arguments: { folder: "nowhere", path: "a.md" } }] },
      { text: "Done." },
    );
    const answer = await t.say("Write it down.");
    const [file, document, read] = steps(answer);
    assert.equal(file?.label, "Writing law//notes.md");
    assert.equal(file?.kind, "file_write");
    assert.deepEqual(file?.object, { name: "law/notes.md", folderId: own?.id });
    assert.ok(file?.startedAt && file.endedAt && file.startedAt <= file.endedAt);
    const made = answer.parts.find((part) => part.type === "document");
    assert.equal(document?.kind, "document_write");
    assert.deepEqual(document?.object, { name: "Plan", documentId: made?.documentId });
    // A folder that is not connected: the step failed and names the file it was given.
    assert.equal(read?.state, "failed");
    assert.deepEqual(read?.object, { name: "a.md" });
    for (const part of answer.parts) assert.deepEqual(Part.parse(part), part);
  });

  test("a step that asked, or was told no, did not do what it is about", async () => {
    const own = t.home.folders.own();
    t.home.folders.setAllow(String(own?.id), "ask");
    t.model.script.push(
      { calls: [{ name: "folder_write", arguments: { path: "b.md", content: "x", why: "w" } }] },
      { text: "As you like." },
    );
    const answer = await t.say("Write another.");
    assert.deepEqual(
      steps(answer).map(({ kind, object }) => [kind, object?.name]),
      [["ask", "b.md"]],
    );
    await t.answer(t.item().id, "deny");
    const { messages } = t.home.store.messages(t.home.store.mainAgent().conversationId, {
      limit: 5,
    });
    assert.ok(
      messages.flatMap(steps).every((step) => step.object?.name !== "b.md" || step.kind === "ask"),
    );
  });

  test("a tool of a plugin has its label alone", () => {
    assert.deepEqual(stepOf(tool("weather_today"), { city: "Wien" }), {});
  });

  test("names stay a line, several are counted, and a tool that cannot say is let be", () => {
    const command = stepOf(tool("shell_run"), { command: `echo\n${"x".repeat(400)}` });
    assert.equal(command.object?.name?.length, 201);
    assert.ok(command.object?.name?.startsWith("echo x"));
    assert.deepEqual(stepOf(tool("folder_move"), { moves: [{}, {}, {}] }), {
      kind: "file_move",
      object: { count: 3 },
    });
    const broken = {
      ...tool("folder_write"),
      object: () => {
        throw new Error("no such folder");
      },
    };
    assert.deepEqual(stepOf(broken, { path: "a.md" }), {
      kind: "file_write",
      object: { name: "a.md" },
    });
  });

  test("a page's address is the web's, without a sign-in in it", () => {
    assert.equal(pageUrl("https://ada:secret@example.com/a?b=1"), "https://example.com/a?b=1");
    for (const other of ["javascript:alert(1)", "file:///etc/hosts", "about:blank", "x", 1])
      assert.equal(pageUrl(other), undefined);
  });
});
