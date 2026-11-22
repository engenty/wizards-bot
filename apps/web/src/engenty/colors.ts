// SPDX-License-Identifier: CC-BY-4.0
// From engenty wizards, apps/web/src/engenty/colors.ts.
/**
 * Fills, one per engenty kind: the vibrant engenty cast. Fixed, high-chroma colours rather than
 * the semantic accents (`--moss` is the success green, `--rose` the danger red), which sit
 * muted on purpose.
 */
export const ENGENTY_FILL = {
  cobalt: "oklch(60% 0.23 262)",
  amber: "oklch(82% 0.17 78)",
  moss: "oklch(72% 0.22 145)",
  rose: "oklch(64% 0.25 18)",
  ember: "oklch(70% 0.21 42)",
  teal: "oklch(74% 0.16 192)",
  violet: "oklch(60% 0.25 300)",
  magenta: "oklch(65% 0.28 345)",
  citron: "oklch(89% 0.2 118)",
  slate: "oklch(66% 0.13 235)",
} as const;
