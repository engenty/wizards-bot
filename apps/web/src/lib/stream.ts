import { onlineManager, type QueryClient } from "@tanstack/react-query";
import type { Event } from "@wizards-bot/protocol";
import { useEffect, useSyncExternalStore } from "react";
import { ApiError, api } from "./api";
import { applyEvent } from "./events";
import { keys } from "./keys";
import { frameReader } from "./sse";

/** `connecting`: not reached yet. `live`: the stream stands. `away`: the home is out of reach. */
export type Link = "connecting" | "live" | "away";

const listeners = new Set<() => void>();
let link: Link = "connecting";

// The home in reach is what "online" means to the lists: they wait for the stream before they
// load, so no event falls between a list and the stream, and they load again when it is back.
onlineManager.setEventListener(() => undefined);
onlineManager.setOnline(false);

function setLink(next: Link) {
  link = next;
  onlineManager.setOnline(next === "live");
  for (const listener of listeners) {
    listener();
  }
}

/** How the home is reached right now. */
export function useLink(): Link {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => link,
  );
}

/** Whether a list is on its way from the home; a file's bytes are no list. */
function loading(client: QueryClient): boolean {
  return (
    client.getQueryCache().findAll({
      predicate: (query) =>
        query.queryKey[0] !== keys.file("")[0] && query.state.fetchStatus !== "idle",
    }).length > 0
  );
}

/** Resolves once no list is on its way, so an event never meets a list the home is still sending. */
function settled(client: QueryClient): Promise<void> {
  return new Promise((resolve) => {
    const stop = client.getQueryCache().subscribe(() => {
      if (!loading(client)) {
        stop();
        resolve();
      }
    });
  });
}

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

/**
 * Reads the home's event stream into the lists and keeps reading it: after a break it waits a
 * little longer each time, names the last event it got, and loads the lists again, because
 * text that was being written is not sent twice.
 */
export async function readEvents(
  client: QueryClient,
  signal: AbortSignal,
  onEvent: (event: Event) => void,
) {
  let lastId: string | undefined;
  let wait = 1000;
  let again = false;
  while (!signal.aborted) {
    try {
      const res = await api.open("/v1/events", {
        signal,
        headers: lastId ? { "last-event-id": lastId } : {},
      });
      if (!res.body) {
        throw new Error("no stream");
      }
      wait = 1000;
      if (again) {
        void client.invalidateQueries();
      }
      again = true;
      setLink("live");
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      const frames = frameReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        for (const frame of frames(value)) {
          if (loading(client)) {
            await settled(client);
          }
          if (frame.id) {
            lastId = frame.id;
          }
          let event: Event;
          try {
            event = JSON.parse(frame.data);
          } catch {
            continue;
          }
          applyEvent(client, event);
          onEvent(event);
        }
      }
    } catch (err) {
      // The home no longer knows this device: the page goes back to pairing.
      if (signal.aborted || (err instanceof ApiError && err.status === 401)) {
        return;
      }
    }
    if (signal.aborted) {
      return;
    }
    setLink("away");
    await pause(wait, signal);
    wait = Math.min(wait * 2, 15_000);
  }
}

/** Keeps the lists current from the home's events for as long as the component is shown. */
export function useEvents(client: QueryClient, onEvent: (event: Event) => void) {
  useEffect(() => {
    const controller = new AbortController();
    void readEvents(client, controller.signal, onEvent);
    return () => {
      controller.abort();
      setLink("connecting");
    };
  }, [client, onEvent]);
}
