/**
 * Shared "smooth field -> RGBA" conversion.
 *
 * Used by the live HeatmapRenderer AND the GIF / PNG exporters so every output
 * uses exactly the same colormap, thresholds and alpha behaviour. Cells with no
 * coverage (or below the visible threshold) are written fully transparent.
 */

import type { UpsampledField } from "./interpolation.js";

/**
 * Fill an RGBA byte buffer from a smoothed field using a precomputed colormap LUT
 * (256 entries x RGBA). `range` is the colorbar [lo, hi]; `visibleMin` hides
 * sub-threshold pixels. Pass `out` to avoid allocation.
 */
export function colorizeField(
  field: UpsampledField,
  lut: Uint8ClampedArray,
  visibleMin: number,
  range: [number, number],
  out: Uint8ClampedArray = new Uint8ClampedArray(field.value.length * 4),
): Uint8ClampedArray {
  const [lo, hi] = range;
  const span = hi - lo || 1;
  const value = field.value;
  const coverage = field.coverage;
  for (let i = 0; i < value.length; i++) {
    const cov = coverage[i];
    const p = value[i];
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    if (cov > 1e-3 && p >= visibleMin) {
      const t = Math.max(0, Math.min(1, (p - lo) / span));
      const idx = Math.min(255, Math.max(0, Math.round(t * 255))) * 4;
      r = lut[idx];
      g = lut[idx + 1];
      b = lut[idx + 2];
      a = Math.round(Math.min(1, cov) * 255);
    }
    const o = i * 4;
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = a;
  }
  return out;
}
