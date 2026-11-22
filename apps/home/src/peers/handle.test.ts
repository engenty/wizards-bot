import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import type { Agent, Message, PersonState } from "@wizards-bot/protocol";
import { type TestHome, testHome, textOf } from "../test/fakes.ts";

/** A person's key as a device holds it. */
function deviceKey(): { key: string; sign(payload: string): string } {
  const pair = generateKeyPairSync("ed25519");
  return {
    key: pair.publicKey.export({ format: "jwk" }).x as string,
    sign: (payload) => sign(null, Buffer.from(payload), pair.privateKey).toString("base64url"),
  };
}
type DeviceKey = ReturnType<typeof deviceKey>;

/** Has a device make the home's first record, or sign what the home proposes. */
async function signOn(t: TestHome, device: DeviceKey): Promise<number> {
  const start = await t.request("/v1/person/start", { body: { key: device.key } });
  if (!start.ok) return start.status;
  const { payload } = (await start.json()) as { payload: string };
  const response = await t.request("/v1/person/records", {
    body: { payload, sig: device.sign(payload) },
  });
  await t.home.idle();
  return response.status;
}

/** A domain of the person's own: a site that is no home and names the home for each name. */
async function domain(): Promise<{
  host: string;
  names: Record<string, string>;
  stop(): void;
}> {
  const names: Record<string, string> = {};
  const server: Server = createServer((request, response) => {
    if (!request.url?.startsWith("/.well-known/wizards.json")) {
      response.statusCode = 404;
      return response.end();
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ names }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    host: `127.0.0.1:${(server.address() as AddressInfo).port}`,
    names,
    stop: () => server.close(),
  };
}

const handle = (t: TestHome): string => t.home.handle() as string;

/** Makes two homes contacts of each other, and has the second remember the first's person. */
async function connect(a: TestHome, b: TestHome): Promise<void> {
  for (const [here, there] of [
    [a, b],
    [b, a],
  ] as const) {
    here.home.db.run(
      "insert into contact (handle, name, url, public_key, state, created_at) values (?, ?, ?, ?, 'connected', ?)",
      handle(there),
      there.home.person(),
      there.url,
      there.home.identity.publicKey,
      new Date().toISOString(),
    );
  }
  assert.ok((await b.home.peers.refreshContact(handle(a)))?.person);
}

async function settle(...homes: TestHome[]): Promise<void> {
  for (let round = 0; round < 4; round++) {
    for (const t of homes) {
      await t.home.peers.rooms.idle();
      await t.home.idle();
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

const roomOf = (t: TestHome): Agent =>
  t.home.store.agents().find((agent) => agent.origin === "room") as Agent;

const lastIn = (t: TestHome, conversationId: string): Message =>
  t.home.store.messages(conversationId, { limit: 1 }).messages[0] as Message;

async function write(t: TestHome, conversationId: string, text: string): Promise<void> {
  await t.request(`/v1/conversations/${conversationId}/messages`, { body: { text } });
}

/** What the last tool call of a home's main agent answered. */
const toolSaid = (t: TestHome): string =>
  [...(t.model.requests.at(-1)?.messages ?? [])]
    .reverse()
    .find((message) => message.role === "tool")?.content ?? "";

describe("a handle on a domain of the person's own", () => {
  let ada: TestHome;
  let ben: TestHome;
  let eve: TestHome;
  let site: Awaited<ReturnType<typeof domain>>;
  let guide: Agent;
  let theirs: Agent;
  let before_: string;
  let mine: string;
  const device = deviceKey();

  before(async () => {
    ada = await testHome("Ada");
    ben = await testHome("Ben");
    eve = await testHome("Eve");
    site = await domain();
    before_ = handle(ada);
    mine = `ada@${site.host}`;
    assert.equal(await signOn(ada, device), 200);
    await connect(ada, ben);
    await connect(ada, eve);

    // Ben is in a room Ada's home keeps.
    ada.model.script.push(
      { calls: [{ name: "room_open", arguments: { name: "Lisbon trip" } }] },
      { text: "Open." },
      { calls: [{ name: "room_invite", arguments: { room: "", handle: handle(ben) } }] },
      { text: "Asked." },
    );
    await ada.say("open a room");
    (ada.model.script[0]?.calls?.[0]?.arguments as { room: string }).room = roomOf(ada).id;
    await ada.say("invite Ben");
    await ada.answer(ada.item().id, "invite");
    await settle(ada, ben);
    await ben.answer(ben.item().id, "join");
    await settle(ada, ben);

    // Eve talks to an agent of Ada's.
    guide = ada.home.store.createAgent({ name: "Guide", kind: "drop", about: "Knows Kraków." });
    ada.home.db.run(
      "insert into share (id, agent_id, handle, mode, created_at) values ('shr_guide', ?, ?, 'talk', ?)",
      guide.id,
      handle(eve),
      new Date().toISOString(),
    );
    theirs = eve.home.store.createAgent({
      name: "Guide",
      kind: "drop",
      about: "Knows Kraków.",
      origin: "shared",
      from: before_,
      remote: `/a2a/agents/${guide.id}`,
    });
  });
  after(() => {
    ada.stop();
    ben.stop();
    eve.stop();
    site.stop();
  });

  test("is refused until the domain names the home, and the agent says what to put there", async () => {
    ada.model.script.push(
      { calls: [{ name: "handle_set", arguments: { handle: mine } }] },
      { text: "The domain does not point here yet." },
    );
    await ada.say("my handle is ada at my domain");
    assert.match(toolSaid(ada), /does not name this Bot Server/);
    assert.ok(toolSaid(ada).includes(`{"names":{"ada":"${ada.url}"}}`));
    assert.equal(handle(ada), before_);
    assert.equal(ada.home.store.items().length, 0);
  });

  test("counts once the person's key signed it, and leads to the home from then on", async () => {
    site.names.ada = ada.url;
    ada.model.script.push(
      { calls: [{ name: "handle_set", arguments: { handle: mine } }] },
      { text: "Sign it." },
    );
    await ada.say("try again");
    const card = ada.item();
    assert.equal(card.title, "Sign your record");
    assert.ok(card.body?.includes(`Your handle becomes ${mine}.`));
    // Asked for is not yet so.
    assert.equal(handle(ada), before_);

    assert.equal(await signOn(ada, device), 200);
    assert.equal(handle(ada), mine);
    const state = (await (await ada.request("/v1/person")).json()) as PersonState;
    assert.equal(state.record?.handle, mine);
    assert.equal(state.proposed, undefined);
    const found = await eve.home.peers.lookup(mine);
    assert.equal(found.url, ada.url);
    assert.equal(found.publicKey, ada.home.identity.publicKey);
    // The old handle leads nowhere any more.
    await assert.rejects(eve.home.peers.lookup(before_), /not/);
  });

  test("a contact in a room hears of it from the room's home and goes on", async () => {
    await settle(ada, ben);
    assert.equal(ben.home.peers.contact(before_), undefined);
    const contact = ben.home.peers.contact(mine);
    assert.equal(contact?.state, "connected");
    assert.equal(contact?.url, ada.url);
    assert.equal(roomOf(ben).from, mine);
    assert.equal(roomOf(ada).from, mine);

    await write(ben, roomOf(ben).conversationId, "Still here.");
    await settle(ada, ben);
    const last = lastIn(ada, roomOf(ada).conversationId);
    assert.equal(textOf(last), "Still here.");
    await write(ada, roomOf(ada).conversationId, "Good.");
    await settle(ada, ben);
    assert.equal(textOf(lastIn(ben, roomOf(ben).conversationId)), "Good.");
    assert.equal(lastIn(ben, roomOf(ben).conversationId).from?.name, "Ada");
  });

  test("a contact that writes to the old handle is led to the new one by the record", async () => {
    assert.equal(eve.home.peers.contact(before_)?.state, "connected");
    ada.model.script.push({ text: "Start at the Rynek." });
    await write(eve, theirs.conversationId, "Where do I start?");
    await settle(ada, eve);
    assert.equal(textOf(lastIn(eve, theirs.conversationId)), "Start at the Rynek.");
    assert.equal(eve.home.peers.contact(before_), undefined);
    assert.equal(eve.home.peers.contact(mine)?.person?.key, device.key);
    assert.equal(eve.home.store.agent(theirs.id)?.from, mine);
  });

  test("a home at a new address is found again once the person signed where it is", async () => {
    const dataDir = ada.home.config.dataDir;
    const old = ada.url;
    ada.stop();
    await new Promise((resolve) => setTimeout(resolve, 150));
    ada = await testHome("Ada", undefined, { dataDir });
    assert.notEqual(ada.url, old);
    // The same home: its key, its handle, its room.
    assert.equal(handle(ada), mine);
    assert.equal(roomOf(ada).from, mine);
    const state = (await (await ada.request("/v1/person")).json()) as PersonState;
    assert.equal(state.proposed?.why, "This Bot Server's address changed.");

    // The domain points to the new address, but the person has not signed it: a contact
    // does not take a domain's word alone for where the home is.
    site.names.ada = ada.url;
    assert.equal(await ben.home.peers.refreshContact(mine), undefined);
    assert.equal(ben.home.peers.contact(mine)?.url, old);

    assert.equal(await signOn(ada, device), 200);
    assert.equal((await ben.home.peers.refreshContact(mine))?.url, ada.url);
    await write(ben, roomOf(ben).conversationId, "Found you.");
    await settle(ada, ben);
    assert.equal(textOf(lastIn(ada, roomOf(ada).conversationId)), "Found you.");
    await write(ada, roomOf(ada).conversationId, "Moved in.");
    await settle(ada, ben);
    assert.equal(textOf(lastIn(ben, roomOf(ben).conversationId)), "Moved in.");
  });
});
