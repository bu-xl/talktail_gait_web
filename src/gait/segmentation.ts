import type { PawBlob, Point } from "./types.js";
import {
  applyMorphologyClose,
  normalizeMorphologyKernelSize,
  type MorphologyCloseOptions,
} from "./morphology.js";

const NEIGH8: readonly [number, number][] = [
  [-1, -1],
  [-1, 0],
  [-1, 1],
  [0, -1],
  [0, 1],
  [1, -1],
  [1, 0],
  [1, 1],
];

export interface SegmentationOptions {
  readonly morphology?: MorphologyCloseOptions;
}

/**
 * Step 2 — 8-connected CCL on (optionally morphology-closed) binary mask, O(rows*cols).
 * Pressure stats use original `data` values; morphology only affects connectivity.
 */
export function segmentPaws(
  data: Float32Array,
  rows: number,
  cols: number,
  minArea: number,
  options: SegmentationOptions = {},
): PawBlob[] {
  const n = rows * cols;
  const morph = options.morphology ?? { enabled: false, kernelSize: 3 };
  const activeMask = applyMorphologyClose(data, rows, cols, {
    enabled: morph.enabled,
    kernelSize: normalizeMorphologyKernelSize(morph.kernelSize),
  });

  const labels = new Int32Array(n);
  labels.fill(-1);
  const stack: number[] = [];
  const blobs: PawBlob[] = [];
  let nextId = 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (activeMask[idx]! === 0 || labels[idx]! >= 0) continue;

      labels[idx] = nextId;
      stack.length = 0;
      stack.push(idx);

      let sumP = 0;
      let peak = 0;
      let xSum = 0;
      let ySum = 0;
      let wxSum = 0;
      let wySum = 0;
      let minRow = rows;
      let maxRow = -1;
      let minCol = cols;
      let maxCol = -1;
      const cells: Point[] = [];
      let pressureCellCount = 0;

      while (stack.length > 0) {
        const cur = stack.pop()!;
        const cr = (cur / cols) | 0;
        const cc = cur % cols;
        const v = data[cur]!;
        cells.push({ row: cr, col: cc });
        xSum += cc;
        ySum += cr;
        if (v > 0) {
          pressureCellCount++;
          sumP += v;
          if (v > peak) peak = v;
          wxSum += cc * v;
          wySum += cr * v;
        }
        if (cr < minRow) minRow = cr;
        if (cr > maxRow) maxRow = cr;
        if (cc < minCol) minCol = cc;
        if (cc > maxCol) maxCol = cc;

        for (const [dr, dc] of NEIGH8) {
          const nr = cr + dr;
          const nc = cc + dc;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
          const ni = nr * cols + nc;
          if (activeMask[ni]! > 0 && labels[ni]! < 0) {
            labels[ni] = nextId;
            stack.push(ni);
          }
        }
      }

      if (cells.length >= minArea && pressureCellCount > 0) {
        const area = cells.length;
        const copX = sumP > 0 ? wxSum / sumP : xSum / area;
        const copY = sumP > 0 ? wySum / sumP : ySum / area;
        blobs.push({
          id: nextId,
          cells,
          centerX: xSum / area,
          centerY: ySum / area,
          copX,
          copY,
          area,
          pressureSum: sumP,
          peakPressure: peak,
          bbox: { minRow, maxRow, minCol, maxCol },
        });
      }
      nextId++;
    }
  }

  return blobs;
}
