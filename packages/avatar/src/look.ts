import { cubeAt, type Model, onHead } from "./model.ts";

// Where the figure looks: its head turns to the side and tilts up or down by itself, while the
// body stays as it stands. The turn is drawn by the stacked renderer; the tilt moves the head's
// cubes up at the face and down at the back, so the face keeps every one of its pixels.

/** The head's turn from the body, in radians, and its tilt, in cubes the face rises. */
export interface Look {
  turn: number;
  tilt: number;
}

/** Straight ahead, where the body faces. */
export const STRAIGHT: Look = { turn: 0, tilt: 0 };

/** How far the head turns from the body at most, and how far it tilts. */
export const MAX_TURN = 1.1;
export const MAX_TILT = 3;
/** How far it turns towards something far to one side; something near it turns towards less. */
const WIDE_TURN = 0.9;
/** The turn is drawn in steps this large, so a small movement draws nothing new. */
const TURN_STEP = 0.1;

/**
 * Where to look at something `dx` to the right of the head and `dy` below it, as seen on the
 * screen. `reach`: how far away something is when the head is turned seven tenths of the way.
 * `body`: the body's angle; the head turns towards the reader's side as far as the neck lets it.
 */
export function lookAt(dx: number, dy: number, reach: number, body = 0): Look {
  const side = dx / Math.hypot(dx, reach) || 0;
  const height = -dy / Math.hypot(dy, reach) || 0;
  // A turn to the reader's right is a smaller angle, as when the figure is turned.
  const world = -side * WIDE_TURN;
  const turn = Math.atan2(Math.sin(world - body), Math.cos(world - body));
  return {
    turn: Math.max(-MAX_TURN, Math.min(MAX_TURN, turn)) || 0,
    tilt: height * MAX_TILT || 0,
  };
}

/** A look in the steps it is drawn in: a new step is a new picture, anything else is not. */
export function lookStep(look: Look): Look {
  return {
    turn: Math.round(look.turn / TURN_STEP) * TURN_STEP || 0,
    tilt: Math.round(look.tilt) || 0,
  };
}

/** Whether two looks are drawn the same. */
export const sameLook = (a: Look, b: Look): boolean => {
  const x = lookStep(a);
  const y = lookStep(b);
  return x.turn === y.turn && x.tilt === y.tilt;
};

const TILTED = new WeakMap<Model, Map<number, Model>>();

/**
 * The figure with its head tilted by `tilt` cubes: up where it is positive. Each column of the
 * head moves as a whole, the face up and the back down, and the body stays where it is. Which
 * way a cube's surface faces tilts with it, so the light falls on a raised face.
 */
export function tiltHead(model: Model, tilt: number): Model {
  const steps = Math.round(tilt);
  if (!steps) return model;
  let tilted = TILTED.get(model);
  if (!tilted) {
    tilted = new Map();
    TILTED.set(model, tilted);
  }
  const kept = tilted.get(steps);
  if (kept) return kept;
  const { width, depth, height, head } = model;
  const cubes = new Uint32Array(model.cubes.length);
  const from = new Int32Array(model.cubes.length).fill(-1);
  const rise = (y: number): number => Math.round((steps * (head.y - y - 0.5)) / head.front);
  for (let z = 0; z < height; z++)
    for (let y = 0; y < depth; y++)
      for (let x = 0; x < width; x++) {
        const cube = cubeAt(model, x, y, z);
        if (!cube || onHead(model, cube, z)) continue;
        const at = x + y * width + z * width * depth;
        cubes[at] = cube;
        from[at] = at;
      }
  for (let z = 0; z < height; z++)
    for (let y = 0; y < depth; y++)
      for (let x = 0; x < width; x++) {
        const cube = cubeAt(model, x, y, z);
        const to = z + rise(y);
        if (!cube || !onHead(model, cube, z) || to < 0 || to >= height) continue;
        const at = x + y * width + to * width * depth;
        cubes[at] = cube;
        from[at] = x + y * width + z * width * depth;
      }
  const result: Model = { ...model, cubes };
  turnFacing(model, result, from, Math.atan2(steps, head.front));
  tilted.set(steps, result);
  return result;
}

/**
 * Which way the surface faces at every cube, as three numbers from -127 to 127: away from
 * the cubes around it. Kept for each model, since it is the same at every angle.
 */
const FACING = new WeakMap<Model, Int8Array>();
/** How far the light and the camera count the cubes around one, to find which way it faces. */
const AROUND = 3;

export function facingOf(model: Model): Int8Array {
  let facing = FACING.get(model);
  if (facing) return facing;
  const { width, depth, height } = model;
  facing = new Int8Array(width * depth * height * 3);
  for (let z = 0; z < height; z++)
    for (let y = 0; y < depth; y++)
      for (let x = 0; x < width; x++) {
        if (!cubeAt(model, x, y, z)) continue;
        let nx = 0;
        let ny = 0;
        let nz = 0;
        for (let dz = -AROUND; dz <= AROUND; dz++)
          for (let dy = -AROUND; dy <= AROUND; dy++)
            for (let dx = -AROUND; dx <= AROUND; dx++)
              if (cubeAt(model, x + dx, y + dy, z + dz)) {
                nx -= dx;
                ny -= dy;
                nz -= dz;
              }
        const length = Math.hypot(nx, ny, nz);
        if (!length) continue;
        const at = (x + y * width + z * width * depth) * 3;
        facing[at] = Math.round((nx / length) * 127);
        facing[at + 1] = Math.round((ny / length) * 127);
        facing[at + 2] = Math.round((nz / length) * 127);
      }
  FACING.set(model, facing);
  return facing;
}

/**
 * The tilted figure's surface faces as the figure's did, from the cube each place came from;
 * the head's turned up by `angle`. Counting the cubes around again would take long, and a
 * stepped column would light as steps.
 */
function turnFacing(model: Model, tilted: Model, from: Int32Array, angle: number): void {
  const source = facingOf(model);
  const facing = new Int8Array(source.length);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const plane = model.width * model.depth;
  for (let at = 0; at < from.length; at++) {
    const was = from[at] as number;
    if (was < 0) continue;
    const nx = source[was * 3] as number;
    const ny = source[was * 3 + 1] as number;
    const nz = source[was * 3 + 2] as number;
    facing[at * 3] = nx;
    if (onHead(tilted, tilted.cubes[at] as number, Math.floor(at / plane))) {
      // The face turns from looking ahead (small y) towards looking up.
      facing[at * 3 + 1] = Math.round(ny * cos + nz * sin);
      facing[at * 3 + 2] = Math.round(nz * cos - ny * sin);
    } else {
      facing[at * 3 + 1] = ny;
      facing[at * 3 + 2] = nz;
    }
  }
  FACING.set(tilted, facing);
}
