import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { FakeMcp } from "../test/fake-mcp.ts";
import { type TestHome, testHome } from "../test/fakes.ts";

const LONG = `Runs one of the space's wizards. ${"Then follow what it waits for. ".repeat(40)}The end.`;

/** What the last tool answered, as the model read it. */
const result = (t: TestHome): string =>
  JSON.stringify(t.model.requests.at(-1)?.messages.at(-1)?.content ?? "");

describe("a connection's tools as the agent reads them", () => {
  let t: TestHome;
  let studio: FakeMcp;
  before(async () => {
    t = await testHome("Ada");
    studio = new FakeMcp("modern", {
      search: {
        title: "Search",
        description: "Searches the space. Gives items with their path.",
        readOnly: true,
        run: () => ({ text: "found" }),
      },
      run: { description: LONG, run: () => ({ text: "ran" }) },
      poll: {
        description: "Only the view polls this.",
        readOnly: true,
        meta: { ui: { visibility: ["app"] } },
        run: () => ({ text: "polled" }),
      },
    });
    await studio.start();
    await t.home.connections.add({ name: "studio", url: studio.url });
  });
  after(() => {
    studio.stop();
    t.stop();
  });

  test("the list has one line per tool, without the ones only a view calls", async () => {
    t.model.script.push({ calls: [{ name: "connection_tools", arguments: { name: "studio" } }] });
    t.model.script.push({ text: "ok" });
    await t.say("what can the studio do");
    const listed = result(t);
    assert.match(listed, /- search \(reads\): Searches the space\./);
    assert.match(listed, /- run \(changes something: the person is asked first\): Runs one/);
    assert.doesNotMatch(listed, /poll/);
    assert.doesNotMatch(listed, /The end\./);
    assert.doesNotMatch(listed, /input:/);
  });

  test("one tool comes in full, with its input", async () => {
    t.model.script.push({
      calls: [{ name: "connection_tools", arguments: { name: "studio", tool: "run" } }],
    });
    t.model.script.push({ text: "ok" });
    await t.say("tell me about run");
    const full = result(t);
    assert.match(full, /The end\./);
    assert.match(full, /input: /);
  });

  test("the agent cannot call a tool only a view calls", async () => {
    t.model.script.push({
      calls: [
        {
          name: "connection_call",
          arguments: { name: "studio", tool: "poll", arguments: {}, why: "Poll" },
        },
      ],
    });
    t.model.script.push({ text: "ok" });
    await t.say("poll it");
    assert.match(result(t), /has no tool poll/);
    assert.equal(studio.calls.length, 0);
  });
});

describe("what a tool's result carries besides its text", () => {
  let t: TestHome;
  let studio: FakeMcp;
  before(async () => {
    t = await testHome("Ada");
    studio = new FakeMcp("modern", {
      run: {
        readOnly: true,
        meta: { ui: { resourceUri: "ui://studio/flow-1.html" } },
        run: () => ({
          text: "The run waits for a page.",
          structured: { runId: "r1", status: "waiting_input" },
          meta: { "engenty/flow": { run: { runId: "r1" } } },
          resources: [{ uri: "ui://studio/note.json", mimeType: "application/json", text: "{}" }],
        }),
      },
    });
    await studio.start();
    await t.home.connections.add({ name: "studio", url: studio.url });
  });
  after(() => {
    studio.stop();
    t.stop();
  });

  test("the tool's view is kept with the tool", () => {
    const tool = t.home.connections.byName("studio")?.tools.find((one) => one.name === "run");
    assert.equal(tool?.view, "ui://studio/flow-1.html");
  });

  test("structured content, _meta and resources come with the step, the text to the agent", async () => {
    const connection = t.home.connections.byName("studio");
    assert.ok(connection);
    const step = await t.home.connections.use(connection, "run", {});
    assert.ok("result" in step);
    assert.match(String(step.result), /^The run waits for a page\.\n\[application\/json\]$/);
    assert.deepEqual(step.carried?.structured, { runId: "r1", status: "waiting_input" });
    assert.deepEqual(step.carried?.meta?.["engenty/flow"], { run: { runId: "r1" } });
    assert.equal(step.carried?.resources?.[0]?.uri, "ui://studio/note.json");
  });
});

describe("a call the server runs as a task", () => {
  let t: TestHome;
  let studio: FakeMcp;
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(ok());
  };
  before(async () => {
    t = await testHome("Ada");
    studio = new FakeMcp("modern", {
      long: { readOnly: true, task: () => ({ status: "working" }), run: () => ({ text: "now" }) },
    });
    await studio.start();
    await t.home.connections.add({ name: "studio", url: studio.url });
  });
  after(() => {
    studio.stop();
    t.stop();
  });

  test("the turn goes on; the task's question is a card; its end is told", async () => {
    t.model.script.push({
      calls: [
        {
          name: "connection_call",
          arguments: { name: "studio", tool: "long", arguments: {}, why: "Run it" },
        },
      ],
    });
    t.model.script.push({ text: "It runs." });
    await t.say("run the long one");
    assert.match(result(t), /runs this as a task \(task-1\)/);

    const task = studio.tasks.get("task-1");
    assert.ok(task);
    task.status = "input_required";
    task.ask = {
      mode: "form",
      message: "Who visits?",
      requestedSchema: { type: "object", properties: { name: { type: "string", title: "Name" } } },
    };
    await until(() =>
      t.home.store.items().some((card) => card.title === "studio asks you something"),
    );
    const card = t.item();
    assert.match(card.body ?? "", /Who visits/);

    await t.answer(card.id, "accept", { f0: "Lena" });
    await until(() => task.answers.length === 1);
    assert.deepEqual(task.answers[0], { page: { action: "accept", content: { name: "Lena" } } });

    t.model.script.push({ text: "Done." });
    task.status = "completed";
    task.text = "The visit is booked.";
    await until(() =>
      JSON.stringify(t.model.requests).includes("studio finished long, which ran as a task"),
    );
    assert.match(JSON.stringify(t.model.requests.at(-1)), /The visit is booked\./);
    // The turn the home's word started ends before the home does.
    await until(() => t.home.store.agents().every((agent) => agent.state !== "working"));
    await t.home.idle();
  });
});
