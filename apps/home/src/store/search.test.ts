import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Events } from "../events.ts";
import { Db } from "./db.ts";
import { Store } from "./store.ts";

describe("search", () => {
  test("finds Wizards, the person's messages and documents, never a guest's conversation", () => {
    const db = new Db(mkdtempSync(join(tmpdir(), "wizards-bot-search-")));
    const store = new Store(db, new Events());
    const travel = store.createAgent({
      name: "Travel",
      kind: "round",
      about: "Plans trips to Lisbon",
    });
    store.addMessage({
      conversationId: travel.conversationId,
      role: "you",
      channel: "app",
      parts: [{ type: "text", text: "Book the hotel in Lisbon for May" }],
    });
    store.createDocument({
      title: "Lisbon packing list",
      content: "Shoes",
      conversationId: travel.conversationId,
    });
    const guest = store.guestConversation(travel.id, "ben@example.org");
    store.addMessage({
      conversationId: guest,
      role: "you",
      channel: "app",
      parts: [{ type: "text", text: "A secret about Lisbon" }],
    });

    const hits = store.search("lisbon");
    assert.deepEqual(hits.map((h) => h.kind).sort(), ["agent", "document", "message"]);
    assert.ok(hits.every((h) => !h.snippet.includes("secret")));
    assert.match(hits.find((h) => h.kind === "message")?.snippet ?? "", /hotel in Lisbon/);
    assert.deepEqual(store.search("l"), []);
    db.close();
  });
});
