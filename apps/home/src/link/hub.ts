import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import {
  base64Of,
  type CallOptions,
  type ChatModel,
  generateFrom,
  type StreamPart,
  type StreamResult,
} from "@engenty/local-models/ollama";
import { levelOf } from "@engenty/tool-harness";
import type { ModelSource } from "@wizards-bot/protocol";
import { type WebSocket, WebSocketServer } from "ws";
import { runsHome } from "../group.ts";
import type { Home } from "../home.ts";
import {
  type ClientEvent,
  type ClientRun,
  clientModel,
  subscriptionOf,
} from "../models/client-model.ts";
import { clientSessions, type Engine, type RemoteSources } from "../models/models.ts";
import type { DeviceRecord } from "../store/store.ts";
import type { ToComputer, ToHome } from "./wire.ts";

interface Computer {
  device: DeviceRecord;
  socket: WebSocket;
  sources: ModelSource[];
}

interface Waiting {
  computer: string;
  part?: (part: StreamPart) => void;
  event?: (event: ClientEvent) => void;
  done?: () => void;
  failed: (error: Error) => void;
}

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "computer";

/** The home's end of the links: the person's other computers and the models they offer. */
export class LinkHub implements RemoteSources {
  private readonly computers = new Map<string, Computer>();
  private readonly waiting = new Map<string, Waiting>();
  private requests = 0;
  private readonly home: Home;

  constructor(home: Home) {
    this.home = home;
    home.models.remote = this;
  }

  /** Takes over WebSocket upgrades of `/v1/link` on the home's server. */
  attach(server: Server): void {
    const sockets = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (!request.url?.startsWith("/v1/link")) return socket.destroy();
      const header = request.headers.authorization ?? "";
      const device = this.home.store.deviceByToken(header.replace(/^bearer /i, "").trim());
      // A model of a group home answers for all of it: only who runs it adds one.
      if (device?.kind !== "computer" || !runsHome(device.person)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return socket.destroy();
      }
      sockets.handleUpgrade(request, socket, head, (ws) => this.connected(device, ws));
    });
  }

  sources(): ModelSource[] {
    return [...this.computers.entries()].flatMap(([key, computer]) =>
      computer.sources.map((source) => ({
        ...source,
        id: `${key}/${source.id}`,
        where: computer.device.name,
      })),
    );
  }

  engine(sourceId: string, model: string): Engine | undefined {
    const [key = "", source = ""] = sourceId.split("/");
    const computer = this.computers.get(key);
    const found = computer?.sources.find((candidate) => candidate.id === source);
    if (!computer || !found) return undefined;
    const ref = `${sourceId}:${model}`;
    if (found.kind !== "subscription") {
      const chat = this.model(key, source, model);
      return { ref, level: levelOf({ model, local: true }), model: () => chat };
    }
    const run: ClientRun = (turn, onEvent) =>
      new Promise<void>((resolve, reject) => {
        const id = this.nextId();
        this.waiting.set(id, { computer: key, event: onEvent, done: resolve, failed: reject });
        const { signal, ...rest } = turn;
        signal.addEventListener("abort", () => this.send(key, { t: "cancel", id }), { once: true });
        this.send(key, { t: "client.run", id, source, turn: rest });
      });
    return {
      ref,
      level: "high",
      steps: true,
      model: ({ mcpToken, conversationId }) =>
        clientModel({
          provider: sourceId,
          model,
          mcpToken,
          run,
          sessions: subscriptionOf(sourceId)?.resumes
            ? clientSessions(this.home.db, conversationId, sourceId)
            : undefined,
        }),
    };
  }

  /** A model of a linked computer: each answer is asked for over the link and streams back. */
  private model(key: string, source: string, model: string): ChatModel {
    const doStream = async ({
      abortSignal,
      headers: _headers,
      ...options
    }: CallOptions): Promise<StreamResult> => {
      const id = this.nextId();
      const stream = new ReadableStream<StreamPart>({
        start: (controller) => {
          const close = () => {
            this.waiting.delete(id);
            try {
              controller.close();
            } catch {}
          };
          this.waiting.set(id, {
            computer: key,
            part: (part) => controller.enqueue(part),
            done: close,
            failed: (error) => {
              controller.enqueue({ type: "error", error });
              close();
            },
          });
          abortSignal?.addEventListener(
            "abort",
            () => {
              this.send(key, { t: "cancel", id });
              close();
            },
            { once: true },
          );
          this.send(key, { t: "model.stream", id, source, model, options: portable(options) });
        },
      });
      return { stream };
    };
    return {
      specificationVersion: "v3",
      provider: `${key}/${source}`,
      modelId: model,
      supportedUrls: {},
      doStream,
      doGenerate: (options) => generateFrom(doStream, options),
    };
  }

  private connected(device: DeviceRecord, socket: WebSocket): void {
    let key = slug(device.name);
    const taken = this.computers.get(key);
    if (taken && taken.device.id !== device.id) key = `${key}-${device.id.slice(-4)}`;
    this.computers.get(key)?.socket.close();
    const computer: Computer = { device, socket, sources: [] };
    this.computers.set(key, computer);
    const alive = setInterval(() => socket.ping(), 25_000);
    const keeps = this.home.group.onRemoved((ids) => {
      if (ids.includes(device.id)) socket.close();
    });
    socket.on("message", (data) => {
      let message: ToHome;
      try {
        message = JSON.parse(String(data)) as ToHome;
      } catch {
        return;
      }
      this.received(computer, message);
    });
    socket.on("close", () => {
      clearInterval(alive);
      keeps();
      if (this.computers.get(key) !== computer) return;
      this.computers.delete(key);
      for (const [id, waiting] of this.waiting) {
        if (waiting.computer !== key) continue;
        this.waiting.delete(id);
        waiting.failed(new Error(`${device.name} went offline.`));
      }
      this.changed();
    });
    socket.on("error", () => socket.close());
  }

  private received(computer: Computer, message: ToHome): void {
    if (message.t === "sources") {
      computer.sources = message.sources;
      this.changed();
      return;
    }
    const waiting = this.waiting.get(message.id);
    if (!waiting) return;
    if (message.t === "model.part") waiting.part?.(message.part);
    else if (message.t === "client.event") waiting.event?.(message.event);
    else if (message.t === "client.done" || message.t === "model.end") {
      this.waiting.delete(message.id);
      waiting.done?.();
    } else if (message.t === "error") {
      this.waiting.delete(message.id);
      waiting.failed(new Error(message.message));
    }
  }

  private send(key: string, message: ToComputer): void {
    const computer = this.computers.get(key);
    if (!computer || computer.socket.readyState !== computer.socket.OPEN) {
      const id = "id" in message ? message.id : "";
      queueMicrotask(() => this.waiting.get(id)?.failed(new Error("The computer is offline.")));
      return;
    }
    computer.socket.send(JSON.stringify(message));
  }

  private nextId(): string {
    return `r${++this.requests}`;
  }

  private changed(): void {
    this.home.events.emit({ type: "models.updated", models: this.home.models.view() });
  }
}

/** A model call with its pictures as base64 text, so it travels as JSON. */
function portable<T extends { prompt: CallOptions["prompt"] }>(options: T): T {
  const prompt = options.prompt.map((message) =>
    message.role === "user"
      ? {
          ...message,
          content: message.content.map((part) =>
            part.type === "file" ? { ...part, data: base64Of(part.data) ?? "" } : part,
          ),
        }
      : message,
  );
  return { ...options, prompt };
}
