/**
 * Spatial noise reduction for the raw 40x40 frame and the thresholded pressure
 * field. FSR mats produce two noise types this module targets:
 *
 *   1. single-pixel ADC spikes  -> 3x3 spatial median on the RAW matrix removes
 *      them at the source without blurring real contact regions;
 *   2. isolated speckle cells    -> a minimum-active-neighbour gate drops any
 *      visible cell that has fewer than `minNeighbors` visible 8-neighbours
 *      (real paw/foot contact is always a connected blob).
 *
 * Both are cheap (1600 cells) and deterministic.
 */

/** 3x3 (or NxN) spatial median filter on a row-major matrix (edge-clamped). */
export function spatialMedian(
  src: Float64Array,
  rows: number,
  cols: number,
  size = 3,
): Float64Array {
  const r = Math.max(1, size >> 1);
  const out = new Float64Array(rows * cols);
  const window: number[] = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      window.length = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(rows - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx++) {
          const xx = Math.min(cols - 1, Math.max(0, x + dx));
          window.push(src[yy * cols + xx]);
        }
      }
      window.sort((a, b) => a - b);
      out[y * cols + x] = window[window.length >> 1];
    }
  }
  return out;
}

/**
 * Remove isolated visible cells: a cell stays only if it has at least
 * `minNeighbors` visible (non-NaN) 8-neighbours. NaN means "not visible".
 */
export function minNeighborGate(
  pressure: Float64Array,
  rows: number,
  cols: number,
  minNeighbors: number,
): Float64Array {
  if (minNeighbors <= 0) return pressure;
  const out = Float64Array.from(pressure);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = y * cols + x;
      if (Number.isNaN(pressure[i])) continue;
      let count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const yy = y + dy;
          const xx = x + dx;
          if (yy < 0 || yy >= rows || xx < 0 || xx >= cols) continue;
          if (!Number.isNaN(pressure[yy * cols + xx])) count++;
        }
      }
      if (count < minNeighbors) out[i] = Number.NaN;
    }
  }
  return out;
}
