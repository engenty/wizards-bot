import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { join, normalize } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { TerminalError } from "@engenty/model-setup/server";
import { CsvRefused, OriginRefused } from "@engenty/vault";
import type { Admin, Agent, Event } from "@wizards-bot/protocol";
import {
  AddMark,
  type AgentDetail,
  AgreeToServices,
  AnswerHandoff,
  Avatar,
  ChangeSetup,
  ConnectFolder,
  DeviceResources,
  FILE_LIMIT,
  FolderEdit,
  ImportMessages,
  MakeFolder,
  PairAdmin,
  PairRequest,
  type PairResponse,
  PullSetup,
  SaveDocument,
  SendMessage,
  SetupGateway,
  SwitchAddress,
  SwitchOllama,
  TestSetup,
  UndoFolderChange,
  UpdateDevice,
  UpdateFolder,
  VaultInput,
} from "@wizards-bot/protocol";
import { REPLY_ACTION, REPLY_FIELD } from "@wizards-bot/protocol/limits";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { formOf, readForm } from "./agent/ask.ts";
import { LeavesHome, NoPictureModel, NotAPicture } from "./avatar/avatars.ts";
import { isHosted, tidyCode, VERSION } from "./config.ts";
import { HandoffRefused, publicDevice } from "./devices/handoffs.ts";
import { FileRefused, isText, sniff } from "./files/check.ts";
import { FolderRefused } from "./folders/folders.ts";
import { PassRefused } from "./group.ts";
import type { Home } from "./home.ts";
import { agree, takeBack } from "./models/services.ts";
import { secretEntries } from "./secrets.ts";
import { OllamaRefused, PullRefused } from "./setup/setup.ts";
import { sharedSetup } from "./setup/shared.ts";
import { langOf } from "./setup/words.ts";
import { AlreadyAnswered, type DeviceRecord, publicAgent, VersionConflict } from "./store/store.ts";
import { AddressRefused } from "./tunnel/tunnel.ts";
import { VaultRefused } from "./vault/vault.ts";

type Env = { Variables: { device: DeviceRecord } };

const AnswerCard = z.object({
  action: z.string(),
  values: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
});
const AddDevice = z.object({
  name: z.string().min(1),
  kind: z.enum(["watch", "phone", "computer", "browser"]),
});

/** Where the built web app lies: `apps/web/dist`, made by `pnpm build`. */
const WEB_DIST = fileURLToPath(new URL("../../web/dist/", import.meta.url));
const WEB_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  svg: "image/svg+xml",
  woff2: "font/woff2",
  png: "image/png",
  json: "application/json",
  map: "application/json",
};

/**
 * What the web app's page may do: load its own files, talk to its own home, show pictures
 * it fetched, use the camera's stream. Scripts written into the page are allowed one by one.
 */
function webPolicy(page: string): string {
  const inline = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (match) =>
      `'sha256-${createHash("sha256")
        .update(match[1] ?? "")
        .digest("base64")}'`,
  );
  return [
    "default-src 'self'",
    `script-src 'self' ${inline.join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self'",
    // A text file the page fetched is read back from its own blob to show it.
    "connect-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const fail = (
  c: Context,
  status: 400 | 401 | 404 | 409 | 413 | 415 | 429,
  error: string,
  message: string,
  more = {},
) => c.json({ error, message, ...more }, status);

const notFound = (c: Context, what: string) =>
  fail(c, 404, "not_found", `There is no such ${what}.`);

/** Text as a Markdown quote: each line begins with "> ". */
const quote = (text: string) =>
  text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

/** The largest file the person drops into a connected folder in the file browser. */
const DROPPED_BYTES = 200 * 1024 * 1024;

/** The place a path inside a folder is in, `""` at the folder itself. */
const parentOf = (path: string): string => path.split("/").slice(0, -1).join("/");

export function createServer(home: Home, options: { webDir?: string } = {}): Hono<Env> {
  const webDir = normalize(options.webDir ?? WEB_DIST);
  const app = new Hono<Env>();
  const { store } = home;
  const wrongCodes: number[] = [];

  app.onError((error, c) => {
    if (error instanceof z.ZodError) {
      return fail(c, 400, "invalid", `The request is not valid: ${z.prettifyError(error)}`);
    }
    if (error instanceof TerminalError) {
      const message = {
        gone: "This terminal is closed.",
        unavailable: "This computer has no terminal the Bot Server can open.",
        not_started: `The command did not start: ${error.detail}`,
      }[error.code];
      return error.code === "gone"
        ? fail(c, 404, "not_found", message)
        : fail(c, 400, "refused", message);
    }
    console.error("[http]", error);
    return c.json({ error: "failed", message: "The Bot Server could not do this." }, 500);
  });

  // The web app: a device like the phone, served by the home itself.
  const webFile = (name: string): { bytes: Uint8Array<ArrayBuffer>; type: string } | undefined => {
    const path = normalize(join(webDir, name));
    const type = WEB_TYPES[name.split(".").pop() ?? ""];
    if (!type || !path.startsWith(webDir) || !existsSync(path) || !statSync(path).isFile())
      return undefined;
    return { bytes: Uint8Array.from(readFileSync(path)), type };
  };
  app.get("/", (c) => {
    const page = webFile("index.html");
    if (!page) {
      return c.text(
        "The web app is not built yet. Run `pnpm build` in the wizards-bot folder, then load this page again.",
        503,
      );
    }
    return c.body(page.bytes, 200, {
      "content-type": page.type,
      "cache-control": "no-cache",
      "content-security-policy": webPolicy(new TextDecoder().decode(page.bytes)),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
  });
  app.get("/icon.svg", (c) => {
    const file = webFile("icon.svg");
    return file
      ? c.body(file.bytes, 200, { "content-type": file.type, "cache-control": "no-cache" })
      : c.body(null, 404);
  });
  // Built files carry a hash of their content in their name: they never change.
  app.get("/assets/:name", (c) => {
    const file = webFile(join("assets", c.req.param("name")));
    if (!file) return c.body(null, 404);
    return c.body(file.bytes, 200, {
      "content-type": file.type,
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    });
  });

  // For Coolify, the status page and the Mac app: the home runs, it is a Bot Server, and its
  // version. It says nothing else, to anyone.
  app.get("/health", (c) => c.json({ ok: true, home: true, version: VERSION }));

  app.get("/v1/home", (c) => c.json(home.info()));

  app.post("/v1/pair", async (c) => {
    const body = PairRequest.parse(await c.req.json());
    const minuteAgo = Date.now() - 60_000;
    while (wrongCodes.length && (wrongCodes[0] as number) < minuteAgo) wrongCodes.shift();
    if (wrongCodes.length >= 5) {
      return fail(c, 429, "too_many", "Too many wrong codes. Wait a minute, then try again.");
    }
    const demo = home.config.demoCode !== undefined && tidyCode(body.code) === home.config.demoCode;
    const redeemed =
      demo || home.hosted.redeemSetupCode(body.code) ? {} : store.redeemPairingCode(body.code);
    // In a group home every device is an admin's: a code pairs only as the admin who asked for it.
    const admin = redeemed?.adminId ? home.group.admin(redeemed.adminId) : undefined;
    if (!redeemed || (home.group.isGroup() && !admin)) {
      wrongCodes.push(Date.now());
      return fail(c, 401, "unauthorized", "This code is not valid any more. Ask for a new one.");
    }
    const { token, device } = store.addDevice({ ...body, adminId: admin?.id });
    return c.json({
      token,
      device: publicDevice(device),
      home: home.info(),
    } satisfies PairResponse);
  });

  // An admin of a group home pairs their first device with the pass the Manage-App gave them.
  app.post("/v1/pair/admin", async (c) => {
    const body = PairAdmin.parse(await c.req.json());
    const minuteAgo = Date.now() - 60_000;
    while (wrongCodes.length && (wrongCodes[0] as number) < minuteAgo) wrongCodes.shift();
    if (wrongCodes.length >= 5) {
      return fail(c, 429, "too_many", "Too many wrong codes. Wait a minute, then try again.");
    }
    let admin: Admin;
    try {
      admin = await home.group.admit(body.pass);
    } catch (error) {
      if (!(error instanceof PassRefused)) throw error;
      wrongCodes.push(Date.now());
      return fail(c, 401, "unauthorized", error.message);
    }
    const { token, device } = store.addDevice({ ...body, adminId: admin.id });
    return c.json({
      token,
      device: publicDevice(device),
      home: home.info(),
    } satisfies PairResponse);
  });

  // What other people's homes reach: this home's key, contact requests, shared agents.
  home.peers.routes(app as unknown as Hono);
  // What a channel's service calls, e.g. WhatsApp's webhook.
  home.channels.routes(app as unknown as Hono);
  home.tasks.routes(app as unknown as Hono);
  // An artifact's page, opened with its own key.
  home.artifacts.openRoutes(app as unknown as Hono);
  // The host page of a connection's view and its bridge, opened with the artifact's key.
  home.apps.openRoutes(app as unknown as Hono, () => {
    const path = join(webDir, "app-host.html");
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  });
  // A published link, opened by anyone who has it.
  home.sharing.openRoutes(app as unknown as Hono);

  // The home's tools for a client that steps by itself. The bearer is a turn's token.
  app.post("/mcp", async (c) => {
    const token = bearer(c);
    const answer = await home.mcp.handle(token, await c.req.json());
    return answer === undefined ? c.body(null, 202) : c.json(answer);
  });
  app.get("/mcp", (c) => c.body(null, 405));

  // Where a service sends the person back after a sign-in.
  app.get("/oauth/callback", async (c) => {
    const page = (text: string) =>
      c.html(
        `<!doctype html><meta name="viewport" content="width=device-width"><title>wizards.bot</title><body style="font: 17px system-ui; margin: 20vh auto; max-width: 24rem; padding: 0 1.5rem"><p>${text}</p>`,
      );
    const state = c.req.query("state");
    const code = c.req.query("code");
    if (!state || !code)
      return page("The sign-in was not finished. Go back to the chat and try again.");
    try {
      // The issuer, when the service names it, is checked against the one the sign-in began with.
      const connection = await home.connections.finishSignIn(state, code, c.req.query("iss"));
      if (!connection)
        return page(
          "This sign-in is not known to your Bot Server. Go back to the chat and try again.",
        );
      for (const card of store.openCardsOfKind("connect")) {
        const payload = store.cardPayload<{ connectionId?: string }>(card.id);
        if (payload?.connectionId === connection.id)
          await home.answer(card.id, { action: "done", by: "sign-in" });
      }
      // The app's sign-in browser closes itself when it is sent to the app's own address.
      return c.html(
        `<!doctype html><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="0;url=wizardsbot://signed-in"><title>wizards.bot</title><body style="font: 17px system-ui; margin: 20vh auto; max-width: 24rem; padding: 0 1.5rem"><p>You are signed in. Go back to the chat.</p>`,
      );
    } catch (error) {
      console.error("[oauth]", error);
      return page("The sign-in did not work. Go back to the chat and try again.");
    }
  });

  app.use("/v1/*", async (c, next) => {
    const device = store.deviceByToken(bearer(c));
    if (!device)
      return fail(
        c,
        401,
        "unauthorized",
        "This device is not paired with the Bot Server any more.",
      );
    c.set("device", device);
    await next();
  });

  // ── Devices ───────────────────────────────────────────────────────────────

  app.get("/v1/device", (c) => c.json(publicDevice(c.get("device"))));

  app.patch("/v1/device", async (c) => {
    const patch = UpdateDevice.parse(await c.req.json());
    const device = store.updateDevice(c.get("device").id, patch);
    return c.json(publicDevice(device as DeviceRecord));
  });

  app.delete("/v1/device", (c) => {
    store.removeDevice(c.get("device").id);
    return c.body(null, 204);
  });

  app.put("/v1/device/resources", async (c) => {
    const body = DeviceResources.parse(await c.req.json());
    // What one admin's phone keeps would reach the turns of the others.
    if (home.group.isGroup())
      return fail(
        c,
        409,
        "group_home",
        "A team's Bot Server takes nothing from a device: its calendar, contacts and folders stay on it.",
      );
    const device = home.handoffs.offer(c.get("device").id, body.resources, body.agents);
    return c.json(publicDevice(device as DeviceRecord));
  });

  app.get("/v1/devices", (c) => c.json({ devices: home.handoffs.publicDevices() }));

  // ── Hand-offs: questions an agent hands to the agent on a device ─────────

  app.get("/v1/handoffs", (c) => c.json({ handoffs: home.handoffs.open(c.get("device").id) }));

  app.post("/v1/handoffs/:id/answer", async (c) => {
    const body = AnswerHandoff.parse(await c.req.json());
    // A declined hand-off carries nothing of the person; an answer does.
    if (!body.declined) {
      const refused = await waitsForYes(c);
      if (refused) return refused;
    }
    try {
      return c.json(home.handoffs.answer(c.get("device").id, c.req.param("id"), body));
    } catch (error) {
      if (!(error instanceof HandoffRefused)) throw error;
      const status = error.code === "not_found" ? 404 : error.code === "invalid" ? 400 : 409;
      return fail(c, status, error.code, error.message);
    }
  });

  app.post("/v1/devices", async (c) => {
    const body = AddDevice.parse(await c.req.json());
    // A watch is the admin's whose phone pairs it.
    const { token, device } = store.addDevice({ ...body, adminId: c.get("device").admin?.id });
    return c.json({
      token,
      device: publicDevice(device),
      home: home.info(),
    } satisfies PairResponse);
  });

  // ── Agents and conversations ──────────────────────────────────────────────

  /** An agent's line as one device sees it: in a group home, with what its admin has not read. */
  const seenBy = (agent: Agent, device: DeviceRecord): Agent =>
    device.admin
      ? { ...agent, unread: store.unread(agent.conversationId, device.admin.id) }
      : agent;

  app.get("/v1/agents", (c) =>
    c.json({ agents: store.agents().map((agent) => seenBy(publicAgent(agent), c.get("device"))) }),
  );

  app.get("/v1/search", (c) => c.json({ hits: store.search(c.req.query("q") ?? "") }));

  app.get("/v1/agents/:id", (c) => {
    const agent = store.agent(c.req.param("id"));
    if (!agent) return c.json({ error: "not_found" }, 404);
    const detail: AgentDetail = {
      agent: seenBy(publicAgent(agent), c.get("device")),
      memory: agent.memory,
      tasks: home.tasks.list(agent.id),
      doing: home.turns.doing(agent.conversationId),
    };
    return c.json(detail);
  });

  // A conversation someone else has with one of the person's agents is theirs: no device
  // reads it, writes in it or stops it. It answers as one that is not there.
  app.use("/v1/conversations/:id/*", async (c, next) => {
    if (store.isGuest(c.req.param("id"))) return notFound(c, "conversation");
    await next();
  });

  app.get("/v1/conversations/:id/messages", (c) => {
    if (!store.conversation(c.req.param("id"))) return notFound(c, "conversation");
    const limit = Number(c.req.query("limit") ?? 50);
    return c.json(store.messages(c.req.param("id"), { before: c.req.query("before"), limit }));
  });

  /**
   * What the person writes on a phone, a watch or in a browser reaches a model service outside
   * their own computers only after they said yes to it (App Review 5.1.2(i)). A terminal and a
   * linked computer are the person's own computers and are not asked.
   */
  const waitsForYes = async (c: Context<Env>) => {
    if (c.get("device").kind === "computer") return undefined;
    await home.models.refresh();
    const waiting = home.models.waitingForYes();
    if (!waiting.length) return undefined;
    return fail(
      c,
      409,
      "needs_consent",
      `Your Bot Server uses ${waiting.map((service) => service.label).join(" and ")}. Say yes to that on this device first.`,
      { services: waiting },
    );
  };

  app.post("/v1/conversations/:id/messages", async (c) => {
    const conversation = store.conversation(c.req.param("id"));
    if (!conversation) return notFound(c, "conversation");
    const refused = await waitsForYes(c);
    if (refused) return refused;
    const body = SendMessage.parse(await c.req.json());
    // A device that is unsure whether its message arrived sends it again with the same clientId.
    const known = body.clientId ? store.messageByClientId(body.clientId) : undefined;
    if (known) return c.json({ message: known }, 202);
    const files = (body.files ?? []).map((id) => home.files.get(id));
    if (files.some((file) => !file))
      return fail(
        c,
        400,
        "invalid",
        "One of the files is not known to the Bot Server. Add it again.",
      );
    const attached = files.filter((file) => file !== undefined);
    if (!body.text.trim() && !attached.length)
      return fail(c, 400, "invalid", "The message is empty.");
    // A passage of a document is asked about: it stands as a quote above the question.
    const about = body.about ? store.document(body.about.documentId) : undefined;
    if (body.about && about?.conversationId !== conversation.id)
      return fail(c, 400, "invalid", "That document is not part of this conversation.");
    const passage = about && body.about ? quote(body.about.quote) : "";
    const shown = passage ? `${passage}\n\n${body.text}` : body.text;
    const channel = c.get("device").kind === "watch" ? "watch" : "app";
    // In a group home a message says which admin wrote it, to the others and to the agent.
    const writer = c.get("device").admin;
    const message = store.addMessage({
      conversationId: conversation.id,
      role: "you",
      channel,
      parts: [
        ...(about ? [{ type: "document" as const, documentId: about.id, title: about.title }] : []),
        ...attached.map((file) => ({ type: "file" as const, file })),
        ...(body.text.trim() ? [{ type: "text" as const, text: shown }] : []),
      ],
      clientId: body.clientId,
      from: writer ? { name: writer.name, admin: writer.id } : undefined,
    });
    store.markRead(conversation.id, writer?.id);
    // Asking about a passage is no answer to what the agent asked.
    const answers = about && body.answers === undefined ? null : body.answers;
    const asked = about
      ? `About this passage of the document "${about.title}" (${about.id}):\n${passage}\n\n${body.text}`
      : body.text;
    home.said(
      {
        conversationId: conversation.id,
        messageId: message.id,
        later: body.later,
        // In a room the group home is one member: the others read who of it wrote.
        text: !writer
          ? asked
          : store.agent(conversation.agentId)?.origin === "room"
            ? `${writer.name}: ${asked}`
            : `${writer.name} writes:\n${asked}`,
        writer,
        channel,
        spoken: body.spoken,
        files: attached,
      },
      { answers, words: body.text, by: c.get("device").name, admin: writer },
    );
    return c.json({ message }, 202);
  });

  app.post("/v1/conversations/:id/read", (c) => {
    store.markRead(c.req.param("id"), c.get("device").admin?.id);
    return c.body(null, 204);
  });

  app.post("/v1/conversations/:id/warm", (c) => {
    if (!store.conversation(c.req.param("id"))) return notFound(c, "conversation");
    void home.turns
      .readAhead(c.req.param("id"))
      .catch((error) => console.error("[turn] reading ahead:", error));
    return c.body(null, 204);
  });

  app.post("/v1/conversations/:id/stop", (c) => {
    home.turns.stop(c.req.param("id"));
    return c.body(null, 204);
  });

  app.post("/v1/conversations/:id/import", async (c) => {
    const conversation = store.conversation(c.req.param("id"));
    if (!conversation) return notFound(c, "conversation");
    const refused = await waitsForYes(c);
    if (refused) return refused;
    const body = ImportMessages.parse(await c.req.json());
    const messages = [];
    for (const entry of body.messages) {
      if (store.messageByClientId(entry.clientId)) continue;
      const message = store.addMessage({
        conversationId: conversation.id,
        role: entry.role,
        agentId: entry.role === "agent" ? conversation.agentId : undefined,
        channel: "app",
        parts: [{ type: "text", text: entry.text }],
        model: entry.model,
        clientId: entry.clientId,
        createdAt: entry.createdAt,
      });
      // The agent reads it next time as part of the conversation.
      await home.mastra.append({
        conversationId: conversation.id,
        agentId: conversation.agentId,
        role: entry.role === "agent" ? "assistant" : "user",
        text: entry.text,
        id: message.id,
        createdAt: new Date(entry.createdAt),
      });
      messages.push(message);
    }
    return c.json({ messages });
  });

  app.get("/v1/conversations/:id/documents", (c) =>
    c.json({ documents: store.documents(c.req.param("id")) }),
  );

  app.get("/v1/conversations/:id/files", (c) =>
    c.json({ files: store.sentFiles(c.req.param("id")) }),
  );

  // ── Artifacts ─────────────────────────────────────────────────────────────

  home.artifacts.routes(app as unknown as Hono);

  // ── Sharing ───────────────────────────────────────────────────────────────

  home.sharing.routes(app as unknown as Hono);

  // ── The person's record ───────────────────────────────────────────────────

  home.peers.person.deviceRoutes(
    app as unknown as Hono,
    (c) => (c as unknown as Context<Env>).get("device").name,
  );

  // ── Invites ───────────────────────────────────────────────────────────────

  home.peers.invites.deviceRoutes(app as unknown as Hono);

  // ── Files ─────────────────────────────────────────────────────────────────

  app.post("/v1/files", async (c) => {
    const form = await c.req.parseBody().catch(() => undefined);
    const file = form?.file;
    if (!(file instanceof File))
      return fail(c, 400, "invalid", "Send the file in a form field named file.");
    if (file.size > FILE_LIMIT) {
      return fail(
        c,
        413,
        "too_large",
        `“${file.name}” is larger than ${FILE_LIMIT / 1024 / 1024} MB.`,
      );
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      return c.json(await home.files.addGiven({ name: file.name, mime: file.type, bytes }));
    } catch (error) {
      if (error instanceof FileRefused) {
        return fail(c, error.code === "too_large" ? 413 : 415, error.code, error.message);
      }
      throw error;
    }
  });

  app.delete("/v1/files/:id", (c) => {
    home.files.remove(c.req.param("id"));
    return c.body(null, 204);
  });

  app.get("/v1/files/:id", (c) => {
    const file = home.files.get(c.req.param("id"));
    const bytes = file && home.files.bytes(file.id);
    if (!file || !bytes) return notFound(c, "file");
    return c.body(new Uint8Array(bytes), 200, {
      "content-type": file.mime,
      "content-length": String(bytes.length),
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "cache-control": "private, max-age=31536000, immutable",
      // A file is shown as a picture or saved. It never runs as a page of the home.
      "content-security-policy": "sandbox; default-src 'none'",
      "x-content-type-options": "nosniff",
    });
  });

  // ── Cards ─────────────────────────────────────────────────────────────────

  app.get("/v1/items", (c) => c.json({ items: store.items() }));

  app.post("/v1/cards/:id/answer", async (c) => {
    const body = AnswerCard.parse(await c.req.json());
    const before = store.card(c.req.param("id"));
    if (!before) return notFound(c, "card");
    if (before.actions.length && !before.actions.some((action) => action.id === body.action)) {
      return fail(c, 400, "invalid", "This card has no such answer.");
    }
    // Words the person typed into a card reach the model like a message; a choice, a yes and a
    // secret (which no model reads) do not wait.
    const typed = (before.fields ?? []).some(
      (field) => field.type === "text" && String(body.values?.[field.id] ?? "").trim(),
    );
    if (typed) {
      const refused = await waitsForYes(c);
      if (refused) return refused;
    }
    // A folder picked on a card is one the home may connect; the card stays open otherwise.
    if (before.actions.find((action) => action.id === body.action)?.style === "primary") {
      for (const field of before.fields ?? []) {
        const path = body.values?.[field.id];
        if (field.type !== "folder" || typeof path !== "string" || !path) continue;
        try {
          // The folder the card proposed to make may not be there yet.
          if (path === field.value && field.placeholder) home.folders.planned(path);
          else home.folders.preview(path);
        } catch (error) {
          return folderProblem(c, error);
        }
      }
    }
    const form = before.state === "open" ? formOf(before) : undefined;
    if (form) {
      const lang = langOf(home.db);
      const read = readForm(form, body.values ?? {}, (id) => home.files.get(id), lang);
      if ("problem" in read) return fail(c, 400, "invalid", read.problem);
    }
    // A device that answers a question on its card: what is typed there is the person's message.
    const words = String(body.values?.[REPLY_FIELD] ?? "").trim();
    const { admin, name: by, kind } = c.get("device");
    const replied = before.state === "open" && before.reply && body.action === REPLY_ACTION;
    if (replied && !words) return fail(c, 400, "invalid", "The answer is empty.");
    const channel = kind === "watch" ? ("watch" as const) : ("app" as const);
    const message = replied
      ? store.addMessage({
          conversationId: before.conversationId,
          role: "you",
          channel,
          parts: [{ type: "text", text: words }],
          from: admin ? { name: admin.name, admin: admin.id } : undefined,
        })
      : undefined;
    const said = message && {
      conversationId: before.conversationId,
      messageId: message.id,
      text: words,
      writer: admin,
      channel,
    };
    try {
      const card = await home.answer(before.id, { ...body, by, admin, said });
      return c.json({ card });
    } catch (error) {
      if (error instanceof AlreadyAnswered) {
        return fail(c, 409, "already_answered", "This was answered already.", { card: error.card });
      }
      throw error;
    }
  });

  // ── Documents ─────────────────────────────────────────────────────────────

  app.get("/v1/documents/:id", (c) => {
    const document = store.document(c.req.param("id"));
    return document ? c.json(document) : notFound(c, "document");
  });

  app.put("/v1/documents/:id", async (c) => {
    const body = SaveDocument.parse(await c.req.json());
    try {
      const document = store.saveDocument(c.req.param("id"), { ...body, by: "you" });
      return document ? c.json(document) : notFound(c, "document");
    } catch (error) {
      if (error instanceof VersionConflict) {
        return fail(c, 409, "version_conflict", "The agent changed this document meanwhile.", {
          document: error.document,
        });
      }
      throw error;
    }
  });

  app.get("/v1/documents/:id/marks", (c) => {
    const id = c.req.param("id");
    return store.document(id) ? c.json({ marks: store.marks(id) }) : notFound(c, "document");
  });

  app.post("/v1/documents/:id/marks", async (c) => {
    const id = c.req.param("id");
    if (!store.document(id)) return notFound(c, "document");
    const body = AddMark.parse(await c.req.json());
    return c.json(store.addMark(id, body), 201);
  });

  app.delete("/v1/documents/:id/marks/:mark", (c) =>
    store.removeMark(c.req.param("id"), c.req.param("mark"))
      ? c.body(null, 204)
      : notFound(c, "mark"),
  );

  // ── Plugins ───────────────────────────────────────────────────────────────

  app.get("/v1/plugins", (c) => c.json(home.plugins.view()));

  app.patch("/v1/plugins/:id", async (c) => {
    const { on } = z.object({ on: z.boolean() }).parse(await c.req.json());
    return (await home.plugins.setOn(c.req.param("id"), on))
      ? c.json(home.plugins.view())
      : notFound(c, "plugin");
  });

  // ── Folders ───────────────────────────────────────────────────────────────

  const folderProblem = (c: Context, error: unknown) => {
    if (error instanceof FolderRefused) {
      return error.code === "not_found"
        ? fail(c, 404, "not_found", error.message)
        : fail(c, 400, "invalid", error.message);
    }
    throw error;
  };

  app.get("/v1/secrets", (c) => c.json({ secrets: secretEntries(home) }));

  // ── Vault ───────────────────────────────────────────────────────────────────

  const vaultProblem = (c: Context, error: unknown) => {
    if (
      error instanceof VaultRefused ||
      error instanceof OriginRefused ||
      error instanceof CsvRefused
    )
      return fail(c, 400, "invalid", error.message);
    if (error instanceof z.ZodError) return fail(c, 400, "invalid", "That is not a Vault item.");
    throw error;
  };

  app.get("/v1/vault", (c) => c.json(home.vault.view()));

  app.post("/v1/vault", async (c) => {
    try {
      return c.json(home.vault.save(VaultInput.parse(await c.req.json())));
    } catch (error) {
      return vaultProblem(c, error);
    }
  });

  app.put("/v1/vault/:id", async (c) => {
    try {
      return c.json(home.vault.save(VaultInput.parse(await c.req.json()), c.req.param("id")));
    } catch (error) {
      return vaultProblem(c, error);
    }
  });

  app.delete("/v1/vault/:id", (c) =>
    home.vault.remove(c.req.param("id")) ? c.json({ ok: true }) : notFound(c, "Vault item"),
  );

  // A reveal answers the person's own device, never a model; it is in the activity.
  app.post("/v1/vault/:id/reveal", (c) => {
    try {
      return c.json(home.vault.reveal(c.req.param("id")));
    } catch (error) {
      return vaultProblem(c, error);
    }
  });

  // The text of a password manager's CSV export; the browser reads the file, the home parses it.
  app.post("/v1/vault/import", async (c) => {
    try {
      const { csv } = z.object({ csv: z.string().max(5_000_000) }).parse(await c.req.json());
      return c.json(home.vault.import(csv));
    } catch (error) {
      return vaultProblem(c, error);
    }
  });

  app.get("/v1/folders", (c) => c.json({ folders: home.folders.list() }));

  app.get("/v1/folders/browse", (c) => {
    try {
      return c.json(home.folders.browse(c.req.query("path")));
    } catch (error) {
      return folderProblem(c, error);
    }
  });

  app.post("/v1/folders/new", async (c) => {
    try {
      return c.json(home.folders.makeFolder(MakeFolder.parse(await c.req.json())));
    } catch (error) {
      return folderProblem(c, error);
    }
  });

  app.post("/v1/folders/preview", async (c) => {
    const { path } = z.object({ path: z.string().min(1) }).parse(await c.req.json());
    try {
      return c.json(home.folders.preview(path));
    } catch (error) {
      return folderProblem(c, error);
    }
  });

  app.post("/v1/folders", async (c) => {
    try {
      const body = ConnectFolder.parse(await c.req.json());
      const folder = home.folders.connect(body);
      if (body.conversationId && store.conversation(body.conversationId)) {
        home.tell(
          body.conversationId,
          `The person connected the folder "${folder.name}" (${folder.access === "write" ? "you may change files after asking" : "read only"}). Tell them in one short sentence. If you were waiting for files that are in it, go on with them now.`,
        );
      }
      return c.json(folder);
    } catch (error) {
      return folderProblem(c, error);
    }
  });

  app.patch("/v1/folders/:id", async (c) => {
    const { access, allow } = UpdateFolder.parse(await c.req.json());
    const id = c.req.param("id");
    if (!home.folders.byId(id)) return notFound(c, "folder");
    if (access) home.folders.setAccess(id, access);
    if (allow) home.folders.setAllow(id, allow);
    return c.json(home.folders.byId(id));
  });

  app.delete("/v1/folders/:id", (c) => {
    home.folders.disconnect(c.req.param("id"));
    return c.body(null, 204);
  });
  // The file browser: what a connected folder holds, its files, and what agents did in it. It
  // reaches what the agents reach, through the same checks.

  app.get("/v1/folders/:id/entries", (c) => {
    const folder = home.folders.byId(c.req.param("id"));
    if (!folder) return notFound(c, "folder");
    try {
      return c.json(home.folders.entries(folder, c.req.query("path") ?? ""));
    } catch (error) {
      return folderProblem(c, error);
    }
  });

  app.get("/v1/folders/:id/file", (c) => {
    const folder = home.folders.byId(c.req.param("id"));
    if (!folder) return notFound(c, "folder");
    let file: ReturnType<Home["folders"]["fileOf"]>;
    try {
      file = home.folders.fileOf(folder, c.req.query("path") ?? "");
    } catch (error) {
      return folderProblem(c, error);
    }
    const head = Buffer.alloc(Math.min(file.size, 64 * 1024));
    const fd = openSync(file.full, "r");
    try {
      readSync(fd, head, 0, head.length, 0);
    } finally {
      closeSync(fd);
    }
    const mime =
      sniff(head) ?? (isText(head) ? "text/plain; charset=utf-8" : "application/octet-stream");
    const shown =
      c.req.query("download") === undefined && /^(image\/|application\/pdf|text\/plain)/.test(mime);
    const stream = Readable.toWeb(createReadStream(file.full)) as ReadableStream<Uint8Array>;
    return c.body(stream, 200, {
      "content-type": mime,
      "content-length": String(file.size),
      "content-disposition": `${shown ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "cache-control": "private, no-cache",
      // A file is shown as a picture, a PDF or text, or saved. It never runs as a page of the home.
      "content-security-policy": "sandbox; default-src 'none'",
      "x-content-type-options": "nosniff",
    });
  });

  app.put("/v1/folders/:id/file", async (c) => {
    const folder = home.folders.byId(c.req.param("id"));
    if (!folder) return notFound(c, "folder");
    const path = c.req.query("path") ?? "";
    if (Number(c.req.header("content-length") ?? 0) > DROPPED_BYTES)
      return fail(c, 413, "too_large", "This file is too large to put here.");
    try {
      const bytes = new Uint8Array(await c.req.arrayBuffer());
      if (bytes.byteLength > DROPPED_BYTES)
        return fail(c, 413, "too_large", "This file is too large to put here.");
      await home.folders.put(folder, path, bytes);
      return c.json(home.folders.entries(folder, parentOf(path)));
    } catch (error) {
      return folderProblem(c, error);
    }
  });

  app.post("/v1/folders/:id/edit", async (c) => {
    const folder = home.folders.byId(c.req.param("id"));
    if (!folder) return notFound(c, "folder");
    const edit = FolderEdit.parse(await c.req.json());
    try {
      await home.folders.edit(folder, edit);
      return c.body(null, 204);
    } catch (error) {
      return folderProblem(c, error);
    }
  });

  app.get("/v1/folders/:id/activity", (c) => {
    if (!home.folders.byId(c.req.param("id"))) return notFound(c, "folder");
    return c.json({ activity: home.folders.activity(c.req.param("id")) });
  });

  app.post("/v1/folders/:id/undo", async (c) => {
    const { activityId, index } = UndoFolderChange.parse(await c.req.json());
    try {
      home.folders.undo(c.req.param("id"), activityId, index);
      return c.json({ activity: home.folders.activity(c.req.param("id")) });
    } catch (error) {
      return folderProblem(c, error);
    }
  });

  // ── The person's avatar ───────────────────────────────────────────────────

  app.get("/v1/avatar", (c) => c.json({ avatar: home.avatars.get() }));

  app.put("/v1/avatar", async (c) => {
    const avatar = Avatar.parse(await c.req.json());
    home.avatars.set(avatar);
    return c.json({ avatar });
  });

  app.delete("/v1/avatar", (c) => {
    home.avatars.set(null);
    return c.body(null, 204);
  });

  app.post("/v1/avatar/from-selfie", async (c) => {
    const { fileId, anywhere } = z
      .object({ fileId: z.string(), anywhere: z.boolean().optional() })
      .parse(await c.req.json());
    try {
      return c.json(await home.avatars.fromSelfie(fileId, anywhere === true));
    } catch (error) {
      if (error instanceof NotAPicture)
        return fail(c, 400, "invalid", "This file is not a picture. Take a photo or choose one.");
      if (error instanceof LeavesHome) {
        return fail(
          c,
          409,
          "leaves_home",
          `No model on your computer sees pictures. ${error.models.join(" or ")} can look at it, but the picture then leaves your computer.`,
          { models: error.models },
        );
      }
      if (error instanceof NoPictureModel) {
        return c.json(
          {
            error: "no_model",
            message:
              "No model that sees pictures answers right now. Start Ollama with a vision model, or try again later.",
          },
          503,
        );
      }
      throw error;
    }
  });

  app.get("/v1/avatar.png", (c) => {
    const avatar = home.avatars.get();
    if (!avatar) return notFound(c, "avatar");
    const degrees = Number(c.req.query("angle") ?? 30) || 0;
    const size = Math.max(32, Math.min(1024, Number(c.req.query("size") ?? 256) || 256));
    const view = c.req.query("view") === "head" ? "head" : "body";
    return c.body(new Uint8Array(home.avatars.png(avatar, degrees, size, view)), 200, {
      "content-type": "image/png",
      "cache-control": "private, no-cache",
    });
  });

  // ── Models ────────────────────────────────────────────────────────────────

  app.get("/v1/models", async (c) => {
    await home.models.refresh();
    return c.json(home.models.view());
  });

  app.post("/v1/consent", async (c) => {
    const { services } = AgreeToServices.parse(await c.req.json());
    await home.models.refresh();
    const known = new Set(home.models.view().services.map((service) => service.id));
    if (services.some((id) => !known.has(id)))
      return fail(c, 400, "invalid", "The Bot Server does not use one of these services.");
    agree(home.db, services, c.get("device").name);
    const view = home.models.view();
    home.events.emit({ type: "models.updated", models: view });
    return c.json(view);
  });

  app.delete("/v1/consent/:service", (c) => {
    takeBack(home.db, c.req.param("service"));
    const view = home.models.view();
    home.events.emit({ type: "models.updated", models: view });
    return c.json(view);
  });

  app.put("/v1/models/order", async (c) => {
    const { order } = z.object({ order: z.array(z.string()).max(20) }).parse(await c.req.json());
    home.models.setOrder(order);
    const view = home.models.view();
    home.events.emit({ type: "models.updated", models: view });
    return c.json(view);
  });

  // ── Setup ─────────────────────────────────────────────────────────────────

  app.get("/v1/setup", async (c) => c.json(await home.setup.view()));

  app.patch("/v1/setup", async (c) =>
    c.json(await home.setup.change(ChangeSetup.parse(await c.req.json()))),
  );

  // Test calls cost tokens: they run only when a device asks, and wait for their answers.
  app.post("/v1/setup/test", async (c) => {
    const { source } = TestSetup.parse(await c.req.json().catch(() => ({})));
    return c.json(await home.setup.test(source));
  });

  app.post("/v1/setup/gateway", async (c) => {
    const { provider } = SetupGateway.parse(await c.req.json());
    return c.json({ card: home.setup.gatewayCard(provider) });
  });

  app.post("/v1/setup/pairing", (c) => c.json(home.setup.pairing()));

  // The address at wizards.host: on only on the person's word, never on a hosted home.
  app.post("/v1/setup/address", async (c) => {
    const { on } = SwitchAddress.parse(await c.req.json());
    try {
      await home.tunnel.set(on);
    } catch (error) {
      if (error instanceof AddressRefused) return fail(c, 400, "refused", error.message);
      throw error;
    }
    return c.json(await home.setup.view());
  });

  // What the wizards think with, picked as in engenty wizards' studio. A hosted home has no
  // clients to install and no computer to sign in on.
  if (!isHosted(home.config)) {
    app.route("/v1/setup/local", sharedSetup(home));
  }

  // Ollama on this computer, used only on the person's word: its model takes much memory.
  app.post("/v1/setup/ollama", async (c) => {
    const { on } = SwitchOllama.parse(await c.req.json());
    try {
      return c.json(await home.setup.ollama(on));
    } catch (error) {
      if (error instanceof OllamaRefused) return fail(c, 400, "refused", error.message);
      throw error;
    }
  });

  // A model for Ollama on this computer, on the person's yes; it loads while the setup shows it.
  app.post("/v1/setup/pull", async (c) => {
    const { model } = PullSetup.parse(await c.req.json());
    try {
      return c.json(await home.setup.pull(model), 202);
    } catch (error) {
      if (error instanceof PullRefused) return fail(c, 400, "invalid", error.message);
      throw error;
    }
  });

  // ── Events ────────────────────────────────────────────────────────────────

  app.get("/v1/events", (c) =>
    streamSSE(c, async (stream) => {
      // The first line goes out at once, so the device sees the stream open before any event.
      await stream.write(": open\n\n");
      const lastId = Number(c.req.header("last-event-id") ?? Number.NaN);
      const queue: { id?: number; data: string }[] = [];
      let wake: (() => void) | undefined;
      const push = (id: number | undefined, event: unknown) => {
        queue.push({ id, data: JSON.stringify(event) });
        wake?.();
      };
      // A hand-off is for one device: no other device hears of it.
      const device = c.get("device");
      const deviceId = device.id;
      const forThis = (event: Event) =>
        event.type !== "handoff.updated" || event.handoff.deviceId === deviceId;
      // An agent's line carries what this device's admin has not read.
      const asSeen = (event: Event): Event =>
        event.type === "agent.updated" ? { ...event, agent: seenBy(event.agent, device) } : event;
      if (!Number.isNaN(lastId)) {
        const missed = home.events.since(lastId);
        if (missed) {
          for (const stored of missed)
            if (forThis(stored.event)) push(stored.id, asSeen(stored.event));
        } else push(undefined, { type: "reset" });
      }
      const unsubscribe = home.events.subscribe((stored) => {
        if (forThis(stored.event)) push(stored.id, asSeen(stored.event));
      });
      const unlisten = home.handoffs.listen(deviceId);
      const ping = setInterval(() => {
        // A device whose admin is gone is signed out; its stream ends with the next ping.
        if (!store.device(deviceId)) {
          open = false;
          wake?.();
          return;
        }
        void stream.write(": ping\n\n").catch(() => {});
      }, 20_000);
      let open = true;
      stream.onAbort(() => {
        open = false;
        wake?.();
      });
      try {
        while (open) {
          const next = queue.shift();
          if (!next) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = undefined;
            continue;
          }
          await stream.writeSSE(
            next.id === undefined ? { data: next.data } : { id: String(next.id), data: next.data },
          );
        }
      } finally {
        clearInterval(ping);
        unsubscribe();
        unlisten();
      }
    }),
  );

  return app;
}

function bearer(c: Context): string {
  const header = c.req.header("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}
