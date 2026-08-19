/**
 * Colour scales for the pressure heatmap.
 *
 * The mat colormap is a reading instrument, not a styling choice. A rainbow ramp
 * (blue-cyan-green-yellow-red) is not perceptually uniform: lightness is
 * non-monotonic through the green band, so it invents contour lines where the
 * data is smooth, and red/green sit on top of each other for the most common
 * colour-vision deficiencies. Both scales below are perceptually uniform.
 *
 * Control points are sampled at 1/16 intervals from matplotlib's canonical
 * `viridis` and `cividis` and interpolated; `cividis` is the CVD-optimised
 * variant, readable with deuteranopia and protanopia.
 */

export type ColormapName = "viridis" | "cividis";

type Stop = readonly [number, number, number];

const VIRIDIS: readonly Stop[] = [
  [68, 1, 84], [72, 24, 106], [71, 45, 123], [66, 64, 134],
  [59, 82, 139], [51, 99, 141], [44, 114, 142], [38, 130, 142],
  [33, 145, 140], [31, 160, 136], [40, 174, 128], [63, 188, 115],
  [94, 201, 98], [132, 212, 75], [173, 220, 48], [216, 226, 25],
  [253, 231, 37],
];

const CIVIDIS: readonly Stop[] = [
  [0, 34, 78], [0, 46, 106], [26, 56, 111], [50, 67, 109],
  [67, 78, 108], [83, 90, 109], [97, 101, 111], [111, 112, 115],
  [125, 124, 120], [140, 136, 120], [155, 148, 118], [171, 160, 114],
  [188, 174, 108], [205, 187, 99], [222, 201, 88], [240, 216, 70],
  [254, 232, 56],
];

const STOPS: Record<ColormapName, readonly Stop[]> = {
  viridis: VIRIDIS,
  cividis: CIVIDIS,
};

export const COLORMAP_NAMES: readonly ColormapName[] = ["viridis", "cividis"];

/**
 * 256-entry RGBA lookup table.
 *
 * `fadeBelow` (0..1) ramps alpha from 0 up to opaque across the bottom of the
 * scale, so an untouched cell stays transparent and the video shows through
 * rather than being covered by the colormap's dark end.
 */
export function buildLut(name: ColormapName, fadeBelow = 0.04): Uint8ClampedArray {
  const stops = STOPS[name] ?? VIRIDIS;
  const lut = new Uint8ClampedArray(256 * 4);
  const segments = stops.length - 1;

  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const pos = t * segments;
    const idx = Math.min(segments - 1, Math.floor(pos));
    const frac = pos - idx;
    const lo = stops[idx];
    const hi = stops[idx + 1];

    const o = i * 4;
    lut[o] = lo[0] + (hi[0] - lo[0]) * frac;
    lut[o + 1] = lo[1] + (hi[1] - lo[1]) * frac;
    lut[o + 2] = lo[2] + (hi[2] - lo[2]) * frac;
    lut[o + 3] = fadeBelow > 0 ? Math.min(1, t / fadeBelow) * 255 : 255;
  }
  return lut;
}

/** CSS colour for a normalised value, for legends and the timeline curve. */
export function sampleColor(name: ColormapName, t: number): string {
  const lut = buildLut(name, 0);
  const i = Math.min(255, Math.max(0, Math.round(t * 255))) * 4;
  return `rgb(${lut[i]}, ${lut[i + 1]}, ${lut[i + 2]})`;
}

/**
 * Relative luminance per WCAG, used to check that a scale stays monotonic.
 * A ramp whose lightness reverses reads as a boundary that is not in the data.
 */
export function relativeLuminance(r: number, g: number, b: number): number {
  const f = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
