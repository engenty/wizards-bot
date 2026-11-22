import { facingOf, type Look, tiltHead } from "./look.ts";
import { colorOf, cubeAt, type Model, onHead, partOf } from "./model.ts";
import { INK, mix, type Rgb, shade } from "./palette.ts";

// Stacked sprites: the figure is cut into flat layers from the feet up, and each layer is
// drawn turned by the same angle, a little higher than the one below. Seen from above at a
// slant, the stack reads as a solid figure, and it turns to any angle without a 3D engine.

/** A picture as RGBA bytes, row by row. */
export interface Picture {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * What of the figure is drawn. `body`: all of it, standing on its shadow. `head`: head and
 * shoulders in a square, for a small place beside a name; drawn at the same scale, it shows
 * the face several times as large as a whole figure of that size would.
 */
export type View = "head" | "body";

export interface StackOptions {
  /** How far the figure is turned, in radians. 0 shows the face. */
  angle: number;
  /** Screen pixels per cube across. */
  scale?: number;
  /** A dark line around the figure and where one part stands in front of another. */
  outline?: boolean;
  view?: View;
  /** Where the head looks, turned and tilted from the body. Without it, where the body faces. */
  look?: Look;
}

const TURN = Math.PI * 2;
/** How flat a layer looks from the camera's height. */
const SQUASH = 0.5;
/** The side of the head view's square, in cubes, and how far below the shoulders it ends. */
const HEAD_SIDE = 40;
const HEAD_BELOW = 1;
/** Where the light comes from: above, the front, and a little from the viewer's right. */
const LIGHT = { right: 0.5, front: 0.45, up: 0.74 };
/**
 * The three tones of a colour, flat as a hand-drawn pixel figure has them: lit, the colour
 * itself, and shade. A surface must face the light this far for its tone.
 */
const TONES = { light: 1.12, shade: 0.76, lightFrom: 0.7, colourFrom: 0.2 };
/** How many layers above a cube another part still throws its shadow onto it. */
const CAST = 4;
/** How dark the shadow on the ground is, out of 255. */
const SHADOW_ALPHA = 44;

interface Layout {
  width: number;
  height: number;
  /** Rows a layer is drawn on, one above the other. */
  rise: number;
  /** The first layer drawn, and the row its middle is on. */
  from: number;
  floor: number;
}

function layout(model: Model, scale: number, view: View): Layout {
  const rise = Math.max(1, Math.round(scale));
  if (view === "head") {
    const side = Math.max(1, Math.round(HEAD_SIDE * scale));
    return { width: side, height: side, rise, from: model.bust, floor: side - HEAD_BELOW * scale };
  }
  const reach = Math.hypot(model.width, model.depth) / 2;
  const height = Math.ceil(reach * 2 * scale * SQUASH) + model.height * rise + 2;
  return {
    width: Math.ceil(reach * 2 * scale) + 2,
    height,
    rise,
    from: 0,
    floor: height - 1 - reach * scale * SQUASH,
  };
}

/** The size of the picture for a figure, the same at every angle. */
export function stackSize(
  model: Model,
  scale = 4,
  view: View = "body",
): { width: number; height: number } {
  const { width, height } = layout(model, scale, view);
  return { width, height };
}

/** Where the middle of the head is in the picture, in its pixels: what the head looks from. */
export function headPoint(model: Model, scale = 4, view: View = "body"): { x: number; y: number } {
  const { width, rise, from, floor } = layout(model, scale, view);
  return { x: width / 2, y: floor - (model.head.z - from) * rise };
}

/** How far the cubes of each layer reach from the middle the figure turns about. */
const REACH = new WeakMap<Model, Float32Array>();
function reachOf(model: Model): Float32Array {
  let reach = REACH.get(model);
  if (!reach) {
    reach = new Float32Array(model.height);
    for (let z = 0; z < model.height; z++)
      for (let y = 0; y < model.depth; y++)
        for (let x = 0; x < model.width; x++)
          if (cubeAt(model, x, y, z)) {
            const far = Math.hypot(
              Math.max(Math.abs(x - model.width / 2), Math.abs(x + 1 - model.width / 2)),
              Math.max(Math.abs(y - model.depth / 2), Math.abs(y + 1 - model.depth / 2)),
            );
            if (far > (reach[z] as number)) reach[z] = far;
          }
    REACH.set(model, reach);
  }
  return reach;
}

const AROUND_PIXEL = [
  [0, 1],
  [0, -1],
  [-1, 0],
  [1, 0],
] as const;
/** How much nearer the camera another part must be for a line between the two. */
const EDGE = 0.7;
/** A line inside the figure is its own colour, darker. */
const INNER = 0.55;

/**
 * The cubes another part shades from above: the forehead under the hair, the neck under the
 * chin, the shoulders under long hair, a face under a brim. The same at every angle.
 */
const CASTS = new WeakMap<Model, Uint8Array>();
function castOf(model: Model): Uint8Array {
  let cast = CASTS.get(model);
  if (cast) return cast;
  const { width, depth, height } = model;
  cast = new Uint8Array(width * depth * height);
  for (let z = 0; z < height; z++)
    for (let y = 0; y < depth; y++)
      for (let x = 0; x < width; x++) {
        const part = partOf(cubeAt(model, x, y, z));
        if (!part) continue;
        for (let up = 1; up <= CAST; up++) {
          const other = partOf(cubeAt(model, x, y, z + up));
          if (other && other !== part) {
            cast[x + y * width + z * width * depth] = 1;
            break;
          }
        }
      }
  CASTS.set(model, cast);
  return cast;
}

const put = (data: Uint8ClampedArray, at: number, color: Rgb, alpha = 255): void => {
  data[at] = (color >> 16) & 255;
  data[at + 1] = (color >> 8) & 255;
  data[at + 2] = color & 255;
  data[at + 3] = alpha;
};

/** Draws the figure turned by `angle`, its head turned and tilted further by `look`. */
export function renderStack(figure: Model, options: StackOptions): Picture {
  const scale = options.scale ?? 4;
  const view = options.view ?? "body";
  const model = tiltHead(figure, options.look?.tilt ?? 0);
  const { width, height, rise, from, floor } = layout(model, scale, view);
  const data = new Uint8ClampedArray(width * height * 4);
  /** For every pixel: the part it shows, and how near the camera that place is. */
  const parts = new Uint8Array(width * height);
  const near = new Float32Array(width * height);
  // The same direction is the same picture, however many times round it was turned.
  const angle = ((options.angle % TURN) + TURN) % TURN;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // The head turns about the same axis as the body, by its own angle.
  const turn = options.look?.turn ?? 0;
  const headCos = Math.cos(angle + turn);
  const headSin = Math.sin(angle + turn);
  const centerX = width / 2;
  const reach = reachOf(model);
  const facing = facingOf(model);
  /**
   * The tone of a cube: light where its surface faces the light, the colour itself beside
   * that, shade where it faces away or where another part above throws its shadow. The top
   * of a cube leans its surface upwards, so a flat top is lighter than the side below it.
   */
  const cast = castOf(model);
  const bright = (index: number, top: boolean, cos: number, sin: number): number => {
    let nx = (facing[index * 3] as number) / 127;
    let ny = (facing[index * 3 + 1] as number) / 127;
    let nz = (facing[index * 3 + 2] as number) / 127;
    if (top) {
      nz += 0.45;
    } else {
      // A side is seen from the camera: it leans towards it.
      nx += sin * 0.2;
      ny -= cos * 0.2;
      nz = Math.min(nz, 0.5);
    }
    const length = Math.hypot(nx, ny, nz) || 1;
    const towards =
      (LIGHT.right * (nx * cos + ny * sin) + LIGHT.front * (nx * sin - ny * cos) + LIGHT.up * nz) /
      length;
    if (cast[index]) return towards >= TONES.lightFrom ? 1 : TONES.shade;
    if (towards >= TONES.lightFrom) return TONES.light;
    return towards >= TONES.colourFrom ? 1 : TONES.shade;
  };
  /** The colours of this picture, worked out once for each cube: its side, and its top. */
  const tones = new Int32Array(model.cubes.length * 2).fill(-1);
  const tone = (index: number, cube: number, top: boolean, head: boolean): Rgb => {
    const at = index * 2 + (top ? 1 : 0);
    let color = tones[at] as number;
    if (color < 0) {
      color = shade(
        colorOf(cube),
        head ? bright(index, top, headCos, headSin) : bright(index, top, cos, sin),
      );
      tones[at] = color;
    }
    return color;
  };

  const turned = turn !== 0;
  for (let z = from; z < model.height; z++) {
    const far = reach[z] as number;
    if (!far) continue;
    const halfX = far * scale + 1;
    const halfY = far * scale * SQUASH + 1;
    const left = Math.max(0, Math.floor(centerX - halfX));
    const right = Math.min(width - 1, Math.ceil(centerX + halfX));
    // A layer is drawn `rise` times, one pixel higher each time: the last pass is the top
    // of its cubes, the passes before are their sides.
    for (let pass = 0; pass < rise; pass++) {
      const middle = floor - ((z - from) * rise + pass);
      const last = pass === rise - 1;
      const top = Math.max(0, Math.floor(middle - halfY));
      const bottom = Math.min(height - 1, Math.ceil(middle + halfY));
      for (let py = top; py <= bottom; py++) {
        const v = (py + 0.5 - middle) / (scale * SQUASH);
        for (let px = left; px <= right; px++) {
          const u = (px + 0.5 - centerX) / scale;
          // From the screen back to the layer: the place this pixel shows. Where the head is
          // turned from the body, the place is looked for twice: on the head turned by its own
          // angle, then on the body.
          let x = 0;
          let y = 0;
          let cube = 0;
          let head = false;
          if (turned) {
            x = Math.floor(u * headCos + v * headSin + model.width / 2);
            y = Math.floor(model.depth / 2 - (v * headCos - u * headSin));
            cube = cubeAt(model, x, y, z);
            head = cube !== 0 && onHead(model, cube, z);
          }
          if (!head) {
            x = Math.floor(u * cos + v * sin + model.width / 2);
            y = Math.floor(model.depth / 2 - (v * cos - u * sin));
            cube = cubeAt(model, x, y, z);
            if (!cube || (turned && onHead(model, cube, z))) continue;
          }
          // Only a cube with nothing on it shows its top; every other pixel of it is a side.
          const index = x + y * model.width + z * model.width * model.depth;
          const at = py * width + px;
          put(data, at * 4, tone(index, cube, last && !cubeAt(model, x, y, z + 1), head));
          parts[at] = partOf(cube);
          near[at] = v + (z + pass / rise) * 0.6;
        }
      }
    }
  }
  smooth(data, parts, width, height, scale / 2);
  if (options.outline ?? true)
    outline(data, parts, near, width, height, Math.max(1, Math.floor(scale / 2)));
  if (view === "body") shadow(data, width, height, centerX, floor, scale);
  return { width, height, data };
}

/**
 * Where a turned step of cubes shows a sliver of one cube's side, narrower than `under`
 * pixels, between two pixels of one colour of the same part, the sliver takes that colour.
 * A whole cube is never that narrow, so no detail of the figure is lost.
 */
function smooth(
  data: Uint8ClampedArray,
  parts: Uint8Array,
  width: number,
  height: number,
  under: number,
): void {
  const same = (a: number, b: number): boolean =>
    data[a * 4] === data[b * 4] &&
    data[a * 4 + 1] === data[b * 4 + 1] &&
    data[a * 4 + 2] === data[b * 4 + 2];
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let x = 1;
    while (x < width - 1) {
      const left = row + x - 1;
      const part = parts[row + x] as number;
      if (!part || parts[left] !== part || same(left, row + x)) {
        x++;
        continue;
      }
      let end = x;
      while (end < width && end - x < under && parts[row + end] === part && !same(left, row + end))
        end++;
      const right = row + end;
      if (end - x < under && end < width && parts[right] === part && same(left, right)) {
        for (let at = row + x; at < right; at++) data.copyWithin(at * 4, left * 4, left * 4 + 4);
      }
      x = Math.max(x + 1, end);
    }
  }
}

/**
 * The dark line of a pixel figure: around the whole of it, and around each of its parts where
 * that part stands in front of another. Where parts meet, the one behind carries the line.
 * `thick`: its width in pixels.
 */
function outline(
  data: Uint8ClampedArray,
  parts: Uint8Array,
  near: Float32Array,
  width: number,
  height: number,
  thick: number,
): void {
  const colorAt = (at: number): Rgb =>
    ((data[at * 4] as number) << 16) |
    ((data[at * 4 + 1] as number) << 8) |
    (data[at * 4 + 2] as number);
  const line = (color: Rgb): Rgb => mix(shade(color, 0.3), INK, 0.72);
  const next: [number, Rgb][] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * width + x;
      const part = parts[at] as number;
      let drawn = false;
      for (let far = 1; far <= thick && !drawn; far++) {
        for (const [dx, dy] of AROUND_PIXEL) {
          const bx = x + dx * far;
          const by = y + dy * far;
          if (bx < 0 || by < 0 || bx >= width || by >= height) continue;
          const beside = by * width + bx;
          const other = parts[beside] as number;
          if (!other) continue;
          const ahead = (near[beside] as number) - (near[at] as number);
          if (!part) next.push([at, line(colorAt(beside))]);
          else if (other !== part && ahead > EDGE) next.push([at, shade(colorAt(at), INNER)]);
          else continue;
          drawn = true;
          break;
        }
      }
    }
  }
  for (const [at, color] of next) put(data, at * 4, color);
}

/** The figure's shadow on the ground: a soft oval under its feet, where nothing else is drawn. */
function shadow(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  centerX: number,
  floor: number,
  scale: number,
): void {
  const rx = 10 * scale;
  const ry = rx * SQUASH;
  for (let y = Math.max(0, Math.floor(floor - ry)); y <= Math.min(height - 1, floor + ry); y++) {
    for (
      let x = Math.max(0, Math.floor(centerX - rx));
      x <= Math.min(width - 1, centerX + rx);
      x++
    ) {
      const at = (y * width + x) * 4;
      if (data[at + 3]) continue;
      if (((x + 0.5 - centerX) / rx) ** 2 + ((y + 0.5 - floor) / ry) ** 2 <= 1)
        put(data, at, INK, SHADOW_ALPHA);
    }
  }
}

/** The layers of a figure as one picture, side by side from the feet up: its sprite sheet. */
export function spriteSheet(model: Model): Picture {
  const width = model.width * model.height;
  const data = new Uint8ClampedArray(width * model.depth * 4);
  for (let z = 0; z < model.height; z++) {
    for (let y = 0; y < model.depth; y++) {
      for (let x = 0; x < model.width; x++) {
        const cube = cubeAt(model, x, y, z);
        if (cube) put(data, (y * width + z * model.width + x) * 4, colorOf(cube));
      }
    }
  }
  return { width, height: model.depth, data };
}
