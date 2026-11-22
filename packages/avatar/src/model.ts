import type { Rgb } from "./palette.ts";

// The figure as a block of small cubes. x runs across the shoulders, y from the face (small)
// to the back, z from the feet up. A cube knows its colour and the part of the figure it
// belongs to, so the renderer can draw a line where one part stands in front of another.

/** What a cube belongs to. */
export const PART = {
  head: 1,
  hair: 2,
  body: 3,
  leftArm: 4,
  rightArm: 5,
  leftLeg: 6,
  rightLeg: 7,
  leftShoe: 8,
  rightShoe: 9,
  hat: 10,
  glasses: 11,
  beard: 12,
  accessory: 13,
} as const;
export type Part = (typeof PART)[keyof typeof PART];

/** A block of cubes. A cube is its part and its colour plus one, so 0 means there is none. */
export interface Model {
  width: number;
  depth: number;
  height: number;
  cubes: Uint32Array;
  /** The layer the head view starts at: the chest, just below the shoulders. */
  bust: number;
  /** The head, which turns and tilts by itself when the figure looks somewhere. */
  head: HeadPlace;
}

/**
 * Where the head is. It turns about the figure's own axis, through the neck, and tilts about
 * its middle from the face to the back.
 */
export interface HeadPlace {
  /** The layer of its middle, and its middle from the face to the back. */
  z: number;
  y: number;
  /** How far the face is in front of that middle. */
  front: number;
  /** The chin's layer: what is worn above it, such as earrings, belongs to the head. */
  chin: number;
}

const HEAD_PARTS = new Set<number>([PART.head, PART.hair, PART.hat, PART.glasses, PART.beard]);

/** Whether a cube in layer `z` turns with the head. */
export const onHead = (model: Model, cube: number, z: number): boolean => {
  const part = partOf(cube);
  return HEAD_PARTS.has(part) || (part === PART.accessory && z > model.head.chin);
};

export const cubeAt = (model: Model, x: number, y: number, z: number): number =>
  x < 0 || y < 0 || z < 0 || x >= model.width || y >= model.depth || z >= model.height
    ? 0
    : (model.cubes[x + y * model.width + z * model.width * model.depth] as number);

/** The colour of a cube that is there. */
export const colorOf = (cube: number): Rgb => (cube & 0x1ffffff) - 1;

/** The part a cube belongs to; 0 where there is none. */
export const partOf = (cube: number): number => cube >>> 25;

/** A number from 0 to 1 that is always the same for the same place: curls and strands. */
export const grain = (x: number, y: number, z: number): number => {
  let n = (x * 374761393 + y * 668265263 + z * 2147483647) | 0;
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 0xffffffff;
};

/** The tools a figure is built with: they put cubes into one model. */
export interface Sculpt {
  model: Model;
  at(x: number, y: number, z: number): number;
  set(x: number, y: number, z: number, color: Rgb, part: Part): void;
  clear(x: number, y: number, z: number): void;
  box(
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    z0: number,
    z1: number,
    color: Rgb,
    part: Part,
  ): void;
  /** Both sides at once: what is given for the left side is also put on the right. */
  both(
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    z0: number,
    z1: number,
    color: Rgb,
    left: Part,
    right?: Part,
  ): void;
  /** Every place of the model the rule gives a colour to. */
  fill(part: Part, rule: (x: number, y: number, z: number) => Rgb | undefined): void;
  /** Every cube of a part: the rule gives its new colour, `null` takes it away. */
  each(part: Part, rule: (x: number, y: number, z: number, color: Rgb) => Rgb | null): void;
}

/**
 * `head`: where the head is, counted as the builder counts. `ahead`: how many cubes of room the model has in front of y = 0, for what stands out in
 * front of the face. The builder counts y from the face; the model keeps the figure in its
 * middle, so it turns about its own axis.
 */
export function sculpt(
  width: number,
  depth: number,
  height: number,
  bust: number,
  head: HeadPlace,
  ahead = 0,
): Sculpt {
  const model: Model = {
    width,
    depth,
    height,
    bust,
    head: { ...head, y: head.y + ahead },
    cubes: new Uint32Array(width * depth * height),
  };
  const inside = (x: number, y: number, z: number): boolean =>
    x >= 0 && y >= -ahead && z >= 0 && x < width && y < depth - ahead && z < height;
  const index = (x: number, y: number, z: number): number =>
    x + (y + ahead) * width + z * width * depth;
  const tools: Sculpt = {
    model,
    at: (x, y, z) => cubeAt(model, x, y + ahead, z),
    set(x, y, z, color, part) {
      if (inside(x, y, z)) model.cubes[index(x, y, z)] = ((part << 25) | (color + 1)) >>> 0;
    },
    clear(x, y, z) {
      if (inside(x, y, z)) model.cubes[index(x, y, z)] = 0;
    },
    box(x0, x1, y0, y1, z0, z1, color, part) {
      for (let z = z0; z <= z1; z++)
        for (let y = y0; y <= y1; y++)
          for (let x = x0; x <= x1; x++) tools.set(x, y, z, color, part);
    },
    both(x0, x1, y0, y1, z0, z1, color, left, right = left) {
      tools.box(x0, x1, y0, y1, z0, z1, color, left);
      tools.box(width - 1 - x1, width - 1 - x0, y0, y1, z0, z1, color, right);
    },
    fill(part, rule) {
      for (let z = 0; z < height; z++)
        for (let y = -ahead; y < depth - ahead; y++)
          for (let x = 0; x < width; x++) {
            const color = rule(x, y, z);
            if (color !== undefined) tools.set(x, y, z, color, part);
          }
    },
    each(part, rule) {
      for (let z = 0; z < height; z++)
        for (let y = -ahead; y < depth - ahead; y++)
          for (let x = 0; x < width; x++) {
            const cube = model.cubes[index(x, y, z)] as number;
            if (!cube || partOf(cube) !== part) continue;
            const color = rule(x, y, z, colorOf(cube));
            if (color === null) model.cubes[index(x, y, z)] = 0;
            else tools.set(x, y, z, color, part);
          }
    },
  };
  return tools;
}
