import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { inflateSync } from "node:zlib";
import { Avatar } from "@wizards-bot/protocol";
import {
  buildFigure,
  colorOf,
  cubeAt,
  DEFAULT_AVATAR,
  headPoint,
  lookAt,
  lookStep,
  MAX_TILT,
  MAX_TURN,
  type Model,
  onHead,
  PART,
  partOf,
  renderStack,
  STRAIGHT,
  sameLook,
  savedTraits,
  spriteSheet,
  stackSize,
  tiltHead,
} from "./index.ts";
import { shade } from "./palette.ts";
import { encodePng } from "./png.ts";

const withTraits = (patch: Partial<Avatar>): Avatar => ({ ...DEFAULT_AVATAR, ...patch });
const count = (cubes: Uint32Array): number => cubes.reduce((sum, cube) => sum + (cube ? 1 : 0), 0);
/** How many cubes of a part there are at or above a layer. */
const partFrom = (model: Model, part: number, from: number): number => {
  let found = 0;
  for (let z = from; z < model.height; z++)
    for (let y = 0; y < model.depth; y++)
      for (let x = 0; x < model.width; x++) if (partOf(cubeAt(model, x, y, z)) === part) found++;
  return found;
};
/** How many opaque pixels of a picture have one of these colours. */
const pixels = (data: Uint8ClampedArray, colors: number[]): number => {
  let found = 0;
  for (let at = 0; at < data.length; at += 4) {
    const color =
      ((data[at] as number) << 16) + ((data[at + 1] as number) << 8) + (data[at + 2] as number);
    if (data[at + 3] === 255 && colors.includes(color)) found++;
  }
  return found;
};
const opaque = (data: Uint8ClampedArray): number =>
  data.filter((_, at) => at % 4 === 3 && data[at] === 255).length;
/** The eye in each of its tones. */
const EYE = [1.12, 1, 0.76].map((tone) => shade(0x2b2431, tone));

describe("a figure", () => {
  test("is the same every time for the same traits", () => {
    assert.deepEqual(
      buildFigure(DEFAULT_AVATAR).cubes,
      buildFigure(structuredClone(DEFAULT_AVATAR)).cubes,
    );
  });

  test("changes with every value of every trait", () => {
    const base = buildFigure(DEFAULT_AVATAR).cubes;
    const { shape } = Avatar;
    const changes: Partial<Avatar>[] = [
      ...shape.skin.options.map((skin) => ({ skin })),
      ...shape.hair.shape.style.options.map((style) => ({
        hair: { ...DEFAULT_AVATAR.hair, style },
      })),
      ...shape.hair.shape.color.options.map((color) => ({
        hair: { ...DEFAULT_AVATAR.hair, color },
      })),
      ...shape.glasses.options.map((glasses) => ({ glasses })),
      ...shape.beard.options.map((beard) => ({ beard })),
      ...shape.hat.shape.style.options
        .filter((style) => style !== "none")
        .map((style) => ({ hat: { style, color: "red" as const } })),
      ...shape.top.shape.style.options.map((style) => ({ top: { ...DEFAULT_AVATAR.top, style } })),
      ...shape.bottom.shape.style.options.map((style) => ({
        bottom: { ...DEFAULT_AVATAR.bottom, style },
      })),
      ...shape.shoes.shape.style.options.map((style) => ({
        shoes: { ...DEFAULT_AVATAR.shoes, style },
      })),
      ...shape.accessory.shape.style.options.map((style) => ({
        accessory: { ...DEFAULT_AVATAR.accessory, style },
      })),
      { top: { ...DEFAULT_AVATAR.top, color: "blue" } },
      { shoes: { ...DEFAULT_AVATAR.shoes, color: "red" } },
    ];
    const seen = new Set<string>();
    for (const change of changes) {
      const patched = withTraits(change);
      const key = JSON.stringify(patched);
      if (key === JSON.stringify(DEFAULT_AVATAR) || seen.has(key)) continue;
      seen.add(key);
      assert.notDeepEqual(buildFigure(patched).cubes, base, JSON.stringify(change));
    }
  });

  test("draws every haircut differently", () => {
    const cuts = Avatar.shape.hair.shape.style.options.map((style) =>
      buildFigure(withTraits({ hair: { style, color: "brown" } })).cubes.join(),
    );
    assert.equal(new Set(cuts).size, cuts.length);
  });

  test("has no hair when bald, and more of it when long", () => {
    const hair = (style: Avatar["hair"]["style"]): number =>
      partFrom(buildFigure(withTraits({ hair: { style, color: "brown" } })), PART.hair, 0);
    assert.equal(hair("bald"), 0);
    assert.ok(hair("buzz") > 0 && hair("short") < hair("long") && hair("curly") < hair("afro"));
  });

  test("wears a hat over its hair: nothing stands up through it", () => {
    const spiky = withTraits({ hair: { style: "spiky", color: "red" } });
    const capped = buildFigure({ ...spiky, hat: { style: "cap", color: "blue" } });
    assert.ok(partFrom(buildFigure(spiky), PART.hair, 62) > 0);
    assert.equal(partFrom(capped, PART.hair, 62), 0);
    assert.ok(partFrom(capped, PART.hat, 0) > 0);
  });
});

describe("traits kept before", () => {
  const old = {
    skin: "tan",
    hair: { style: "curly", color: "red" },
    glasses: "round",
    beard: "full",
    hat: { style: "beanie", color: "yellow" },
    top: { style: "hoodie", color: "teal" },
    bottom: { style: "skirt", color: "black" },
    shoes: "red",
  };

  test("are read as the same figure: shoes of that colour, nothing else worn", () => {
    const read = Avatar.parse(savedTraits(old));
    assert.deepEqual(read.shoes, { style: DEFAULT_AVATAR.shoes.style, color: "red" });
    assert.deepEqual(read.accessory, DEFAULT_AVATAR.accessory);
    assert.equal(read.accessory.style, "none");
    assert.deepEqual(
      { ...read, shoes: old.shoes, accessory: undefined },
      { ...old, accessory: undefined },
    );
    assert.ok(count(buildFigure(read).cubes) > 0);
  });

  test("leave today's traits and what is no avatar as they are", () => {
    assert.deepEqual(savedTraits(DEFAULT_AVATAR), DEFAULT_AVATAR);
    assert.equal(savedTraits(null), null);
    assert.equal(savedTraits("tee"), "tee");
    assert.equal(Avatar.safeParse(savedTraits({ skin: "green" })).success, false);
  });
});

describe("stacked sprites", () => {
  const model = buildFigure(withTraits({ glasses: "none" }));

  test("draw a picture of the same size at every angle, in both views", () => {
    for (const view of ["body", "head"] as const) {
      const size = stackSize(model, 3, view);
      for (const angle of [0, 0.3, Math.PI / 2, 2, Math.PI, 5]) {
        const picture = renderStack(model, { angle, scale: 3, view });
        assert.deepEqual([picture.width, picture.height], [size.width, size.height]);
        assert.equal(picture.data.length, size.width * size.height * 4);
      }
    }
  });

  test("show the face from the front and not from the back", () => {
    for (const view of ["body", "head"] as const) {
      const front = renderStack(model, { angle: 0, scale: 3, view });
      const back = renderStack(model, { angle: Math.PI, scale: 3, view });
      assert.ok(pixels(front.data, EYE) >= 6 * 9, view);
      assert.equal(pixels(back.data, EYE), 0, view);
    }
  });

  test("draw the head view as a square of head and shoulders, without the legs", () => {
    const head = stackSize(model, 2, "head");
    const body = stackSize(model, 2, "body");
    assert.equal(head.width, head.height);
    assert.ok(head.height < body.height / 2);
    const other = buildFigure(
      withTraits({
        bottom: { style: "skirt", color: "red" },
        shoes: { style: "boots", color: "green" },
      }),
    );
    assert.deepEqual(
      renderStack(other, { angle: 0.4, scale: 2, view: "head" }).data,
      renderStack(model, { angle: 0.4, scale: 2, view: "head" }).data,
    );
  });

  test("come round to the same picture after a full turn, and mirror nothing on the way", () => {
    assert.deepEqual(
      renderStack(model, { angle: Math.PI * 2 }).data,
      renderStack(model, { angle: 0 }).data,
    );
    assert.notDeepEqual(
      renderStack(model, { angle: Math.PI / 2 }).data,
      renderStack(model, { angle: 0 }).data,
    );
  });

  test("draw a line around the figure only when asked", () => {
    const lined = renderStack(model, { angle: 0.7, scale: 4 });
    const bare = renderStack(model, { angle: 0.7, scale: 4, outline: false });
    assert.ok(opaque(lined.data) > opaque(bare.data) + 200);
  });

  test("stand the whole figure on a soft shadow, and the head on none", () => {
    const soft = (data: Uint8ClampedArray): number =>
      data.filter((alpha, at) => at % 4 === 3 && alpha > 0 && alpha < 255).length;
    assert.ok(soft(renderStack(model, { angle: 0, scale: 2 }).data) > 50);
    assert.equal(soft(renderStack(model, { angle: 0, scale: 2, view: "head" }).data), 0);
  });

  test("grow with the scale", () => {
    const small = renderStack(model, { angle: 0, scale: 2 });
    const large = renderStack(model, { angle: 0, scale: 6 });
    assert.ok(large.width > small.width * 2 && large.height > small.height * 2);
  });

  test("lay the layers out side by side as a sprite sheet", () => {
    const sheet = spriteSheet(model);
    assert.deepEqual([sheet.width, sheet.height], [model.width * model.height, model.depth]);
    assert.equal(opaque(sheet.data), count(model.cubes));
  });
});

describe("where the head looks", () => {
  const model = buildFigure(DEFAULT_AVATAR);
  const REACH = 160;

  test("turns towards the side the pointer is on, and tilts towards its height", () => {
    const right = lookAt(200, 0, REACH);
    const left = lookAt(-200, 0, REACH);
    const up = lookAt(0, -200, REACH);
    const down = lookAt(0, 200, REACH);
    // A smaller angle turns the face to the reader's right, as when the whole figure turns.
    assert.ok(right.turn < -0.4 && left.turn > 0.4);
    assert.equal(right.turn, -left.turn);
    assert.ok(up.tilt > 1 && down.tilt < -1);
    assert.equal(up.tilt, -down.tilt);
    assert.equal(lookAt(0, -200, REACH).turn, 0);
    assert.equal(lookAt(200, 0, REACH).tilt, 0);
    assert.deepEqual(lookStep(lookAt(0, 0, REACH)), STRAIGHT);
  });

  test("turns further for something further away, and never further than the neck lets it", () => {
    assert.ok(lookAt(40, 0, REACH).turn > lookAt(400, 0, REACH).turn);
    const far = lookAt(1e6, -1e6, REACH);
    assert.ok(Math.abs(far.turn) <= MAX_TURN && far.tilt <= MAX_TILT);
    assert.ok(far.tilt > MAX_TILT - 0.01);
  });

  test("turns from where the body faces, towards the reader as far as it can", () => {
    // A body turned away a little: the head turns back to look at a pointer on the head.
    assert.ok(Math.abs(lookAt(0, 0, REACH, -0.5).turn - 0.5) < 1e-9);
    // A body that faces away: the head turns only as far as the neck lets it.
    assert.equal(Math.abs(lookAt(0, 0, REACH, Math.PI - 0.1).turn), MAX_TURN);
  });

  test("is drawn in steps: a small movement is the same picture", () => {
    assert.ok(sameLook({ turn: 0.31, tilt: 1.2 }, { turn: 0.32, tilt: 0.9 }));
    assert.ok(!sameLook({ turn: 0.31, tilt: 1.2 }, { turn: 0.45, tilt: 1.2 }));
    assert.ok(!sameLook({ turn: 0.3, tilt: 1 }, { turn: 0.3, tilt: 2 }));
  });

  test("tilts only the head: the face rises, the back falls, the body stays", () => {
    const up = tiltHead(model, 2);
    assert.equal(tiltHead(model, 2), up, "kept for the same tilt");
    assert.equal(tiltHead(model, 0), model);
    let body = 0;
    let head = 0;
    for (let z = 0; z < model.height; z++)
      for (let y = 0; y < model.depth; y++)
        for (let x = 0; x < model.width; x++) {
          const cube = cubeAt(model, x, y, z);
          if (!cube) continue;
          if (onHead(model, cube, z)) head++;
          else if (cubeAt(up, x, y, z) === cube) body++;
        }
    assert.ok(body > 0.97 * (count(model.cubes) - head), "the body is where it was");
    const eyes = (m: Model): number[] => {
      const rows: number[] = [];
      for (let z = 0; z < m.height; z++)
        for (let y = 0; y < m.depth; y++)
          for (let x = 0; x < m.width; x++)
            if (colorOf(cubeAt(m, x, y, z)) === 0x2b2431) rows.push(z);
      return rows;
    };
    const ahead = eyes(model);
    const raised = eyes(up);
    assert.equal(raised.length, ahead.length, "the face keeps every cube");
    assert.equal(Math.min(...raised), Math.min(...ahead) + 2);
  });

  test("draws a head that looks up or down other than one that looks ahead", () => {
    for (const view of ["head", "body"] as const) {
      const draw = (tilt: number) =>
        renderStack(model, { angle: -0.5, scale: 2, view, look: { turn: 0, tilt } }).data;
      const ahead = draw(0);
      assert.notDeepEqual(draw(2), ahead, view);
      assert.notDeepEqual(draw(-2), ahead, view);
      assert.notDeepEqual(draw(2), draw(-2), view);
    }
  });

  test("turns the head alone: a body turned aside, its face to the reader", () => {
    const aside = renderStack(model, { angle: 1, scale: 3 });
    const looking = renderStack(model, { angle: 1, scale: 3, look: { turn: -1, tilt: 0 } });
    const front = renderStack(model, { angle: 0, scale: 3 });
    assert.ok(pixels(looking.data, EYE) > pixels(aside.data, EYE));
    assert.ok(pixels(looking.data, EYE) >= pixels(front.data, EYE) * 0.8);
    // Below the shoulders nothing changes.
    const { width } = looking;
    const below = (headPoint(model, 3).y + 26 * 3) * width * 4;
    assert.deepEqual(looking.data.subarray(below), aside.data.subarray(below));
    assert.notDeepEqual(looking.data.subarray(0, below), aside.data.subarray(0, below));
  });

  test("finds the middle of the head in the picture", () => {
    for (const view of ["head", "body"] as const) {
      const size = stackSize(model, 2, view);
      const point = headPoint(model, 2, view);
      assert.equal(point.x, size.width / 2);
      assert.ok(point.y > 0 && point.y < size.height * (view === "head" ? 0.6 : 0.4), view);
    }
  });
});

describe("a picture as a PNG", () => {
  test("is a PNG of the picture's size with its pixels", () => {
    const picture = renderStack(buildFigure(DEFAULT_AVATAR), { angle: 0.5, scale: 3 });
    const png = encodePng(picture);
    assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(png.readUInt32BE(16), picture.width);
    assert.equal(png.readUInt32BE(20), picture.height);
    const length = png.readUInt32BE(33);
    const raw = inflateSync(png.subarray(41, 41 + length));
    assert.equal(raw.length, (picture.width * 4 + 1) * picture.height);
    assert.deepEqual(
      [...raw.subarray(1, 1 + picture.width * 4)],
      [...picture.data.subarray(0, picture.width * 4)],
    );
  });
});
