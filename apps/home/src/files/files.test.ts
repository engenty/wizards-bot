import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { FILE_LIMIT } from "@wizards-bot/protocol";
import { type TestHome, testHome, textOf } from "../test/fakes.ts";
import { checkFile, cleanName, FileRefused, sniff } from "./check.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

describe("checking a file", () => {
  test("reads the type from the bytes, not from what the device says", () => {
    assert.equal(sniff(PNG), "image/png");
    assert.deepEqual(checkFile({ name: "a.bin", mime: "application/octet-stream", bytes: PNG }), {
      name: "a.bin",
      mime: "image/png",
    });
    assert.equal(
      checkFile({ name: "n.md", mime: "", bytes: Buffer.from("# Notes") }).mime,
      "text/plain",
    );
    assert.equal(
      checkFile({ name: "n.csv", mime: "text/csv", bytes: Buffer.from("a,b") }).mime,
      "text/csv",
    );
    assert.equal(
      checkFile({ name: "x", mime: "", bytes: Buffer.from([0, 1, 2, 3]) }).mime,
      "application/octet-stream",
    );
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]);
    assert.match(checkFile({ name: "letter.docx", mime: "", bytes: zip }).mime, /wordprocessingml/);
  });

  test("refuses a file that is not what it says, an empty one and one that is too large", () => {
    const code = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return error instanceof FileRefused ? error.code : "other";
      }
      return "taken";
    };
    assert.equal(
      code(() =>
        checkFile({ name: "photo.jpg", mime: "image/jpeg", bytes: Buffer.from("<script>") }),
      ),
      "not_its_type",
    );
    assert.equal(
      code(() => checkFile({ name: "doc.pdf", mime: "application/pdf", bytes: PNG })),
      "not_its_type",
    );
    assert.equal(
      code(() => checkFile({ name: "e.txt", mime: "text/plain", bytes: Buffer.alloc(0) })),
      "empty",
    );
    assert.equal(
      code(() => checkFile({ name: "big.bin", mime: "", bytes: Buffer.alloc(FILE_LIMIT + 1) })),
      "too_large",
    );
  });

  test("keeps a plain name", () => {
    assert.equal(cleanName("../../etc/passwd"), "passwd");
    assert.equal(cleanName("C:\\Users\\ada\\photo.png"), "photo.png");
    assert.equal(cleanName("evil\u202Egnp.exe"), "evilgnp.exe");
    assert.equal(cleanName(".."), "file");
    assert.equal(cleanName(`${"a".repeat(200)}.jpeg`).length, 120);
    assert.ok(cleanName(`${"a".repeat(200)}.jpeg`).endsWith(".jpeg"));
  });
});

describe("files in a conversation", () => {
  let t: TestHome;
  before(async () => {
    t = await testHome("Ada");
  });
  after(() => t.stop());

  const upload = (name: string, type: string, bytes: Uint8Array) => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(bytes)], name, { type }));
    return fetch(`${t.url}/v1/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.token}` },
      body: form,
    });
  };

  test("the home keeps an uploaded file and gives it back to a paired device only", async () => {
    const response = await upload("ticket.png", "image/png", PNG);
    assert.equal(response.status, 200);
    const file = (await response.json()) as {
      id: string;
      name: string;
      mime: string;
      size: number;
    };
    assert.deepEqual([file.name, file.mime, file.size], ["ticket.png", "image/png", PNG.length]);
    const got = await t.request(`/v1/files/${file.id}`);
    assert.equal(got.headers.get("content-type"), "image/png");
    assert.match(got.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), PNG);
    assert.equal((await fetch(`${t.url}/v1/files/${file.id}`)).status, 401);
    assert.equal((await t.request("/v1/files/fil_unknown")).status, 404);
  });

  test("keeps a phone's HEIC photo as a JPEG", {
    skip: process.platform !== "darwin" && "makes the HEIC with sips",
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "wizards-bot-heic-"));
    writeFileSync(join(dir, "in.png"), PNG);
    execFileSync("/usr/bin/sips", [
      "-s",
      "format",
      "heic",
      join(dir, "in.png"),
      "--out",
      join(dir, "IMG_1.HEIC"),
    ]);
    const heic = readFileSync(join(dir, "IMG_1.HEIC"));
    assert.equal(sniff(heic), "image/heic");
    const response = await upload("IMG_1.HEIC", "image/heic", heic);
    assert.equal(response.status, 200);
    const file = (await response.json()) as { id: string; name: string; mime: string };
    assert.deepEqual([file.name, file.mime], ["IMG_1.jpg", "image/jpeg"]);
    const got = Buffer.from(await (await t.request(`/v1/files/${file.id}`)).arrayBuffer());
    assert.equal(sniff(got), "image/jpeg");
  });

  test("refuses what is not its type", async () => {
    const response = await upload("photo.jpg", "image/jpeg", Buffer.from("not a picture"));
    assert.equal(response.status, 415);
    assert.equal(((await response.json()) as { error: string }).error, "not_its_type");
  });

  test("the agent sees an attached picture and reads an attached text file", async () => {
    const picture = (await (await upload("ticket.png", "image/png", PNG)).json()) as { id: string };
    const notes = (await (
      await upload("notes.md", "text/markdown", Buffer.from("Seat 12A"))
    ).json()) as { id: string };
    const conversationId = t.home.store.mainAgent().conversationId;
    t.model.script.push({ text: "Seat 12A, I see the ticket." });
    const sent = await t.request(`/v1/conversations/${conversationId}/messages`, {
      body: { text: "What seat?", files: [picture.id, notes.id] },
    });
    const stored = ((await sent.json()) as { message: { parts: { type: string }[] } }).message;
    assert.deepEqual(
      stored.parts.map((part) => part.type),
      ["file", "file", "text"],
    );
    await t.home.idle();
    assert.equal(textOf(t.last()), "Seat 12A, I see the ticket.");
    const asked = t.model.requests.at(-1)?.messages.at(-1) as {
      content: string;
      images?: string[];
    };
    assert.deepEqual(asked.images, [PNG.toString("base64")]);
    assert.match(asked.content, /^What seat\?/);
    assert.match(asked.content, /Attached picture: ticket\.png/);
    assert.match(asked.content, /Attached file notes\.md:\n```\nSeat 12A\n```/);
  });

  test("a picture is not sent again with the next message", async () => {
    t.model.script.push({ text: "Yes." });
    await t.say("Thanks. Still there?");
    const messages = (t.model.requests.at(-1)?.messages ?? []) as {
      role: string;
      content: string;
      images?: string[];
    }[];
    assert.ok(messages.every((message) => !message.images));
    assert.ok(messages.some((message) => message.content.includes("[picture: ticket.png]")));
  });

  test("a message may be files alone, but not a file the home does not know", async () => {
    const conversationId = t.home.store.mainAgent().conversationId;
    const picture = (await (await upload("a.png", "image/png", PNG)).json()) as { id: string };
    t.model.script.push({ text: "A picture." });
    const alone = await t.request(`/v1/conversations/${conversationId}/messages`, {
      body: { text: "", files: [picture.id] },
    });
    assert.equal(alone.status, 202);
    await t.home.idle();
    const unknown = await t.request(`/v1/conversations/${conversationId}/messages`, {
      body: { text: "x", files: ["fil_nope"] },
    });
    assert.equal(unknown.status, 400);
    const empty = await t.request(`/v1/conversations/${conversationId}/messages`, {
      body: { text: " " },
    });
    assert.equal(empty.status, 400);
  });

  test("the files sent in a conversation are listed, newest first, each once", async () => {
    const conversationId = t.home.store.mainAgent().conversationId;
    const listed = async () =>
      (
        (await (await t.request(`/v1/conversations/${conversationId}/files`)).json()) as {
          files: { id: string; name: string }[];
        }
      ).files;
    const before = (await listed()).length;
    const note = (await (await upload("note.txt", "text/plain", Buffer.from("hi"))).json()) as {
      id: string;
    };
    t.model.script.push({ text: "Noted." });
    await t.request(`/v1/conversations/${conversationId}/messages`, {
      body: { text: "keep this", files: [note.id] },
    });
    await t.home.idle();
    const files = await listed();
    assert.equal(files.length, before + 1);
    assert.equal(files[0]?.name, "note.txt");
  });
});
