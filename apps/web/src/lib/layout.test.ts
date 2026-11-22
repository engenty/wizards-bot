import { describe, expect, it } from "vitest";
import { sidebar, split } from "./layout";

describe("the list of agents", () => {
  it("is out of sight on a phone, a column of figures on an upright tablet, open on a wide window", () => {
    expect(sidebar(390, false, false)).toBe("none");
    expect(sidebar(834, false, false)).toBe("rail");
    expect(sidebar(1180, false, false)).toBe("open");
  });

  it("stays closed when the person closed it", () => {
    expect(sidebar(1440, false, true)).toBe("rail");
  });

  it("gives way to a document where the three do not fit", () => {
    expect(sidebar(1180, true, false)).toBe("rail");
    // Where the column of figures would push a document over the chat, it gives way.
    expect(sidebar(800, true, false)).toBe("none");
    expect(sidebar(800, false, false)).toBe("rail");
    expect(sidebar(1280, true, false)).toBe("open");
  });
});

describe("the chat beside a document", () => {
  it("lies under the document where both do not fit", () => {
    expect(split(700, null)).toBe("over");
  });

  it("is as wide as a large phone until the document is as wide as an upright tablet", () => {
    expect(split(1000, null)).toEqual({ chat: 432, pane: 568 });
    expect(split(1200, null)).toEqual({ chat: 432, pane: 768 });
    expect(split(1500, null)).toEqual({ chat: 732, pane: 768 });
  });

  it("gets narrower than that only to leave the document its least width", () => {
    expect(split(800, null)).toEqual({ chat: 400, pane: 400 });
  });

  it("takes the width the person chose, within what both need", () => {
    expect(split(1200, 600)).toEqual({ chat: 600, pane: 600 });
    expect(split(1200, 100)).toEqual({ chat: 352, pane: 848 });
    expect(split(1200, 2000)).toEqual({ chat: 800, pane: 400 });
  });
});
