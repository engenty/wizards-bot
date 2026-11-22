import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Models } from "@wizards-bot/protocol";
import { type TestHome, testHome } from "../test/fakes.ts";
import { serviceOf, services } from "./services.ts";

describe("the service behind a model source", () => {
  test("a model on the person's computers has none", () => {
    assert.equal(serviceOf({ id: "ollama", kind: "ollama", label: "Ollama" }), undefined);
    assert.equal(serviceOf({ id: "dev_mac/ollama", kind: "ollama", label: "Ollama" }), undefined);
  });

  test("a subscription and a gateway name their company, also on a linked computer", () => {
    assert.deepEqual(serviceOf({ id: "claude", kind: "subscription", label: "Claude" }), {
      id: "anthropic",
      label: "Anthropic",
    });
    assert.equal(
      serviceOf({ id: "dev_mac/codex", kind: "subscription", label: "Codex" })?.id,
      "openai",
    );
    assert.equal(
      serviceOf({ id: "anthropic", kind: "gateway", label: "Anthropic" })?.id,
      "anthropic",
    );
    assert.deepEqual(serviceOf({ id: "mygate", kind: "gateway", label: "My gateway" }), {
      id: "mygate",
      label: "My gateway",
    });
  });

  test("Claude and the Anthropic gateway are one service; a yes stays when it is not in use", () => {
    const list = services(
      [
        {
          id: "claude",
          kind: "subscription",
          label: "Claude",
          where: "Mac",
          online: true,
          models: [],
        },
        {
          id: "anthropic",
          kind: "gateway",
          label: "Anthropic",
          where: "the cloud",
          online: true,
          models: [],
        },
      ],
      ["claude"],
      { openrouter: { at: "2026-11-22T10:00:00.000Z", by: "Phone" } },
    );
    assert.deepEqual(list, [
      { id: "anthropic", label: "Anthropic", sources: ["Claude", "Anthropic"], inUse: true },
      {
        id: "openrouter",
        label: "OpenRouter",
        sources: [],
        inUse: false,
        agreed: { at: "2026-11-22T10:00:00.000Z", by: "Phone" },
      },
    ]);
  });
});

describe("the person's yes before words reach a model service", () => {
  let t: TestHome;
  let terminal: string;
  let conversationId: string;

  before(async () => {
    t = await testHome("Ada");
    terminal = t.home.store.addDevice({ name: "Terminal", kind: "computer" }).token;
    conversationId = t.home.store.mainAgent().conversationId;
  });
  after(() => t.stop());

  const models = async (): Promise<Models> =>
    (await (await t.request("/v1/models")).json()) as Models;
  const send = (text: string, token = t.token) =>
    t.request(`/v1/conversations/${conversationId}/messages`, { body: { text }, token });

  test("a home with Ollama only asks nothing", async () => {
    const view = await models();
    assert.deepEqual(view.services, []);
    assert.equal(view.sources[0]?.service, undefined);
    t.model.script.push({ text: "Hello." });
    assert.equal((await t.say("Hi")).parts[0]?.type, "text");
  });

  test("a gateway in use waits for a yes; the phone's message is refused, nothing is stored", async () => {
    t.home.models.setGateway(
      {
        id: "openrouter",
        label: "OpenRouter",
        baseUrl: "http://127.0.0.1:9",
        models: ["some/model"],
      },
      "key",
    );
    const view = await models();
    assert.equal(view.sources.find((source) => source.id === "openrouter")?.service, "openrouter");
    assert.deepEqual(view.services, [
      { id: "openrouter", label: "OpenRouter", sources: ["OpenRouter"], inUse: true },
    ]);
    const before = t.home.store.messages(conversationId, { limit: 50 }).messages.length;
    const response = await send("My dentist is on Friday.");
    assert.equal(response.status, 409);
    const body = (await response.json()) as {
      error: string;
      message: string;
      services: { id: string }[];
    };
    assert.equal(body.error, "needs_consent");
    assert.match(body.message, /OpenRouter/);
    assert.deepEqual(
      body.services.map((service) => service.id),
      ["openrouter"],
    );
    assert.equal(t.home.store.messages(conversationId, { limit: 50 }).messages.length, before);
  });

  test("what the phone did while the home was away and a hand-off's answer wait too", async () => {
    const imported = await t.request(`/v1/conversations/${conversationId}/import`, {
      body: {
        messages: [
          { role: "you", text: "Note this", createdAt: "2026-11-22T09:00:00.000Z", clientId: "c1" },
        ],
      },
    });
    assert.equal(imported.status, 409);
    const answered = await t.request("/v1/handoffs/hnd_none/answer", {
      body: { text: "Friday 10:00" },
    });
    assert.equal(answered.status, 409);
    // A declined hand-off carries nothing of the person: it goes on to the usual check.
    const declined = await t.request("/v1/handoffs/hnd_none/answer", {
      body: { text: "No.", declined: true },
    });
    assert.equal(declined.status, 404);
  });

  test("a terminal is the person's own computer and is not asked", async () => {
    t.model.script.push({ text: "Noted." });
    assert.equal((await send("From the terminal", terminal)).status, 202);
    await t.home.idle();
  });

  test("the yes is kept by the home, for every device, and the message goes", async () => {
    const unknown = await t.request("/v1/consent", { body: { services: ["nobody"] } });
    assert.equal(unknown.status, 400);
    const agreed = (await (
      await t.request("/v1/consent", { body: { services: ["openrouter"] } })
    ).json()) as Models;
    assert.equal(agreed.services[0]?.agreed?.by, "Test phone");
    const other = t.home.store.addDevice({ name: "Browser", kind: "browser" }).token;
    t.model.script.push({ text: "Friday it is." });
    assert.equal((await send("My dentist is on Friday.", other)).status, 202);
    await t.home.idle();
  });

  test("a new service asks again; taking a yes back asks again", async () => {
    t.home.models.setGateway(
      { id: "vercel", label: "Vercel AI Gateway", baseUrl: "http://127.0.0.1:9", models: ["m"] },
      "key",
    );
    t.home.models.setOrder(["vercel:m"]);
    let response = await send("Hello again");
    assert.equal(response.status, 409);
    assert.deepEqual(
      ((await response.json()) as { services: { id: string }[] }).services.map(
        (service) => service.id,
      ),
      ["vercel"],
    );
    const taken = (await (
      await t.request("/v1/consent/openrouter", { method: "DELETE" })
    ).json()) as Models;
    assert.equal(taken.services.find((service) => service.id === "openrouter")?.agreed, undefined);
    await t.request("/v1/consent", { body: { services: ["vercel"] } });
    response = await send("Hello again");
    assert.equal(response.status, 409);
    assert.deepEqual(
      ((await response.json()) as { services: { id: string }[] }).services.map(
        (service) => service.id,
      ),
      ["openrouter"],
    );
  });

  test("words typed into a card wait as well; a yes or a choice does not", async () => {
    const agentId = t.home.store.mainAgent().id;
    const card = t.home.store.createCard(
      {
        kind: "question",
        level: "needs_you",
        title: "What should it say?",
        fields: [{ id: "text", label: "Text", type: "text" }],
        actions: [{ id: "send", label: "Send", style: "primary" }],
      },
      { agentId, conversationId, messageId: t.last().id },
    );
    const typed = await t.request(`/v1/cards/${card.id}/answer`, {
      body: { action: "send", values: { text: "Dear Anna" } },
    });
    assert.equal(typed.status, 409);
    const chosen = await t.request(`/v1/cards/${card.id}/answer`, { body: { action: "send" } });
    assert.equal(chosen.status, 200);
  });
});
