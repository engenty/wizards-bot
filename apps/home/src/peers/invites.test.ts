import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { Agent, Card, Message } from "@wizards-bot/protocol";
import { type TestHome, testHome, textOf } from "../test/fakes.ts";
import { keyPrint } from "./invites.ts";
import { signRequest } from "./signature.ts";

/** Waits until no home has a turn running or anything on its way to another home. */
async function settle(...homes: TestHome[]): Promise<void> {
  for (let round = 0; round < 4; round++) {
    for (const t of homes) {
      await t.home.peers.rooms.idle();
      await t.home.idle();
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

const main = (t: TestHome): string => t.home.store.mainAgent().conversationId;

/** What the last tool call of a home's main agent answered. */
const toolSaid = (t: TestHome): string =>
  [...(t.model.requests.at(-1)?.messages ?? [])]
    .reverse()
    .find((message) => message.role === "tool")?.content ?? "";

/** Has the person make an invite and returns the card that shows it. */
async function invite(t: TestHome, what: "connect" | "agent" | "room", id?: string): Promise<Card> {
  t.model.script.push(
    { calls: [{ name: "invite_make", arguments: { what, id } }] },
    { text: "Asked." },
  );
  await t.say("make an invite");
  await t.answer(t.item().id, "make");
  const cards = t.home.store
    .messages(main(t), { limit: 6 })
    .messages.flatMap((message) => message.parts)
    .flatMap((part) => (part.type === "card" && part.card.qr ? [part.card] : []));
  return cards.at(-1) as Card;
}

/** Gives a link to a home's agent. Returns the card that asks, when the link was taken. */
async function open(t: TestHome, link: string): Promise<Card | undefined> {
  const before = t.home.store.items().length;
  t.model.script.push({ calls: [{ name: "invite_open", arguments: { link } }] }, { text: "Read." });
  await t.say("here is a link");
  return t.home.store.items().length > before ? t.item() : undefined;
}

function signed(from: TestHome, to: TestHome, path: string, body: unknown): Promise<Response> {
  const text = JSON.stringify(body);
  return fetch(`${to.url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...signRequest({
        identity: from.home.identity,
        from: from.home.handle() as string,
        to: to.home.handle() as string,
        method: "POST",
        path,
        body: text,
      }),
    },
    body: text,
  });
}

const handle = (t: TestHome): string => t.home.handle() as string;

describe("an invite", () => {
  let ada: TestHome;
  let ben: TestHome;
  let eve: TestHome;
  let travel: Agent;
  before(async () => {
    ada = await testHome("Ada");
    ben = await testHome("Ben");
    eve = await testHome("Eve");
    travel = ada.home.store.createAgent({
      name: "Travel",
      kind: "drop",
      about: "Plans trips.",
      instructions: "You plan trips.",
    });
  });
  after(() => {
    ada.stop();
    ben.stop();
    eve.stop();
  });

  test("is a link with a QR code that names the home, a code and the print of its key", async () => {
    const card = await invite(ada, "connect");
    assert.equal(card.title, "Invite to connect");
    assert.equal(card.actions.length, 0);
    const link = card.qr as string;
    assert.match(link, new RegExp(`^${ada.url}/i/[a-z0-9]{32}#k=[0-9a-f]{16}$`));
    assert.ok(link.endsWith(`#k=${keyPrint(ada.home.identity.publicKey)}`));
    assert.ok(card.body?.includes(link));
    assert.match(card.body ?? "", /works once/);
  });

  test("to connect makes two homes contacts after the one who got it said yes, once", async () => {
    const link = (await invite(ada, "connect")).qr as string;
    const card = await open(ben, link);
    assert.equal(card?.title, "Ada invites you to connect");
    assert.match(card?.body ?? "", /it is the Bot Server the link was made by/);
    // Reading an invite connects nobody.
    assert.equal(ada.home.peers.contact(handle(ben)), undefined);

    await ben.answer((card as Card).id, "join");
    await settle(ada, ben);
    for (const [here, there] of [
      [ada, ben],
      [ben, ada],
    ] as const) {
      const contact = here.home.peers.contact(handle(there));
      assert.equal(contact?.state, "connected");
      assert.equal(contact?.limited, false);
      assert.equal(contact?.publicKey, there.home.identity.publicKey);
    }

    assert.equal(await open(eve, link), undefined);
    assert.match(toolSaid(eve), /does not work any more/);
    assert.equal(ada.home.peers.contact(handle(eve)), undefined);
  });

  test("to one agent lets the other talk to it, and connects the homes for that only", async () => {
    const link = (await invite(ada, "agent", travel.id)).qr as string;
    const card = await open(eve, link);
    assert.equal(card?.title, "Ada invites you to Travel");
    assert.match(card?.body ?? "", /Plans trips\./);
    assert.match(
      card?.body ?? "",
      /Ada's devices do not show it to them, but they run that Bot Server/,
    );
    await eve.answer((card as Card).id, "join");
    await settle(ada, eve);

    const shared = eve.home.store.agents().find((agent) => agent.origin === "shared");
    assert.equal(shared?.name, "Travel");
    assert.equal(shared?.from, handle(ada));
    assert.equal(ada.home.peers.contact(handle(eve))?.limited, true);
    // Whoever joins by invite hears nothing of what the agent remembers, unless it was said.
    assert.equal(
      ada.home.db.get<{ memory: string }>("select memory from share where agent_id = ?", travel.id)
        ?.memory,
      "none",
    );
    assert.equal(eve.home.peers.contact(handle(ada))?.limited, true);

    ada.model.script.push({ text: "Take the night train." });
    await eve.request(`/v1/conversations/${shared?.conversationId}/messages`, {
      body: { text: "How do I get to Lisbon?" },
    });
    await settle(ada, eve);
    const reply = eve.home.store.messages(shared?.conversationId as string, { limit: 1 })
      .messages[0] as Message;
    assert.equal(textOf(reply), "Take the night train.");

    // Joined for that only: no documents, no offers, and not among the contacts to send to.
    const send = await signed(eve, ada, "/peers/send", {
      kind: "document",
      title: "Spam",
      content: "Hello",
    });
    assert.equal(send.status, 401);
    const share = await signed(eve, ada, "/peers/share", {
      mode: "talk",
      agent: { id: "agt_x", name: "X", kind: "drop", about: "" },
    });
    assert.equal(share.status, 401);
    const contacts = (await (await ada.request("/v1/contacts")).json()) as {
      contacts: { handle: string }[];
    };
    assert.ok(!contacts.contacts.some((contact) => contact.handle === handle(eve)));
    // The first agent of a home is never invited to.
    ada.model.script.push(
      {
        calls: [
          {
            name: "invite_make",
            arguments: { what: "agent", id: ada.home.store.mainAgent().id },
          },
        ],
      },
      { text: "No." },
    );
    await ada.say("invite to yourself");
    assert.match(toolSaid(ada), /yours alone/);
  });

  test("to a room takes the other into it, and what is written there reaches both", async () => {
    ada.model.script.push(
      { calls: [{ name: "room_open", arguments: { name: "Lisbon trip" } }] },
      { text: "Open." },
    );
    await ada.say("open a room");
    const room = ada.home.store.agents().find((agent) => agent.origin === "room") as Agent;
    const link = (await invite(ada, "room", room.id)).qr as string;
    const card = await open(eve, link);
    assert.equal(card?.title, "Ada invites you to the room “Lisbon trip”");
    await eve.answer((card as Card).id, "join");
    await settle(ada, eve);

    const theirs = eve.home.store.agents().find((agent) => agent.origin === "room") as Agent;
    assert.equal(theirs.about, "Ada, Eve");
    assert.equal(ada.home.store.agent(room.id)?.about, "Ada, Eve");
    await eve.request(`/v1/conversations/${theirs.conversationId}/messages`, {
      body: { text: "Hello from Eve." },
    });
    await settle(ada, eve);
    const last = ada.home.store.messages(room.conversationId, { limit: 1 }).messages[0] as Message;
    assert.equal(textOf(last), "Hello from Eve.");
    assert.equal(last.from?.name, "Eve");
  });

  test("a contact by invite becomes one like any other when both say so", async () => {
    eve.model.script.push(
      { calls: [{ name: "contact_connect", arguments: { handle: handle(ada) } }] },
      { text: "Asked Ada." },
    );
    await eve.say("connect me with Ada");
    await settle(ada, eve);
    assert.equal(eve.home.peers.contact(handle(ada))?.limited, true);
    const card = ada.item();
    assert.equal(card.title, "Eve wants to connect");
    await ada.answer(card.id, "connect");
    await settle(ada, eve);
    assert.equal(ada.home.peers.contact(handle(eve))?.limited, false);
    assert.equal(eve.home.peers.contact(handle(ada))?.limited, false);
    // What was joined before stays.
    assert.ok(eve.home.store.agents().some((agent) => agent.origin === "shared"));
  });

  test("is refused when the home behind the address is not the one the link was made by", async () => {
    const link = (await invite(ada, "connect")).qr as string;
    const forged = link.replace(/#k=.*/, "#k=0123456789abcdef");
    const fresh = await testHome("Zoe");
    try {
      assert.equal(await open(fresh, forged), undefined);
      assert.match(toolSaid(fresh), /its key is another/);
      assert.equal(await open(fresh, "https://example.com/not-an-invite"), undefined);
      assert.match(toolSaid(fresh), /not an invite link/);
    } finally {
      fresh.stop();
    }
  });

  test("is opened by a device as by the agent, without a turn of the agent", async () => {
    const link = (await invite(ada, "connect")).qr as string;
    const fresh = await testHome("Zoe");
    try {
      const asked = fresh.model.requests.length;
      const other = await fresh.request("/v1/invites/open", {
        body: { link: "https://example.com/not-an-invite" },
      });
      assert.deepEqual(await other.json(), {
        opened: false,
        message: "That is not an invite link.",
      });
      const opened = await fresh.request("/v1/invites/open", { body: { link } });
      assert.deepEqual(await opened.json(), { opened: true });
      assert.equal(fresh.model.requests.length, asked);
      // The card that asks stands in the main agent's conversation.
      const card = fresh.item();
      assert.equal(card.title, "Ada invites you to connect");
      assert.match(card.body ?? "", /it is the Bot Server the link was made by/);
      const newest = fresh.home.store.messages(main(fresh), { limit: 1 }).messages[0];
      assert.ok(newest?.parts.some((part) => part.type === "card" && part.card.id === card.id));
      assert.equal(ada.home.peers.contact(handle(fresh)), undefined);

      await fresh.answer(card.id, "join");
      await settle(ada, fresh);
      assert.equal(fresh.home.peers.contact(handle(ada))?.state, "connected");
      assert.equal(ada.home.peers.contact(handle(fresh))?.state, "connected");
      // Only a paired device asks.
      const stranger = await fetch(`${fresh.url}/v1/invites/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ link }),
      });
      assert.equal(stranger.status, 401);
    } finally {
      fresh.stop();
    }
  });

  test("stops working when it is taken back or its time is over, and its page says only that", async () => {
    const card = await invite(ada, "agent", travel.id);
    const link = card.qr as string;
    const page = await fetch(link, { headers: { "accept-language": "en" } });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Ada invites you to Travel/);
    assert.match(html, /Give this link to your agent/);
    // On a phone the page hands the link to the app.
    assert.ok(html.includes(`href="wizardsbot://invite?link=${encodeURIComponent(link)}"`));
    assert.ok(!html.includes("<script"));
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);

    const row = ada.home.db.get<{ id: string }>(
      "select id from invite where code = ?",
      /\/i\/([a-z0-9]+)/.exec(link)?.[1] ?? "",
    );
    ada.model.script.push(
      { calls: [{ name: "invite_take_back", arguments: { id: row?.id } }] },
      { text: "Taken back." },
    );
    await ada.say("take it back");
    assert.equal((await fetch(link)).status, 410);
    const fresh = await testHome("Zoe");
    try {
      assert.equal(await open(fresh, link), undefined);
      assert.match(toolSaid(fresh), /does not work any more/);

      const late = (await invite(ada, "connect")).qr as string;
      ada.home.db.run(
        "update invite set expires_at = ? where code = ?",
        new Date(Date.now() - 1000).toISOString(),
        /\/i\/([a-z0-9]+)/.exec(late)?.[1] ?? "",
      );
      assert.equal((await fetch(late)).status, 410);
      assert.equal(await open(fresh, late), undefined);
      const unknown = await fetch(`${ada.url}/i/${"0".repeat(32)}`);
      assert.equal(unknown.status, 404);
      // A used code does not make a contact, whoever signs.
      const accept = await signed(fresh, ada, "/peers/invite/accept", {
        code: /\/i\/([a-z0-9]+)/.exec(late)?.[1],
      });
      assert.equal(accept.status, 410);
      assert.equal(ada.home.peers.contact(handle(fresh)), undefined);
    } finally {
      fresh.stop();
    }
  });
});
