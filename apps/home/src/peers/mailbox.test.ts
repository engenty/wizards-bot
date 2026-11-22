import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { Agent, Card, Message } from "@wizards-bot/protocol";
import { type TestHome, testHome, textOf } from "../test/fakes.ts";
import { signRequest } from "./signature.ts";

/** A person's key as a device holds it. */
function deviceKey(): { key: string; sign(payload: string): string } {
  const pair = generateKeyPairSync("ed25519");
  return {
    key: pair.publicKey.export({ format: "jwk" }).x as string,
    sign: (payload) => sign(null, Buffer.from(payload), pair.privateKey).toString("base64url"),
  };
}

/** Has a device make the home's first record. */
async function makeKey(t: TestHome, device = deviceKey()): Promise<number> {
  const start = await t.request("/v1/person/start", { body: { key: device.key } });
  if (!start.ok) return start.status;
  const { payload } = (await start.json()) as { payload: string };
  const response = await t.request("/v1/person/records", {
    body: { payload, sig: device.sign(payload) },
  });
  await t.home.idle();
  return response.status;
}

/** Waits for the homes to be done, and has the home without an address fetch what is kept for it. */
async function settle(lea: TestHome, ...others: TestHome[]): Promise<void> {
  for (let round = 0; round < 4; round++) {
    for (const t of [lea, ...others]) {
      await t.home.peers.rooms.idle();
      await t.home.idle();
    }
    await lea.home.peers.mailbox.collect();
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

const main = (t: TestHome): string => t.home.store.mainAgent().conversationId;

const toolSaid = (t: TestHome): string =>
  [...(t.model.requests.at(-1)?.messages ?? [])]
    .reverse()
    .find((message) => message.role === "tool")?.content ?? "";

const roomOf = (t: TestHome): Agent =>
  t.home.store.agents().find((agent) => agent.origin === "room") as Agent;

const lines = (t: TestHome): string[] =>
  t.home.store
    .messages(roomOf(t).conversationId, { limit: 50 })
    .messages.filter((message: Message) => message.role !== "note")
    .map((message) => `${message.role === "you" ? "me" : message.from?.name}: ${textOf(message)}`);

async function write(t: TestHome, text: string): Promise<void> {
  await t.request(`/v1/conversations/${roomOf(t).conversationId}/messages`, { body: { text } });
}

/** Has a home's main agent call one tool and answers the card it made. */
async function withCard(
  t: TestHome,
  call: { name: string; arguments: Record<string, unknown> },
  action: string,
): Promise<void> {
  t.model.script.push({ calls: [call] }, { text: "Asked." });
  await t.say("do it");
  await t.answer(t.item().id, action);
}

describe("a home without an address", () => {
  let ada: TestHome;
  let lea: TestHome;
  let link: string;
  before(async () => {
    ada = await testHome("Ada");
    lea = await testHome("Lea", undefined, { unreachable: true });
    ada.model.script.push(
      { calls: [{ name: "room_open", arguments: { name: "Lisbon trip" } }] },
      { text: "Open." },
    );
    await ada.say("open a room");
    await withCard(
      ada,
      { name: "invite_make", arguments: { what: "room", id: roomOf(ada).id } },
      "make",
    );
    link = ada.home.store
      .messages(main(ada), { limit: 6 })
      .messages.flatMap((message) => message.parts)
      .flatMap((part) => (part.type === "card" && part.card.qr ? [part.card.qr] : []))
      .at(-1) as string;
  });
  after(() => {
    ada.stop();
    lea.stop();
  });

  test("is nobody to other homes until its person has a key, then is known by that key", async () => {
    assert.equal(lea.home.handle(), undefined);
    lea.model.script.push(
      { calls: [{ name: "invite_open", arguments: { link } }] },
      { text: "Make your key first." },
    );
    await lea.say("here is a link");
    assert.match(toolSaid(lea), /Make your key first/);

    assert.equal(await makeKey(lea), 200);
    const handle = lea.home.handle() as string;
    assert.match(handle, /^lea@k-[0-9a-f]{20}$/);
    const record = lea.home.peers.person.current();
    assert.equal(record?.handle, handle);
    assert.ok(handle.endsWith(`@k-${record?.id.slice(0, 20)}`));
    // The record names the home without an address, and nothing waits to be signed again.
    assert.deepEqual(record?.homes, [{ key: lea.home.identity.publicKey, receives: true }]);
    assert.equal(lea.home.peers.person.proposed(), undefined);
    // It makes no invites and keeps no room for others: nobody could come to it.
    lea.model.script.push(
      { calls: [{ name: "invite_make", arguments: { what: "connect" } }] },
      { text: "Not from here." },
    );
    await lea.say("make an invite");
    assert.match(toolSaid(lea), /no address others reach/);
  });

  test("joins a room with an invite, and is told by its card who it is", async () => {
    lea.model.script.push(
      { calls: [{ name: "invite_open", arguments: { link } }] },
      { text: "Read." },
    );
    await lea.say("here is the link again");
    const card = lea.item() as Card;
    assert.equal(card.title, "Ada invites you to the room “Lisbon trip”");
    await lea.answer(card.id, "join");
    await settle(lea, ada);

    assert.equal(roomOf(lea).about, "Ada, Lea");
    assert.equal(roomOf(ada).about, "Ada, Lea");
    const contact = ada.home.peers.contact(lea.home.handle() as string);
    assert.equal(contact?.state, "connected");
    assert.equal(contact?.url, "");
    assert.equal(contact?.limited, true);
    assert.equal(contact?.publicKey, lea.home.identity.publicKey);
    assert.equal(contact?.person?.id, lea.home.peers.person.current()?.id);
  });

  test("writes to the room itself and fetches what the others wrote", async () => {
    await write(lea, "Hello from the train.");
    await settle(lea, ada);
    assert.equal(lines(ada).at(-1), "Lea: Hello from the train.");

    await write(ada, "Welcome.");
    await ada.home.peers.rooms.idle();
    // Ada's home cannot call Lea's: it keeps the message until Lea's home asks.
    assert.ok(!lines(lea).includes("Ada: Welcome."));
    assert.ok(ada.home.peers.mailbox.kept(lea.home.handle() as string) > 0);
    await settle(lea, ada);
    assert.equal(lines(lea).at(-1), "Ada: Welcome.");
    // What was fetched is said to be taken with the next asking, and then dropped.
    await lea.home.peers.mailbox.collect();
    assert.equal(ada.home.peers.mailbox.kept(lea.home.handle() as string), 0);
  });

  test("hears at once while it waits for what is kept", async () => {
    const waiting = lea.home.peers.mailbox.collect(10);
    const started = Date.now();
    await write(ada, "Are you there?");
    assert.equal(await waiting, 1);
    assert.ok(Date.now() - started < 5000);
    assert.equal(lines(lea).at(-1), "Ada: Are you there?");
  });

  test("its agent answers the room when it is named", async () => {
    const recipes = lea.home.store.createAgent({
      name: "Recipes",
      kind: "flame",
      about: "Knows where to eat",
    });
    await withCard(
      lea,
      { name: "room_add", arguments: { room: roomOf(lea).id, agentId: recipes.id } },
      "add",
    );
    await settle(lea, ada);
    assert.equal(roomOf(ada).about, "Ada, Lea · Recipes");

    lea.model.script.push({ text: "A tasca on the hill." });
    await write(ada, "@Recipes where do we eat?");
    await settle(lea, ada);
    assert.equal(lines(ada).at(-1), "Recipes: A tasca on the hill.");
    assert.equal(lines(lea).at(-1), "Recipes: A tasca on the hill.");
  });

  test("nobody else takes what is kept for it, and nobody else passes for it", async () => {
    const handle = lea.home.handle() as string;
    await write(ada, "For Lea only.");
    await ada.home.peers.rooms.idle();
    const kept = ada.home.peers.mailbox.kept(handle);
    assert.ok(kept > 0);

    // Another home without an address, with a key of its own, says it is Lea.
    const zoe = await testHome("Lea", undefined, { unreachable: true });
    try {
      await makeKey(zoe);
      const body = JSON.stringify({ after: 0 });
      const forged = Buffer.from(
        JSON.stringify({
          protocol: 1,
          handle,
          name: "Lea",
          publicKey: zoe.home.identity.publicKey,
          person: { log: zoe.home.peers.person.log() },
        }),
      ).toString("base64url");
      const response = await fetch(`${ada.url}/peers/mailbox`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "wizards-card": forged,
          ...signRequest({
            identity: zoe.home.identity,
            from: handle,
            to: ada.home.handle() as string,
            method: "POST",
            path: "/peers/mailbox",
            body,
          }),
        },
        body,
      });
      assert.equal(response.status, 401);
      // Under its own name it is no contact: nothing is kept for it and it gets nothing.
      await assert.rejects(
        zoe.home.peers.post(ada.home.handle() as string, "/peers/mailbox", { after: 0 }),
        /Only a contact's home is heard/,
      );
      assert.equal(ada.home.peers.mailbox.kept(handle), kept);
      assert.equal(ada.home.peers.contact(handle)?.publicKey, lea.home.identity.publicKey);
    } finally {
      zoe.stop();
    }
    await settle(lea, ada);
    assert.equal(lines(lea).at(-1), "Ada: For Lea only.");
  });
});
