import type { Setup, SetupCheck } from "@wizards-bot/protocol";
import { describe, expect, it } from "vitest";
import { canGoOn, needsSetup, stepsOf, testable, testedAt, testing, testOnOpen } from "./steps";

const check = (id: string, more: Partial<SetupCheck> = {}): SetupCheck => ({
  id,
  kind: "model",
  label: id,
  state: "untested",
  said: "",
  ...more,
});

const setup = (more: Partial<Setup> = {}): Setup => ({
  done: false,
  name: { value: "Ada", confirmed: false },
  working: false,
  hasModel: true,
  models: [check("claude"), check("ollama", { state: "absent" })],
  home: [],
  capabilities: [],
  ...more,
});

describe("when the setup opens", () => {
  it("opens on a home nobody set up, and on one without a model", () => {
    expect(needsSetup(setup())).toBe(true);
    expect(needsSetup(setup({ done: true }))).toBe(false);
    expect(needsSetup(setup({ done: true, hasModel: false }))).toBe(true);
  });

  it("asks the name only while the person has not said it", () => {
    expect(stepsOf(setup())).toEqual(["name", "models", "abilities", "devices"]);
    expect(stepsOf(setup({ name: { value: "Ada", confirmed: true } }))).toEqual([
      "models",
      "abilities",
      "devices",
    ]);
  });

  it("shows only the models on a home set up before", () => {
    expect(stepsOf(setup({ done: true, hasModel: false }))).toEqual(["models"]);
  });
});

describe("going on", () => {
  it("needs a name, then a model that answered; the rest does not hold the person", () => {
    expect(canGoOn("name", setup(), "  ")).toBe(false);
    expect(canGoOn("name", setup(), "Ada")).toBe(true);
    expect(canGoOn("models", setup())).toBe(false);
    expect(canGoOn("models", setup({ working: true }))).toBe(true);
    expect(canGoOn("abilities", setup())).toBe(true);
    expect(canGoOn("devices", setup())).toBe(true);
  });
});

describe("test calls", () => {
  it("are made when the models step opens only if none was made", () => {
    expect(testOnOpen(setup())).toBe(true);
    expect(testOnOpen(setup({ models: [check("claude", { at: "2026-11-22T10:00:00Z" })] }))).toBe(
      false,
    );
    expect(testOnOpen(setup({ models: [check("claude", { state: "testing" })] }))).toBe(false);
  });

  it("can be made again for the models of this computer and the gateways", () => {
    expect(testable(check("claude", { state: "problem" }))).toBe(true);
    expect(testable(check("ollama", { state: "absent" }))).toBe(true);
    expect(testable(check("codex", { state: "absent" }))).toBe(false);
    expect(testable(check("mac/claude", { state: "ok" }))).toBe(false);
    expect(testable(check("claude", { state: "testing" }))).toBe(false);
    expect(testable(check("data", { kind: "data", state: "warning" }))).toBe(false);
  });

  it("say whether one runs, and when the newest ran", () => {
    expect(testing(setup({ models: [check("claude", { state: "testing" })] }))).toBe(true);
    expect(testing(setup())).toBe(false);
    expect(
      testedAt(
        setup({
          models: [
            check("claude", { at: "2026-11-22T10:00:00Z" }),
            check("ollama", { at: "2026-11-22T11:00:00Z" }),
          ],
        }),
      ),
    ).toBe("2026-11-22T11:00:00Z");
  });
});
