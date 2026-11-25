import { afterEach, describe, expect, it } from "vitest";
import { inOpenSpace, listenToStudio, spaceFrom } from "./studio";

const STUDIO = "https://studio.example";
const said = { type: "wizards.space", id: "spc_1", name: "Sales" };

describe("the studio's open space", () => {
  it("is taken from the studio's page", () => {
    expect(spaceFrom({ origin: STUDIO, data: said }, STUDIO)).toEqual({
      id: "spc_1",
      name: "Sales",
    });
  });

  it("is ignored from another origin", () => {
    expect(spaceFrom({ origin: "https://evil.example", data: said }, STUDIO)).toBeUndefined();
    expect(spaceFrom({ origin: `${STUDIO}.evil.example`, data: said }, STUDIO)).toBeUndefined();
  });

  it("is ignored where the home names no studio", () => {
    expect(spaceFrom({ origin: STUDIO, data: said }, undefined)).toBeUndefined();
  });

  it("is ignored when the message says something else", () => {
    for (const data of [
      null,
      "wizards.space",
      { type: "wizards.ready" },
      { type: "wizards.space", id: "spc_1" },
      { type: "wizards.space", id: 1, name: "Sales" },
      { type: "wizards.space", id: "", name: "Sales" },
      { type: "wizards.space", id: "spc_1", name: " " },
    ])
      expect(spaceFrom({ origin: STUDIO, data }, STUDIO)).toBeUndefined();
  });
});

/** A page as the listener meets it: its parent, and what was said to and in it. */
function page(framed: boolean) {
  const posted: { message: unknown; target: string }[] = [];
  const listeners = new Set<(event: MessageEvent) => void>();
  const parent = {
    postMessage: (message: unknown, target: string) => posted.push({ message, target }),
  };
  const own = {
    addEventListener: (_: string, heard: (event: MessageEvent) => void) => listeners.add(heard),
    removeEventListener: (_: string, heard: (event: MessageEvent) => void) =>
      listeners.delete(heard),
  } as unknown as Window;
  Object.assign(own, { parent: framed ? parent : own });
  const hear = (origin: string, data: unknown) => {
    for (const heard of listeners) heard({ origin, data } as MessageEvent);
  };
  return { own, posted, hear, listening: () => listeners.size };
}

describe("the page inside the studio's frame", () => {
  let stop = () => {};
  afterEach(() => stop());

  it("says it is ready to the studio's origin only, and sends the space it then hears", () => {
    const framed = page(true);
    stop = listenToStudio(STUDIO, framed.own);
    expect(framed.posted).toEqual([{ message: { type: "wizards.ready" }, target: STUDIO }]);
    expect(inOpenSpace()).toEqual({});

    framed.hear("https://evil.example", { ...said, id: "spc_x" });
    expect(inOpenSpace()).toEqual({});

    framed.hear(STUDIO, said);
    expect(inOpenSpace()).toEqual({ space: { id: "spc_1", name: "Sales" } });

    // The person opens another space in the studio.
    framed.hear(STUDIO, { type: "wizards.space", id: "spc_2", name: "Support" });
    expect(inOpenSpace()).toEqual({ space: { id: "spc_2", name: "Support" } });

    stop();
    expect(framed.listening()).toBe(0);
    expect(inOpenSpace()).toEqual({});
  });

  it("says nothing where no page frames it", () => {
    const alone = page(false);
    stop = listenToStudio(STUDIO, alone.own);
    expect(alone.posted).toEqual([]);
    expect(alone.listening()).toBe(0);
  });
});
