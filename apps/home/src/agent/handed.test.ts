import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { AgentRecord } from "../store/store.ts";
import { type TestHome, testHome } from "../test/fakes.ts";

describe("a task one agent handed to another", () => {
  let dataDir: string;
  let t: TestHome;
  let law: AgentRecord;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "wizards-bot-handed-"));
    t = await testHome("Ada", undefined, { dataDir });
    law = t.home.store.createAgent({ name: "Building law", kind: "drop", about: "Knows the law." });
  });
  afterEach(() => t.stop());

  const goose = () => t.home.store.mainAgent();
  const waitsFor = async () => {
    const response = await t.request("/v1/agents");
    const { agents } = (await response.json()) as {
      agents: { main: boolean; waitsFor?: unknown }[];
    };
    return agents.find((agent) => agent.main)?.waitsFor;
  };
  const said = () => t.model.requests.map((request) => request.messages.at(-1)?.content ?? "");
  const reports = () => said().filter((text) => text.includes("Building law answered"));
  const until = async (ready: () => unknown) => {
    for (let tries = 0; tries < 200 && !ready(); tries++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(ready());
  };
  const handOver = () =>
    t.model.script.push(
      { calls: [{ name: "agent_message", arguments: { id: law.id, text: "May I build?" } }] },
      { text: "I handed it over." },
    );
  const ask = { calls: [{ name: "ask", arguments: { title: "Which zone?", hint: "Zone" } }] };

  /** Goose handed the task over and is done; the other agent asks the person. */
  const handOverAndAsk = async () => {
    let go: () => void = () => {};
    const hold = new Promise<void>((resolve) => {
      go = resolve;
    });
    handOver();
    t.model.script.push({ ...ask, text: "I need one thing. ", hold });
    await t.request(`/v1/conversations/${goose().conversationId}/messages`, {
      body: { text: "Ask the law" },
    });
    await until(() => t.model.requests.length === 3 && goose().state === "idle");
    assert.deepEqual(await waitsFor(), [{ agentId: law.id }]);
    go();
    await t.home.idle();
  };

  it("is not answered while that agent waits for the person", async () => {
    await handOverAndAsk();
    const card = t.item();
    assert.equal(t.home.store.agent(law.id)?.state, "needs_you");
    assert.equal(goose().state, "idle");
    assert.deepEqual(reports(), []);
    assert.deepEqual(await waitsFor(), [{ agentId: law.id, cardId: card.id }]);

    t.model.script.push({ text: "In zone W you may." }, { text: "The law says you may." });
    await t.answer(card.id, "reply", { answer: "W" });
    assert.deepEqual(reports(), ["[home] Building law answered: In zone W you may."]);
    assert.equal(await waitsFor(), undefined);
    assert.deepEqual(t.last().parts, [{ type: "text", text: "The law says you may." }]);
  });

  it("waits on when the agent asks once more", async () => {
    await handOverAndAsk();
    t.model.script.push(ask);
    await t.answer(t.item().id, "reply", { answer: "W" });
    assert.deepEqual(reports(), []);
    assert.deepEqual(await waitsFor(), [{ agentId: law.id, cardId: t.item().id }]);

    t.model.script.push({ text: "You may." }, { text: "Good news." });
    await t.answer(t.item().id, "reply", { answer: "W" });
    assert.deepEqual(reports(), ["[home] Building law answered: You may."]);
  });

  it("waits for the answer, not for what the person writes about something else", async () => {
    await handOverAndAsk();
    t.model.script.push({ text: "Because it depends on it." });
    await t.request(`/v1/conversations/${law.conversationId}/messages`, {
      body: { text: "Why?", answers: null },
    });
    await t.home.idle();
    assert.deepEqual(reports(), []);

    t.model.script.push({ text: "You may." }, { text: "Good news." });
    await t.answer(t.item().id, "reply", { answer: "W" });
    assert.deepEqual(reports(), ["[home] Building law answered: You may."]);
  });

  it("is answered with what the person writes in that agent's chat", async () => {
    await handOverAndAsk();
    t.model.script.push({ text: "In zone W you may." }, { text: "The law says you may." });
    await t.request(`/v1/conversations/${law.conversationId}/messages`, { body: { text: "W" } });
    await t.home.idle();
    await until(() => reports().length);
    assert.deepEqual(reports(), ["[home] Building law answered: In zone W you may."]);
    assert.equal(t.home.store.items().length, 0);
  });

  it("waits for the card over a start of the home", async () => {
    await handOverAndAsk();
    const card = t.item();
    t.stop();
    t = await testHome("Ada", undefined, { dataDir });
    assert.deepEqual(await waitsFor(), [{ agentId: law.id, cardId: card.id }]);
    t.model.script.push({ text: "You may." }, { text: "Good news." });
    await t.answer(card.id, "reply", { answer: "W" });
    assert.deepEqual(reports(), ["[home] Building law answered: You may."]);
    assert.equal(await waitsFor(), undefined);
  });

  it("ends with the answer to a card no turn follows", async () => {
    const { handed, store } = t.home;
    const id = handed.over(goose(), goose().conversationId, law);
    const card = store.createCard(
      {
        kind: "approval",
        level: "needs_you",
        title: "Keep the draft?",
        actions: [{ id: "keep", label: "Keep it", style: "primary" }],
        payload: { type: "nothing" },
      },
      { agentId: law.id, conversationId: law.conversationId, messageId: "" },
    );
    handed.waits(id, [card.id]);
    t.model.script.push({ text: "It is kept." });
    await t.answer(card.id, "keep");
    assert.deepEqual(reports(), [
      '[home] Building law answered: The person answered "Keep the draft?" with "Keep it".',
    ]);
    assert.equal(await waitsFor(), undefined);
  });

  it("ends when the agent is removed", async () => {
    await handOverAndAsk();
    t.home.removeAgent(law.id);
    assert.equal(await waitsFor(), undefined);
  });
});
