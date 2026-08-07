import { CELL_AREA_CM2, COL_PITCH_CM, GRID_COLS, GRID_ROWS, ROW_PITCH_CM } from "../../core/constants.js";
import type { BBox, PawBlob } from "../types.js";

export { COL_PITCH_CM, ROW_PITCH_CM, CELL_AREA_CM2 };

/**
 * Physical cm coordinates on the mat.
 *   x = lateral (col × 1.825 cm) — width axis, short edge
 *   y = longitudinal (row × 4.2 cm) — walk axis, long edge (TOP → BOTTOM)
 */
export function colRowToCm(col: number, row: number): { x: number; y: number } {
  return { x: col * COL_PITCH_CM, y: row * ROW_PITCH_CM };
}

export function lateralCm(col: number): number {
  return col * COL_PITCH_CM;
}

export function longitudinalCm(row: number): number {
  return row * ROW_PITCH_CM;
}

export function distCm(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

export function bboxAreaCm2(bbox: BBox): number {
  const w = (bbox.maxCol - bbox.minCol + 1) * COL_PITCH_CM;
  const h = (bbox.maxRow - bbox.minRow + 1) * ROW_PITCH_CM;
  return w * h;
}

export function blobTouchesEdge(bbox: BBox): boolean {
  return (
    bbox.minRow <= 0 ||
    bbox.maxRow >= GRID_ROWS - 1 ||
    bbox.minCol <= 0 ||
    bbox.maxCol >= GRID_COLS - 1
  );
}

/** Pressure-weighted sub-pixel centroid in cm (x=lateral, y=longitudinal). */
export function blobCentroidCm(blob: PawBlob, pressures?: Float32Array): { x: number; y: number } {
  let wx = 0;
  let wy = 0;
  let wSum = 0;
  for (const cell of blob.cells) {
    const w =
      pressures != null
        ? pressures[cell.row * GRID_COLS + cell.col] ?? blob.peakPressure
        : blob.peakPressure;
    if (w <= 0) continue;
    wx += cell.col * w;
    wy += cell.row * w;
    wSum += w;
  }
  if (wSum <= 0) return colRowToCm(blob.copX, blob.copY);
  return colRowToCm(wx / wSum, wy / wSum);
}

export function robustMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const m = sorted.length >> 1;
  return sorted.length % 2 ? sorted[m]! : (sorted[m - 1]! + sorted[m]!) / 2;
}

export function robustMean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
