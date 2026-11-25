import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { serve } from "@hono/node-server";
import { Home } from "../home.ts";
import { Secrets } from "../identity.ts";
import { Models } from "../models/models.ts";
import { createServer } from "../server.ts";
import { Db } from "../store/db.ts";
import { FakeOllama } from "../test/fakes.ts";
import { LinkedComputer, type LinkState } from "./computer.ts";
import { LinkHub } from "./hub.ts";

describe("a home without models and a linked computer", () => {
  const model = new FakeOllama();
  let home: Home;
  let server: ReturnType<typeof serve>;
  let computer: LinkedComputer;
  let computerDb: Db;
  const states: LinkState[] = [];
  let token = "";
  let models: Models;

  before(async () => {
    await model.start();
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    home = new Home({
      dataDir: mkdtempSync(join(tmpdir(), "wizards-bot-hub-")),
      port,
      publicUrl: undefined,
      ollamaUrl: "http://127.0.0.1:9",
      lmstudioUrl: "http://127.0.0.1:9",
      subscriptions: [],
    });
    home.db.setMeta("person.name", "Ada");
    home.db.setMeta("morning.offer", "not_new");
    server = serve({ fetch: createServer(home).fetch, port, hostname: "127.0.0.1" });
    new LinkHub(home).attach(server as Server);
    ({ token } = home.store.addDevice({ name: "Ada's Mac", kind: "computer" }));
    const dataDir = mkdtempSync(join(tmpdir(), "wizards-bot-mac-"));
    computerDb = new Db(dataDir);
    models = new Models(
      {
        dataDir,
        port: 0,
        publicUrl: undefined,
        ollamaUrl: model.url,
        lmstudioUrl: "http://127.0.0.1:9",
        subscriptions: [],
      },
      computerDb,
      new Secrets(computerDb, dataDir),
      "Ada's Mac",
    );
    computer = new LinkedComputer({
      home: `http://127.0.0.1:${port}`,
      token,
      models,
      onState: (state) => states.push(state),
    });
    computer.start();
    for (let n = 0; n < 100 && !home.models.sources().length; n++)
      await new Promise((r) => setTimeout(r, 20));
  });

  after(() => {
    computer.stop();
    server.close();
    model.stop();
    computerDb.close();
    home.close();
  });

  test("the computer says it is linked", () => {
    assert.deepEqual(states, ["linked"]);
  });

  test("the home sees the computer's models", async () => {
    await home.models.refresh(true);
    const [source] = home.models.sources();
    assert.equal(source?.id, "ada-s-mac/ollama");
    assert.equal(source?.where, "Ada's Mac");
    assert.deepEqual(home.models.candidates(), ["ada-s-mac/ollama:fake:1"]);
  });

  test("a turn runs on the computer's model, tools run in the home", async () => {
    model.script.push(
      { calls: [{ name: "remember", arguments: { memory: "Ada likes trains." } }] },
      { text: "Noted." },
    );
    const main = home.store.mainAgent();
    await home.turns.enqueue({
      conversationId: main.conversationId,
      text: "I like trains",
      channel: "app",
    });
    const reply = home.store.messages(main.conversationId, { limit: 1 }).messages[0];
    assert.equal(reply?.state, "done");
    assert.equal(reply?.model, "ada-s-mac/ollama:fake:1");
    assert.deepEqual(
      reply?.parts.map((part) => (part.type === "text" ? part.text : part.type)),
      ["activity", "Noted."],
    );
    assert.equal(home.store.mainAgent().memory, "Ada likes trains.");
  });

  test("when the computer goes offline its models are gone", async () => {
    computer.stop();
    for (let n = 0; n < 100 && home.models.sources().length; n++)
      await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(home.models.candidates(), []);
    const main = home.store.mainAgent();
    await home.turns.enqueue({
      conversationId: main.conversationId,
      text: "Still there?",
      channel: "app",
    });
    const reply = home.store.messages(main.conversationId, { limit: 1 }).messages[0];
    assert.equal(reply?.state, "failed");
  });

  test("a computer the home removed is refused and stops", async () => {
    const device = home.store.devices().find((d) => d.name === "Ada's Mac");
    assert.ok(device);
    home.store.removeDevice(device.id);
    const refused: LinkState[] = [];
    const again = new LinkedComputer({
      home: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      token,
      models,
      onState: (state) => refused.push(state),
    });
    again.start();
    for (let n = 0; n < 100 && !refused.length; n++) await new Promise((r) => setTimeout(r, 20));
    again.stop();
    assert.deepEqual(refused, ["refused"]);
  });
});
