import { onlineManager, QueryClient } from "@tanstack/react-query";
import type { Agent } from "@wizards-bot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keys } from "./keys";
import { readEvents } from "./stream";

const agent: Agent = {
  id: "agt_1",
  name: "Goose",
  kind: "round",
  about: "",
  origin: "own",
  state: "idle",
  open: 0,
  conversationId: "cnv_1",
  preview: "",
  unread: 0,
  updatedAt: "2026-11-21T09:12:00.000Z",
  main: true,
};

/** A stream the test feeds piece by piece and ends when it likes. */
function feed() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  return {
    body,
    say: (text: string) => controller?.enqueue(encoder.encode(text)),
    end: () => controller?.close(),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("readEvents", () => {
  it("comes back after a break, names the last event it got and loads the lists again", async () => {
    vi.useFakeTimers();
    const first = feed();
    const second = feed();
    const asked: Headers[] = [];
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      asked.push(new Headers(init.headers));
      return Promise.resolve(new Response(asked.length === 1 ? first.body : second.body));
    });
    const client = new QueryClient();
    client.setQueryData<Agent[]>(keys.agents(), [agent]);
    const seen: string[] = [];
    const stop = new AbortController();
    const reading = readEvents(client, stop.signal, (event) => seen.push(event.type));

    await vi.advanceTimersByTimeAsync(0);
    expect(onlineManager.isOnline()).toBe(true);
    expect(asked[0]?.has("last-event-id")).toBe(false);

    const working = JSON.stringify({
      type: "agent.updated",
      agent: { ...agent, state: "working" },
    });
    first.say(`id: 7\ndata: ${working}\n\n`);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["agent.updated"]);
    expect(client.getQueryData<Agent[]>(keys.agents())?.[0]?.state).toBe("working");

    // The stream breaks: the home counts as out of reach until the next try, a second later.
    first.end();
    await vi.advanceTimersByTimeAsync(0);
    expect(onlineManager.isOnline()).toBe(false);
    expect(asked).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(asked).toHaveLength(2);
    expect(asked[1]?.get("last-event-id")).toBe("7");
    expect(onlineManager.isOnline()).toBe(true);
    expect(client.getQueryState(keys.agents())?.isInvalidated).toBe(true);

    // A line that is no JSON is passed over; the event after it still arrives.
    second.say('data: {"type":\n\ndata: {"type":"reset"}\n\n');
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["agent.updated", "reset"]);

    stop.abort();
    second.end();
    await vi.advanceTimersByTimeAsync(0);
    await reading;
  });

  it("waits longer after each try that fails", async () => {
    vi.useFakeTimers();
    let tries = 0;
    vi.stubGlobal("fetch", () => {
      tries += 1;
      return Promise.reject(new TypeError("no route to the home"));
    });
    const stop = new AbortController();
    const reading = readEvents(new QueryClient(), stop.signal, () => undefined);

    await vi.advanceTimersByTimeAsync(0);
    expect(tries).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(tries).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(tries).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(tries).toBe(3);

    stop.abort();
    await vi.advanceTimersByTimeAsync(0);
    await reading;
  });
});
