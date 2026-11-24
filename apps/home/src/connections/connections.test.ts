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
