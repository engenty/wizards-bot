import { describe, expect, it } from "vitest";
import { frameReader } from "./sse";

describe("frameReader", () => {
  it("gives a frame once its blank line has arrived", () => {
    const read = frameReader();
    expect(read('id: 412\ndata: {"type":"reset"}\n')).toEqual([]);
    expect(read("\n")).toEqual([{ id: "412", data: '{"type":"reset"}' }]);
  });

  it("reads several frames from one piece and keeps the unfinished rest", () => {
    const read = frameReader();
    expect(read('data: {"a":1}\n\nid: 7\ndata: {"b":2}\n\ndata: {"c"')).toEqual([
      { data: '{"a":1}' },
      { id: "7", data: '{"b":2}' },
    ]);
    expect(read(":3}\n\n")).toEqual([{ data: '{"c":3}' }]);
  });

  it("leaves out the home's comment lines", () => {
    const read = frameReader();
    expect(read(": still here\n\n")).toEqual([]);
  });

  it("keeps a space the text itself starts with", () => {
    const read = frameReader();
    expect(read('data: {"text":" free"}\n\n')).toEqual([{ data: '{"text":" free"}' }]);
    expect(read("data:  two\n\n")).toEqual([{ data: " two" }]);
  });

  it("reads lines that end in CR LF, also when a piece ends between the two", () => {
    const read = frameReader();
    expect(read("id: 1\r\ndata: x\r\n\r")).toEqual([]);
    expect(read("\n")).toEqual([{ id: "1", data: "x" }]);
  });

  it("joins the data lines of one frame", () => {
    const read = frameReader();
    expect(read("data: a\ndata: b\n\n")).toEqual([{ data: "a\nb" }]);
  });
});
