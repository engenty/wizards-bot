import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { Card } from "@wizards-bot/protocol";
import { cardsAsText, claimCode, pickAction } from "./channels/channels.ts";
import { Events } from "./events.ts";
import { Identity, Secrets } from "./identity.ts";
import { isQuiet } from "./notify/notifier.ts";
import { isHandle, isLocal, urlOf } from "./peers/peers.ts";
import { signer, signRequest, verifyRequest } from "./peers/signature.ts";
import { nextAfter } from "./schedule.ts";
import { Db } from "./store/db.ts";

const card = (patch: Partial<Card> = {}): Card => ({
  id: "crd_1",
  kind: "approval",
  level: "needs_you",
  state: "open",
  title: "Send the invitation?",
  actions: [
    { id: "yes", label: "Send", style: "primary" },
    { id: "no", label: "Don't send", style: "plain" },
  ],
  agentId: "agt_1",
  conversationId: "cnv_1",
  messageId: "msg_1",
  createdAt: "2026-11-21T09:00:00.000Z",
  ...patch,
});

describe("cards on a channel without buttons", () => {
  test("are answered with a number or the button's words", () => {
    assert.match(cardsAsText([card()]), /1: Send {3}2: Don't send\nReply with the number\./);
    assert.equal(pickAction(card(), "2"), "no");
    assert.equal(pickAction(card(), " send. "), "yes");
    assert.equal(pickAction(card(), "3"), undefined);
    assert.equal(pickAction(card(), "send it tomorrow"), undefined);
  });

  test("a card with fields is answered in the app", () => {
    const withField = card({ fields: [{ id: "key", label: "Key", type: "secret" }] });
    assert.match(cardsAsText([withField]), /Answer this one in the wizards.bot app\./);
    assert.equal(pickAction(withField, "1"), undefined);
  });

  test("a claim code is found in a sentence", () => {
    assert.equal(claimCode("claim 4821"), "4821");
    assert.equal(claimCode("Hi, Claim-0042 thanks"), "0042");
    assert.equal(claimCode("I claim nothing"), undefined);
  });
});

describe("requests between homes", () => {
  const dir = mkdtempSync(join(tmpdir(), "wizards-bot-sig-"));
  const ada = new Identity(dir);
  const eve = new Identity(mkdtempSync(join(tmpdir(), "wizards-bot-sig-")));
  const request = {
    from: "ada@a.example",
    to: "ben@b.example",
    method: "POST",
    path: "/peers/share",
    body: '{"x":1}',
  };
  const verify = (
    headers: Record<string, string>,
    patch: Partial<Parameters<typeof verifyRequest>[0]> = {},
  ) =>
    verifyRequest({
      headers: new Headers(headers),
      publicKey: ada.publicKey,
      ...request,
      ...patch,
    });

  test("verify with the sender's key and name the sender", () => {
    const headers = signRequest({ identity: ada, ...request });
    assert.equal(signer(new Headers({ ...headers })), "ada@a.example");
    assert.equal(verify({ ...headers }), true);
  });

  test("fail for another body, path, receiver, key or time", () => {
    const headers = { ...signRequest({ identity: ada, ...request }) };
    assert.equal(verify(headers, { body: '{"x":2}' }), false);
    assert.equal(verify(headers, { path: "/peers/accept" }), false);
    assert.equal(verify(headers, { to: "carl@c.example" }), false);
    assert.equal(verify(headers, { publicKey: eve.publicKey }), false);
    assert.equal(verify(headers, { now: Date.now() + 10 * 60_000 }), false);
    assert.equal(
      verify({ ...headers, "x-wizards-to": "carl@c.example" }, { to: "carl@c.example" }),
      false,
    );
  });

  test("each request has a nonce of its own, and one without is not taken", () => {
    const first = signRequest({ identity: ada, ...request });
    const second = signRequest({ identity: ada, ...request });
    assert.notEqual(first["signature-input"], second["signature-input"]);
    const bare = { ...first };
    bare["signature-input"] = bare["signature-input"].replace(/;nonce="[^"]+"/, "");
    assert.equal(verify(bare), false);
  });

  test("a handle names where its home answers", () => {
    assert.equal(urlOf("anna@anna.example"), "https://anna.example");
    assert.equal(urlOf("ada@127.0.0.1:4747"), "http://127.0.0.1:4747");
    assert.equal(isHandle("anna@anna.example"), true);
    assert.equal(isHandle("anna"), false);
    assert.equal(isHandle("anna@host/path"), false);
    assert.equal(isLocal("x@172.20.0.4:80"), true);
    assert.equal(isLocal("x@[::1]:4747"), true);
    assert.equal(isLocal("x@172.example.com"), false);
  });
});

describe("a scheduled task", () => {
  const monday = new Date(2026, 10, 23, 9, 30); // Monday 23 November 2026, 09:30 local

  test("runs once, then never", () => {
    const at = new Date(2026, 10, 24, 9, 0).toISOString();
    assert.equal(nextAfter({ at }, monday)?.toISOString(), at);
    assert.equal(nextAfter({ at }, new Date(2026, 10, 25)), undefined);
  });

  test("runs daily at its time, today when that is still ahead", () => {
    assert.deepEqual(
      nextAfter({ every: "day", time: "22:00" }, monday),
      new Date(2026, 10, 23, 22, 0),
    );
    assert.deepEqual(
      nextAfter({ every: "day", time: "08:00" }, monday),
      new Date(2026, 10, 24, 8, 0),
    );
  });

  test("skips the weekend on weekdays", () => {
    const friday = new Date(2026, 10, 27, 18, 0);
    assert.deepEqual(
      nextAfter({ every: "weekday", time: "08:00" }, friday),
      new Date(2026, 10, 30, 8, 0),
    );
  });

  test("runs weekly on its weekday and hourly on the hour", () => {
    assert.deepEqual(
      nextAfter({ every: "week", time: "09:00", weekday: 1 }, monday),
      new Date(2026, 10, 30, 9, 0),
    );
    assert.deepEqual(nextAfter({ every: "hour" }, monday), new Date(2026, 10, 23, 10, 0));
  });
});

describe("quiet hours", () => {
  const at = (hour: number) => new Date(Date.UTC(2026, 10, 21, hour));
  test("cover the night across midnight in the device's time zone", () => {
    const quiet = { quiet: { from: 22, to: 7, timezone: "UTC" } };
    assert.equal(isQuiet(quiet, at(23)), true);
    assert.equal(isQuiet(quiet, at(3)), true);
    assert.equal(isQuiet(quiet, at(7)), false);
    assert.equal(isQuiet(quiet, at(12)), false);
    assert.equal(isQuiet({ quiet: { from: 22, to: 7, timezone: "Europe/Vienna" } }, at(21)), true);
    assert.equal(isQuiet({}, at(3)), false);
  });
});

describe("the event log", () => {
  test("replays what a device missed and says when it cannot", () => {
    const events = new Events();
    const ids: number[] = [];
    events.subscribe((stored) => stored.id !== undefined && ids.push(stored.id));
    for (let n = 0; n < 3; n++) events.emit({ type: "agent.removed", agentId: `agt_${n}` });
    events.emit({ type: "message.delta", conversationId: "c", messageId: "m", part: 0, text: "x" });
    assert.equal(ids.length, 3);
    assert.deepEqual(
      events.since(ids[0] as number)?.map((stored) => stored.id),
      ids.slice(1),
    );
    assert.deepEqual(events.since(ids[2] as number), []);
    assert.equal(events.since((ids[0] as number) - 100), undefined);
  });
});

describe("secrets", () => {
  test("are stored encrypted and read back", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "wizards-bot-secret-"));
    const db = new Db(dataDir);
    const secrets = new Secrets(db, dataDir);
    secrets.set("gateway.x", "sk-123");
    const stored = db.get<{ value: Uint8Array }>(
      "select value from secret where name = 'gateway.x'",
    );
    assert.ok(
      !Buffer.from(stored?.value ?? [])
        .toString("latin1")
        .includes("sk-123"),
    );
    assert.equal(new Secrets(db, dataDir).get("gateway.x"), "sk-123");
    secrets.delete("gateway.x");
    assert.equal(secrets.has("gateway.x"), false);
    db.close();
  });
});
