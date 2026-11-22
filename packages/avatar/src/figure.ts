import type { Avatar } from "@wizards-bot/protocol";
import { buildHead, HEAD } from "./head.ts";
import { type Model, PART, sculpt } from "./model.ts";
import { GARMENT, mix, type Rgb, SKIN, shade } from "./palette.ts";

// The person as a figure of small cubes. It is built from the avatar's traits by rule, so
// there is no picture file: a trait changes which cubes exist and what colour they have.
// The head is large and the body small: the face is what one looks at.

export const WIDTH = 32;
export const DEPTH = 34;
export const HEIGHT = 68;

/** The layer the head view starts at: the chest below the shoulders. */
const BUST = 33;
/** Room in front of the face, for the peak of a cap. */
const AHEAD = 2;
/** The front of the chest, where a shirt has its buttons. */
const CHEST = 11;

/** How far down a top reaches, and where its sleeves end. */
const TOPS: Record<Avatar["top"]["style"], { hem: number; sleeve: number }> = {
  tank: { hem: 20, sleeve: 36 },
  tee: { hem: 20, sleeve: 30 },
  sweater: { hem: 20, sleeve: 22 },
  stripes: { hem: 20, sleeve: 22 },
  shirt: { hem: 20, sleeve: 22 },
  hoodie: { hem: 19, sleeve: 22 },
  jacket: { hem: 19, sleeve: 22 },
};

/** The figure for an avatar. */
export function buildFigure(avatar: Avatar): Model {
  const s = sculpt(
    WIDTH,
    DEPTH,
    HEIGHT,
    BUST,
    { z: HEAD.z, y: HEAD.y, front: HEAD.ry, chin: HEAD.z - HEAD.rz },
    AHEAD,
  );
  const mirror = (x: number): number => WIDTH - 1 - x;
  const skin = SKIN[avatar.skin];
  const top = GARMENT[avatar.top.color];
  const bottom = GARMENT[avatar.bottom.color];
  const shoe = GARMENT[avatar.shoes.color];
  const worn = GARMENT[avatar.accessory.color];
  const legs = [PART.leftLeg, PART.rightLeg] as const;
  const arms = [PART.leftArm, PART.rightArm] as const;
  const shoes = [PART.leftShoe, PART.rightShoe] as const;

  // Legs and feet. The legs are short.
  s.both(10, 14, 12, 17, 2, 17, skin, ...legs);
  const sole = avatar.shoes.color === "white" ? 0xbab6ae : mix(shoe, GARMENT.white, 0.85);
  if (avatar.shoes.style === "sneakers") {
    s.both(10, 14, 9, 17, 0, 2, shoe, ...shoes);
    s.both(10, 14, 9, 17, 0, 0, sole, ...shoes);
    s.both(11, 13, 9, 9, 1, 1, sole, ...shoes);
  }
  if (avatar.shoes.style === "boots") {
    s.both(10, 14, 9, 17, 0, 2, shoe, ...shoes);
    s.both(10, 14, 11, 17, 3, 8, shoe, ...shoes);
    s.both(10, 14, 9, 17, 0, 0, shade(shoe, 0.55), ...shoes);
  }
  if (avatar.shoes.style === "flats") {
    s.both(10, 14, 9, 17, 0, 1, shoe, ...shoes);
    s.both(10, 14, 12, 16, 1, 1, skin, ...legs);
  }

  // What is worn on the legs.
  const hips = (): void => s.box(9, 22, 11, 18, 18, 21, bottom, PART.body);
  switch (avatar.bottom.style) {
    case "trousers":
      s.both(10, 14, 12, 17, 3, 17, bottom, ...legs);
      hips();
      break;
    case "wide":
      s.both(9, 14, 11, 18, 3, 17, bottom, ...legs);
      s.both(8, 14, 10, 18, 3, 5, bottom, ...legs);
      hips();
      break;
    case "shorts":
      s.both(9, 14, 11, 18, 12, 17, bottom, ...legs);
      hips();
      break;
    case "skirt":
    case "longskirt": {
      // Wider towards the hem.
      const long = avatar.bottom.style === "longskirt";
      const hem = long ? 4 : 11;
      for (let z = hem; z <= 21; z++) {
        const wide = Math.min(
          long ? 3 : 2,
          Math.floor((21 - z) / (long ? 5 : 4)) + (z < 20 ? 1 : 0),
        );
        s.box(9 - wide, 22 + wide, 11 - wide, 18 + wide, z, z, bottom, PART.body);
        for (const x of [9 - wide, 22 + wide])
          for (const y of [11 - wide, 18 + wide]) if (wide) s.clear(x, y, z);
      }
      s.box(9, 22, 11, 18, 21, 21, shade(bottom, 0.85), PART.body);
      break;
    }
  }

  // The body and the arms; the hands hang below the sleeves.
  const { hem, sleeve } = TOPS[avatar.top.style];
  const striped = avatar.top.style === "stripes";
  const cloth = (z: number): Rgb => (striped && z % 4 < 2 ? mix(top, GARMENT.white, 0.82) : top);
  for (let z = hem; z <= 36; z++) s.box(9, 22, 11, 18, z, z, cloth(z), PART.body);
  s.both(6, 8, 12, 17, 20, 35, skin, ...arms);
  for (let z = sleeve; z <= 35; z++) s.both(6, 8, 12, 17, z, z, cloth(z), ...arms);
  for (let y = 11; y <= 18; y++) {
    for (const x of [9, 22]) s.clear(x, y, 36);
    for (const x of [6, mirror(6)]) s.clear(x, y, 35);
  }
  const chest = (x0: number, x1: number, z0: number, z1: number, color: Rgb): void =>
    s.box(x0, x1, CHEST, CHEST, z0, z1, color, PART.body);
  const edge = shade(top, 0.84);
  const light = shade(top, 1.16);
  switch (avatar.top.style) {
    case "tank":
      // Straps over the shoulders: the neck and the arms are bare.
      s.box(13, 18, 11, 18, 35, 36, skin, PART.body);
      chest(13, 18, 33, 34, skin);
      s.both(10, 10, 11, 18, 34, 36, skin, PART.body);
      break;
    case "tee":
      s.box(13, 18, 11, 18, 36, 36, skin, PART.body);
      chest(14, 17, 35, 35, skin);
      s.both(6, 8, 12, 17, 30, 30, edge, ...arms);
      break;
    case "sweater":
      s.box(12, 19, 11, 18, 36, 36, edge, PART.body);
      s.box(9, 22, 11, 18, hem, hem + 1, edge, PART.body);
      s.both(6, 8, 12, 17, 22, 23, edge, ...arms);
      break;
    case "stripes":
      s.box(13, 18, 11, 18, 36, 36, skin, PART.body);
      break;
    case "shirt":
      // A collar, a row of buttons, cuffs.
      s.box(12, 19, 11, 18, 36, 36, light, PART.body);
      s.both(12, 14, CHEST - 1, CHEST - 1, 35, 36, light, PART.body);
      chest(15, 16, 35, 36, skin);
      chest(15, 16, hem, 34, light);
      for (let z = hem + 2; z <= 33; z += 4) chest(16, 16, z, z, shade(top, 0.6));
      s.both(6, 8, 12, 17, 22, 23, light, ...arms);
      break;
    case "hoodie":
      // The hood lies on the back; a pocket in front, and two cords.
      s.box(10, 21, 17, 21, 33, 38, top, PART.body);
      s.box(11, 20, 18, 22, 34, 37, top, PART.body);
      s.box(11, 20, 10, 12, 36, 37, edge, PART.body);
      s.box(13, 18, 12, 17, 36, 37, skin, PART.body);
      chest(12, 19, 22, 26, edge);
      for (const x of [14, 17]) s.box(x, x, CHEST - 1, CHEST - 1, 31, 35, GARMENT.white, PART.body);
      s.box(9, 22, 11, 18, hem, hem, edge, PART.body);
      s.both(6, 8, 12, 17, 22, 22, edge, ...arms);
      break;
    case "jacket":
      // Worn open over a white top, with lapels and a collar.
      chest(14, 17, hem, 36, GARMENT.white);
      s.box(13, 18, 11, 18, 36, 36, skin, PART.body);
      s.both(13, 13, CHEST - 1, CHEST - 1, 28, 36, edge, PART.body);
      s.both(12, 12, CHEST - 1, CHEST - 1, 32, 36, edge, PART.body);
      s.box(11, 20, 17, 19, 37, 37, edge, PART.body);
      s.both(11, 11, 12, 17, 37, 37, edge, PART.body);
      break;
  }

  // What is worn on the body goes on before the head, so hair lies over it.
  if (avatar.accessory.style === "tie") {
    s.box(15, 16, CHEST - 1, CHEST - 1, 25, 36, worn, PART.accessory);
    s.box(15, 16, CHEST - 1, CHEST - 1, 35, 35, shade(worn, 0.8), PART.accessory);
  }
  if (avatar.accessory.style === "backpack") {
    s.box(10, 21, 19, 23, 22, 34, worn, PART.accessory);
    for (const x of [10, 21]) for (let y = 19; y <= 23; y++) s.clear(x, y, 34);
    s.box(12, 19, 24, 24, 23, 28, shade(worn, 0.8), PART.accessory);
    s.both(10, 11, CHEST - 1, CHEST - 1, 26, 36, shade(worn, 0.8), PART.accessory);
    s.both(10, 11, CHEST, 19, 37, 37, shade(worn, 0.8), PART.accessory);
  }

  buildHead(s, avatar);

  if (avatar.accessory.style === "scarf") {
    // Wound round the neck, one end hanging in front.
    for (let z = 35; z <= 38; z++)
      for (let y = 8; y <= 20; y++)
        for (let x = 9; x <= 22; x++) {
          const corner = (x < 11 || x > 20) && (y < 10 || y > 18);
          if (!corner && s.at(x, y, z) >>> 25 !== PART.head)
            s.set(x, y, z, z % 2 ? worn : shade(worn, 0.88), PART.accessory);
        }
    s.box(11, 13, 9, 10, 26, 35, worn, PART.accessory);
    s.box(11, 13, 9, 10, 26, 26, shade(worn, 0.8), PART.accessory);
  }

  return s.model;
}
