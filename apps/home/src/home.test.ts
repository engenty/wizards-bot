import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Agent, AgentDetail, Event } from "@wizards-bot/protocol";
import { z } from "zod";
import { defineTool } from "./agent/tool.ts";
import { createServer } from "./server.ts";
import { type TestHome, testHome, textOf } from "./test/fakes.ts";

describe("a home", () => {
  let t: TestHome;
  before(async () => {
    t = await testHome("Ada");
  });
  after(() => t.stop());

  test("says who it is without a token and refuses the rest", async () => {
    const info = (await (await fetch(`${t.url}/v1/home`)).json()) as {
      name: string;
      handle: string;
      hosted: boolean;
    };
    assert.equal(info.name, "Ada");
    // On a person's own computer: no operator's imprint or terms on its pages.
    assert.equal(info.hosted, false);
    assert.match(info.handle, /^ada@127\.0\.0\.1:\d+$/);
    assert.equal((await fetch(`${t.url}/v1/agents`)).status, 401);
  });

  test("pairs a device with a code that works once", async () => {
    const code = t.home.store.newPairingCode();
    const pair = () =>
      fetch(`${t.url}/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, name: "Phone", kind: "phone" }),
      });
    const first = await pair();
    assert.equal(first.status, 200);
    const { token } = (await first.json()) as { token: string };
    assert.equal((await t.request("/v1/agents", { token })).status, 200);
    assert.equal((await pair()).status, 401);
  });

  test("answers a message and streams it as events", async () => {
    const events: Event[] = [];
    const stop = t.home.events.subscribe((stored) => events.push(stored.event));
    t.model.script.push({ text: "Good morning, Ada." });
    const reply = await t.say("Hello");
    stop();
    assert.equal(reply.role, "agent");
    assert.equal(reply.state, "done");
    assert.equal(reply.model, "ollama:fake:1");
    assert.equal(textOf(reply), "Good morning, Ada.");
    const deltas = events
      .filter((event) => event.type === "message.delta")
      .map((event) => event.text);
    assert.equal(deltas.join(""), "Good morning, Ada.");
    const system = t.model.requests.at(-1)?.messages[0]?.content ?? "";
    assert.match(system, /You are Goose, Ada's own agent/);
  });

  test("an agent carries its newest line and what is unread, and says so when either changes", async () => {
    const events: Event[] = [];
    const stop = t.home.events.subscribe((stored) => events.push(stored.event));
    t.model.script.push({ text: "It is   sunny\nin Graz." });
    await t.say("Weather?");
    const listed = async () => {
      const { agents } = (await (await t.request("/v1/agents")).json()) as { agents: Agent[] };
      return agents[0] as Agent;
    };
    const unreadAgent = await listed();
    assert.equal(unreadAgent.preview, "It is sunny in Graz.");
    assert.equal(unreadAgent.unread, 1);
    assert.ok(Date.parse(unreadAgent.updatedAt) > 0);

    events.length = 0;
    await t.request(`/v1/conversations/${unreadAgent.conversationId}/read`, { method: "POST" });
    stop();
    assert.equal((await listed()).unread, 0);
    const told = events.filter((event) => event.type === "agent.updated");
    assert.equal(told.length, 1);
    assert.equal(told[0]?.agent.unread, 0);
  });

  test("a card waits for the person; the first answer wins and starts the next turn", async () => {
    // The run is suspended at the card: the model is not asked again before the answer.
    t.model.script.push({
      calls: [{ name: "ask", arguments: { title: "Train or car?", choices: ["Train", "Car"] } }],
    });
    const reply = await t.say("Plan my trip");
    const card = reply.parts.find((part) => part.type === "card")?.card;
    assert.equal(card?.kind, "approval");
    assert.equal(card?.state, "open");
    const items = (await (await t.request("/v1/items")).json()) as { items: { id: string }[] };
    assert.deepEqual(
      items.items.map((item) => item.id),
      [card?.id],
    );
    const agents = (await (await t.request("/v1/agents")).json()) as {
      agents: { state: string; open: number }[];
    };
    assert.deepEqual([agents.agents[0]?.state, agents.agents[0]?.open], ["needs_you", 1]);

    t.model.script.push({ text: "Train it is." });
    await t.answer(card?.id as string, "choice_0");
    assert.equal(textOf(t.last()), "Train it is.");
    const told = t.model.requests.at(-1)?.messages.at(-1)?.content ?? "";
    // The answer is the result of the same tool call, not a new message.
    assert.equal(t.model.requests.at(-1)?.messages.at(-1)?.role, "tool");
    assert.match(told, /^The person answered "Train or car\?" with "Train"/);

    const second = await t.request(`/v1/cards/${card?.id}/answer`, {
      body: { action: "choice_1" },
    });
    assert.equal(second.status, 409);
    const body = (await second.json()) as { error: string; card: { answer: { action: string } } };
    assert.equal(body.error, "already_answered");
    assert.equal(body.card.answer.action, "choice_0");
    assert.equal(t.home.store.items().length, 0);
  });

  test("the agent reads the conversation back from its thread, tool calls included", async () => {
    t.model.script.push({ text: "Yes." });
    await t.say("Still there?");
    const sent = t.model.requests.at(-1)?.messages ?? [];
    const roles = sent.map((message) => message.role);
    assert.equal(roles[0], "system");
    assert.ok(roles.includes("tool"));
    const asked = sent.find((message) => message.role === "tool");
    // The thread keeps the question with the person's answer as its result.
    assert.match(asked?.content ?? "", /The person answered "Train or car\?" with "Train"/);
    assert.ok(
      sent.some((message) => message.role === "user" && message.content === "Plan my trip"),
    );
    assert.equal(sent.at(-1)?.content, "Still there?");
  });

  test("a document is written beside the chat and a stale edit is a conflict", async () => {
    t.model.script.push(
      { calls: [{ name: "document_write", arguments: { title: "Packing", content: "- socks" } }] },
      { text: "The list is beside the chat." },
    );
    const reply = await t.say("Write a packing list");
    const part = reply.parts.find((candidate) => candidate.type === "document");
    assert.equal(part?.title, "Packing");
    const id = part?.documentId as string;
    const saved = await t.request(`/v1/documents/${id}`, {
      method: "PUT",
      body: { content: "- socks\n- book", baseVersion: 1 },
    });
    assert.equal(((await saved.json()) as { version: number }).version, 2);
    const stale = await t.request(`/v1/documents/${id}`, {
      method: "PUT",
      body: { content: "x", baseVersion: 1 },
    });
    assert.equal(stale.status, 409);
    assert.equal(
      ((await stale.json()) as { document: { content: string } }).document.content,
      "- socks\n- book",
    );
  });

  test("the agent is told which documents are beside the chat", async () => {
    t.model.script.push({ text: "Yes." });
    await t.say("Is the list there?");
    const system = t.model.requests.at(-1)?.messages[0]?.content ?? "";
    assert.match(system, /Documents beside this chat/);
    assert.match(system, /- "Packing" \(doc_\w+\), version 2, last changed by Ada/);
  });

  test("passages marked in a document are kept, listed, removed and read by the agent", async () => {
    const conversationId = t.home.store.mainAgent().conversationId;
    const id = t.home.store.documents(conversationId).find((d) => d.title === "Packing")
      ?.id as string;
    const add = (body: object) => t.request(`/v1/documents/${id}/marks`, { method: "POST", body });
    const marked = await add({
      quote: "book",
      before: "socks\n",
      after: "",
      comment: "Which one?",
    });
    assert.equal(marked.status, 201);
    const mark = (await marked.json()) as { id: string; comment: string };
    assert.equal(mark.comment, "Which one?");
    await add({ quote: "socks", before: "", after: "\nbook" });
    assert.equal((await add({ quote: "", before: "", after: "" })).status, 400);
    const list = async () =>
      ((await (await t.request(`/v1/documents/${id}/marks`)).json()) as { marks: unknown[] }).marks;
    assert.equal((await list()).length, 2);

    t.model.script.push(
      { calls: [{ name: "document_read", arguments: { id } }] },
      { text: "Read it." },
    );
    await t.say("Read the list");
    const read = t.model.requests.at(-1)?.messages.findLast((m) => m.role === "tool");
    assert.match(read?.content ?? "", /The person marked these passages/);
    assert.match(read?.content ?? "", /- "book": Which one\?/);
    assert.match(read?.content ?? "", /- "socks"$/m);

    const removed = await t.request(`/v1/documents/${id}/marks/${mark.id}`, { method: "DELETE" });
    assert.equal(removed.status, 204);
    assert.equal(
      (await t.request(`/v1/documents/${id}/marks/${mark.id}`, { method: "DELETE" })).status,
      404,
    );
    assert.equal((await list()).length, 1);
    assert.equal((await t.request("/v1/documents/doc_none/marks")).status, 404);
  });

  test("a question about a passage shows the quote and tells the agent which document", async () => {
    const conversationId = t.home.store.mainAgent().conversationId;
    const id = t.home.store.documents(conversationId).find((d) => d.title === "Packing")
      ?.id as string;
    t.model.script.push({ text: "Take the thin one." });
    const sent = await t.request(`/v1/conversations/${conversationId}/messages`, {
      body: { text: "Which book?", about: { documentId: id, quote: "- book\nsocks" } },
    });
    assert.equal(sent.status, 202);
    const { message } = (await sent.json()) as {
      message: { parts: { type: string; text?: string; documentId?: string }[] };
    };
    assert.deepEqual(
      message.parts.map((part) => part.type),
      ["document", "text"],
    );
    assert.equal(message.parts[0]?.documentId, id);
    assert.equal(message.parts[1]?.text, "> - book\n> socks\n\nWhich book?");
    await t.home.idle();
    const asked = t.model.requests.at(-1)?.messages.findLast((m) => m.role === "user");
    assert.equal(
      asked?.content,
      `About this passage of the document "Packing" (${id}):\n> - book\n> socks\n\nWhich book?`,
    );

    const other = t.home.store.createDocument({
      title: "Elsewhere",
      content: "x",
      conversationId: "cnv_other",
    });
    const refused = await t.request(`/v1/conversations/${conversationId}/messages`, {
      body: { text: "And this?", about: { documentId: other.id, quote: "x" } },
    });
    assert.equal(refused.status, 400);
  });

  test("a secret typed into a card reaches the home and no one else", async () => {
    t.model.script.push(
      {
        calls: [
          { name: "gateway_add", arguments: { provider: "openrouter", models: ["some/model"] } },
        ],
      },
      { text: "The card is there." },
    );
    await t.say("Add OpenRouter");
    const card = t.item();
    assert.equal(card.kind, "secret");
    t.model.script.push({ text: "OpenRouter is set up." });
    await t.answer(card.id, "save", { key: "sk-very-secret" });
    assert.equal(t.home.store.card(card.id)?.answer?.values?.key, "•••");
    assert.equal(t.home.secrets.get("gateway.openrouter"), "sk-very-secret");
    const everything = JSON.stringify(t.model.requests);
    assert.ok(!everything.includes("sk-very-secret"));
    assert.ok(t.home.models.candidates().includes("openrouter:some/model"));
    // From now on what the phone writes reaches OpenRouter only after the person said yes.
    const main = t.home.store.mainAgent().conversationId;
    const asked = await t.request(`/v1/conversations/${main}/messages`, {
      body: { text: "Hi" },
    });
    assert.equal(asked.status, 409);
    const agreed = await t.request("/v1/consent", { body: { services: ["openrouter"] } });
    assert.equal(agreed.status, 200);
  });

  test("the same message sent twice is stored and answered once", async () => {
    t.model.script.push({ text: "Once." });
    const conversationId = t.home.store.mainAgent().conversationId;
    const send = () =>
      t.request(`/v1/conversations/${conversationId}/messages`, {
        body: { text: "Ping", clientId: "c-1" },
      });
    const [first, second] = await Promise.all([send(), send()]);
    const ids = await Promise.all(
      [first, second].map(
        async (r) => ((await r.json()) as { message: { id: string } }).message.id,
      ),
    );
    assert.equal(ids[0], ids[1]);
    const asked = t.model.requests.length;
    await t.home.turns.idle();
    const texts = t.home.store.messages(conversationId, { limit: 4 }).messages.map(textOf);
    assert.equal(texts.filter((text) => text === "Ping").length, 1);
    assert.equal(t.model.requests.length - asked <= 1, true);
    assert.equal(textOf(t.last()), "Once.");
  });

  test("what a phone wrote by itself is part of the conversation afterwards", async () => {
    const conversationId = t.home.store.mainAgent().conversationId;
    const sent = await t.request(`/v1/conversations/${conversationId}/import`, {
      body: {
        messages: [
          {
            role: "you",
            text: "Note: the cat is called Miso",
            createdAt: new Date().toISOString(),
            clientId: "imp-1",
          },
          {
            role: "agent",
            text: "Noted, Miso.",
            createdAt: new Date().toISOString(),
            clientId: "imp-2",
            model: "apple:on-device",
          },
        ],
      },
    });
    assert.equal(((await sent.json()) as { messages: unknown[] }).messages.length, 2);
    t.model.script.push({ text: "Miso." });
    await t.say("What is the cat called?");
    const read = (t.model.requests.at(-1)?.messages ?? []).map(
      (message) => `${message.role}:${message.content}`,
    );
    assert.ok(read.includes("user:Note: the cat is called Miso"));
    assert.ok(read.includes("assistant:Noted, Miso."));
  });

  test("a scheduled task gives the agent a turn when it is due", async () => {
    t.model.script.push(
      {
        calls: [
          {
            name: "schedule_set",
            arguments: {
              title: "Good night",
              prompt: "Say good night",
              every: "day",
              time: "22:00",
            },
          },
        ],
      },
      { text: "Scheduled." },
    );
    await t.say("Remind me every evening");
    t.model.script.push({ text: "Good night." });
    t.home.tasks.tick(new Date(Date.now() + 25 * 3600_000));
    await t.home.turns.idle();
    assert.equal(textOf(t.last()), "Good night.");
    assert.match(
      t.model.requests.at(-1)?.messages.at(-1)?.content ?? "",
      /A task you scheduled is due now: Say good night/,
    );
  });

  test("an agent's detail shows what it remembers and what it scheduled", async () => {
    const agent = t.home.store.mainAgent();
    t.home.store.updateAgent(agent.id, { memory: "Ada takes the train." });
    const detail = (await (await t.request(`/v1/agents/${agent.id}`)).json()) as AgentDetail;
    assert.equal(detail.agent.id, agent.id);
    assert.equal(detail.memory, "Ada takes the train.");
    assert.deepEqual(
      detail.tasks.map((task) => [task.prompt, task.rule]),
      [["Say good night", { every: "day", time: "22:00" }]],
    );
    assert.ok(Date.parse(detail.tasks[0]?.nextAt ?? "") > Date.now());
    assert.equal((await t.request("/v1/agents/agt_none")).status, 404);
  });
});

describe("a turn", () => {
  test("reads what is written while it runs, and answers once", async () => {
    const t = await testHome("Ada");
    try {
      t.home.addTools(() => [
        defineTool({
          name: "look_up",
          description: "Takes a moment.",
          input: z.object({}),
          run: async () => {
            await new Promise((resolve) => setTimeout(resolve, 400));
            return "The 7:10 is on time.";
          },
        }),
      ]);
      const conversationId = t.home.store.mainAgent().conversationId;
      t.model.script.push(
        { calls: [{ name: "look_up", arguments: {} }] },
        { text: "On time, and I booked a seat." },
      );
      const first = t.home.turns.enqueue({
        conversationId,
        text: "Is the 7:10 on time?",
        channel: "app",
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      const second = t.home.turns.enqueue({
        conversationId,
        text: "Also book a seat.",
        channel: "app",
      });
      await Promise.all([first, second]);
      const replies = t.home.store
        .messages(conversationId, { limit: 10 })
        .messages.filter((message) => message.role === "agent");
      assert.equal(replies.length, 1);
      assert.equal(textOf(replies[0] as never), "On time, and I booked a seat.");
      const read = (t.model.requests.at(-1)?.messages ?? []).map(
        (message) => `${message.role}:${message.content}`,
      );
      assert.deepEqual(read.slice(-3), [
        "assistant:",
        "tool:The 7:10 is on time.",
        "user:Also book a seat.",
      ]);
      assert.equal(t.model.requests.length, 2);
    } finally {
      t.stop();
    }
  });

  test("goes to the next model when the first one does not answer", async () => {
    const t = await testHome("Ada");
    try {
      t.home.models.setGateway(
        { id: "custom", label: "Gone", baseUrl: "http://127.0.0.1:9/v1", models: ["x"] },
        "key",
      );
      t.home.models.setOrder(["custom:x"]);
      assert.deepEqual(t.home.models.candidates(), ["custom:x", "ollama:fake:1"]);
      await t.request("/v1/consent", { body: { services: ["custom"] } });
      t.model.script.push({ text: "Here." });
      const reply = await t.say("Anyone?");
      assert.equal(reply.state, "done");
      assert.equal(textOf(reply), "Here.");
      assert.equal(reply.model, "ollama:fake:1");
    } finally {
      t.stop();
    }
  });
});

describe("two homes", () => {
  let ada: TestHome;
  let ben: TestHome;
  before(async () => {
    ada = await testHome("Ada");
    ben = await testHome("Ben");
  });
  after(() => {
    ada.stop();
    ben.stop();
  });

  test("connect after the other person approves, share an agent, and talk to it", async () => {
    const benHandle = ben.home.handle() as string;
    const adaHandle = ada.home.handle() as string;

    ada.model.script.push(
      { calls: [{ name: "contact_connect", arguments: { handle: benHandle } }] },
      { text: "Asked Ben." },
    );
    await ada.say("Connect me with Ben");
    assert.equal(ada.home.peers.contact(benHandle)?.state, "requested");

    const request = ben.item();
    assert.equal(request.kind, "contact");
    assert.equal(request.title, "Ada wants to connect");
    ben.model.script.push({ text: "Ada is connected." });
    ada.model.script.push({ text: "Ben accepted." });
    await ben.answer(request.id, "connect");
    await ada.home.turns.idle();
    assert.equal(ben.home.peers.contact(adaHandle)?.state, "connected");
    assert.equal(ada.home.peers.contact(benHandle)?.state, "connected");

    const guide = ada.home.store.createAgent({
      name: "Kraków guide",
      kind: "drop",
      about: "Knows Kraków.",
      instructions: "Answer questions about Kraków.",
    });
    ada.model.script.push(
      {
        calls: [
          {
            name: "agent_share",
            arguments: { agentId: guide.id, handle: benHandle, mode: "talk" },
          },
        ],
      },
      { text: "I asked you first." },
    );
    await ada.say("Share the guide with Ben");
    ada.model.script.push({ text: "Offered to Ben." });
    await ada.answer(ada.item().id, "share");

    const offer = ben.item();
    assert.equal(offer.title, "Ada shares “Kraków guide” with you");
    ben.model.script.push({ text: "The guide is in your list." });
    await ben.answer(offer.id, "add");
    const shared = ben.home.store.agents().find((agent) => agent.origin === "shared");
    assert.equal(shared?.from, adaHandle);

    ada.model.script.push({ text: "Start at the Rynek." });
    await ben.request(`/v1/conversations/${shared?.conversationId}/messages`, {
      body: { text: "Where do I start?" },
    });
    await ben.home.turns.idle();
    const reply = ben.home.store.messages(shared?.conversationId as string, { limit: 1 })
      .messages[0];
    assert.equal(reply && textOf(reply), "Start at the Rynek.");
    assert.equal(reply?.model, `shared:${adaHandle}`);
    const guest = ada.model.requests.at(-1);
    assert.match(guest?.messages[0]?.content ?? "", /Ada shares you with Ben/);
    // The one thing the agent can do there: ask its person to keep a sentence.
    assert.deepEqual(
      ((guest?.tools ?? []) as { function: { name: string } }[]).map((tool) => tool.function.name),
      ["remember_suggest"],
    );
  });

  test("a home that is not a contact cannot talk to an agent", async () => {
    const stranger = await testHome("Eve");
    try {
      const guide = ada.home.store.agents().find((agent) => agent.name === "Kraków guide");
      const fake = { ...guide, from: ada.home.handle(), remote: `/a2a/agents/${guide?.id}` };
      await assert.rejects(
        stranger.home.peers.ask(fake as never, "Hello", new AbortController().signal, () => {}),
        /does not know the sender/,
      );
    } finally {
      stranger.stop();
    }
  });
});

describe("the web app", () => {
  test("is served from its built folder, with a policy for its page, and nothing else from disk", async () => {
    const webDir = mkdtempSync(join(tmpdir(), "wizards-bot-web-"));
    mkdirSync(join(webDir, "assets"));
    writeFileSync(
      join(webDir, "index.html"),
      '<!doctype html><script>go()</script><script type="module" src="/assets/app-1.js"></script>',
    );
    writeFileSync(join(webDir, "assets", "app-1.js"), "export {};");
    writeFileSync(join(webDir, "icon.svg"), "<svg/>");
    writeFileSync(join(webDir, "notes.txt"), "not for a browser");
    const t = await testHome("Ada");
    const app = createServer(t.home, { webDir });
    try {
      const page = await app.request("/");
      assert.equal(page.status, 200);
      assert.match(page.headers.get("content-type") ?? "", /text\/html/);
      const policy = page.headers.get("content-security-policy") ?? "";
      assert.match(policy, /default-src 'self'/);
      assert.match(policy, /script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
      assert.match(policy, /connect-src 'self'/);
      const script = await app.request("/assets/app-1.js");
      assert.equal(script.status, 200);
      assert.match(script.headers.get("cache-control") ?? "", /immutable/);
      assert.equal((await app.request("/icon.svg")).status, 200);
      assert.equal((await app.request("/assets/nope.js")).status, 404);
      assert.equal((await app.request("/assets/..%2Fnotes.txt")).status, 404);
      assert.equal((await app.request("/notes.txt")).status, 404);
      assert.equal((await app.request("/assets/..%2F..%2F..%2Fetc%2Fpasswd")).status, 404);
    } finally {
      t.stop();
    }
  });

  test("says how to build it when it is not built", async () => {
    const t = await testHome("Ada");
    try {
      const page = await createServer(t.home, {
        webDir: join(tmpdir(), "wizards-bot-no-such-web"),
      }).request("/");
      assert.equal(page.status, 503);
      assert.match(await page.text(), /pnpm build/);
    } finally {
      t.stop();
    }
  });
});
