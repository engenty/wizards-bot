import { describe, expect, it } from "vitest";
import page from "../../index.html?raw";
import css from "../styles/ember-primitives.css?raw";
import { BRANDED_GROUNDS } from "./theme";

type Oklch = [l: number, c: number, h: number];

const oklch = (text: string): Oklch => {
  const [, l, c, h] = text.match(/oklch\(([\d.]+)% ([\d.]+) ([\d.]+)\)/) ?? [];
  return [Number(l) / 100, Number(c), Number(h)];
};

function linear([l, c, h]: Oklch): number[] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const x = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const y = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const z = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * x - 3.3077115913 * y + 0.2309699292 * z,
    -1.2684380046 * x + 2.6097574011 * y - 0.3413193965 * z,
    -0.0041960863 * x - 0.7034186147 * y + 1.707614701 * z,
  ];
}

/** WCAG's contrast of two colours. */
function contrast(one: Oklch, other: Oklch): number {
  const [light, dark] = [one, other]
    .map(linear)
    .map((rgb) => {
      const [r = 0, g = 0, b = 0] = rgb.map((v) => Math.min(1, Math.max(0, v)));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    })
    .sort((a, b) => b - a) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

const inGamut = (colour: Oklch) => linear(colour).every((v) => v > -0.005 && v < 1.005);

/** The seed of the accent that a base colour sets in the light or the dark theme. */
function seed(ground: string, dark: boolean): Oklch {
  const rule = `:root${dark ? ".dark" : ""}[data-ground="${ground}"]:not(.branded) {`;
  return oklch(css.slice(css.indexOf(rule) + rule.length).split("}")[0] ?? "");
}

/** The button's colour, its text and the marks, as ember-primitives.css and shadcn-ember.css make them. */
function accent([l, c, h]: Oklch, dark: boolean) {
  const button: Oklch = [l + (dark ? 0.08 : -0.08), c, h];
  const text: Oklch = [button[0] < 0.65 ? 0.99 : 0.16, 0.01, h];
  const clamp = (x: number) => (dark ? Math.max(x, 0.6) : Math.min(x, 0.65));
  return { button, text, mark: [clamp(l), c, h] as Oklch, link: [clamp(button[0]), c, h] as Oklch };
}

describe("the base colours", () => {
  for (const { ground, stage, accent: branded, light, dark } of BRANDED_GROUNDS) {
    it(`${ground} carries text in every theme`, () => {
      // The page and the card on it: white paper in light, the near-black stage in dark.
      const pages = {
        light: [oklch("oklch(97% 0.004 80)"), oklch("oklch(100% 0 0)")],
        dark: [oklch("oklch(21% 0.035 264)"), oklch("oklch(27% 0.033 264)")],
      };
      for (const mode of ["light", "dark"] as const) {
        const { button, text, mark, link } = accent(seed(ground, mode === "dark"), mode === "dark");
        expect(contrast(text, button)).toBeGreaterThanOrEqual(4.5);
        for (const on of pages[mode]) {
          expect(contrast(link, on)).toBeGreaterThanOrEqual(4.5);
          expect(contrast(mark, on)).toBeGreaterThanOrEqual(3);
        }
        expect(inGamut(button)).toBe(true);
        // The swatch that picks it shows the button's colour.
        const swatch = oklch(mode === "dark" ? dark : light);
        for (const i of [0, 1, 2] as const) expect(swatch[i]).toBeCloseTo(button[i]);
      }
      expect(contrast(oklch(branded), oklch(stage))).toBeGreaterThanOrEqual(3);
    });

    it(`${ground} is known before the page is drawn`, () => {
      expect(page).toContain(`"${ground}"`);
    });
  }
});
