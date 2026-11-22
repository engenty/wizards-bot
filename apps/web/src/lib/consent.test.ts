import type { ModelService } from "@wizards-bot/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "./api";
import { consentAsk, withConsent } from "./consent";

const OPENROUTER: ModelService = {
  id: "openrouter",
  label: "OpenRouter",
  sources: ["OpenRouter"],
  inUse: true,
};

/** A home that refuses the first message until it heard a yes, and records what it was sent. */
function home() {
  const calls: { path: string; body: unknown }[] = [];
  let agreed = false;
  vi.stubGlobal("fetch", async (path: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path, body });
    if (path === "/v1/consent") {
      agreed = true;
      return new Response(JSON.stringify({ sources: [], order: [], services: [] }));
    }
    if (!agreed) {
      return new Response(
        JSON.stringify({ error: "needs_consent", message: "…", services: [OPENROUTER] }),
        { status: 409 },
      );
    }
    return new Response(JSON.stringify({ message: { id: "msg_1" } }), { status: 202 });
  });
  return calls;
}

const send = async () => {
  const { api } = await import("./api");
  return api.post<{ message: { id: string } }>("/v1/conversations/cnv_1/messages", {
    text: "My dentist is on Friday.",
  });
};

/** Waits until the question is on screen, then answers it. */
async function answer(yes: boolean) {
  await vi.waitFor(() => expect(consentAsk()).not.toBeNull());
  expect(consentAsk()?.services).toEqual([OPENROUTER]);
  consentAsk()?.answer(yes);
}

describe("the yes before a message goes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks, tells the home the yes, then sends the message again", async () => {
    const calls = home();
    const seen = vi.fn();
    const sent = withConsent(send, seen);
    await answer(true);
    expect((await sent).message.id).toBe("msg_1");
    expect(calls.map((call) => call.path)).toEqual([
      "/v1/conversations/cnv_1/messages",
      "/v1/consent",
      "/v1/conversations/cnv_1/messages",
    ]);
    expect(calls[1]?.body).toEqual({ services: ["openrouter"] });
    expect(seen).toHaveBeenCalledOnce();
    expect(consentAsk()).toBeNull();
  });

  it("sends nothing more without a yes, and says the message was not sent", async () => {
    const calls = home();
    const sent = withConsent(send);
    await answer(false);
    await expect(sent).rejects.toBeInstanceOf(ApiError);
    await expect(sent).rejects.toThrow(/not sent|nicht gesendet/);
    expect(calls.map((call) => call.path)).toEqual(["/v1/conversations/cnv_1/messages"]);
  });

  it("leaves any other refusal as it is", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ error: "invalid", message: "No." }), { status: 400 }),
    );
    await expect(withConsent(send)).rejects.toThrow("No.");
    expect(consentAsk()).toBeNull();
  });
});
