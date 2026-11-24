import type { KeyObject } from "node:crypto";
import { claimBody } from "./keys.ts";

// The relay's API at wizards.host (WIZARDS_TUNNEL_URL changes it): a name for a claim key, and a
// certificate for that name. Errors come as `{ error, code }`.

/** Where the relay's API answers when WIZARDS_TUNNEL_URL names no other place. */
export const RELAY_URL = "https://wizards.host";

/** What a claim gives: a fresh key for the relay, the name, and where frpc connects. */
export interface Claimed {
  key: string;
  name: string;
  server: string;
  serverPort: number;
}

/**
 * Something the relay said no to, with its sentence for people and its code. Status 0: the
 * relay did not answer at all.
 */
export class RelayError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }

  /** The relay answered with a no; a 401 only means its key for this home ended. */
  get refused(): boolean {
    return this.status >= 400 && this.status !== 401;
  }
}

export class Relay {
  readonly url: string;
  private readonly fetch: typeof fetch;

  constructor(url: string, fetcher: typeof fetch = (input, init) => fetch(input, init)) {
    this.url = url.replace(/\/+$/, "");
    this.fetch = fetcher;
  }

  private async call<T>(
    path: string,
    init: { method?: string; key?: string; body?: unknown } = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetch(`${this.url}${path}`, {
        method: init.method ?? "GET",
        headers: {
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...(init.key ? { authorization: `Bearer ${init.key}` } : {}),
          "user-agent": "wizards-bot-home",
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new RelayError(
        `${this.url} did not answer: ${(error as Error).message}`,
        "unreachable",
        0,
      );
    }
    const data = (response.status === 204 ? {} : await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok) {
      throw new RelayError(
        typeof data.error === "string" ? data.error : `${this.url} answered ${response.status}.`,
        typeof data.code === "string" ? data.code : "error",
        response.status,
      );
    }
    return data as T;
  }

  /** Claims the name of a claim key. Every claim gives a fresh key for the relay; the name stays. */
  async claim(key: KeyObject): Promise<Claimed> {
    const data = await this.call<Partial<Claimed>>("/v1/tunnels/claim", {
      method: "POST",
      body: claimBody(key),
    });
    if (!data.key || !data.name || !data.server) {
      throw new RelayError(`${this.url} answered the claim without a name.`, "invalid", 502);
    }
    return {
      key: data.key,
      name: data.name,
      server: data.server,
      serverPort: Number(data.serverPort) || 443,
    };
  }

  /**
   * A certificate for the key's name: posts the request, then asks every `every` ms until the
   * relay has it (Let's Encrypt checks the name's DNS meanwhile). Returns the PEM chain.
   */
  async certificate(
    key: string,
    csr: string,
    { every = 3000, within = 300_000 }: { every?: number; within?: number } = {},
  ): Promise<string> {
    const order = await this.call<{ id: string }>("/v1/tunnels/cert", {
      method: "POST",
      key,
      body: { csr },
    });
    const until = Date.now() + within;
    while (Date.now() < until) {
      const data = await this.call<{ state: string; cert?: string; error?: string }>(
        `/v1/tunnels/cert/${encodeURIComponent(order.id)}`,
        { key },
      );
      if (data.state === "ready" && data.cert) return data.cert;
      if (data.state === "failed") {
        throw new RelayError(data.error || "The certificate could not be made.", "failed", 422);
      }
      await new Promise((done) => setTimeout(done, every));
    }
    throw new RelayError("The certificate took too long. It is tried again later.", "slow", 0);
  }
}
