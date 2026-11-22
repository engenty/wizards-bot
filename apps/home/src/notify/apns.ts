import { createPrivateKey, sign } from "node:crypto";
import { type ClientHttp2Session, connect } from "node:http2";

export interface ApnsKey {
  /** The .p8 file's text. */
  key: string;
  keyId: string;
  teamId: string;
}

export interface ApnsPush {
  token: string;
  environment: "development" | "production";
  topic: string;
  /** `alert` shows something; `background` only wakes the app. */
  type: "alert" | "background";
  collapseId?: string;
  payload: unknown;
}

export type ApnsResult = { ok: true } | { ok: false; status: number; reason: string };

/** What sends a push: Apple's service with the person's key, or a stand-in in tests. */
export interface PushSender {
  send(push: ApnsPush): Promise<ApnsResult>;
  close(): void;
}

const HOSTS = {
  development: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};
const TOKEN_MINUTES = 40;

/** Sends pushes to Apple with a signing key of the person's developer account. */
export class Apns implements PushSender {
  private readonly sessions = new Map<string, ClientHttp2Session>();
  private jwt: { value: string; at: number } | undefined;
  private readonly key: ApnsKey;

  constructor(key: ApnsKey) {
    this.key = key;
  }

  send(push: ApnsPush): Promise<ApnsResult> {
    return new Promise((resolve) => {
      let session: ClientHttp2Session;
      try {
        session = this.session(push.environment);
      } catch (error) {
        return resolve({ ok: false, status: 0, reason: String((error as Error).message) });
      }
      const request = session.request({
        ":method": "POST",
        ":path": `/3/device/${push.token}`,
        authorization: `bearer ${this.token()}`,
        "apns-topic": push.topic,
        "apns-push-type": push.type,
        "apns-priority": push.type === "alert" ? "10" : "5",
        ...(push.collapseId ? { "apns-collapse-id": push.collapseId } : {}),
        "content-type": "application/json",
      });
      let status = 0;
      let body = "";
      request.on("response", (headers) => {
        status = Number(headers[":status"]);
      });
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        if (status === 200) return resolve({ ok: true });
        let reason = body;
        try {
          reason = (JSON.parse(body) as { reason?: string }).reason ?? body;
        } catch {}
        resolve({ ok: false, status, reason });
      });
      request.on("error", (error) => resolve({ ok: false, status: 0, reason: error.message }));
      request.setTimeout(10_000, () => request.close());
      request.end(JSON.stringify(push.payload));
    });
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  private session(environment: "development" | "production"): ClientHttp2Session {
    const existing = this.sessions.get(environment);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = connect(HOSTS[environment]);
    session.on("error", () => this.sessions.delete(environment));
    session.on("close", () => this.sessions.delete(environment));
    session.unref();
    this.sessions.set(environment, session);
    return session;
  }

  private token(): string {
    if (this.jwt && Date.now() - this.jwt.at < TOKEN_MINUTES * 60_000) return this.jwt.value;
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const head = `${encode({ alg: "ES256", kid: this.key.keyId })}.${encode({
      iss: this.key.teamId,
      iat: Math.floor(Date.now() / 1000),
    })}`;
    const signature = sign("sha256", Buffer.from(head), {
      key: createPrivateKey(this.key.key),
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    this.jwt = { value: `${head}.${signature}`, at: Date.now() };
    return this.jwt.value;
  }
}
