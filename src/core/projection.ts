/**
 * Temporal projections of a recording's per-frame pressure fields, used for the
 * static "summary heatmap". NaN means a cell was below the visible threshold in
 * that frame and is ignored (so projections reflect only real contact).
 */

import type { Matrix } from "./types.js";

/**
 * Per-cell MAXIMUM pressure across all frames (peak footprint). A cell is NaN in
 * the result only if it was never visible in any frame.
 */
export function maxProjection(frames: readonly Matrix[]): Matrix {
  const n = frames[0]?.length ?? 0;
  const out = new Float64Array(n).fill(Number.NaN);
  for (const f of frames) {
    for (let i = 0; i < n; i++) {
      const v = f[i];
      if (Number.isNaN(v)) continue;
      if (Number.isNaN(out[i]) || v > out[i]) out[i] = v;
    }
  }
  return out;
}

/**
 * Per-cell MEAN pressure over the frames in which the cell was visible (average
 * load while in contact). Cells never visible stay NaN.
 */
export function meanProjection(frames: readonly Matrix[]): Matrix {
  const n = frames[0]?.length ?? 0;
  const sum = new Float64Array(n);
  const count = new Float64Array(n);
  for (const f of frames) {
    for (let i = 0; i < n; i++) {
      const v = f[i];
      if (Number.isNaN(v)) continue;
      sum[i] += v;
      count[i] += 1;
    }
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = count[i] > 0 ? sum[i] / count[i] : Number.NaN;
  return out;
}
