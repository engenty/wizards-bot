import WebSocket from "ws";
import type { Models } from "../models/models.ts";
import type { ToComputer, ToHome } from "./wire.ts";

/**
 * A computer's end of the link: it offers its own models (Ollama, the signed-in clients) to
 * the person's home and runs what the home asks for.
 */
export class LinkedComputer {
  private socket: WebSocket | undefined;
  private readonly runs = new Map<string, AbortController>();
  private retry = 1000;
  private stopped = false;
  private announced = "";
  private timer: NodeJS.Timeout | undefined;
  private readonly home: string;
  private readonly token: string;
  private readonly models: Models;
  private readonly log: (line: string) => void;

  constructor(options: {
    home: string;
    token: string;
    models: Models;
    log?: (line: string) => void;
  }) {
    this.home = options.home.replace(/\/+$/, "");
    this.token = options.token;
    this.models = options.models;
    this.log = options.log ?? (() => {});
    // A client on this computer reaches the home's tools at the home's own address.
    this.models.mcpUrl = `${this.home}/mcp`;
  }

  start(): void {
    this.connect();
    this.timer = setInterval(() => void this.announce(), 60_000);
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.socket?.close();
  }

  private connect(): void {
    if (this.stopped) return;
    const socket = new WebSocket(`${this.home.replace(/^http/, "ws")}/v1/link`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    this.socket = socket;
    socket.on("open", () => {
      this.retry = 1000;
      this.announced = "";
      this.log("Linked. This computer's models are offered to your home.");
      void this.announce(true);
    });
    socket.on("message", (data) => {
      try {
        void this.handle(JSON.parse(String(data)) as ToComputer);
      } catch {}
    });
    socket.on("unexpected-response", (_request, response) => {
      if (response.statusCode === 401) {
        this.log("The home does not know this computer any more. Link it again.");
        this.stopped = true;
      }
      socket.terminate();
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      for (const run of this.runs.values()) run.abort();
      this.runs.clear();
      if (this.stopped) return;
      this.log(`The home is out of reach. Trying again in ${Math.round(this.retry / 1000)} s.`);
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 60_000);
    });
  }

  private async announce(force = false): Promise<void> {
    await this.models.refresh(force);
    const sources = this.models.localSources();
    const text = JSON.stringify(sources);
    if (text === this.announced) return;
    this.announced = text;
    this.send({ t: "sources", sources });
  }

  private send(message: ToHome): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private async handle(message: ToComputer): Promise<void> {
    const fail = (error: unknown) =>
      this.send({
        t: "error",
        id: message.id,
        message: String((error as Error)?.message ?? error),
      });
    switch (message.t) {
      case "model.stream": {
        const model =
          message.source === "ollama" ? this.models.localChat(message.model) : undefined;
        if (!model) return fail("This model is not on the computer any more.");
        const abort = new AbortController();
        this.runs.set(message.id, abort);
        try {
          const { stream } = await model.doStream({
            ...message.options,
            abortSignal: abort.signal,
          });
          for await (const part of stream) {
            // An error is an object here; over the link it travels as its message.
            if (part.type === "error") return fail(part.error);
            this.send({ t: "model.part", id: message.id, part });
          }
          this.send({ t: "model.end", id: message.id });
        } catch (error) {
          fail(error);
        } finally {
          this.runs.delete(message.id);
        }
        return;
      }
      case "client.run": {
        const run = this.models.localClient(message.source);
        if (!run) return fail("This client is not on the computer any more.");
        const abort = new AbortController();
        this.runs.set(message.id, abort);
        try {
          await run({ ...message.turn, signal: abort.signal }, (event) =>
            this.send({ t: "client.event", id: message.id, event }),
          );
          this.send({ t: "client.done", id: message.id });
        } catch (error) {
          fail(error);
        } finally {
          this.runs.delete(message.id);
        }
        return;
      }
      case "cancel":
        this.runs.get(message.id)?.abort();
        return;
    }
  }
}
