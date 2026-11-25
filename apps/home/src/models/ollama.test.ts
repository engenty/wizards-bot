import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { CallOptions } from "@engenty/local-models/ollama";
import { Secrets } from "../identity.ts";
import { Db } from "../store/db.ts";
import { Models } from "./models.ts";
import { chatModels } from "./ollama.ts";

const INKLING = "inkling-2-mini:latest";
const QWEN = "qwen3.8:27b-mlx";
const SMALL = "llama2:7b";
const GB = 2 ** 30;

// What Ollama reports on a Mac once Inkling 2 Mini is pulled: two chat models that take
// tools, pictures and thinking, one that only talks, and two models that do not chat.
const LIBRARY: Record<string, { size: number; capabilities: string[] }> = {
  "embeddinggemma-2:740m": { size: 1_325_205_612, capabilities: ["embedding", "vision", "audio"] },
  "clef-flash:latest": { size: 12_387_093_750, capabilities: ["decision", "vision"] },
  [SMALL]: { size: 3_826_793_677, capabilities: ["completion"] },
  [QWEN]: { size: 18_174_721_847, capabilities: ["completion", "vision", "tools", "thinking"] },
  [INKLING]: { size: 20_188_097_271, capabilities: ["completion", "vision", "tools", "thinking"] },
};

// One answer as Ollama streams it: what the model thinks, what it says, the tool it calls.
const ANSWER = [
  { message: { role: "assistant", content: "", thinking: "The person asks for the weather." } },
  { message: { role: "assistant", content: "Looking " } },
  { message: { role: "assistant", content: "it up." } },
  {
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{ function: { name: "weather", arguments: { city: "Kraków" } } }],
    },
  },
  { done: true, done_reason: "stop", prompt_eval_count: 120, eval_count: 14 },
];

const PICTURE = Buffer.from("a picture").toString("base64");

const CALL: CallOptions = {
  prompt: [
    { role: "system", content: "You are Ada's agent." },
    {
      role: "user",
      content: [
        { type: "text", text: "What is the weather where this was taken?" },
        { type: "file", mediaType: "image/png", data: PICTURE, filename: "square.png" },
      ],
    },
  ],
  tools: [
    {
      type: "function",
      name: "weather",
      description: "The weather in a city.",
      inputSchema: { type: "object", properties: { city: { type: "string" } } },
    },
  ],
};

interface ChatRequest {
  model: string;
  think: boolean;
  messages: { role: string; content: string; images?: string[] }[];
  tools?: { function: { name: string } }[];
  options: { num_ctx: number };
}

describe("an Ollama with Inkling 2 Mini pulled", () => {
  let server: Server;
  let url = "";
  let db: Db;
  let models: Models;
  const requests: ChatRequest[] = [];

  before(async () => {
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        if (request.url === "/api/tags") {
          const tags = Object.entries(LIBRARY).map(([name, { size }]) => ({
            name,
            size,
            digest: `sha256:${name}`,
          }));
          return response.end(JSON.stringify({ models: tags }));
        }
        if (request.url === "/api/ps") {
          return response.end(JSON.stringify({ models: [] }));
        }
        if (request.url === "/api/show") {
          const { model } = JSON.parse(body) as { model: string };
          return response.end(JSON.stringify({ capabilities: LIBRARY[model]?.capabilities }));
        }
        requests.push(JSON.parse(body) as ChatRequest);
        response.end(`${ANSWER.map((line) => JSON.stringify(line)).join("\n")}\n`);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const dataDir = mkdtempSync(join(tmpdir(), "wizards-bot-ollama-"));
    db = new Db(dataDir);
    models = new Models(
      { dataDir, port: 0, publicUrl: undefined, ollamaUrl: url, subscriptions: [] },
      db,
      new Secrets(db, dataDir),
      "Ada's Mac",
    );
    models.memory = 64 * GB;
    await models.refresh(true);
    models.pickOllama(true);
  });

  after(() => {
    server.close();
    db.close();
  });

  test("lists the models that chat, the largest that takes tools first", async () => {
    assert.deepEqual(
      (await chatModels(url)).map(({ name, size, tools, vision, thinking }) => ({
        name,
        size,
        tools,
        vision,
        thinking,
      })),
      [
        { name: INKLING, size: 20_188_097_271, tools: true, vision: true, thinking: true },
        { name: QWEN, size: 18_174_721_847, tools: true, vision: true, thinking: true },
        { name: SMALL, size: 3_826_793_677, tools: false, vision: false, thinking: false },
      ],
    );
  });

  test("a computer with little memory prefers the model that leaves it room", async () => {
    assert.deepEqual(
      (await chatModels(url, 32 * GB)).map((model) => model.name),
      [QWEN, INKLING, SMALL],
    );
    models.memory = 32 * GB;
    await models.refresh(true);
    assert.deepEqual(models.candidates(), [`ollama:${QWEN}`]);
    models.memory = 64 * GB;
    await models.refresh(true);
    assert.deepEqual(models.candidates(), [`ollama:${INKLING}`]);
  });

  test("the home picks it until the person sets another order", () => {
    assert.deepEqual(
      models.localSources().map((source) => source.models.map((model) => model.id)),
      [[INKLING, QWEN, SMALL]],
    );
    assert.deepEqual(models.candidates(), [`ollama:${INKLING}`]);
    assert.equal(models.engine(`ollama:${INKLING}`)?.ref, `ollama:${INKLING}`);
    models.setOrder([`ollama:${QWEN}`]);
    assert.deepEqual(models.candidates(), [`ollama:${QWEN}`, `ollama:${INKLING}`]);
    models.setOrder([]);
  });

  test("the home asks it only while the person has it picked; an order that names it picks it", () => {
    models.setOrder([`ollama:${QWEN}`]);
    models.pickOllama(false);
    assert.deepEqual(models.order(), []);
    assert.deepEqual(models.candidates(), []);
    assert.deepEqual(models.forPictures().here, []);
    assert.deepEqual(models.ollamaOffer(), { model: INKLING, size: 20_188_097_271 });
    models.setOrder([`ollama:${QWEN}`]);
    assert.equal(models.ollamaPicked(), true);
    assert.equal(models.candidates()[0], `ollama:${QWEN}`);
    models.setOrder([]);
    models.pickOllama(true);
  });

  test("a step sends the tools and the picture and keeps what it thinks out of the answer", async () => {
    const chat = models.localChat(INKLING);
    assert.ok(chat);
    const answer = await chat.doGenerate(CALL);
    const request = requests.at(-1);
    assert.equal(request?.model, INKLING);
    assert.equal(request?.think, true);
    assert.equal(request?.options.num_ctx, 16_384);
    assert.deepEqual(
      request?.tools?.map((tool) => tool.function.name),
      ["weather"],
    );
    assert.deepEqual(request?.messages.at(-1), {
      role: "user",
      content: "What is the weather where this was taken?",
      images: [PICTURE],
    });
    assert.deepEqual(
      answer.content.map((part) =>
        part.type === "text"
          ? part.text
          : part.type === "tool-call"
            ? [part.toolName, part.input]
            : part.type,
      ),
      ["Looking it up.", ["weather", '{"city":"Kraków"}']],
    );
    assert.equal(answer.finishReason.unified, "tool-calls");
    assert.equal(answer.usage.inputTokens.total, 120);
  });

  test("a model that cannot think is not asked to, and one without tools gets none", async () => {
    await models.localChat(SMALL)?.doGenerate(CALL);
    const request = requests.at(-1);
    assert.equal(request?.model, SMALL);
    assert.equal(request?.think, false);
    assert.equal(request?.tools, undefined);
  });
});
