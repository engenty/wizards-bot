import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { Message } from "@wizards-bot/protocol";
import { z } from "zod";
import { newToken } from "../ids.ts";
import { type TestHome, testHome } from "../test/fakes.ts";
import { Draft } from "./draft.ts";
import { type Asking, bridgedTools, defineTool, ENDS_TURN } from "./tool.ts";

// A subscription's client reaches a turn's tools at the home's `/mcp` with the turn's token:
// the bridge of @engenty/local-models, the home's tools, lines and cards.

describe("the turn's tools over MCP", () => {
  let t: TestHome;
  before(async () => {
    t = await testHome("Ada");
  });
  after(() => t.stop());

  const tools = [
    defineTool({
      name: "add",
      description: "Adds two numbers.",
      input: z.object({ a: z.number(), b: z.number() }),
      label: () => "Adding",
      run: async ({ a, b }) => String(a + b),
    }),
    defineTool({
      name: "look",
      description: "Looks at the screen.",
      input: z.object({}),
      run: async () => ({
        text: "The screen:",
        pictures: [{ name: "screen", mime: "image/png", base64: "iVBORw0KGgo=" }],
      }),
    }),
    defineTool({
      name: "broken",
      description: "Fails.",
      input: z.object({}),
      run: async () => {
        throw new Error("The folder is gone.");
      },
    }),
    defineTool({
      name: "ask",
      description: "Asks the person.",
      input: z.object({}),
      asks: true,
      run: async (_input, call) =>
        call.ask({
          kind: "question",
          level: "needs_you",
          title: "Which one?",
          actions: [{ id: "this", label: "This one", style: "primary" }],
        }),
    }),
  ];

  /** A turn's message and its tools on the bridge, as `Turn.parts` opens them. */
  function openTurn() {
    const { home } = t;
    const agent = home.store.mainAgent();
    const message = home.store.addMessage({
      conversationId: agent.conversationId,
      role: "agent",
      agentId: agent.id,
      channel: "home",
      parts: [],
      state: "streaming",
    });
    const draft = new Draft(home.store, message);
    const asking: Asking = {
      card: (tool, input, card, kept) => {
        const made = home.store.createCard(
          { ...card, payload: { type: "tool", tool: tool.name, input, kept } },
          { agentId: agent.id, conversationId: agent.conversationId, messageId: draft.id },
        );
        draft.add({ type: "card", card: made });
        return made;
      },
    };
    const token = newToken();
    const bridge = home.mcp.open(bridgedTools(tools, draft, asking), { token });
    const parts = () =>
      (home.store.messages(agent.conversationId, { limit: 1 }).messages[0] as Message).parts;
    return { token, bridge, parts };
  }

  async function connect(token: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(`${t.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    return client;
  }

  const textOf = (result: { content?: unknown }) =>
    (result.content as { type: string; text?: string }[])[0]?.text ?? "";

  test("lists the turn's tools and runs them as lines of the message", async () => {
    const { token, bridge, parts } = openTurn();
    const client = await connect(token);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      "add",
      "ask",
      "broken",
      "look",
    ]);
    const sum = await client.callTool({ name: "add", arguments: { a: 2, b: 3 } });
    assert.equal(textOf(sum), "5");
    assert.deepEqual(parts(), [{ type: "activity", label: "Adding", state: "done" }]);

    const looked = await client.callTool({ name: "look", arguments: {} });
    assert.deepEqual(looked.content, [
      { type: "text", text: "The screen:" },
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ]);

    const broken = await client.callTool({ name: "broken", arguments: {} });
    assert.equal(broken.isError, true);
    assert.equal(textOf(broken), "The folder is gone.");
    assert.deepEqual(parts().at(-1), { type: "activity", label: "broken", state: "failed" });
    await client.close();
    bridge.close();
  });

  test("puts the card of a tool that asks into the message and tells the client to end its turn", async () => {
    const { token, bridge, parts } = openTurn();
    const client = await connect(token);
    const asked = await client.callTool({ name: "ask", arguments: {} });
    assert.equal(textOf(asked), ENDS_TURN);
    const card = parts().find((part) => part.type === "card");
    assert.equal(card?.type === "card" && card.card.title, "Which one?");
    await client.close();
    bridge.close();
  });

  test("closes with the turn, and a token of another turn opens nothing", async () => {
    const { token, bridge } = openTurn();
    bridge.close();
    const rpc = (bearer: string) =>
      fetch(`${t.url}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    assert.equal((await rpc(token)).status, 404);
    assert.equal((await rpc("not-a-turn")).status, 404);
  });
});
