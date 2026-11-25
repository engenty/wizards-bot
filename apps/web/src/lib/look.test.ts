import { describe, expect, it } from "vitest";
import { chatLook, lookFrom, PLAIN_LOOK, showLook } from "./look";

describe("how the chat looks", () => {
  it("is the plain one where nothing was picked", () => {
    expect(chatLook()).toEqual(PLAIN_LOOK);
    expect(lookFrom(null)).toEqual(PLAIN_LOOK);
  });

  it("takes the plain value for one it does not know", () => {
    expect(lookFrom({ view: "bubbles", tools: "loud" })).toEqual({
      view: "bubbles",
      tools: "summary",
    });
  });

  it("is drawn as picked", () => {
    showLook({ view: "bubbles", tools: "none" });
    expect(chatLook()).toEqual({ view: "bubbles", tools: "none" });
    showLook(PLAIN_LOOK);
  });
});
