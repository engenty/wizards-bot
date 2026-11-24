import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createPublicKey, verify } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Setup } from "@wizards-bot/protocol";
import { type TestHome, testHome } from "../test/fakes.ts";
import { ensureFrpc, FrpcMissing, frpcConfig, readFrpcLine } from "./frpc.ts";
import {
  base32,
  claimBody,
  claimKey,
  claimText,
  csrFor,
  labelOf,
  makeKey,
  nameOf,
  needsRenewal,
  publicKeyOf,
} from "./keys.ts";
import { Relay } from "./relay.ts";

/** A self-signed certificate for the test name, valid until 2126. */
const CERT = `-----BEGIN CERTIFICATE-----
MIIBejCCASCgAwIBAgIUSfqRW3VmPX5Qox9LyqrGusrtdfwwCgYIKoZIzj0EAwIw
IjEgMB4GA1UEAwwXbW1nNDJrbGd5cS53aXphcmRzLmhvc3QwIBcNMjYxMTI0MDA0
NjUwWhgPMjEyNjEwMzEwMDQ2NTBaMCIxIDAeBgNVBAMMF21tZzQya2xneXEud2l6
YXJkcy5ob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEWWnZEwEl4Rb2AXC9
lZO0UkmclY/cPNEQ7qzAVqUvpxsk37kjhWAUW4SUqU7sTigxoYXBgAH+iDpyL+Pz
76DJ2KMyMDAwHQYDVR0OBBYEFFACEjVwJ4lKZQMceYNgoyOAk54/MA8GA1UdEwEB
/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIhAKnCKIvz2V3b+dD9Ut5jQcfeRrCw
qwtk83i7xrlGl4GLAiBl1MEuKdmxMgrwYuW7STqKSmz8IWOfBn08vFBl0H5J4A==
-----END CERTIFICATE-----
`;

/** The relay of wizards.host as the home meets it: claim, certificate order, its answer. */
class FakeRelay {
  claims = 0;
  orders = 0;
  /** What the claim answers instead of a name: a status and the relay's error. */
  refuse: { status: number; body: unknown } | undefined;
  /** The key a claim gives; the relay knows only the newest. */
  private keys = 0;
  readonly bodies: Record<string, unknown>[] = [];

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const bearer = new Headers(init?.headers).get("authorization");
    if (url.pathname === "/v1/tunnels/claim" && init?.method === "POST") {
      this.claims++;
      this.bodies.push(body);
      if (this.refuse) return json(this.refuse.status, this.refuse.body);
      const publicKey = String(body.publicKey);
      const signed = verify(
        null,
        Buffer.from(claimText(publicKey, Number(body.timestamp))),
        createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKey }, format: "jwk" }),
        Buffer.from(String(body.signature), "base64url"),
      );
      if (!signed)
        return json(400, { error: "The signature is not valid.", code: "bad_signature" });
      this.keys++;
      return json(200, {
        key: `wbn_${this.keys}`,
        name: `${labelOf(Buffer.from(publicKey, "base64url"))}.wizards.host`,
        server: "wizards.host",
        serverPort: 443,
      });
    }
    if (bearer !== `Bearer wbn_${this.keys}`) {
      return json(401, { error: "Unknown key.", code: "unauthorized" });
    }
    if (url.pathname === "/v1/tunnels/cert" && init?.method === "POST") {
      this.orders++;
      assert.match(String(body.csr), /BEGIN CERTIFICATE REQUEST/);
      return json(202, { id: "order_1", state: "pending" });
    }
    if (url.pathname === "/v1/tunnels/cert/order_1") {
      return json(200, { state: "ready", cert: CERT, notAfter: "2126-10-31T00:46:50Z" });
    }
    return json(404, { error: "Not here.", code: "unknown" });
  };
}

/** An frpc that says what frpc says, and counts its starts in `<dir>/starts`. */
function fakeFrpc(dir: string, lines: string[], exitAfter?: number): string {
  const file = join(dir, "frpc");
  writeFileSync(
    file,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(join(dir, "starts"))}, process.argv.slice(2).join(" ") + "\\n");
for (const line of ${JSON.stringify(lines)}) console.log(line);
${exitAfter === undefined ? "setInterval(() => {}, 1000);" : `setTimeout(() => process.exit(${exitAfter}), 50);`}
`,
  );
  chmodSync(file, 0o755);
  return file;
}

const starts = (dir: string) =>
  existsSync(join(dir, "starts"))
    ? readFileSync(join(dir, "starts"), "utf8").trim().split("\n").length
    : 0;

const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("waited too long");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe("the claim key and its name", () => {
  test("the name is base32 of sha256 of the raw public key, as the relay makes it", () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => i);
    assert.equal(labelOf(bytes), "mmg42klgyq");
    assert.equal(base32(Buffer.from("foobar")), "mzxw6ytboi");
  });

  test("the key is made once, kept for the computer's account only, and signs the claim", () => {
    const dir = mkdtempSync(join(tmpdir(), "wizards-bot-claim-"));
    const file = join(dir, "claim.pem");
    const key = claimKey(file);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(publicKeyOf(claimKey(file)), publicKeyOf(key));
    assert.match(nameOf(key), /^[a-z2-7]{10}\.wizards\.host$/);
    const body = claimBody(key, 1_700_000_000_000);
    assert.equal(Buffer.from(body.publicKey, "base64url").length, 32);
    assert.ok(
      verify(
        null,
        Buffer.from(`wizards.host claim ${body.publicKey} 1700000000000`),
        createPublicKey(key),
        Buffer.from(body.signature, "base64url"),
      ),
    );
  });

  test("the certificate request names the one name and is signed", (t) => {
    const name = "mmg42klgyq.wizards.host";
    const csr = csrFor(name, makeKey());
    let text: string;
    try {
      text = execFileSync("openssl", ["req", "-noout", "-verify", "-text"], {
        input: csr,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return t.skip("no openssl");
      throw error;
    }
    assert.match(text, /CN\s*=\s*mmg42klgyq\.wizards\.host/);
    assert.match(text, /DNS:mmg42klgyq\.wizards\.host/);
  });

  test("a certificate is renewed when it is missing or ends within 30 days", () => {
    assert.equal(needsRenewal(undefined), true);
    assert.equal(needsRenewal("not a certificate"), true);
    assert.equal(needsRenewal(CERT), false);
    assert.equal(needsRenewal(CERT, Date.parse("2126-10-15T00:00:00Z")), true);
  });
});

describe("frpc", () => {
  test("its settings: one https proxy for the name, TLS ended here, the home on 127.0.0.1", () => {
    const text = frpcConfig({
      name: "mmg42klgyq.wizards.host",
      key: "wbn_1",
      server: "wizards.host",
      serverPort: 443,
      port: 4747,
      adminPort: 7400,
      adminPassword: "secret",
      certFile: "/data/tunnel/cert.pem",
      keyFile: "/data/tunnel/key.pem",
    });
    assert.match(text, /transport\.protocol = "wss"/);
    assert.match(text, /metadatas\.token = "wbn_1"/);
    assert.match(text, /customDomains = \["mmg42klgyq\.wizards\.host"\]/);
    assert.match(text, /type = "https2http"/);
    assert.match(text, /localAddr = "127\.0\.0\.1:4747"/);
    assert.doesNotMatch(text, /hostHeaderRewrite|auth\.token|^user/m);
  });

  test("its log says when the proxy is up, refused, or connecting", () => {
    assert.deepEqual(
      readFrpcLine(
        "2026-11-24 10:00:00.000 [I] [client/control.go:168] [ab] [x] start proxy success",
      ),
      { state: "on" },
    );
    assert.deepEqual(
      readFrpcLine("[W] [client/control.go:170] [x] start error: proxy [x] already exists"),
      {
        state: "refused",
        reason: "proxy [x] already exists",
      },
    );
    assert.equal(readFrpcLine("\u001b[1;34m[I] login to server success\u001b[0m"), undefined);
    assert.equal(readFrpcLine("[W] login to the server failed: i/o timeout")?.state, "starting");
  });

  test("a download that is not the one frp published is not kept", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wizards-bot-frpc-"));
    const fetcher: typeof fetch = async () => new Response("not frpc");
    await assert.rejects(ensureFrpc(dir, fetcher), FrpcMissing);
    assert.equal(existsSync(join(dir, "frp", "0.72.0", "frpc")), false);
  });
});

describe("the address at wizards.host", () => {
  let t: TestHome;
  let relay: FakeRelay;
  let tools: string;

  const setup = async (): Promise<Setup> => (await (await t.request("/v1/setup")).json()) as Setup;
  const switchTo = async (on: boolean): Promise<Setup> => {
    const response = await t.request("/v1/setup/address", { body: { on } });
    assert.equal(response.status, 200);
    return (await response.json()) as Setup;
  };

  before(async () => {
    tools = mkdtempSync(join(tmpdir(), "wizards-bot-fake-frpc-"));
    t = await testHome("Ada", undefined, {
      unreachable: true,
      config: {
        frpc: fakeFrpc(tools, ["[I] [client/control.go:168] [ab] [x] start proxy success"]),
      },
    });
    relay = new FakeRelay();
    t.home.tunnel.relay = new Relay("https://relay.test", relay.fetch);
  });

  after(() => t.stop());

  test("it is off until the person switches it on, and nothing runs meanwhile", async () => {
    const view = await setup();
    assert.deepEqual(view.address, { on: false, state: "off" });
    assert.equal(existsSync(t.home.tunnel.dir), false);
    assert.equal(starts(tools), 0);
    assert.equal(relay.claims, 0);
  });

  test("switched on, it claims the name, gets a certificate and runs frpc", async () => {
    const view = await switchTo(true);
    assert.equal(view.address?.on, true);
    assert.equal(await t.home.tunnel.settled(5000), "on");
    const { address } = await setup();
    const name = nameOf(claimKey(join(t.home.tunnel.dir, "claim.pem")));
    assert.deepEqual(address, { on: true, state: "on", name });
    assert.equal(relay.claims, 1);
    assert.equal(relay.orders, 1);
    assert.equal(relay.bodies[0]?.computer, undefined);
    for (const file of ["claim.pem", "tunnel.json", "key.pem", "frpc.toml"]) {
      assert.equal(statSync(join(t.home.tunnel.dir, file)).mode & 0o777, 0o600, file);
    }
    assert.match(readFileSync(join(t.home.tunnel.dir, "frpc.toml"), "utf8"), new RegExp(name));
    assert.equal(t.home.address(), `https://${name}`);
    const pairing = (await (await t.request("/v1/setup/pairing", { body: {} })).json()) as {
      address: string;
      link: string;
    };
    assert.equal(pairing.address, `https://${name}`);
    assert.ok(pairing.link.includes(encodeURIComponent(`https://${name}`)));
  });

  test("switched off, frpc stops and the name stays; on again, the same name without a claim", async () => {
    const name = (await setup()).address?.name;
    const view = await switchTo(false);
    assert.deepEqual(view.address, { on: false, state: "off", name });
    assert.doesNotMatch(t.home.address(), /wizards\.host/);
    const before = starts(tools);
    await switchTo(true);
    assert.equal(await t.home.tunnel.settled(5000), "on");
    assert.equal((await setup()).address?.name, name);
    assert.equal(relay.claims, 1);
    assert.equal(starts(tools), before + 1);
  });

  test("the relay's no is shown as it said it", async () => {
    await switchTo(false);
    const fresh = await testHome("Bo", undefined, {
      unreachable: true,
      config: { frpc: join(tools, "frpc") },
    });
    const refusing = new FakeRelay();
    refusing.refuse = {
      status: 429,
      body: { error: "Too many new names from here today.", code: "too_many" },
    };
    fresh.home.tunnel.relay = new Relay("https://relay.test", refusing.fetch);
    try {
      await fresh.request("/v1/setup/address", { body: { on: true } });
      assert.equal(await fresh.home.tunnel.settled(5000), "refused");
      const view = (await (await fresh.request("/v1/setup")).json()) as Setup;
      assert.equal(view.address?.state, "refused");
      assert.equal(view.address?.reason, "Too many new names from here today.");
      assert.match(fresh.home.address(), /^http:\/\//);
    } finally {
      fresh.stop();
    }
  });

  test("frpc that ends is started again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wizards-bot-fake-frpc-"));
    const ending = await testHome("Cy", undefined, {
      unreachable: true,
      config: { frpc: fakeFrpc(dir, ["[W] login to the server failed: i/o timeout"], 1) },
    });
    ending.home.tunnel.relay = new Relay("https://relay.test", new FakeRelay().fetch);
    try {
      await ending.request("/v1/setup/address", { body: { on: true } });
      await until(() => starts(dir) >= 2);
      const view = (await (await ending.request("/v1/setup")).json()) as Setup;
      assert.equal(view.address?.state, "starting");
      assert.ok(view.address?.reason);
    } finally {
      ending.stop();
    }
  });

  test("the main agent switches it on only after the person said yes", async () => {
    t.model.script.push({ calls: [{ name: "address_switch", arguments: { on: true } }] });
    await t.say("Make my Bot Server reachable away from home.");
    assert.equal((await setup()).address?.on, false);
    const card = t.item();
    assert.match(card.body ?? "", /wizards\.host/);
    t.model.script.push({ text: "It is on." });
    await t.answer(card.id, "on");
    assert.equal(await t.home.tunnel.settled(5000), "on");
    assert.equal((await setup()).address?.state, "on");

    t.model.script.push(
      { calls: [{ name: "address_switch", arguments: { on: false } }] },
      { text: "Off." },
    );
    await t.say("Switch the address off.");
    assert.equal((await setup()).address?.on, false);
  });
});

describe("a hosted home", () => {
  test("offers no address at wizards.host and refuses to switch one on", async () => {
    const t = await testHome("Di", undefined, {
      unreachable: true,
      config: { manageUrl: "http://127.0.0.1:9", ollamaUrl: "http://127.0.0.1:9" },
    });
    try {
      const view = (await (await t.request("/v1/setup")).json()) as Setup;
      assert.equal(view.address, undefined);
      const response = await t.request("/v1/setup/address", { body: { on: true } });
      assert.equal(response.status, 400);
      assert.equal(t.home.db.meta("address.on"), undefined);
    } finally {
      t.stop();
    }
  });
});
