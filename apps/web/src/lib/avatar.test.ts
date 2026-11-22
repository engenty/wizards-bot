import { DEFAULT_AVATAR, GARMENT, HAIR, SKIN } from "@wizards-bot/avatar";
import { describe, expect, it } from "vitest";
import { cssColor, GARMENT_NAMES, HAIR_NAMES, SKIN_NAMES, sameAvatar } from "./avatar";

describe("cssColor", () => {
  it("writes a palette colour with all six digits", () => {
    expect(cssColor(0xe0531b)).toBe("#e0531b");
    expect(cssColor(0x00a0ff)).toBe("#00a0ff");
  });
});

describe("sameAvatar", () => {
  it("is true for the same traits, whatever order they were written in", () => {
    const { shoes, skin, ...rest } = DEFAULT_AVATAR;
    expect(sameAvatar(DEFAULT_AVATAR, { shoes, ...rest, skin })).toBe(true);
  });

  it("is false once one trait differs, also a colour inside a trait", () => {
    expect(sameAvatar(DEFAULT_AVATAR, { ...DEFAULT_AVATAR, beard: "full" })).toBe(false);
    expect(
      sameAvatar(DEFAULT_AVATAR, { ...DEFAULT_AVATAR, top: { style: "tee", color: "teal" } }),
    ).toBe(false);
    expect(
      sameAvatar(DEFAULT_AVATAR, { ...DEFAULT_AVATAR, shoes: { style: "boots", color: "white" } }),
    ).toBe(false);
  });
});

describe("the names of the colours", () => {
  it("are offered in the order of the engine's palettes", () => {
    expect(Object.keys(SKIN_NAMES)).toEqual(Object.keys(SKIN));
    expect(Object.keys(HAIR_NAMES)).toEqual(Object.keys(HAIR));
    expect(Object.keys(GARMENT_NAMES)).toEqual(Object.keys(GARMENT));
  });
});
