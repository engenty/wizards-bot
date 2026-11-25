import { expect, it } from "vitest";
import { eventsIn } from "./terminal";

it("reads a terminal's events from the stream, and nothing from a heartbeat", () => {
  expect(eventsIn('event: data\ndata: {"type":"data","data":"a\\nb"}')).toEqual([
    { type: "data", data: "a\nb" },
  ]);
  expect(eventsIn('event: exit\ndata: {"type":"exit","code":0}')).toEqual([
    { type: "exit", code: 0 },
  ]);
  expect(eventsIn("event: ping\ndata: ")).toEqual([]);
});
