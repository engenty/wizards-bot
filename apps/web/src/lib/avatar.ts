import type { Avatar } from "@wizards-bot/protocol";
import type { Key } from "./i18n";

// What each option of a trait is called, in the order it is offered. A trait the protocol
// gains an option for does not compile until the option has its words here.

export const SKIN_NAMES: Record<Avatar["skin"], Key> = {
  light: "avatar.skin.light",
  fair: "avatar.skin.fair",
  medium: "avatar.skin.medium",
  tan: "avatar.skin.tan",
  brown: "avatar.skin.brown",
  dark: "avatar.skin.dark",
};

export const HAIR_STYLES: Record<Avatar["hair"]["style"], Key> = {
  bald: "avatar.hair.bald",
  buzz: "avatar.hair.buzz",
  short: "avatar.hair.short",
  side: "avatar.hair.side",
  quiff: "avatar.hair.quiff",
  curtains: "avatar.hair.curtains",
  spiky: "avatar.hair.spiky",
  mohawk: "avatar.hair.mohawk",
  curly: "avatar.hair.curly",
  afro: "avatar.hair.afro",
  bob: "avatar.hair.bob",
  long: "avatar.hair.long",
  ponytail: "avatar.hair.ponytail",
  bun: "avatar.hair.bun",
  pigtails: "avatar.hair.pigtails",
};

export const HAIR_NAMES: Record<Avatar["hair"]["color"], Key> = {
  black: "colour.black",
  brown: "colour.brown",
  chestnut: "colour.chestnut",
  blond: "colour.blond",
  red: "colour.red",
  grey: "colour.grey",
  white: "colour.white",
  blue: "colour.blue",
  pink: "colour.pink",
};

export const GLASSES: Record<Avatar["glasses"], Key> = {
  none: "avatar.glasses.none",
  round: "avatar.glasses.round",
  square: "avatar.glasses.square",
  shades: "avatar.glasses.shades",
};

export const BEARDS: Record<Avatar["beard"], Key> = {
  none: "avatar.beard.none",
  stubble: "avatar.beard.stubble",
  moustache: "avatar.beard.moustache",
  goatee: "avatar.beard.goatee",
  full: "avatar.beard.full",
};

export const HATS: Record<Avatar["hat"]["style"], Key> = {
  none: "avatar.hat.none",
  cap: "avatar.hat.cap",
  beanie: "avatar.hat.beanie",
  brim: "avatar.hat.brim",
};

export const TOPS: Record<Avatar["top"]["style"], Key> = {
  tank: "avatar.top.tank",
  tee: "avatar.top.tee",
  sweater: "avatar.top.sweater",
  stripes: "avatar.top.stripes",
  shirt: "avatar.top.shirt",
  hoodie: "avatar.top.hoodie",
  jacket: "avatar.top.jacket",
};

export const BOTTOMS: Record<Avatar["bottom"]["style"], Key> = {
  trousers: "avatar.bottom.trousers",
  wide: "avatar.bottom.wide",
  shorts: "avatar.bottom.shorts",
  skirt: "avatar.bottom.skirt",
  longskirt: "avatar.bottom.longskirt",
};

export const SHOES: Record<Avatar["shoes"]["style"], Key> = {
  sneakers: "avatar.shoes.sneakers",
  boots: "avatar.shoes.boots",
  flats: "avatar.shoes.flats",
};

export const ACCESSORIES: Record<Avatar["accessory"]["style"], Key> = {
  none: "avatar.accessory.none",
  scarf: "avatar.accessory.scarf",
  tie: "avatar.accessory.tie",
  headphones: "avatar.accessory.headphones",
  backpack: "avatar.accessory.backpack",
  earrings: "avatar.accessory.earrings",
};

/** The colours clothes, hats and shoes come in. */
export const GARMENT_NAMES: Record<Avatar["top"]["color"], Key> = {
  white: "colour.white",
  black: "colour.black",
  grey: "colour.grey",
  navy: "colour.navy",
  blue: "colour.blue",
  teal: "colour.teal",
  green: "colour.green",
  olive: "colour.olive",
  yellow: "colour.yellow",
  orange: "colour.orange",
  red: "colour.red",
  pink: "colour.pink",
  purple: "colour.purple",
  brown: "colour.brown",
  beige: "colour.beige",
};

/** A colour of the engine's palettes (0xRRGGBB) as CSS writes it. */
export function cssColor(rgb: number): string {
  return `#${rgb.toString(16).padStart(6, "0")}`;
}

/** Whether two avatars are the same figure. */
export function sameAvatar(a: Avatar, b: Avatar): boolean {
  return (Object.keys(a) as (keyof Avatar)[]).every((trait) => {
    const [x, y] = [a[trait], b[trait]];
    return typeof x === "string" || typeof y === "string"
      ? x === y
      : x.style === y.style && x.color === y.color;
  });
}
