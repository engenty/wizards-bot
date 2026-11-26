import assert from "node:assert/strict";
import { createHash, createPublicKey, X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { request as plainRequest } from "node:http";
import { request as secureRequest } from "node:https";
import type { AddressInfo } from "node:net";
import { createServer as tcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { TLSSocket } from "node:tls";
import { WebSocket, WebSocketServer } from "ws";
import { ownCertificate, printOf } from "./certificate.ts";
import { listen } from "./listen.ts";
import { pairingCard, pairingLink } from "./setup/words.ts";
import { testHome } from "./test/fakes.ts";

const freePort = async (): Promise<number> => {
  const probe = tcpServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
};

const spkiPrint = (pem: string): string =>
  createHash("sha256")
    .update(new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" }))
    .digest("base64url");

/** A GET on the port, over https when `secure`: the body and the print of the key it answered with. */
function get(
  port: number,
  path: string,
  secure: boolean,
): Promise<{ body: string; print?: string }> {
  return new Promise((resolve, reject) => {
    const options = { host: "127.0.0.1", port, path, rejectUnauthorized: false };
    const req = (secure ? secureRequest : plainRequest)(options, (res) => {
      const socket = res.socket as TLSSocket;
      const raw = secure ? socket.getPeerCertificate().raw : undefined;
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () =>
        resolve({
          body,
          ...(raw ? { print: spkiPrint(new X509Certificate(raw).toString()) } : {}),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

describe("the home's own certificate", () => {
  test("is made once, from a key that stays, and checks out with that key alone", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "wizards-bot-cert-")), "certificate");
    const first = ownCertificate(dir);
    assert.equal(statSync(join(dir, "key.pem")).mode & 0o777, 0o600);
    assert.deepEqual(ownCertificate(dir), first);

    const cert = new X509Certificate(first.cert);
    assert.ok(cert.verify(createPublicKey(first.key)), "signed with its own key");
    assert.equal(cert.ca, false);
    assert.equal(new Date(cert.validTo).getUTCFullYear(), 9999);
    assert.ok(new Date(cert.validFrom).getTime() < Date.now());
    assert.equal(first.print, spkiPrint(first.cert));
    assert.equal(first.print, printOf(first.key));
    assert.match(first.print, /^[A-Za-z0-9_-]{43}$/);

    // Without its certificate the same key makes a new one: the print stays.
    rmSync(join(dir, "cert.pem"));
    const again = ownCertificate(dir);
    assert.notEqual(again.cert, first.cert);
    assert.equal(again.print, first.print);
  });
});

describe("one port for https and http", () => {
  test("answers both, over https with the home's own key, and streams", async () => {
    const certificate = ownCertificate(join(mkdtempSync(join(tmpdir(), "wizards-bot-cert-")), "c"));
    const port = await freePort();
    const server = listen(
      (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/stream") {
          const body = new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("first\n"));
              setTimeout(() => {
                controller.enqueue(new TextEncoder().encode("second\n"));
                controller.close();
              }, 50);
            },
          });
          return new Response(body, { headers: { "content-type": "text/event-stream" } });
        }
        return new Response(`${url.protocol} ${url.pathname}`);
      },
      port,
      "127.0.0.1",
      certificate,
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(await get(port, "/a", false), { body: "http: /a" });
      assert.deepEqual(await get(port, "/b", true), {
        body: "https: /b",
        print: certificate.print,
      });
      assert.equal((await get(port, "/stream", true)).body, "first\nsecond\n");
    } finally {
      server.close();
    }
  });

  test("hands WebSocket upgrades of both to whoever listens on its servers", async () => {
    const certificate = ownCertificate(join(mkdtempSync(join(tmpdir(), "wizards-bot-cert-")), "c"));
    const port = await freePort();
    const server = listen(() => new Response("no"), port, "127.0.0.1", certificate);
    const sockets = new WebSocketServer({ noServer: true });
    for (const each of server.servers) {
      each.on("upgrade", (request, socket, head) =>
        sockets.handleUpgrade(request, socket, head, (ws) =>
          ws.send((request.socket as Partial<TLSSocket>).encrypted ? "wss" : "ws"),
        ),
      );
    }
    const said = (url: string) =>
      new Promise<string>((resolve, reject) => {
        const ws = new WebSocket(url, { rejectUnauthorized: false });
        ws.on("message", (data) => {
          resolve(String(data));
          ws.close();
        });
        ws.on("error", reject);
      });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(await said(`ws://127.0.0.1:${port}/v1/link`), "ws");
      assert.equal(await said(`wss://127.0.0.1:${port}/v1/link`), "wss");
    } finally {
      sockets.close();
      server.close();
    }
  });
});

describe("pairing on the person's network", () => {
  test("the QR leads the apps to https with the key's print; typed and browser keep http", async () => {
    const t = await testHome("Ada", undefined, { unreachable: true });
    try {
      const address = t.home.address();
      assert.match(address, /^http:\/\//);
      const print = t.home.certificate()?.print;
      assert.ok(print);
      assert.deepEqual(t.home.pairingAddress(), {
        address: address.replace(/^http:/, "https:"),
        print,
      });
      assert.equal(t.home.info().print, print);

      const card = pairingCard(address, "K7QM-2RXD", "en", t.home.pairingAddress());
      assert.equal(
        card.qr,
        `wizardsbot://pair?home=${encodeURIComponent(address.replace(/^http:/, "https:"))}&code=K7QM-2RXD&k=${print}`,
      );
      assert.ok(
        card.body.includes(`\`${address}\``),
        "the address to type stays the one a browser opens",
      );
    } finally {
      t.stop();
    }
  });

  test("a home with an address of its own has no certificate of its own", async () => {
    const t = await testHome("Ben");
    try {
      assert.equal(t.home.certificate(), undefined);
      assert.deepEqual(t.home.pairingAddress(), { address: t.home.address() });
      assert.equal(t.home.info().print, undefined);
      assert.equal(
        pairingLink(t.home.address(), "K7QM-2RXD"),
        `wizardsbot://pair?home=${encodeURIComponent(t.home.address())}&code=K7QM-2RXD`,
      );
    } finally {
      t.stop();
    }
  });
});
