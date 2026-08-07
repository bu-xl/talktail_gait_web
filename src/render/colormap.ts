/**
 * Fixed pressure colormap (no per-frame autoscale -> no flicker).
 *
 * Stops (mmHg):
 *   < 10        transparent
 *   10 .. 20    blue
 *   20 .. 30    cyan / green
 *   30 .. 50    yellow / orange
 *   > 50        red
 *
 * The mapping is anchored to colorbar_range (default [10, 80]) so colours are
 * stable across frames and subjects.
 */

type RGB = [number, number, number];

interface Stop {
  mmhg: number;
  rgb: RGB;
}

const STOPS: Stop[] = [
  { mmhg: 10, rgb: [40, 60, 200] }, // blue
  { mmhg: 20, rgb: [0, 170, 220] }, // cyan
  { mmhg: 30, rgb: [40, 200, 90] }, // green
  { mmhg: 40, rgb: [240, 220, 40] }, // yellow
  { mmhg: 50, rgb: [245, 150, 30] }, // orange
  { mmhg: 80, rgb: [220, 30, 30] }, // red
];

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Map a pressure (mmHg) to an RGBA value. Returns alpha 0 below `visibleMin`.
 * `range` clamps the gradient endpoints (colorbar_range).
 */
export function pressureToRgba(
  mmhg: number,
  visibleMin: number,
  range: [number, number],
): [number, number, number, number] {
  if (Number.isNaN(mmhg) || mmhg < visibleMin) return [0, 0, 0, 0];

  const v = Math.max(range[0], Math.min(range[1], mmhg));

  // Find the bracketing stops.
  let lo = STOPS[0];
  let hi = STOPS[STOPS.length - 1];
  for (let i = 0; i < STOPS.length - 1; i++) {
    if (v >= STOPS[i].mmhg && v <= STOPS[i + 1].mmhg) {
      lo = STOPS[i];
      hi = STOPS[i + 1];
      break;
    }
  }
  const span = hi.mmhg - lo.mmhg || 1;
  const t = (v - lo.mmhg) / span;
  const r = Math.round(lerp(lo.rgb[0], hi.rgb[0], t));
  const g = Math.round(lerp(lo.rgb[1], hi.rgb[1], t));
  const b = Math.round(lerp(lo.rgb[2], hi.rgb[2], t));
  return [r, g, b, 255];
}

/** Precompute a 256-entry RGBA lookup table over the colorbar range. */
export function buildLut(
  visibleMin: number,
  range: [number, number],
  size = 256,
): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(size * 4);
  for (let i = 0; i < size; i++) {
    const mmhg = range[0] + ((range[1] - range[0]) * i) / (size - 1);
    const [r, g, b, a] = pressureToRgba(mmhg, visibleMin, range);
    lut[i * 4] = r;
    lut[i * 4 + 1] = g;
    lut[i * 4 + 2] = b;
    lut[i * 4 + 3] = a;
  }
  return lut;
}
