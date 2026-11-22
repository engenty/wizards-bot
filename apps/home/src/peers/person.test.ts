import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { after, before, describe, test } from "node:test";
import type { PersonRecord, PersonState, SignedRecord } from "@wizards-bot/protocol";
import { type TestHome, testHome } from "../test/fakes.ts";
import { PERSON_CARD_URL, personId, RecordRefused, readLog } from "./person.ts";

/** A person's key as a device holds it: the public half, and signing with the other. */
function deviceKey(): { key: string; sign(payload: string): string } {
  const pair = generateKeyPairSync("ed25519");
  return {
    key: pair.publicKey.export({ format: "jwk" }).x as string,
    sign: (payload) => sign(null, Buffer.from(payload), pair.privateKey).toString("base64url"),
  };
}
type DeviceKey = ReturnType<typeof deviceKey>;

/** A version of a record as a device signs it. */
function version(
  signer: DeviceKey,
  record: Partial<PersonRecord> & { key: string; seq: number },
): SignedRecord {
  const payload = JSON.stringify({
    v: 1,
    id: personId(record.key),
    name: "Ada",
    homes: [{ url: "https://ada.example", key: "home-key-1", receives: true }],
    at: new Date().toISOString(),
    ...record,
  });
  return { payload, sig: signer.sign(payload) };
}

/** Has a device make the home's first record, or sign what the home proposes. */
async function signOn(t: TestHome, device: DeviceKey): Promise<Response> {
  const start = await t.request("/v1/person/start", { body: { key: device.key } });
  if (!start.ok) return start;
  const { payload } = (await start.json()) as { payload: string };
  const response = await t.request("/v1/person/records", {
    body: { payload, sig: device.sign(payload) },
  });
  // The card that asked is answered, and the agent says so.
  await t.home.idle();
  return response;
}

const state = async (t: TestHome): Promise<PersonState> =>
  (await (await t.request("/v1/person")).json()) as PersonState;

const handle = (t: TestHome): string => t.home.handle() as string;

/** Makes two homes contacts of each other, as after a request one of them approved. */
function connect(a: TestHome, b: TestHome): void {
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
}

describe("a person's record", () => {
  const first = deviceKey();
  const second = deviceKey();
  const id = personId(first.key);

  test("seen for the first time holds when it is signed with its own key", () => {
    const read = readLog([version(first, { key: first.key, seq: 10 })]);
    assert.deepEqual(read?.pin, { id, key: first.key, seq: 10 });
    assert.throws(() => readLog([version(second, { key: first.key, seq: 10 })]), RecordRefused);
    assert.equal(readLog([]), undefined);
  });

  test("later holds only when the key a home remembers signed it", () => {
    const pin = { id, key: first.key, seq: 10 };
    const newer = version(first, { key: first.key, seq: 20, name: "Ada L." });
    assert.equal(readLog([newer], pin)?.record.name, "Ada L.");
    assert.equal(readLog([newer], pin)?.pin.seq, 20);
    // Someone else's key, and someone else's record under a key that would verify.
    assert.throws(
      () => readLog([version(second, { key: second.key, seq: 20 })], pin),
      RecordRefused,
    );
    assert.throws(
      () => readLog([version(first, { key: first.key, seq: 20, id: "another" })], pin),
      RecordRefused,
    );
    // Nothing newer than what is remembered: the pin stays as it is.
    assert.equal(readLog([version(first, { key: first.key, seq: 5 })], pin), undefined);
  });

  test("names a new key with the old one, and a home that missed that step is not fooled", () => {
    const pin = { id, key: first.key, seq: 10 };
    const turn = version(first, { id, key: second.key, seq: 20 });
    const after = version(second, { id, key: second.key, seq: 30 });
    assert.deepEqual(readLog([turn, after], pin)?.pin, { id, key: second.key, seq: 30 });
    assert.throws(() => readLog([after], pin), RecordRefused);
  });
});

describe("a home and its person's key", () => {
  let t: TestHome;
  const device = deviceKey();
  before(async () => {
    t = await testHome("Ada");
  });
  after(() => t.stop());

  test("the key is made on a device: the home asks with a card and keeps only the record", async () => {
    assert.deepEqual(await state(t), {});
    t.model.script.push({ calls: [{ name: "person_key", arguments: {} }] }, { text: "Asked." });
    await t.say("make my key");
    const card = t.item();
    assert.equal(card.title, "Make your key");
    assert.equal(card.url, PERSON_CARD_URL);

    assert.equal((await signOn(t, device)).status, 200);
    const { record, proposed } = await state(t);
    assert.equal(record?.id, personId(device.key));
    assert.equal(record?.key, device.key);
    assert.equal(record?.name, "Ada");
    assert.equal(record?.handle, handle(t));
    assert.deepEqual(record?.homes, [
      { url: t.url, key: t.home.identity.publicKey, receives: true },
    ]);
    assert.equal(proposed, undefined);
    // The card is done, and the home shows the record to other homes.
    assert.equal(t.home.store.card(card.id)?.state, "answered");
    const shown = (await (await fetch(`${t.url}/.well-known/wizards.json`)).json()) as {
      person?: { log: SignedRecord[] };
    };
    assert.equal(readLog(shown.person?.log ?? [])?.pin.id, personId(device.key));
    // Nothing of the key's other half is in the home.
    const kept = JSON.stringify(t.home.db.all("select * from person_record"));
    assert.ok(kept.includes(device.key));
  });

  test("a version is taken only when the person's key signed it and it names this home", async () => {
    const other = deviceKey();
    assert.equal((await signOn(t, other)).status, 409);
    const { record } = await state(t);
    const forged = version(other, { ...(record as PersonRecord), seq: Date.now() + 1000 });
    assert.equal((await t.request("/v1/person/records", { body: forged })).status, 400);
    const elsewhere = version(device, {
      ...(record as PersonRecord),
      seq: Date.now() + 1000,
      homes: [{ url: "https://else.example", key: "another-home", receives: true }],
    });
    assert.equal((await t.request("/v1/person/records", { body: elsewhere })).status, 400);
    const old = version(device, { ...(record as PersonRecord), seq: 1 });
    assert.equal((await t.request("/v1/person/records", { body: old })).status, 400);
    assert.equal((await state(t)).record?.seq, record?.seq);
  });

  test("what changed is proposed as a new version, and signing it settles it", async () => {
    t.home.db.setMeta("person.name", "Ada Lovelace");
    const { proposed } = await state(t);
    assert.equal(proposed?.why, "Your name changed.");
    t.model.script.push({ calls: [{ name: "person_key", arguments: {} }] }, { text: "Asked." });
    await t.say("anything to sign?");
    assert.equal(t.item().title, "Sign your record");
    assert.equal((await signOn(t, device)).status, 200);
    const after = await state(t);
    assert.equal(after.record?.name, "Ada Lovelace");
    assert.equal(after.proposed, undefined);
    assert.equal(t.home.peers.person.log().length, 2);
    t.home.db.setMeta("person.name", "Ada");
  });
});

describe("a contact's person", () => {
  let ada: TestHome;
  let ben: TestHome;
  const device = deviceKey();
  before(async () => {
    ada = await testHome("Ada");
    ben = await testHome("Ben");
    await signOn(ada, device);
    connect(ada, ben);
  });
  after(() => {
    ada.stop();
    ben.stop();
  });

  test("is remembered from the record the home this home knows shows", async () => {
    const contact = await ben.home.peers.refreshContact(handle(ada));
    assert.equal(contact?.person?.id, personId(device.key));
    assert.equal(contact?.person?.key, device.key);
    // A home without a record is a contact as before.
    assert.equal(await ada.home.peers.refreshContact(handle(ben)), undefined);
    assert.equal(ada.home.peers.contact(handle(ben))?.person, undefined);
  });

  test("a new home at the address is heard once the person's key vouches for it, not before", async () => {
    const port = Number(new URL(ada.url).port);
    const oldKey = ada.home.identity.publicKey;
    ada.stop();
    await new Promise((resolve) => setTimeout(resolve, 150));
    // The home is lost. A new one takes its place: another key, the same address.
    ada = await testHome("Ada", undefined, { port });
    assert.notEqual(ada.home.identity.publicKey, oldKey);
    ada.home.db.run(
      "insert into contact (handle, name, url, public_key, state, created_at) values (?, 'Ben', ?, ?, 'connected', ?)",
      handle(ben),
      ben.url,
      ben.home.identity.publicKey,
      new Date().toISOString(),
    );
    const knock = () =>
      ada.home.peers
        .post(handle(ben), "/peers/unshare", { agent: "agt_none" })
        .then((response) => response.status)
        .catch((error: Error) => error.message);

    // No record: whoever sits at the address is not Ada to Ben's home.
    assert.equal(await knock(), "Only a connected home is heard.");
    // A record made with another key is another person.
    const impostor = deviceKey();
    await signOn(ada, impostor);
    assert.notEqual(await knock(), 200);
    assert.equal(ben.home.peers.contact(handle(ada))?.publicKey, oldKey);

    // The person brings their key back and signs a record that names the new home.
    ada.home.db.run("delete from person_record");
    assert.equal((await signOn(ada, device)).status, 200);
    assert.equal(await knock(), 200);
    const contact = ben.home.peers.contact(handle(ada));
    assert.equal(contact?.publicKey, ada.home.identity.publicKey);
    assert.equal(contact?.person?.id, personId(device.key));
    // The lost home's key is no longer taken.
    assert.notEqual(contact?.publicKey, oldKey);
  });
});
