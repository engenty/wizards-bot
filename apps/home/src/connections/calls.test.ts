import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Card } from "@wizards-bot/protocol";
import { marked } from "marked";
import { cardsAsText, pickAction } from "../channels/channels.ts";
import { Home } from "../home.ts";
import { FakeMcp, type FakeTool } from "../test/fake-mcp.ts";
import { type TestHome, testHome, textOf } from "../test/fakes.ts";
import { contentOf, formOf, pageOf, plain } from "./elicitation.ts";

const WHO = {
  type: "object",
  properties: {
    name: { type: "string", title: "Name", minLength: 2 },
    age: { type: "integer", minimum: 18, description: "Your age in years" },
    news: { type: "boolean", title: "Send news", default: true },
    color: { type: "string", enum: ["red", "green"], default: "green" },
    days: {
      type: "array",
      maxItems: 1,
      items: {
        anyOf: [
          { const: "mon", title: "Monday" },
          { const: "tue", title: "Tuesday" },
        ],
      },
    },
  },
  required: ["name", "age"],
};

/** The tools of the fake. `paid` stands for what the person does on the server's page. */
function tools(world: { paid: boolean; page: string }): Record<string, FakeTool> {
  const form = (key: string, question: Record<string, unknown>, done: string): FakeTool => ({
    readOnly: true,
    run: (call, state) => {
      const answer = call.inputResponses?.[key];
      if (!answer) return { ask: { [key]: { mode: "form", ...question } }, state: { step: 1 } };
      return {
        text:
          answer.action === "accept"
            ? `${done} (state ${JSON.stringify(state)})`
            : `not done (${answer.action})`,
      };
    },
  });
  return {
    whoami: form(
      "who",
      { message: "Who are you? See [here](https://evil.example).", requestedSchema: WHO },
      "known",
    ),
    transfer: {
      ...form(
        "sure",
        {
          message: "Send 5 EUR?",
          requestedSchema: {
            type: "object",
            properties: { confirm: { type: "boolean", title: "Really send it" } },
            required: ["confirm"],
          },
        },
        "sent",
      ),
      readOnly: false,
    },
    login: form(
      "login",
      {
        message: "Sign in.",
        requestedSchema: { type: "object", properties: { password: { type: "string" } } },
      },
      "signed in",
    ),
    nested: form(
      "nested",
      {
        message: "Where?",
        requestedSchema: {
          type: "object",
          properties: { address: { type: "object", properties: { city: { type: "string" } } } },
        },
      },
      "moved",
    ),
    pay: {
      readOnly: true,
      run: (call) => {
        const answer = call.inputResponses?.page;
        if (answer && answer.action !== "accept") return { text: `not paid (${answer.action})` };
        if (world.paid) return { text: "paid" };
        return {
          ask: { page: { mode: "url", message: "Pay on our page.", url: world.page } },
          state: { order: 7 },
        };
      },
    },
    both: {
      readOnly: true,
      run: (call) => {
        if (call.inputResponses) return { text: `both: ${Object.keys(call.inputResponses)}` };
        return {
          ask: {
            first: {
              message: "Your city?",
              requestedSchema: { type: "object", properties: { city: { type: "string" } } },
            },
            second: { mode: "url", message: "Then confirm.", url: world.page },
          },
          state: { both: true },
        };
      },
    },
  };
}

/** Lets the scripted model use one tool of the connection `bank`. The run then waits or ends. */
async function use(t: TestHome, tool: string, after?: string): Promise<void> {
  t.model.script.push({
    calls: [
      {
        name: "connection_call",
        arguments: { name: "bank", tool, arguments: { amount: 5 }, why: `Use ${tool}` },
      },
    ],
  });
  if (after) t.model.script.push({ text: after });
  await t.say(`use ${tool}`);
}

/** Everything a model was given, as text. */
const seen = (t: TestHome): string => JSON.stringify(t.model.requests);

/** What the tool answered last, as the model read it. */
const result = (t: TestHome): string =>
  t.model.requests
    .at(-1)
    ?.messages.filter((message) => message.role === "tool")
    .at(-1)?.content ?? "";

/** The last thing the home told the agent. */
const told = (t: TestHome): string =>
  t.model.requests
    .flatMap((request) => request.messages)
    .filter((message) => message.role === "user" && message.content.includes("[home]"))
    .at(-1)?.content ?? "";

describe("a connection that asks the person, the newest way", () => {
  let t: TestHome;
  let bank: FakeMcp;
  const world = { paid: false, page: "" };
  before(async () => {
    t = await testHome("Ada");
    bank = new FakeMcp("modern", tools(world));
    await bank.start();
    world.page = `${bank.url.replace("/mcp", "")}/checkout?order=7`;
    const { connection } = await t.home.connections.add({ name: "bank", url: bank.url });
    assert.equal(connection.state, "connected");
    assert.deepEqual(
      connection.tools
        .map((tool) => [tool.name, tool.readOnly])
        .find(([name]) => name === "transfer"),
      ["transfer", false],
    );
  });
  // The last test stops the home itself, to start it again.
  let stopped = false;
  after(() => {
    bank.stop();
    if (stopped) t.model.stop();
    else t.stop();
  });

  let card: Card;

  test("a form is a card with fields made from the schema, and the run waits", async () => {
    const requests = t.model.requests.length;
    await use(t, "whoami");
    card = t.item();
    assert.equal(card.title, "bank asks you something");
    assert.deepEqual(
      card.actions.map((action) => action.id),
      ["accept", "decline", "cancel"],
    );
    const [name, age, news, color, days] = card.fields ?? [];
    assert.deepEqual(name, { id: "f0", label: "Name", type: "text", required: true });
    assert.equal(age?.type, "text");
    assert.equal(age?.placeholder, "A whole number, at least 18");
    assert.deepEqual(
      news?.options?.map((option) => option.id),
      ["yes", "no"],
    );
    assert.equal(news?.value, "yes");
    assert.equal(color?.type, "choice");
    assert.equal(color?.value, "green");
    assert.equal(days?.type, "multi");
    assert.deepEqual(days?.options?.[0], { id: "mon", label: "Monday" });
    // The server's words are shown as they are: its link is no link.
    const html = await marked.parse(card.body ?? "");
    assert.ok(!html.includes("<a "), html);
    assert.match(html, /evil\.example/);
    assert.match(html, /Your age in years/);
    // Mastra suspended the run at the card: the model was asked once and not again.
    assert.equal(t.model.requests.length, requests + 1);
    assert.equal(bank.calls.length, 1);
  });

  test("an answer that does not fit is asked again, and nothing is sent", async () => {
    await t.answer(card.id, "accept", { f0: "Ada Lovelace", f1: "12", f3: "green" });
    assert.equal(bank.calls.length, 1);
    const again = t.item();
    assert.notEqual(again.id, card.id);
    assert.match(again.body ?? "", /age is at least 18/);
    card = again;
  });

  test("the answer goes to the server only, and the tool's call ends with its result", async () => {
    t.model.script.push({ text: "You are known." });
    await t.answer(card.id, "accept", {
      f0: "Ada Lovelace",
      f1: "36",
      f2: "no",
      f3: "green",
      f4: ["mon"],
    });
    const retry = bank.calls.at(-1);
    assert.deepEqual(retry?.inputResponses, {
      who: {
        action: "accept",
        content: { name: "Ada Lovelace", age: 36, news: false, color: "green", days: ["mon"] },
      },
    });
    assert.deepEqual(retry?.arguments, { amount: 5 });
    // The fake checks its token's signature: a changed token would have failed the call.
    assert.equal(result(t), 'known (state {"step":1})');
    // What was typed is nowhere but at the server.
    assert.equal(t.home.store.card(card.id)?.answer?.values, undefined);
    assert.ok(!seen(t).includes("Lovelace"));
    const conversationId = t.home.store.mainAgent().conversationId;
    assert.ok(!JSON.stringify(t.home.store.messages(conversationId, {})).includes("Lovelace"));
    assert.equal(t.home.store.items().length, 0);
  });

  test("no and not now reach the server as decline and cancel", async () => {
    for (const [action, word] of [
      ["decline", /said no to what bank asked/],
      ["cancel", /put off what bank asked/],
    ] as const) {
      await use(t, "whoami");
      t.model.script.push({ text: "Fine." });
      await t.answer(t.item().id, action, { f0: "Grace Hopper" });
      assert.deepEqual(bank.calls.at(-1)?.inputResponses, { who: { action } });
      assert.match(result(t), word);
      assert.match(result(t), new RegExp(`not done \\(${action}\\)`));
    }
    assert.ok(!bank.bodies.join("\n").includes("Hopper"));
  });

  test("a page is a card with the link and its host, and the home does not open it", async () => {
    const before = bank.bodies.length;
    await use(t, "pay");
    const page = t.item();
    assert.equal(page.title, "bank asks you to open a page");
    assert.equal(page.url, world.page);
    assert.equal(page.fields, undefined);
    assert.ok(page.body?.includes(new URL(world.page).host));
    assert.ok(page.body?.includes(world.page));
    // Only the tool call arrived at the server: the home fetched nothing from the page.
    assert.equal(bank.bodies.length, before + 1);

    // "Go on" before the person paid: the server asks again, with a new card.
    await t.answer(page.id, "accept");
    assert.deepEqual(bank.calls.at(-1)?.inputResponses, { page: { action: "accept" } });
    const again = t.item();
    assert.notEqual(again.id, page.id);

    world.paid = true;
    t.model.script.push({ text: "Paid." });
    await t.answer(again.id, "accept");
    assert.equal(result(t), "paid");
    world.paid = false;
  });

  test("a form that asks for a secret, or nests, is refused", async () => {
    for (const [tool, why] of [
      ["login", /asks for a secret in a form/],
      // Mastra's client turns this one down itself, before the home is asked.
      ["nested", /Invalid elicitation request/],
    ] as const) {
      const calls = bank.calls.length;
      await use(t, tool, "It did not work.");
      assert.equal(t.home.store.items().length, 0);
      assert.equal(bank.calls.length, calls + 1);
      assert.match(result(t), why);
    }
  });

  test("a tool that changes something asks twice: the home first, then the server", async () => {
    await use(t, "transfer");
    const approval = t.item();
    assert.equal(approval.kind, "approval");
    await t.answer(approval.id, "once");
    const question = t.item();
    assert.equal(question.title, "bank asks you something");
    assert.notEqual(question.messageId, approval.messageId);
    t.model.script.push({ text: "Sent." });
    await t.answer(question.id, "accept", { f0: "yes" });
    assert.deepEqual(bank.calls.at(-1)?.inputResponses?.sure?.content, { confirm: true });
    assert.match(result(t), /^sent \(state/);
  });

  test("two questions at once are two cards and one call", async () => {
    await use(t, "both");
    const calls = bank.calls.length;
    const first = t.item();
    await t.answer(first.id, "accept", { f0: "Kraków" });
    assert.equal(bank.calls.length, calls);
    const second = t.item();
    assert.equal(second.url, world.page);
    assert.ok(!JSON.stringify(t.home.store.cardPayload(second.id)).includes("Kraków"));
    t.model.script.push({ text: "Both." });
    await t.answer(second.id, "accept");
    assert.deepEqual(bank.calls.at(-1)?.inputResponses, {
      first: { action: "accept", content: { city: "Kraków" } },
      second: { action: "accept" },
    });
    assert.match(result(t), /both: first,second/);
  });

  test("over a channel a page has numbers to answer with, a form points to the app", async () => {
    await use(t, "pay");
    const page = t.item();
    assert.match(cardsAsText([page]), /1: Go on {3}2: Don't {3}3: Not now/);
    assert.ok(cardsAsText([page]).includes(world.page));
    assert.equal(pickAction(page, "2"), "decline");
    t.model.script.push({ text: "Fine." });
    await t.answer(page.id, "decline");
    await use(t, "whoami");
    const form = t.item();
    assert.match(cardsAsText([form]), /Answer this one in the wizards.bot app/);
    assert.equal(pickAction(form, "1"), undefined);
    t.model.script.push({ text: "Fine." });
    await t.answer(form.id, "cancel");
  });

  test("what is said meanwhile ends the wait in Mastra; the card still answers", async () => {
    await use(t, "transfer");
    const approval = t.item();
    // The person writes instead of answering: the message is read at once.
    t.model.script.push({ text: "Take your time." });
    await t.say("Wait a moment");
    assert.equal(textOf(t.last()), "Take your time.");
    assert.equal(t.home.store.card(approval.id)?.state, "open");
    // No run waits for the card now: the home runs the tool again with the answer.
    await t.answer(approval.id, "once");
    const question = t.item();
    assert.equal(question.title, "bank asks you something");
    t.model.script.push({ text: "Sent." });
    await t.answer(question.id, "accept", { f0: "yes" });
    assert.match(
      told(t),
      /\[home\] The person answered "bank asks you something" with "Send"\. connection_call says:\nsent \(state/,
    );
    assert.equal(textOf(t.last()), "Sent.");
  });

  test("a start of the home closes the card of a call that waited", async () => {
    await use(t, "whoami");
    const waiting = t.item();
    const calls = bank.calls.length;
    t.stop();
    stopped = true;
    await t.model.start();
    const again = new Home({ ...t.home.config, ollamaUrl: t.model.url }, []);
    try {
      assert.equal(again.store.card(waiting.id)?.state, "expired");
      assert.equal(again.store.items().length, 0);
      assert.equal(bank.calls.length, calls);
    } finally {
      again.close();
    }
  });
});

describe("a connection that asks the person, the older way", () => {
  let t: TestHome;
  let bank: FakeMcp;
  const world = { paid: false, page: "https://pay.example/checkout?order=7" };
  before(async () => {
    t = await testHome("Ada");
    bank = new FakeMcp("legacy", tools(world));
    await bank.start();
    await t.home.connections.add({ name: "bank", url: bank.url });
  });
  after(() => {
    bank.stop();
    t.stop();
  });

  test("the call stays open, the turn does not: the answer goes into the open call", async () => {
    await use(t, "whoami");
    const card = t.item();
    assert.equal(card.fields?.length, 5);
    t.model.script.push({ text: "Known." });
    await t.answer(card.id, "accept", { f0: "Ada Lovelace", f1: "36" });
    assert.deepEqual(bank.calls.at(-1)?.inputResponses?.who, {
      action: "accept",
      content: { name: "Ada Lovelace", age: 36 },
    });
    assert.equal(bank.calls.length, 1);
    assert.match(result(t), /^known/);
    assert.ok(!seen(t).includes("Lovelace"));
    assert.equal(t.home.store.card(card.id)?.answer?.values, undefined);
  });

  test("a page asked the older way is a card too", async () => {
    await use(t, "pay");
    const page = t.item();
    assert.equal(page.url, world.page);
    world.paid = true;
    t.model.script.push({ text: "Paid." });
    await t.answer(page.id, "accept");
    assert.equal(result(t), "paid");
    world.paid = false;
  });

  test("when the server stops waiting, the card closes and the agent is told", async () => {
    bank.patience = 150;
    t.model.script.push(
      {
        calls: [
          {
            name: "connection_call",
            arguments: { name: "bank", tool: "whoami", arguments: {}, why: "Use whoami" },
          },
        ],
      },
      { text: "It gave up." },
    );
    await t.say("use whoami");
    const card = t.home.store
      .messages(t.home.store.mainAgent().conversationId, {})
      .messages.flatMap((message) => message.parts)
      .filter((part) => part.type === "card")
      .at(-1)?.card as Card;
    for (let tries = 0; tries < 100 && t.home.store.card(card.id)?.state === "open"; tries++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(t.home.store.card(card.id)?.state, "expired");
    await t.home.idle();
    assert.match(told(t), /stopped waiting before an answer came/);
    const late = await t.request(`/v1/cards/${card.id}/answer`, { body: { action: "accept" } });
    assert.equal(late.status, 409);
    bank.patience = 5000;
  });

  test("a form that asks for a secret is refused to the server", async () => {
    await use(t, "login", "It did not work.");
    assert.equal(t.home.store.items().length, 0);
    assert.match(result(t), /asks for a secret in a form/);
  });
});

describe("a tool that asked, after a start of the home", () => {
  test("Mastra goes on with the run it kept: the answer ends the same tool call", async () => {
    const t = await testHome("Ada");
    t.model.script.push({
      calls: [{ name: "ask", arguments: { title: "Train or car?", choices: ["Train", "Car"] } }],
    });
    await t.say("Plan my trip");
    const card = t.item();
    t.stop();
    await t.model.start();
    const again = new Home({ ...t.home.config, ollamaUrl: t.model.url }, []);
    try {
      await again.models.refresh(true);
      t.model.script.push({ text: "Train it is." });
      await again.answer(card.id, { action: "choice_0", by: "Test phone" });
      await again.idle();
      const read = t.model.requests.at(-1)?.messages.at(-1);
      assert.equal(read?.role, "tool");
      assert.equal(read?.content, 'The person answered "Train or car?" with "Train"');
      const conversationId = again.store.mainAgent().conversationId;
      const last = again.store.messages(conversationId, { limit: 1 }).messages[0];
      assert.equal(last && textOf(last), "Train it is.");
    } finally {
      again.close();
      t.model.stop();
    }
  });
});

describe("a connection that wants a sign-in", () => {
  test("the sign-in ends at the home's own address, and the tools work after it", async () => {
    const t = await testHome("Ada");
    const bank = new FakeMcp("modern", { echo: { readOnly: true, run: () => ({ text: "hi" }) } });
    bank.signIn = true;
    await bank.start();
    try {
      const { connection, signIn } = await t.home.connections.add({ name: "bank", url: bank.url });
      assert.equal(connection.state, "needs_sign_in");
      const where = new URL(signIn as string);
      assert.equal(where.pathname, "/authorize");
      assert.equal(where.searchParams.get("redirect_uri"), `${t.url}/oauth/callback`);

      const state = where.searchParams.get("state");
      const back = await fetch(`${t.url}/oauth/callback?state=${state}&code=code-1`);
      assert.match(await back.text(), /You are signed in/);
      assert.deepEqual(bank.codes, ["code-1"]);
      assert.equal(t.home.connections.byName("bank")?.state, "connected");

      await use(t, "echo", "Hi.");
      assert.equal(result(t), "hi");
    } finally {
      bank.stop();
      t.stop();
    }
  });
});

describe("what a server may ask", () => {
  test("its words stay words: no link, no picture, no heading", async () => {
    const html = await marked.parse(
      plain(
        "# Hi\n[pay](https://evil.example) https://evil.example www.evil.example <https://evil.example> a@evil.example ![x](https://evil.example/x.png)\n    code\n===",
      ),
    );
    assert.ok(!/<a |<img|<h1|<h2|<pre/.test(html), html);
    assert.match(html, /https:\/\/evil\.example/);
  });

  test("only the kinds MCP allows in a form", () => {
    const refused = (properties: Record<string, unknown>) =>
      "refused" in formOf({ type: "object", properties });
    assert.ok(refused({ a: { type: "object" } }));
    assert.ok(refused({ a: { type: "array", items: { type: "string" } } }));
    assert.ok(refused({ a: { type: "string", enum: [] } }));
    assert.ok(refused({ a: { type: "null" } }));
    assert.ok(refused({ key: { type: "string", title: "API key" } }));
    assert.ok(refused({ a: { type: "string", description: "Your card number" } }));
    assert.ok(refused({ code: { type: "string", title: "One-time code" } }));
    assert.ok("refused" in formOf({ type: "array" }));
    assert.ok(
      !refused({ a: { type: "string", format: "email" }, token_count: { type: "number" } }),
    );
    assert.deepEqual(formOf({ type: "object", properties: {} }), { fields: [], notes: [] });
  });

  test("what is typed is checked against the schema", () => {
    const schema = {
      type: "object",
      properties: {
        mail: { type: "string", format: "email" },
        when: { type: "string", format: "date" },
        share: { type: "number", minimum: 0, maximum: 1 },
        pick: { type: "string", oneOf: [{ const: "a", title: "A" }] },
      },
      required: ["mail"],
    };
    assert.deepEqual(contentOf(schema, { f0: " ada@example.com ", f2: "0,5", f3: "a" }), {
      content: { mail: "ada@example.com", share: 0.5, pick: "a" },
    });
    const wrong = contentOf(schema, { f0: "ada", f1: "tomorrow", f2: "2", f3: "b" });
    assert.equal("problems" in wrong && wrong.problems.length, 4);
    assert.deepEqual(contentOf(schema, {}), { problems: ["mail is missing."] });
  });

  test("a page is https, names no sign-in, and odd letters are pointed out", () => {
    assert.ok("refused" in pageOf("http://pay.example/x"));
    assert.ok("refused" in pageOf("javascript:alert(1)"));
    assert.ok("refused" in pageOf("https://user:pw@pay.example/"));
    assert.ok("refused" in pageOf(undefined));
    assert.deepEqual(pageOf("https://pay.example/a?b=`c`"), {
      url: "https://pay.example/a?b=%60c%60",
      host: "pay.example",
      warning: undefined,
    });
    const odd = pageOf("https://pаypal.com/");
    assert.ok("warning" in odd && odd.warning);
  });
});
