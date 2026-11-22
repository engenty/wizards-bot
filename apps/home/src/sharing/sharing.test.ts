import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Message, PublishedLink, PublishedLinks } from "@wizards-bot/protocol";
import { type TestHome, testHome } from "../test/fakes.ts";
import { documentPage, renderMarkdown } from "./page.ts";
import { reachOf, ShareRefused } from "./sharing.ts";

const CHART = `<main class="sheet"><h1>Spending</h1><svg viewBox="0 0 10 10"></svg><script>document.title = "drawn";</script></main>`;

/** Opens an address as a stranger does: no token, no cookie. */
const open = (url: string, init?: RequestInit) => fetch(url, { redirect: "manual", ...init });

const give = (url: string, password: string) =>
  open(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password }),
  });

async function publish(
  t: TestHome,
  body: { kind: "document" | "artifact"; id: string; lasts: string; password?: string },
): Promise<PublishedLink> {
  const response = await t.request("/v1/links", { body });
  assert.equal(response.status, 200);
  return (await response.json()) as PublishedLink;
}

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

describe("a document as a published page", () => {
  test("shows what the Markdown says and nothing the text brought along", () => {
    const html = renderMarkdown(
      [
        "# Plan",
        "",
        "A **bold** word and a [site](https://example.com/a?b=1&c=2).",
        "",
        '<script>alert(1)</script><img src="https://evil.example/x.png" onerror="alert(2)">',
        "",
        "[run](javascript:alert(3)) and [inside](/v1/agents) and ![far](https://evil.example/y.png)",
        "",
        "![near](data:image/png;base64,AAAA)",
        "",
        "| a | b |",
        "| - | - |",
        "| 1 | 2 |",
      ].join("\n"),
    );
    assert.match(html, /<h1>Plan<\/h1>/);
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(
      html,
      /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer nofollow">site<\/a>/,
    );
    assert.match(html, /<table>/);
    // HTML in the text is text on the page.
    assert.ok(!/<script|<img src="https|onerror="/.test(html));
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    // A link that leads nowhere on the web and a picture from an address stay words.
    assert.ok(!html.includes("javascript:"));
    assert.ok(!html.includes("/v1/agents"));
    assert.ok(!html.includes("evil.example/y.png"));
    assert.match(html, /<img src="data:image\/png;base64,AAAA" alt="near">/);
  });

  test("has the title as its heading unless the text brings one", () => {
    const titled = documentPage({ title: "A <b>list</b>", content: "Milk", lang: "en" });
    assert.match(titled, /<title>A &lt;b&gt;list&lt;\/b&gt;<\/title>/);
    assert.match(titled, /<h1>A &lt;b&gt;list&lt;\/b&gt;<\/h1>/);
    assert.match(titled, /<meta name="robots" content="noindex, nofollow, noarchive">/);
    const own = documentPage({ title: "List", content: "# Shopping\n\nMilk", lang: "en" });
    assert.equal(own.split("<h1").length, 2);
  });
});

describe("how far an address reaches", () => {
  test("is this computer, a private network or the internet", () => {
    assert.equal(reachOf("http://localhost:4747"), "computer");
    assert.equal(reachOf("http://127.0.0.1:4747"), "computer");
    assert.equal(reachOf("http://[::1]:4747"), "computer");
    assert.equal(reachOf("http://192.168.1.20:4747"), "network");
    assert.equal(reachOf("http://10.0.0.5:4747"), "network");
    assert.equal(reachOf("http://100.101.102.103:4747"), "network");
    assert.equal(reachOf("http://macbook.local:4747"), "network");
    assert.equal(reachOf("http://macbook:4747"), "network");
    assert.equal(reachOf("http://[fd12:3456::1]:4747"), "network");
    assert.equal(reachOf("https://me.example.com"), "internet");
    assert.equal(reachOf("https://203.0.113.9"), "internet");
  });
});

describe("a published link", () => {
  let t: TestHome;
  let conversationId: string;
  before(async () => {
    t = await testHome("Ada");
    conversationId = t.home.store.mainAgent().conversationId;
  });
  after(() => t.stop());

  test("opens without a token and shows only its document", async () => {
    const plan = t.home.store.createDocument({
      title: "Trip plan",
      content: "# Trip plan\n\nFly on **Monday**.\n\n<script>alert(1)</script>",
      conversationId,
    });
    t.home.store.createDocument({ title: "Diary", content: "Nobody reads this.", conversationId });
    const link = await publish(t, { kind: "document", id: plan.id, lasts: "day" });
    assert.ok(link.url.startsWith(`${t.url}/p/`));
    assert.equal(link.password, false);
    assert.equal(link.version, 1);
    const ends = Date.parse(link.expiresAt as string) - Date.now();
    assert.ok(ends > 23 * 3_600_000 && ends <= 24 * 3_600_000);

    const response = await open(link.url);
    assert.equal(response.status, 200);
    const page = await response.text();
    assert.match(page, /<strong>Monday<\/strong>/);
    assert.ok(!page.includes("Nobody reads this"));
    assert.ok(!page.includes("<script"));
    assert.ok(!page.includes(plan.id));

    const policy = response.headers.get("content-security-policy") ?? "";
    assert.match(
      policy,
      /^sandbox allow-popups allow-popups-to-escape-sandbox; default-src 'none'/,
    );
    assert.ok(!policy.includes("allow-scripts"));
    assert.ok(!policy.includes("unsafe-inline"));
    assert.match(policy, /frame-ancestors 'none'/);
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("set-cookie"), null);

    // The link opens its page and nothing else of the home.
    assert.equal((await open(`${t.url}/v1/documents/${plan.id}`)).status, 401);
    assert.equal((await open(`${t.url}/v1/links?kind=document&id=${plan.id}`)).status, 401);
    const token = link.url.split("/p/")[1];
    assert.equal((await open(`${t.url}/v1/documents/${plan.id}?key=${token}`)).status, 401);
  });

  test("gives a device the same page of a document to download or print", async () => {
    const doc = t.home.store.createDocument({
      title: "Packing list",
      content: "- **Boots**\n- <b>raw</b>",
      conversationId,
    });
    const response = await t.request(`/v1/documents/${doc.id}/page`);
    assert.equal(response.status, 200);
    const page = await response.text();
    assert.match(page, /<h1>Packing list<\/h1>/);
    assert.match(page, /<strong>Boots<\/strong>/);
    assert.ok(page.includes("&lt;b&gt;raw&lt;/b&gt;"));
    assert.match(response.headers.get("content-security-policy") ?? "", /^sandbox /);
    assert.equal((await open(`${t.url}/v1/documents/${doc.id}/page`)).status, 401);
    assert.equal((await t.request("/v1/documents/doc_nothing/page")).status, 404);
  });

  test("shows the document as it was when the link was made", async () => {
    const note = t.home.store.createDocument({ title: "Note", content: "First.", conversationId });
    const first = await publish(t, { kind: "document", id: note.id, lasts: "always" });
    assert.equal(first.expiresAt, undefined);
    t.home.store.saveDocument(note.id, { content: "Second, and private.", by: "you" });
    assert.match(await (await open(first.url)).text(), /First\./);
    assert.ok(!(await (await open(first.url)).text()).includes("Second"));

    const second = await publish(t, { kind: "document", id: note.id, lasts: "always" });
    assert.equal(second.version, 2);
    assert.match(await (await open(second.url)).text(), /Second, and private\./);
    const listed = (await (
      await t.request(`/v1/links?kind=document&id=${note.id}`)
    ).json()) as PublishedLinks;
    assert.deepEqual(
      listed.links.map((link) => link.id),
      [second.id, first.id],
    );
    assert.equal(listed.reach, "computer");
  });

  test("shows an artifact as closed off as in the pane", async () => {
    const artifact = t.home.artifacts.write({ title: "Spending", content: CHART, conversationId });
    const link = await publish(t, { kind: "artifact", id: artifact.id, lasts: "week" });
    const response = await open(link.url);
    assert.equal(response.status, 200);
    const policy = response.headers.get("content-security-policy") ?? "";
    assert.match(policy, /^sandbox allow-scripts allow-modals; default-src 'none'/);
    assert.ok(!policy.includes("allow-same-origin"));
    assert.match(policy, /connect-src 'none'/);
    assert.match(policy, /frame-ancestors 'none'/);
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
    assert.equal(response.headers.get("set-cookie"), null);
    assert.ok((await response.text()).includes(CHART));
  });

  test("stops working when its time is over", async () => {
    const doc = t.home.store.createDocument({
      title: "Hour",
      content: "Soon gone.",
      conversationId,
    });
    const link = await publish(t, { kind: "document", id: doc.id, lasts: "hour" });
    assert.equal((await open(link.url)).status, 200);
    t.home.db.run(
      "update link set expires_at = ? where id = ?",
      new Date(Date.now() - 1000).toISOString(),
      link.id,
    );
    const response = await open(link.url);
    assert.equal(response.status, 410);
    const page = await response.text();
    assert.match(page, /This link does not work any more\./);
    assert.ok(!page.includes("Soon gone") && !page.includes("Hour"));
    assert.deepEqual(t.home.sharing.links("document", doc.id), []);
  });

  test("asks for its password, says nothing before it is right, and slows guesses", async () => {
    const doc = t.home.store.createDocument({
      title: "Salaries",
      content: "Ada earns 1.",
      conversationId,
    });
    const link = await publish(t, {
      kind: "document",
      id: doc.id,
      lasts: "day",
      password: "tulip-42",
    });
    assert.equal(link.password, true);
    const stored = t.home.db.get<{ password: string }>(
      "select password from link where id = ?",
      link.id,
    );
    assert.match(stored?.password ?? "", /^scrypt\$/);
    assert.ok(!stored?.password.includes("tulip-42"));

    const asked = await open(link.url);
    assert.equal(asked.status, 401);
    const form = await asked.text();
    assert.match(form, /<form method="post"/);
    assert.ok(!form.includes("Salaries") && !form.includes("Ada earns"));
    assert.match(asked.headers.get("content-security-policy") ?? "", /form-action 'self'/);

    const wrong = await give(link.url, "tulip-41");
    assert.equal(wrong.status, 401);
    assert.ok(!(await wrong.text()).includes("Ada earns"));
    const empty = await open(link.url, { method: "POST" });
    assert.equal(empty.status, 401);

    const right = await give(link.url, "tulip-42");
    assert.equal(right.status, 200);
    assert.equal(right.headers.get("set-cookie"), null);
    assert.match(await right.text(), /Ada earns 1\./);
    // Nothing was kept: the next look asks again.
    assert.equal((await open(link.url)).status, 401);

    for (let guess = 0; guess < 3; guess++) await give(link.url, `no-${guess}`);
    const slowed = await give(link.url, "tulip-42");
    assert.equal(slowed.status, 429);
    assert.ok(!(await slowed.text()).includes("Ada earns"));
  });

  test("refuses a password that is too short", async () => {
    const doc = t.home.store.createDocument({ title: "Short", content: "x", conversationId });
    const response = await t.request("/v1/links", {
      body: { kind: "document", id: doc.id, lasts: "day", password: "abc" },
    });
    assert.equal(response.status, 400);
    assert.deepEqual(t.home.sharing.links("document", doc.id), []);
  });

  test("opens nothing once it is taken back, also one with no end", async () => {
    const doc = t.home.store.createDocument({
      title: "Open",
      content: "For a while.",
      conversationId,
    });
    const link = await publish(t, { kind: "document", id: doc.id, lasts: "always" });
    assert.equal((await open(link.url)).status, 200);
    assert.equal((await t.request(`/v1/links/${link.id}`, { method: "DELETE" })).status, 204);
    const gone = await open(link.url);
    assert.equal(gone.status, 410);
    assert.ok(!(await gone.text()).includes("For a while"));
    assert.deepEqual(t.home.sharing.links("document", doc.id), []);
    assert.equal((await t.request("/v1/links/lnk_nothing", { method: "DELETE" })).status, 404);
    // Only a device takes a link back.
    assert.equal((await open(`${t.url}/v1/links/${link.id}`, { method: "DELETE" })).status, 401);
  });

  test("tells nothing for an address that was never a link", async () => {
    const one = await open(`${t.url}/p/nothing-here`);
    const two = await open(`${t.url}/p/doc_0000000000000000`);
    assert.equal(one.status, 404);
    assert.equal(two.status, 404);
    assert.equal(await one.text(), await two.text());
    const german = await open(`${t.url}/p/nothing-here`, {
      headers: { "accept-language": "de-AT,de;q=0.9" },
    });
    assert.match(await german.text(), /Dieser Link öffnet nichts\./);
  });

  test("is gone with the version it showed", async () => {
    const doc = t.home.store.createDocument({ title: "Kept", content: "Here.", conversationId });
    const link = await publish(t, { kind: "document", id: doc.id, lasts: "day" });
    t.home.store.saveDocument(doc.id, { content: "Newer.", by: "agent" });
    t.home.db.run("delete from document_version where document_id = ?", doc.id);
    assert.equal((await open(link.url)).status, 410);
    assert.equal((await t.request("/v1/links?kind=document&id=doc_nothing")).status, 404);
  });
});

describe("sending to a contact", () => {
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

  const arrived = (t: TestHome): Message[] =>
    t.home.store.messages(t.home.store.mainAgent().conversationId, { limit: 20 }).messages;

  test("puts a copy into the contact's main chat, with whom it is from", async () => {
    const doc = ada.home.store.createDocument({
      title: "Recipe",
      content: "Flour, water, salt.",
      conversationId: ada.home.store.mainAgent().conversationId,
    });
    const contacts = (await (await ada.request("/v1/contacts")).json()) as {
      contacts: { handle: string; name: string }[];
    };
    assert.deepEqual(contacts.contacts, [{ handle: ben.home.handle(), name: "Ben" }]);

    const response = await ada.request("/v1/send", {
      body: { kind: "document", id: doc.id, handle: ben.home.handle() },
    });
    assert.equal(response.status, 200);
    await ben.home.idle();

    const message = arrived(ben).at(-1) as Message;
    assert.equal(message.role, "agent");
    assert.deepEqual(message.parts[0], {
      type: "text",
      text: `Ada (${ada.home.handle()}) sent you this document.`,
    });
    const part = message.parts[1];
    assert.equal(part?.type, "document");
    const copy = ben.home.store.document(part?.type === "document" ? part.documentId : "");
    assert.equal(copy?.title, "Recipe");
    assert.equal(copy?.content, "Flour, water, salt.");
    assert.notEqual(copy?.id, doc.id);
    // No model was asked: the agent reads the line in its next turn.
    assert.equal(ben.model.requests.length, 0);

    // A copy stays as it was sent.
    ada.home.store.saveDocument(doc.id, { content: "Flour, water, salt, yeast.", by: "you" });
    assert.equal(ben.home.store.document(copy?.id as string)?.content, "Flour, water, salt.");
  });

  test("sends an artifact the same way", async () => {
    const artifact = ada.home.artifacts.write({
      title: "Spending",
      content: CHART,
      conversationId: ada.home.store.mainAgent().conversationId,
    });
    await ada.home.sharing.send({
      kind: "artifact",
      id: artifact.id,
      handle: ben.home.handle() as string,
    });
    const part = (arrived(ben).at(-1) as Message).parts[1];
    assert.equal(part?.type, "artifact");
    const copy = ben.home.artifacts.get(part?.type === "artifact" ? part.artifactId : "");
    assert.equal(copy?.content, CHART);
    assert.equal(copy?.conversationId, ben.home.store.mainAgent().conversationId);
  });

  test("takes nothing from a home that is not a contact", async () => {
    const eve = await testHome("Eve");
    try {
      const doc = eve.home.store.createDocument({
        title: "Spam",
        content: "Buy this.",
        conversationId: eve.home.store.mainAgent().conversationId,
      });
      // Eve's home has no such contact: it does not try.
      await assert.rejects(
        eve.home.sharing.send({
          kind: "document",
          id: doc.id,
          handle: ben.home.handle() as string,
        }),
        (error) => error instanceof ShareRefused && error.code === "not_contact",
      );
      // Eve's home believes it is connected; Ben's never said yes.
      eve.home.db.run(
        "insert into contact (handle, name, url, public_key, state, created_at) values (?, 'Ben', ?, ?, 'connected', ?)",
        ben.home.handle() as string,
        ben.url,
        ben.home.identity.publicKey,
        new Date().toISOString(),
      );
      const before = arrived(ben).length;
      await assert.rejects(
        eve.home.sharing.send({
          kind: "document",
          id: doc.id,
          handle: ben.home.handle() as string,
        }),
        /Only a connected home can send/,
      );
      const refused = await eve.request("/v1/send", {
        body: { kind: "document", id: doc.id, handle: ben.home.handle() },
      });
      assert.equal(refused.status, 502);
      // Nor an unsigned request that only names a contact.
      const unsigned = await fetch(`${ben.url}/peers/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "document", title: "Spam", content: "Buy this." }),
      });
      assert.equal(unsigned.status, 401);
      assert.equal(arrived(ben).length, before);
      assert.ok(
        !ben.home.store
          .documents(ben.home.store.mainAgent().conversationId)
          .some((document) => document.title === "Spam"),
      );
    } finally {
      eve.stop();
    }
  });

  test("takes only so many copies an hour from one contact", async () => {
    const from = { handle: "flo@flo.example", name: "Flo" };
    const copy = { kind: "document", title: "Again", content: "x" };
    for (let count = 0; count < 20; count++) await ben.home.sharing.receive(from, copy);
    await assert.rejects(
      ben.home.sharing.receive(from, copy),
      (error) => error instanceof ShareRefused && error.code === "too_many",
    );
    await assert.rejects(
      ben.home.sharing.receive({ handle: "gus@gus.example", name: "Gus" }, { kind: "note" }),
      (error) => error instanceof ShareRefused && error.code === "invalid",
    );
  });
});

describe("the tools for sharing", () => {
  let ada: TestHome;
  let ben: TestHome;
  let conversationId: string;
  before(async () => {
    ada = await testHome("Ada");
    ben = await testHome("Ben");
    connect(ada, ben);
    conversationId = ada.home.store.mainAgent().conversationId;
  });
  after(() => {
    ada.stop();
    ben.stop();
  });

  test("publishing asks first, and the password goes to no model", async () => {
    const doc = ada.home.store.createDocument({ title: "Menu", content: "Soup.", conversationId });
    ada.model.script.push(
      {
        calls: [
          { name: "link_publish", arguments: { kind: "document", id: doc.id, lasts: "week" } },
        ],
      },
      { text: "I asked you first." },
    );
    await ada.say("Publish the menu for a week");
    const card = ada.item();
    assert.equal(card.title, "Publish “Menu”?");
    assert.equal(card.fields?.[0]?.type, "secret");
    // The home here has no address others reach, and the card says so.
    assert.match(card.body ?? "", /for a week/);
    assert.match(card.body ?? "", /opens on this computer only/);
    assert.deepEqual(ada.home.sharing.links("document", doc.id), []);

    // What changes after the question is not what the person said yes to.
    ada.home.store.saveDocument(doc.id, { content: "Soup. And a secret.", by: "agent" });
    ada.model.script.push({ text: "It is published." });
    await ada.answer(card.id, "publish", { password: "tulip-42" });
    const [link] = ada.home.sharing.links("document", doc.id);
    assert.equal(link?.password, true);
    assert.equal(link?.version, 1);
    const told = ada.model.requests.at(-1)?.messages.at(-1)?.content ?? "";
    assert.ok(told.includes(link?.url as string));
    assert.match(told, /opens on this computer only/);
    assert.ok(!JSON.stringify(ada.model.requests).includes("tulip-42"));
    assert.equal(ada.home.store.card(card.id)?.answer?.values?.password, "•••");
    const page = await give(link?.url as string, "tulip-42");
    assert.match(await page.text(), /Soup\./);
  });

  test("a no publishes nothing", async () => {
    const doc = ada.home.store.createDocument({
      title: "Draft",
      content: "Not yet.",
      conversationId,
    });
    ada.model.script.push(
      {
        calls: [
          { name: "link_publish", arguments: { kind: "document", id: doc.id, lasts: "always" } },
        ],
      },
      { text: "I asked you first." },
    );
    await ada.say("Publish the draft");
    await ada.answer(ada.item().id, "keep");
    assert.deepEqual(ada.home.sharing.links("document", doc.id), []);
  });

  test("lists the links and takes one back", async () => {
    const doc = ada.home.store.createDocument({
      title: "Rota",
      content: "Mon: Ada.",
      conversationId,
    });
    const link = await ada.home.sharing.publish({ kind: "document", id: doc.id, lasts: "always" });
    ada.model.script.push(
      { calls: [{ name: "link_list", arguments: {} }] },
      { calls: [{ name: "link_take_back", arguments: { linkId: link.id } }] },
      { text: "Taken back." },
    );
    await ada.say("Take the link to the rota back");
    const results = JSON.stringify(ada.model.requests.at(-1)?.messages);
    assert.ok(results.includes(link.url));
    assert.match(results, /until it is taken back/);
    assert.match(results, /opens nothing any more/);
    assert.equal((await open(link.url)).status, 410);
  });

  test("sending asks first", async () => {
    const doc = ada.home.store.createDocument({
      title: "Route",
      content: "Left, then right.",
      conversationId,
    });
    const handle = ben.home.handle() as string;
    ada.model.script.push(
      { calls: [{ name: "contact_send", arguments: { kind: "document", id: doc.id, handle } }] },
      { text: "I asked you first." },
    );
    await ada.say("Send the route to Ben");
    const card = ada.item();
    assert.equal(card.title, "Send “Route” to Ben?");
    assert.equal(card.kind, "approval");
    const benMain = ben.home.store.mainAgent().conversationId;
    assert.ok(!ben.home.store.documents(benMain).some((document) => document.title === "Route"));

    ada.model.script.push({ text: "Sent to Ben." });
    await ada.answer(card.id, "send");
    await ben.home.idle();
    assert.ok(ben.home.store.documents(benMain).some((document) => document.title === "Route"));
    assert.match(ada.model.requests.at(-1)?.messages.at(-1)?.content ?? "", /was sent to Ben/);
  });

  test("an agent shares nothing of another conversation, and sends to contacts only", async () => {
    const other = ada.home.store.createAgent({
      name: "Clerk",
      kind: "drop",
      about: "Files things.",
      instructions: "File things.",
    });
    const theirs = ada.home.store.createDocument({
      title: "Ledger",
      content: "Private.",
      conversationId: other.conversationId,
    });
    const mine = ada.home.store.createDocument({
      title: "Card",
      content: "Hello.",
      conversationId,
    });
    const open = ada.home.store.items().length;
    ada.model.script.push(
      {
        calls: [
          { name: "link_publish", arguments: { kind: "document", id: theirs.id, lasts: "day" } },
        ],
      },
      {
        calls: [
          {
            name: "contact_send",
            arguments: { kind: "document", id: mine.id, handle: "eve@eve.example" },
          },
        ],
      },
      { text: "Neither works." },
    );
    await ada.say("Publish the ledger and send the card to Eve");
    const results = JSON.stringify(ada.model.requests.at(-1)?.messages);
    assert.match(results, /There is no document doc_\w+ in this conversation/);
    assert.match(results, /eve@eve\.example is not a connected contact\. Connected: Ben/);
    assert.equal(ada.home.store.items().length, open);
  });
});
