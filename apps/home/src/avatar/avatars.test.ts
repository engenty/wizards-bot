import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { DEFAULT_AVATAR } from "@wizards-bot/avatar";
import type { Avatar } from "@wizards-bot/protocol";
import { type TestHome, testHome } from "../test/fakes.ts";
import { avatarFromAnswer, SELFIE_INSTRUCTIONS } from "./avatars.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const SEEN = {
  skin: "fair",
  hair: { style: "long", color: "blond" },
  glasses: "round",
  beard: "none",
  hat: { style: "none", color: "grey" },
  top: { style: "hoodie", color: "teal" },
  bottom: { style: "trousers", color: "black" },
  shoes: { style: "boots", color: "white" },
  accessory: { style: "scarf", color: "red" },
};
/** The same person as traits were kept before shoes had a style and anything was worn. */
const KEPT_BEFORE = {
  ...SEEN,
  shoes: "white",
  accessory: undefined,
};

describe("a model's answer about a photo", () => {
  test("is read however it is wrapped", () => {
    assert.deepEqual(
      avatarFromAnswer(`Here you go:\n\`\`\`json\n${JSON.stringify(SEEN)}\n\`\`\``),
      SEEN,
    );
  });

  test("keeps what fits and falls back to the plain figure for what does not", () => {
    const read = avatarFromAnswer(
      JSON.stringify({
        ...SEEN,
        skin: "green",
        hair: { style: "mullet", color: "blond" },
        top: "a nice jumper",
      }),
    );
    assert.equal(read?.skin, DEFAULT_AVATAR.skin);
    assert.deepEqual(read?.hair, { style: DEFAULT_AVATAR.hair.style, color: "blond" });
    assert.deepEqual(read?.top, DEFAULT_AVATAR.top);
    assert.equal(read?.glasses, "round");
  });

  test("is read in the shape traits once had, with shoes of that colour and nothing worn", () => {
    assert.deepEqual(avatarFromAnswer(JSON.stringify(KEPT_BEFORE)), {
      ...SEEN,
      shoes: { style: DEFAULT_AVATAR.shoes.style, color: "white" },
      accessory: { ...DEFAULT_AVATAR.accessory, style: "none" },
    });
  });

  test("names every trait and every choice of each to the model", () => {
    for (const word of [
      "accessory",
      "pigtails",
      "afro",
      "longskirt",
      "boots",
      "headphones",
      "brim",
    ])
      assert.match(SELFIE_INSTRUCTIONS, new RegExp(`\\b${word}\\b`));
  });

  test("is nothing when it names no traits", () => {
    assert.equal(avatarFromAnswer("I cannot help with that."), undefined);
    assert.equal(avatarFromAnswer("{ not json }"), undefined);
  });
});

describe("the person's avatar", () => {
  let t: TestHome;
  before(async () => {
    t = await testHome("Ada");
  });
  after(() => t.stop());

  const upload = async (name: string, type: string, bytes: Uint8Array): Promise<string> => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array(bytes)], name, { type }));
    const response = await fetch(`${t.url}/v1/files`, {
      method: "POST",
      headers: { authorization: `Bearer ${t.token}` },
      body: form,
    });
    return ((await response.json()) as { id: string }).id;
  };
  const saved = async (): Promise<Avatar | null> =>
    ((await (await t.request("/v1/avatar")).json()) as { avatar: Avatar | null }).avatar;

  test("is not there until the person makes one, then is told to every device", async () => {
    assert.equal(await saved(), null);
    assert.equal((await t.request("/v1/avatar.png")).status, 404);
    const events: unknown[] = [];
    const stop = t.home.events.subscribe(
      (stored) => stored.event.type === "avatar.updated" && events.push(stored.event.avatar),
    );
    assert.equal((await t.request("/v1/avatar", { method: "PUT", body: SEEN })).status, 200);
    assert.equal(
      (await t.request("/v1/avatar", { method: "PUT", body: { ...SEEN, skin: "green" } })).status,
      400,
    );
    stop();
    assert.deepEqual(await saved(), SEEN);
    assert.deepEqual(events, [SEEN]);
  });

  test("comes as a picture for a device that cannot draw it", async () => {
    const small = await t.request("/v1/avatar.png?size=96&angle=0");
    const large = await t.request("/v1/avatar.png?size=480&angle=45");
    assert.equal(small.headers.get("content-type"), "image/png");
    const [a, b] = [Buffer.from(await small.arrayBuffer()), Buffer.from(await large.arrayBuffer())];
    assert.equal(a.subarray(1, 4).toString(), "PNG");
    assert.ok(b.readUInt32BE(20) > a.readUInt32BE(20) * 3);
    // The head is a square, larger than the whole figure's head would be at that size.
    const head = Buffer.from(
      await (await t.request("/v1/avatar.png?size=96&angle=0&view=head")).arrayBuffer(),
    );
    assert.equal(head.readUInt32BE(16), head.readUInt32BE(20));
    assert.ok(Math.abs(head.readUInt32BE(20) - 96) <= 20);
  });

  test("kept before the traits grew is still read and drawn", async () => {
    t.home.db.setMeta("person.avatar", JSON.stringify(KEPT_BEFORE));
    assert.deepEqual((await saved())?.shoes, { style: DEFAULT_AVATAR.shoes.style, color: "white" });
    assert.equal((await t.request("/v1/avatar.png?view=head")).status, 200);
    t.home.db.setMeta("person.avatar", JSON.stringify(SEEN));
  });

  test("is made from a selfie by a model on this computer, and the selfie is not kept", async () => {
    await t.request("/v1/avatar", { method: "DELETE" });
    const fileId = await upload("me.png", "image/png", PNG);
    t.model.script.push({ text: JSON.stringify({ ...SEEN, beard: "a goatee" }) });
    const response = await t.request("/v1/avatar/from-selfie", { body: { fileId } });
    assert.equal(response.status, 200);
    const made = (await response.json()) as { avatar: Avatar; model: string; where: string };
    assert.deepEqual(made.avatar, SEEN);
    assert.equal(made.model, "ollama:fake:1");
    assert.equal(made.where, t.home.models.where);
    const asked = t.model.requests.at(-1) as {
      messages: { role: string; content: string; images?: string[] }[];
      tools?: unknown[];
    };
    assert.match(asked.messages[0]?.content ?? "", /Do not say who the person is/);
    assert.deepEqual(asked.messages.at(-1)?.images, [PNG.toString("base64")]);
    assert.equal(asked.tools, undefined);
    assert.equal((await t.request(`/v1/files/${fileId}`)).status, 404);
    assert.equal(await saved(), null);
  });

  test("is not made from a file that is no picture, or when no model sees pictures", async () => {
    const notes = await upload("notes.txt", "text/plain", Buffer.from("hello"));
    const refused = await t.request("/v1/avatar/from-selfie", { body: { fileId: notes } });
    assert.equal(refused.status, 400);
    assert.equal((await t.request(`/v1/files/${notes}`)).status, 404);

    t.model.vision = false;
    await t.home.models.refresh(true);
    const fileId = await upload("me.png", "image/png", PNG);
    const blind = await t.request("/v1/avatar/from-selfie", { body: { fileId } });
    assert.equal(blind.status, 503);
    assert.equal(((await blind.json()) as { error: string }).error, "no_model");
    assert.equal((await t.request(`/v1/files/${fileId}`)).status, 404);
  });

  test("leaves the computer only when the person said so", async () => {
    // Nothing on this computer sees pictures; a gateway could.
    t.home.models.setGateway(
      { id: "custom", label: "A gateway", baseUrl: "http://127.0.0.1:9/v1", models: ["x"] },
      "key",
    );
    const fileId = await upload("me.png", "image/png", PNG);
    const asked = await t.request("/v1/avatar/from-selfie", { body: { fileId } });
    assert.equal(asked.status, 409);
    const body = (await asked.json()) as { error: string; models: string[]; message: string };
    assert.deepEqual([body.error, body.models], ["leaves_home", ["A gateway"]]);
    assert.match(body.message, /the picture then leaves your computer/);
    assert.equal((await t.request(`/v1/files/${fileId}`)).status, 200);

    const allowed = await t.request("/v1/avatar/from-selfie", { body: { fileId, anywhere: true } });
    assert.equal(allowed.status, 503);
    assert.equal((await t.request(`/v1/files/${fileId}`)).status, 404);

    const second = await upload("me.png", "image/png", PNG);
    assert.equal((await t.request(`/v1/files/${second}`, { method: "DELETE" })).status, 204);
    assert.equal((await t.request(`/v1/files/${second}`)).status, 404);
    t.home.models.removeGateway("custom");
    t.model.vision = true;
    await t.home.models.refresh(true);
  });

  test("is set by the agent when the person asks in the chat", async () => {
    t.model.script.push(
      { calls: [{ name: "avatar_set", arguments: { ...SEEN, glasses: "shades" } }] },
      { text: "Your figure is ready." },
    );
    await t.say("Make me an avatar with sunglasses");
    assert.equal((await saved())?.glasses, "shades");
  });
});
