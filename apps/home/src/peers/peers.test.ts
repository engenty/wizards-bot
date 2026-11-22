import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { type TestHome, testHome } from "../test/fakes.ts";
import { signRequest } from "./signature.ts";

/** Makes two homes contacts of each other, as after a request one of them approved. */
function connect(a: TestHome, b: TestHome): void {
  for (const [here, there] of [
    [a, b],
    [b, a],
  ] as const) {
    here.home.db.run(
      "insert into contact (handle, name, url, public_key, state, created_at) values (?, ?, ?, ?, 'connected', ?)",
      there.home.handle() as string,
      there.home.person(),
      there.url,
      there.home.identity.publicKey,
      new Date().toISOString(),
    );
  }
}

/** Waits until something is so, for what one home tells another without anyone waiting for it. */
async function until(check: () => boolean): Promise<void> {
  for (let tries = 0; tries < 100 && !check(); tries++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(check());
}

/** An agent of one home, shared with the other to talk to, as after both said yes. */
function share(owner: TestHome, guest: TestHome, name: string): { own: string; theirs: string } {
  const agent = owner.home.store.createAgent({ name, kind: "drop", about: "Knows things." });
  owner.home.db.run(
    "insert into share (id, agent_id, handle, mode, created_at) values (?, ?, ?, 'talk', ?)",
    `shr_${agent.id}`,
    agent.id,
    guest.home.handle() as string,
    new Date().toISOString(),
  );
  const shared = guest.home.store.createAgent({
    name,
    kind: "drop",
    about: "Knows things.",
    origin: "shared",
    from: owner.home.handle(),
    remote: `/a2a/agents/${agent.id}`,
  });
  return { own: agent.id, theirs: shared.id };
}

const shares = (t: TestHome, agentId: string): number =>
  t.home.db.all("select 1 from share where agent_id = ?", agentId).length;

describe("homes that are contacts", () => {
  let ada: TestHome;
  let ben: TestHome;
  before(async () => {
    ada = await testHome("Ada");
    ben = await testHome("Ben");
    connect(ada, ben);
  });
  after(() => {
    ada.stop();
    ben.stop();
  });

  test("a signed request is heard once: the same one sent again is refused", async () => {
    const path = "/peers/unshare";
    const body = JSON.stringify({ agent: "agt_none" });
    const headers = {
      "content-type": "application/json",
      ...signRequest({
        identity: ben.home.identity,
        from: ben.home.handle() as string,
        to: ada.home.handle() as string,
        method: "POST",
        path,
        body,
      }),
    };
    const send = () => fetch(`${ada.url}${path}`, { method: "POST", headers, body });
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 401);
  });

  test("the owner takes one agent back: it goes from the other's list and answers them no more", async () => {
    const guide = share(ada, ben, "Guide");
    const other = share(ada, ben, "Cook");
    ada.model.script.push(
      {
        calls: [
          {
            name: "agent_unshare",
            arguments: { agentId: guide.own, handle: ben.home.handle() },
          },
        ],
      },
      { text: "Taken back." },
    );
    await ada.say("Take the guide back from Ben");
    await ben.home.idle();
    assert.equal(shares(ada, guide.own), 0);
    assert.equal(ben.home.store.agent(guide.theirs), undefined);
    // The other share stays.
    assert.equal(shares(ada, other.own), 1);
    assert.ok(ben.home.store.agent(other.theirs));
    const told = ada.model.requests.at(-1)?.messages.at(-1)?.content ?? "";
    assert.match(told, /Guide is taken back from Ben\. It is gone from their list\./);
  });

  test("who removes a shared agent from their list is no longer counted in by its home", async () => {
    const guide = share(ada, ben, "Atlas");
    ben.home.removeAgent(guide.theirs);
    await until(() => shares(ada, guide.own) === 0);
    await ada.home.idle();
    assert.ok(ada.home.store.agent(guide.own));
  });
});

describe("what someone else writes to an agent shared with them", () => {
  let ada: TestHome;
  let ben: TestHome;
  let guide: { own: string; theirs: string };
  let conversationId: string;
  const told: { type: string; conversationId?: string }[] = [];
  before(async () => {
    ada = await testHome("Ada");
    ben = await testHome("Ben");
    connect(ada, ben);
    guide = share(ada, ben, "Guide");
    ada.home.events.subscribe(({ event }) => {
      if (event.type === "message.created" || event.type === "message.updated")
        told.push({ type: event.type, conversationId: event.message.conversationId });
      if (event.type === "message.delta")
        told.push({ type: event.type, conversationId: event.conversationId });
    });
    ada.model.script.push({ text: "Start at the Rynek." });
    const theirs = ben.home.store.agent(guide.theirs);
    await ben.request(`/v1/conversations/${theirs?.conversationId}/messages`, {
      body: { text: "Where do I start? It is for a surprise." },
    });
    await ben.home.idle();
    await ada.home.idle();
    conversationId = ada.home.store.guestConversation(guide.own, ben.home.handle() as string);
  });
  after(() => {
    ada.stop();
    ben.stop();
  });

  test("is kept in the agent's home and told to none of its person's devices", () => {
    const kept = ada.home.store.messages(conversationId, { limit: 10 }).messages;
    assert.equal(kept.length, 2);
    assert.ok(told.every((event) => event.conversationId !== conversationId));
    // The person's own conversations are told as before.
    ada.home.store.addMessage({
      conversationId: ada.home.store.mainAgent().conversationId,
      role: "note",
      channel: "home",
      parts: [{ type: "text", text: "A line." }],
    });
    assert.equal(told.at(-1)?.type, "message.created");
  });

  test("is not read, written in or stopped by a device, as if it were not there", async () => {
    const at = `/v1/conversations/${conversationId}`;
    assert.equal((await ada.request(`${at}/messages`)).status, 404);
    assert.equal((await ada.request(`${at}/messages`, { body: { text: "Hello" } })).status, 404);
    assert.equal((await ada.request(`${at}/read`, { method: "POST" })).status, 404);
    assert.equal((await ada.request(`${at}/stop`, { method: "POST" })).status, 404);
    assert.equal((await ada.request(`${at}/documents`)).status, 404);
    assert.equal((await ada.request(`${at}/files`)).status, 404);
    // The person's own conversation with the agent is read as before.
    const own = ada.home.store.agent(guide.own)?.conversationId;
    assert.equal((await ada.request(`/v1/conversations/${own}/messages`)).status, 200);
  });

  test("is deleted when the agent is taken back", async () => {
    ada.model.script.push(
      {
        calls: [
          { name: "agent_unshare", arguments: { agentId: guide.own, handle: ben.home.handle() } },
        ],
      },
      { text: "Taken back." },
    );
    await ada.say("Take the guide back from Ben");
    assert.equal(ada.home.store.conversation(conversationId), undefined);
    assert.equal(ada.home.store.messages(conversationId, { limit: 10 }).messages.length, 0);
  });
});

describe("what an agent remembers, and someone it is shared with", () => {
  let ada: TestHome;
  let ben: TestHome;
  let guideId: string;
  let theirs: string;
  /** Ben writes to the agent; returns what Ada's model was asked. */
  const ask = async (text: string, ...script: Parameters<typeof ada.model.script.push>) => {
    ada.model.script.push(...script);
    await ben.request(`/v1/conversations/${theirs}/messages`, { body: { text } });
    await ben.home.idle();
    await ada.home.idle();
    return ada.model.requests.at(-1);
  };
  const suggestions = () =>
    ada.home.store
      .openCards(ada.home.store.agent(guideId)?.conversationId ?? "")
      .filter((card) => card.title.startsWith("Ben asked Guide to keep this"));
  before(async () => {
    ada = await testHome("Ada");
    ben = await testHome("Ben");
    connect(ada, ben);
    const guide = ada.home.store.createAgent({
      name: "Guide",
      kind: "drop",
      about: "Knows Kraków.",
      instructions: "Answer questions about Kraków.",
    });
    guideId = guide.id;
    ada.home.store.updateAgent(guide.id, { memory: "Ada's door code is 4711." });
    ada.model.script.push(
      {
        calls: [
          {
            name: "agent_share",
            arguments: { agentId: guide.id, handle: ben.home.handle(), mode: "talk" },
          },
        ],
      },
      { text: "Asked." },
    );
    await ada.say("Share the guide with Ben");
    assert.match(ada.item().body ?? "", /tells Ben nothing of what it remembers\./);
    await ada.answer(ada.item().id, "share");
    await ben.home.idle();
    await ben.answer(ben.item().id, "add");
    theirs = ben.home.store.agents().find((agent) => agent.origin === "shared")
      ?.conversationId as string;
  });
  after(() => {
    ada.stop();
    ben.stop();
  });

  test("hears nothing of it unless the agent's person said so", async () => {
    const asked = await ask("What do you know?", { text: "Only Kraków." });
    const system = asked?.messages[0]?.content ?? "";
    assert.match(system, /Answer questions about Kraków\./);
    assert.ok(!system.includes("4711"));

    ada.model.script.push(
      {
        calls: [
          {
            name: "agent_share",
            arguments: {
              agentId: guideId,
              handle: ben.home.handle(),
              mode: "talk",
              memory: "all",
            },
          },
        ],
      },
      { text: "Asked." },
    );
    await ada.say("Ben may hear what the guide remembers");
    assert.match(ada.item().body ?? "", /Ben can hear all of that\./);
    await ada.answer(ada.item().id, "share");
    await ben.home.idle();
    const again = await ask("And now?", { text: "The door code." });
    assert.ok((again?.messages[0]?.content ?? "").includes("Ada's door code is 4711."));
  });

  test("teaches it only what its person keeps: one sentence on a card", async () => {
    const asked = await ask(
      "Remember that I travel by night train.",
      { calls: [{ name: "remember_suggest", arguments: { note: "Ben travels by night train." } }] },
      { text: "I asked Ada whether I may keep that." },
    );
    const told = [...(asked?.messages ?? [])].reverse().find((message) => message.role === "tool");
    assert.match(told?.content ?? "", /Ada reads this one sentence and decides/);
    const card = suggestions()[0];
    assert.ok(card?.body?.includes("Ben travels by night train."));
    assert.match(card?.body ?? "", /Nothing else of what Ben wrote is shown to you\./);
    // Asked is not kept.
    assert.equal(ada.home.store.agent(guideId)?.memory, "Ada's door code is 4711.");

    await ada.answer(card?.id as string, "keep");
    assert.equal(
      ada.home.store.agent(guideId)?.memory,
      "Ada's door code is 4711.\nBen travels by night train.",
    );

    await ask(
      "And that I am allergic to cats.",
      { calls: [{ name: "remember_suggest", arguments: { note: "Ben is allergic to cats." } }] },
      { text: "Asked." },
    );
    await ada.answer(suggestions()[0]?.id as string, "drop");
    assert.ok(!ada.home.store.agent(guideId)?.memory.includes("cats"));
  });

  test("is not asked more than its person can look at", async () => {
    for (let i = 0; i < 7; i++) {
      await ask(
        `Remember ${i}.`,
        { calls: [{ name: "remember_suggest", arguments: { note: `Note ${i}.` } }] },
        { text: "Asked." },
      );
    }
    assert.equal(suggestions().length, 5);
  });
});
