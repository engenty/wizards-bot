import type { SetupChoice } from "@engenty/model-setup/react";
import type { ModelSource, Models, Setup } from "@wizards-bot/protocol";
import { describe, expect, it } from "vitest";
import { modelInUse, orderWithFirst, placeOf, sourceName, sourceRows, testResult } from "./sources";

const source = (id: string, kind: ModelSource["kind"], ...models: string[]): ModelSource => ({
  id,
  kind,
  label: id,
  where: "Mac",
  online: true,
  models: models.map((model) => ({ id: model, label: model })),
});

const claude = { ...source("claude", "subscription", "default", "opus"), label: "Claude" };
const cursor = source("cursor", "subscription", "default");
const ollama = source("ollama", "ollama", "qwen3:8b", "gemma4:12b");

const models: Models = {
  sources: [claude, cursor, ollama],
  order: ["ollama:gemma4:12b"],
  current: "ollama:gemma4:12b",
  answers: ["ollama:gemma4:12b", "claude:default", "ollama:qwen3:8b"],
  services: [],
};

const choice = (id: string, more = false): SetupChoice => ({
  id,
  title: id,
  description: "",
  ...(more ? { more } : {}),
});

describe("the model sources of the settings", () => {
  it("name a client with its provider, also one of a linked computer", () => {
    expect(sourceName(claude)).toBe("Anthropic Claude Code");
    expect(sourceName({ ...claude, id: "mini/codex" })).toBe("OpenAI Codex");
    expect(sourceName({ id: "openai", kind: "gateway", label: "OpenAI" })).toBe("OpenAI");
  });

  it("say which model of a source answers and where the source stands", () => {
    expect(modelInUse(models, "ollama")).toBe("gemma4:12b");
    expect(modelInUse(models, "cursor")).toBeUndefined();
    expect(placeOf(models, "claude")).toBe(1);
    expect(placeOf(models, "cursor")).toBe(-1);
  });

  it("put a source first on the model it has, and keep the others' order", () => {
    expect(orderWithFirst(models, ollama)).toEqual(["ollama:gemma4:12b"]);
    expect(orderWithFirst(models, claude)).toEqual(["claude:default", "ollama:gemma4:12b"]);
    // One that is named and does not answer right now keeps its name.
    const named = { ...models, order: ["claude:opus", "ollama:gemma4:12b"], answers: [] };
    expect(orderWithFirst(named, claude)).toEqual(["claude:opus", "ollama:gemma4:12b"]);
    expect(orderWithFirst(named, source("mlx", "mlx"))).toBeUndefined();
  });

  it("list what can answer, and the rest by the setup's rule", () => {
    const { first, rest } = sourceRows(models, [
      choice("claude"),
      choice("cursor", true),
      choice("antigravity", true),
      choice("ollama", true),
      choice("lmstudio"),
      choice("own"),
    ]);
    // Ollama is in use: it stays, whatever the setup found of it.
    expect(first.map((row) => row.id)).toEqual(["claude", "ollama", "lmstudio", "own"]);
    expect(rest.map((row) => [row.id, Boolean(row.source)])).toEqual([
      ["cursor", true],
      ["antigravity", false],
    ]);
  });

  it("tell what a test call of one source came to", () => {
    const check = { kind: "model" as const, label: "Ollama", said: "No.", todo: "Start Ollama." };
    const setup = {
      models: [
        { ...check, id: "ollama", state: "problem" },
        { ...check, id: "claude", label: "Claude Code", state: "ok", model: "opus" },
      ],
    } as Setup;
    expect(testResult(setup, "claude", 5)).toEqual({ ok: true, ref: "opus", reply: "OK", ms: 5 });
    expect(testResult(setup, "ollama", 5)).toEqual({
      ok: false,
      error: "No. Start Ollama.",
      ms: 5,
    });
  });
});
