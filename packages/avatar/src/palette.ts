import type { Avatar } from "@wizards-bot/protocol";

/** A colour as 0xRRGGBB. */
export type Rgb = number;

export const SKIN: Record<Avatar["skin"], Rgb> = {
  light: 0xf6d7c3,
  fair: 0xeebd9e,
  medium: 0xd9a074,
  tan: 0xbd8556,
  brown: 0x8f5a3a,
  dark: 0x5b3a29,
};

export const HAIR: Record<Avatar["hair"]["color"], Rgb> = {
  black: 0x1f1b1e,
  brown: 0x4a3023,
  chestnut: 0x7a4526,
  blond: 0xd9b25f,
  red: 0xb4502a,
  grey: 0x8e8e94,
  white: 0xe9e7e2,
  blue: 0x3c6fd6,
  pink: 0xe67aa8,
};

export const GARMENT: Record<Avatar["top"]["color"], Rgb> = {
  white: 0xf2f0eb,
  black: 0x24232a,
  grey: 0x8a8d96,
  navy: 0x25355e,
  blue: 0x3b74d9,
  teal: 0x2c9c95,
  green: 0x3f9a52,
  olive: 0x6f7436,
  yellow: 0xe9c23f,
  orange: 0xe0531b,
  red: 0xc93a36,
  pink: 0xe58bb0,
  purple: 0x7a55c7,
  brown: 0x7a4f33,
  beige: 0xd8c3a0,
};

export const INK: Rgb = 0x1d1b26;

/** A colour made lighter (factor above 1) or darker (below 1). */
export function shade(color: Rgb, factor: number): Rgb {
  const channel = (value: number) => Math.max(0, Math.min(255, Math.round(value * factor)));
  return (
    (channel((color >> 16) & 255) << 16) | (channel((color >> 8) & 255) << 8) | channel(color & 255)
  );
}

/** Two colours mixed: `share` of the second in the first. */
export function mix(a: Rgb, b: Rgb, share: number): Rgb {
  const channel = (shift: number) =>
    Math.round(((a >> shift) & 255) * (1 - share) + ((b >> shift) & 255) * share) << shift;
  return channel(16) | channel(8) | channel(0);
}
