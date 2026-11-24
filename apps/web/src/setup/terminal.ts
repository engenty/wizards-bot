import type { TerminalEvent } from "@engenty/model-setup";
import { api } from "../lib/api";

/**
 * Follows a terminal of the Bot Server until its end. With fetch, as the event stream is: an
 * EventSource sends no token.
 */
export function followTerminal(path: string, on: (event: TerminalEvent) => void): () => void {
  const stop = new AbortController();
  void (async () => {
    const response = await api.open(path, {
      headers: { accept: "text/event-stream" },
      signal: stop.signal,
    });
    const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
    let rest = "";
    while (reader) {
      const { value, done } = await reader.read();
      if (done) return;
      rest += value;
      const blocks = rest.split("\n\n");
      rest = blocks.pop() ?? "";
      for (const event of blocks.flatMap(eventsIn)) on(event);
    }
  })().catch(() => {
    // The stream ended with the terminal or with the page.
  });
  return () => stop.abort();
}

/** The terminal events in one block of the stream; a heartbeat has none. */
export function eventsIn(block: string): TerminalEvent[] {
  const data = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("\n");
  return data ? [JSON.parse(data) as TerminalEvent] : [];
}
