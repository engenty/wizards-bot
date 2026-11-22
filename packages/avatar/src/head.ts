import type { Avatar } from "@wizards-bot/protocol";
import { grain, PART, type Part, partOf, type Sculpt } from "./model.ts";
import { GARMENT, HAIR, mix, type Rgb, SKIN, shade } from "./palette.ts";

// The head: a rounded block with a face, and around it hair, a beard, glasses, a hat and what
// is worn on the head. Each trait is a rule over the cubes around the head's own shape.

/** Where the head is: its middle and how far it reaches from there. */
export const HEAD = { x: 16, y: 14, z: 49, rx: 11, ry: 10, rz: 11 } as const;
const TOP = HEAD.z + HEAD.rz;
const CHIN = HEAD.z - HEAD.rz;

const EYE: Rgb = 0x2b2431;
const EYE_WHITE: Rgb = 0xffffff;
const FRAME: Rgb = 0x34303d;

/**
 * How far out a place is from the head's middle: up to 1 it is inside a head grown by `grow`
 * cubes. The head is round from above and flatter at the top, and gets narrower to the chin.
 * `column`: below its middle the shape runs straight down, for hair that hangs.
 */
function shape(x: number, y: number, z: number, grow = 0, round = 3, column = false): number {
  const dz = z + 0.5 - HEAD.z;
  const low = column ? 0 : Math.max(0, -dz / HEAD.rz);
  const narrow = 1 - 0.16 * low * low;
  const dx = Math.abs(x + 0.5 - HEAD.x) / ((HEAD.rx + grow) * narrow);
  const dy = Math.abs(y + 0.5 - HEAD.y) / ((HEAD.ry + grow) * narrow);
  const up = column && dz < 0 ? 0 : Math.abs(dz) / (HEAD.rz + grow);
  return (dx ** round + dy ** round) ** (4 / round) + up ** 4;
}

const inHead = (x: number, y: number, z: number): boolean => shape(x, y, z) <= 1;

/** Whether a place is inside a ball, flattened or stretched as its three reaches say. */
const inBall = (
  x: number,
  y: number,
  z: number,
  middle: readonly [number, number, number],
  reach: readonly [number, number, number],
): boolean =>
  ((x + 0.5 - middle[0]) / reach[0]) ** 2 +
    ((y + 0.5 - middle[1]) / reach[1]) ** 2 +
    ((z + 0.5 - middle[2]) / reach[2]) ** 2 <=
  1;

/** A haircut: how thick the hair lies on the head and how far down it reaches. */
interface Cut {
  top: number;
  side: number;
  back: number;
  /** The lowest hair over the face, by the place across it: 0 is the middle. */
  line: (across: number) => number;
  /** How far down the hair reaches beside the ears, and at the back. */
  sides: number;
  nape: number;
  /** Curls: the hair stands out in lumps. */
  lumps?: boolean;
  /** Below the head the hair hangs straight down. */
  hangs?: boolean;
  /** How round the hair is from above; a head of hair is rounder than the head. */
  round?: number;
  /** Cropped so short that the skin shows through: how much of it, up to 1. */
  cropped?: number;
  /** Parted in the middle: a line runs back from the forehead. */
  parted?: boolean;
}

const temples =
  (middle: number, temple: number, from = 9) =>
  (across: number): number =>
    Math.abs(across) > from ? temple : middle;
/** A fringe cut in tufts. */
const tufts =
  (middle: number, temple: number) =>
  (across: number): number =>
    Math.abs(across) > 9 ? temple : middle - (Math.floor((across + 12) / 3) % 2);
/** Hair parted in the middle falls to both sides of the forehead. */
const curtains =
  (temple: number, from = 9) =>
  (across: number): number =>
    Math.abs(across) > from ? temple : 60 - Math.abs(across) * 0.85;

const SHORT: Cut = { top: 2, side: 1, back: 1, line: tufts(56, 52), sides: 49, nape: 42 };
const TIED: Cut = { top: 2, side: 1, back: 1, line: temples(56, 51), sides: 49, nape: 43 };
const cropped = (shows: number): Cut => ({
  top: 1,
  side: 1,
  back: 1,
  line: temples(56, 53, 8),
  sides: 50,
  nape: 43,
  cropped: shows,
});

const CUTS: Record<Avatar["hair"]["style"], Cut | null> = {
  bald: null,
  buzz: cropped(0.4),
  short: SHORT,
  side: { ...SHORT, top: 3, line: (across) => 54.5 + across * 0.36 },
  quiff: { ...SHORT, line: temples(57, 52), sides: 49, nape: 43 },
  curtains: { top: 2, side: 2, back: 2, line: curtains(49), sides: 45, nape: 41, parted: true },
  spiky: SHORT,
  mohawk: cropped(0.7),
  curly: { top: 3, side: 3, back: 3, line: temples(54, 49), sides: 45, nape: 41, lumps: true },
  afro: {
    top: 4,
    side: 5,
    back: 5,
    line: temples(54, 50),
    sides: 46,
    nape: 44,
    lumps: true,
    round: 2.2,
  },
  bob: { top: 2, side: 2, back: 2, line: temples(52, 40, 8.5), sides: 40, nape: 40, hangs: true },
  long: {
    top: 2,
    side: 2,
    back: 2,
    line: curtains(37),
    sides: 36,
    nape: 26,
    hangs: true,
    parted: true,
  },
  ponytail: TIED,
  bun: TIED,
  pigtails: { ...TIED, line: curtains(50), nape: 43, parted: true },
};

/** Where a hat's lower edge sits. */
const HAT_FROM: Record<Exclude<Avatar["hat"]["style"], "none">, number> = {
  cap: 54,
  beanie: 53,
  brim: 55,
};

/** Puts the head, its face and everything worn on it onto a figure that has its body. */
export function buildHead(s: Sculpt, avatar: Avatar): void {
  const { width, height } = s.model;
  const mirror = (x: number): number => width - 1 - x;
  const skin = SKIN[avatar.skin];
  const hair = HAIR[avatar.hair.color];
  const cut = CUTS[avatar.hair.style];

  // The neck, then the head itself.
  s.box(13, 18, 12, 17, CHIN - 1, CHIN + 1, shade(skin, 0.88), PART.head);
  s.fill(PART.head, (x, y, z) => (inHead(x, y, z) ? skin : undefined));

  /** The cube of the face that is seen from the front at this place; -1: there is none. */
  const front = (x: number, z: number): number => {
    for (let y = 0; y < HEAD.y; y++) if (partOf(s.at(x, y, z)) === PART.head) return y;
    return -1;
  };
  const face = (x: number, z: number, color: Rgb): void => {
    const y = front(x, z);
    if (y >= 0) s.set(x, y, z, color, PART.head);
  };
  const pair = (x: number, z: number, color: Rgb): void => {
    face(x, z, color);
    face(mirror(x), z, color);
  };
  /** A cube that stands on the face. */
  const on = (x: number, z: number, color: Rgb, part: Part): void => {
    const y = front(x, z);
    if (y > 0) s.set(x, y - 1, z, color, part);
  };

  // Stubble is the skin of the jaw in another tone, so it comes before the mouth.
  if (avatar.beard === "stubble") {
    const tone = mix(skin, hair, 0.3);
    s.each(PART.head, (_x, y, z, color) =>
      color === skin && z <= 43 && z >= CHIN && y < HEAD.y + 2 ? tone : color,
    );
  }

  // The face: eyes with their whites and a point of light, brows, a nose that stands out,
  // a mouth that smiles, a little red on the cheeks.
  for (let z = 46; z <= 48; z++) {
    pair(10, z, EYE);
    pair(11, z, EYE);
  }
  pair(9, 46, EYE_WHITE);
  pair(9, 47, EYE_WHITE);
  pair(10, 48, EYE_WHITE);
  const brow = mix(hair, EYE, avatar.hair.color === "black" ? 0 : 0.35);
  for (let x = 10; x <= 12; x++) pair(x, 51, brow);
  pair(9, 50, brow);
  for (const x of [15, 16]) {
    on(x, 44, skin, PART.head);
    on(x, 45, skin, PART.head);
    face(x, 43, shade(skin, 0.86));
  }
  const lip = mix(skin, 0x8c2f33, 0.55);
  for (let x = 14; x <= 17; x++) face(x, 41, lip);
  pair(13, 42, lip);
  const blush = mix(skin, 0xe86f6a, 0.2);
  pair(7, 44, blush);
  pair(8, 44, blush);

  // A beard stands one cube on the face.
  const whiskers = (): void => {
    for (let x = 13; x <= 18; x++) on(x, 43, hair, PART.beard);
    on(12, 42, hair, PART.beard);
    on(mirror(12), 42, hair, PART.beard);
  };
  if (avatar.beard === "moustache") whiskers();
  if (avatar.beard === "goatee") {
    whiskers();
    for (let z = CHIN; z <= 40; z++) for (let x = 13; x <= 18; x++) on(x, z, hair, PART.beard);
    for (const x of [12, mirror(12)]) on(x, 41, hair, PART.beard);
  }
  if (avatar.beard === "full") {
    whiskers();
    s.fill(PART.beard, (x, y, z) => {
      const across = Math.abs(x + 0.5 - HEAD.x);
      const upTo = across > 8 ? 49 : across >= 5 ? 44 : 43;
      const mouth = across < 3 && (z === 41 || z === 42) && y < 9;
      if (z > upTo || mouth || y > HEAD.y + 2 || inHead(x, y, z) || s.at(x, y, z)) return undefined;
      return shape(x, y, z, 1) <= 1 ? hair : undefined;
    });
  }

  // Hair: a layer around the head, as thick and as long as the cut says.
  if (cut) {
    const round = cut.round ?? 2.7;
    const tone = cut.cropped ? mix(hair, skin, cut.cropped) : hair;
    /**
     * The lowest hair at a place: the line over the face, and from the temples back to the
     * neck a line that runs down smoothly, so the hair has no step in it.
     */
    const lowest = (x: number, y: number): number => {
      if (y + 0.5 < 9) return cut.line(x + 0.5 - HEAD.x);
      const back = Math.max(0, Math.min(1, (y + 0.5 - 12) / 9));
      return Math.round(cut.sides + (cut.nape - cut.sides) * back);
    };
    s.fill(PART.hair, (x, y, z) => {
      if (s.at(x, y, z)) return undefined;
      const across = x + 0.5 - HEAD.x;
      const back = y + 0.5 >= 17;
      if (z < lowest(x, y)) return undefined;
      // Below the head, long hair gets narrower and lies on the back only.
      if (z < CHIN && Math.abs(across) > 9 + (z - cut.nape) * 0.3) return undefined;
      const cell = grain(x >> 1, y >> 1, z >> 1);
      const lump = cut.lumps && cell > 0.5 ? 1 : 0;
      const upper = Math.max(0, Math.min(1, (z - 52) / 6));
      const thick = (back ? cut.back : cut.side) * (1 - upper) + cut.top * upper + lump;
      if (shape(x, y, z, thick, round, cut.hangs) > 1) return undefined;
      const hollow = cut.hangs && z < HEAD.z && shape(x, y, z, 0, round, true) <= 1;
      if (hollow && !(back && z < CHIN)) return undefined;
      if (cut.lumps) return shade(tone, 0.88 + cell * 0.24);
      return cut.parted && Math.abs(across) < 1 && z > TOP && y < 18 ? shade(tone, 0.7) : tone;
    });

    // The layer follows its own, rounder shape: where the head reaches past it, the hair
    // still covers the head, so no skin shows through.
    s.fill(PART.hair, (x, y, z) => {
      if (s.at(x, y, z) || z < lowest(x, y)) return undefined;
      const beside = [
        s.at(x - 1, y, z),
        s.at(x + 1, y, z),
        s.at(x, y - 1, z),
        s.at(x, y + 1, z),
        s.at(x, y, z - 1),
      ];
      return beside.some((cube) => partOf(cube) === PART.head) ? tone : undefined;
    });
    // A notch where the layer turns a corner would let the turned figure show the skin far
    // below through it: it is filled.
    const isHair = (x: number, y: number, z: number): boolean =>
      partOf(s.at(x, y, z)) === PART.hair;
    const notches: [number, number, number][] = [];
    s.fill(PART.hair, (x, y, z) => {
      if (s.at(x, y, z) || z < lowest(x, y)) return undefined;
      const across = isHair(x - 1, y, z) || isHair(x + 1, y, z);
      const along = isHair(x, y - 1, z) || isHair(x, y + 1, z);
      if (across && along) notches.push([x, y, z]);
      return undefined;
    });
    for (const [x, y, z] of notches) s.set(x, y, z, tone, PART.hair);

    const strand = (x: number, y: number, z: number, color = hair): void => {
      if (!s.at(x, y, z)) s.set(x, y, z, color, PART.hair);
    };
    const ball = (
      middle: readonly [number, number, number],
      reach: readonly [number, number, number],
    ): void => {
      for (
        let z = Math.floor(middle[2] - reach[2]);
        z <= Math.min(height - 1, middle[2] + reach[2]);
        z++
      )
        for (let y = Math.floor(middle[1] - reach[1]); y <= middle[1] + reach[1]; y++)
          for (let x = Math.floor(middle[0] - reach[0]); x <= middle[0] + reach[0]; x++)
            if (inBall(x, y, z, middle, reach)) strand(x, y, z);
    };
    const tie = shade(hair, 0.62);
    switch (avatar.hair.style) {
      case "side":
        // The longer side lies in a wave over the forehead.
        ball([10, 6, 57.5], [6.5, 4.5, 3.5]);
        break;
      case "quiff":
        // Brushed up over the forehead.
        ball([HEAD.x, 7, 61], [7, 5.5, 4.6]);
        ball([HEAD.x, 11, 61], [6, 5, 3.6]);
        break;
      case "spiky":
        // Tufts that stand up, row by row a little to the side of the row before.
        for (let row = 0; row < 5; row++)
          for (let column = 0; column < 5; column++) {
            const x = 7 + column * 4 + (row % 2) * 2;
            const y = 5 + row * 4;
            if (shape(x, y, TOP + 1, 2) > 1 && shape(x + 1, y + 1, TOP - 1, 2) > 1) continue;
            const base = TOP + (shape(x, y, TOP + 1, 2) <= 1 ? 2 : 0);
            for (let z = base - 2; z <= base; z++) {
              strand(x, y, z);
              strand(x + 1, y, z);
              strand(x, y + 1, z);
              strand(x + 1, y + 1, z);
            }
            strand(x, y + 1, base + 1);
            strand(x + 1, y + 1, base + 1);
            strand(x + (row % 2), y + 1, base + 2);
          }
        break;
      case "mohawk":
        // A crest from the forehead to the neck.
        for (let z = 44; z < height; z++)
          for (let y = 0; y <= 30; y++)
            for (let x = 14; x <= 17; x++) {
              const low = y + 0.5 < 9 ? 54 : cut.nape + 1;
              if (z >= low && shape(x, y, z, 5 - ((y >> 1) % 2)) <= 1) strand(x, y, z);
            }
        break;
      case "ponytail":
        // Tied high at the back; the tail swings out and hangs to the shoulders.
        ball([HEAD.x, 24.5, 57], [2.6, 2.6, 2.6]);
        s.each(PART.hair, (_x, y, z, color) => (y >= 23 && z >= 56 && z <= 57 ? tie : color));
        for (let z = 38; z <= 56; z++) {
          const out = z > 52 ? 56 - z : z > 44 ? 4 : 3;
          const thin = z < 41 ? 1 : 0;
          for (let x = 14 + thin; x <= 17 - thin; x++)
            for (let y = 24 + out; y <= 26 + out - thin; y++) strand(x, y, z);
        }
        break;
      case "bun":
        ball([HEAD.x, 19, 63], [4.2, 4.2, 3.6]);
        break;
      case "pigtails":
        for (let z = 37; z <= 51; z++) {
          const thin = z < 39 ? 1 : 0;
          for (let y = 13 + thin; y <= 16 - thin; y++)
            for (let x = 2 + thin; x <= 4; x++) {
              strand(x - (z < 49 ? 1 : 0), y, z, z >= 50 ? tie : hair);
              strand(mirror(x) + (z < 49 ? 1 : 0), y, z, z >= 50 ? tie : hair);
            }
        }
        break;
    }
  }

  // The ears show where no hair lies over them.
  for (let z = 46; z <= 49; z++)
    for (let y = 13; y <= 15; y++)
      for (const x of [4, mirror(4)])
        if (!s.at(x, y, z)) s.set(x, y, z, shade(skin, 0.93), PART.head);

  // A hat sits on the hair and hides what would stand up through it.
  let crown = cut ? cut.top + (cut.lumps ? 1 : 0) : 0;
  if (avatar.hat.style !== "none") {
    const hat = GARMENT[avatar.hat.color];
    const from = HAT_FROM[avatar.hat.style];
    crown = 2;
    s.each(PART.hair, (x, y, z, color) => (z >= from && shape(x, y, z, 2) > 1 ? null : color));
    s.fill(PART.hat, (x, y, z) =>
      z >= from && !inHead(x, y, z) && shape(x, y, z, 2) <= 1 ? hat : undefined,
    );
    if (avatar.hat.style === "cap") {
      // The peak, and the button on top.
      for (let y = -2; y <= 6; y++)
        for (let x = 6; x <= 25; x++) {
          const d = ((x + 0.5 - HEAD.x) / 9.5) ** 2 + ((y + 0.5 - 7) / 9) ** 2;
          if (d <= 1 && !s.at(x, y, from)) s.set(x, y, from, shade(hat, 0.84), PART.hat);
        }
      s.box(15, 16, 13, 14, TOP + 2, TOP + 2, shade(hat, 1.2), PART.hat);
    }
    if (avatar.hat.style === "beanie") {
      // The turned-up edge, and a bobble.
      s.fill(PART.hat, (x, y, z) =>
        z >= from && z <= from + 2 && !inHead(x, y, z) && shape(x, y, z, 2.6) <= 1
          ? shade(hat, 0.82)
          : undefined,
      );
      s.box(14, 17, 12, 15, TOP + 2, TOP + 4, shade(hat, 1.18), PART.hat);
      for (const x of [14, 17]) for (const y of [12, 15]) s.clear(x, y, TOP + 4);
    }
    if (avatar.hat.style === "brim") {
      // A brim all round, and a band above it.
      for (let y = -2; y <= 30; y++)
        for (let x = 0; x < width; x++) {
          const d = ((x + 0.5 - HEAD.x) / 15.5) ** 2 + ((y + 0.5 - HEAD.y) / 15) ** 2;
          if (d <= 1 && !inHead(x, y, from)) s.set(x, y, from, hat, PART.hat);
        }
      s.each(PART.hat, (_x, _y, z, color) =>
        z === from + 1 || z === from + 2 ? shade(hat, 0.6) : color,
      );
    }
  }

  // Glasses stand one cube in front of the face; the eyes show through the frames.
  if (avatar.glasses !== "none") {
    const shades = avatar.glasses === "shades";
    const plane = front(10, 47) - 1;
    for (let z = 45; z <= 49; z++) {
      for (let x = 9; x <= 12; x++) {
        const rim = x === 9 || x === 12 || z === 45 || z === 49;
        const corner = (x === 9 || x === 12) && (z === 45 || z === 49);
        if (shades ? z === 49 : !rim || (corner && avatar.glasses === "round")) continue;
        const glass = shades && !rim ? 0x1c1a22 : FRAME;
        s.set(x, plane, z, glass, PART.glasses);
        s.set(mirror(x), plane, z, glass, PART.glasses);
      }
    }
    if (shades) for (const x of [10, 20]) s.set(x, plane, 47, 0x5b5868, PART.glasses);
    s.box(13, 18, plane, plane, 48, 48, FRAME, PART.glasses);
    // The arms follow the head round to the ears, under the hair.
    for (let y = plane; y <= 13; y++) {
      let x = 0;
      while (x < HEAD.x && partOf(s.at(x, Math.max(y, plane + 1), 48)) !== PART.head) x++;
      for (let i = x - 1; i <= (y === plane ? 8 : x - 1); i++) {
        if (s.at(i, y, 48)) continue;
        s.set(i, y, 48, FRAME, PART.glasses);
        s.set(mirror(i), y, 48, FRAME, PART.glasses);
      }
    }
  }

  // What is worn on the head.
  const worn = GARMENT[avatar.accessory.color];
  if (avatar.accessory.style === "earrings") {
    for (const x of [4, mirror(4)])
      for (const z of [44, 45]) if (!s.at(x, 14, z)) s.set(x, 14, z, worn, PART.accessory);
  }
  if (avatar.accessory.style === "headphones") {
    // A band over whatever is on the head, and a cup over each ear.
    s.fill(PART.accessory, (x, y, z) =>
      y >= 13 && y <= 15 && z >= 50 && shape(x, y, z, crown + 1) <= 1 && shape(x, y, z, crown) > 1
        ? shade(worn, 0.6)
        : undefined,
    );
    const side = avatar.hat.style === "none" && cut ? cut.side + (cut.lumps ? 1 : 0) : 1;
    const outer = Math.max(0, 3 - side);
    s.both(outer, 4, 11, 17, 44, 51, worn, PART.accessory);
    s.both(outer, outer, 12, 16, 45, 50, shade(worn, 0.8), PART.accessory);
  }
}
