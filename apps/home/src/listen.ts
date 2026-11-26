import { createServer as plainServer, type Server } from "node:http";
import { createServer as secureServer } from "node:https";
import { type Socket, createServer as tcpServer } from "node:net";
import { getRequestListener } from "@hono/node-server";
import type { OwnCertificate } from "./certificate.ts";

// The home's one port speaks https with its own certificate and plain http, told apart by the
// first byte a device sends: 22 begins a TLS handshake. The apps pair over https and trust only
// the key whose print came with the code; a browser on the network, which cannot know that key,
// keeps http.

/** A connection that says nothing for this long is closed. */
const FIRST_BYTE_WITHIN = 30_000;
const HANDSHAKE = 0x16;

export interface Listening {
  /** The servers that take requests, for upgrades (`/v1/link`). */
  servers: Server[];
  close(): void;
}

export function listen(
  fetch: (request: Request) => Response | Promise<Response>,
  port: number,
  hostname: string,
  certificate: OwnCertificate | undefined,
): Listening {
  const listener = getRequestListener(fetch);
  const plain = plainServer(listener);
  if (!certificate) {
    plain.listen(port, hostname);
    return { servers: [plain], close: () => plain.close() };
  }
  const secure = secureServer({ key: certificate.key, cert: certificate.cert }, listener);
  // The first byte is read and put back: the server that takes the socket reads it again.
  const both = tcpServer({ pauseOnConnect: true }, (socket: Socket) => {
    socket.setTimeout(FIRST_BYTE_WITHIN, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.once("readable", () => {
      const first = socket.read(1) as Buffer | null;
      if (!first) return socket.destroy();
      socket.setTimeout(0);
      socket.unshift(first);
      (first[0] === HANDSHAKE ? secure : plain).emit("connection", socket);
    });
  });
  both.listen(port, hostname);
  return {
    servers: [plain, secure as unknown as Server],
    close: () => {
      both.close();
      plain.close();
      secure.close();
    },
  };
}
