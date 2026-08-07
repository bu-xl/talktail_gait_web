/** Row-major 40x40 matrix helpers + orientation transforms. */

import { GRID_COLS, GRID_ROWS } from "./constants.js";
import type { Matrix, OrientationConfig } from "./types.js";

export const at = (m: Matrix, row: number, col: number, cols = GRID_COLS): number =>
  m[row * cols + col];

export const setAt = (
  m: Matrix,
  row: number,
  col: number,
  value: number,
  cols = GRID_COLS,
): void => {
  m[row * cols + col] = value;
};

export const makeMatrix = (rows = GRID_ROWS, cols = GRID_COLS): Matrix =>
  new Float64Array(rows * cols);

/**
 * Apply display orientation to a raw matrix.
 *
 * The core mapping (per spec) for a 90-degree rotation is
 *   rotated[col][R-1-row] = raw[row][col]
 * which turns a stored row-major frame into the upright portrait display. Flip
 * options are applied afterwards. Each transform is independent and configurable.
 */
export function applyOrientation(
  raw: Matrix,
  orient: OrientationConfig,
  rows = GRID_ROWS,
  cols = GRID_COLS,
): { matrix: Matrix; rows: number; cols: number } {
  let m = raw;
  let r = rows;
  let c = cols;

  if (orient.rotate90) {
    // rotated has dimensions cols x rows; rotated[col][r-1-row] = raw[row][col]
    const out = new Float64Array(rows * cols);
    const newRows = cols;
    const newCols = rows;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        out[col * newCols + (rows - 1 - row)] = m[row * cols + col];
      }
    }
    m = out;
    r = newRows;
    c = newCols;
  }

  if (orient.flipHorizontal) {
    const out = new Float64Array(r * c);
    for (let row = 0; row < r; row++) {
      for (let col = 0; col < c; col++) {
        out[row * c + (c - 1 - col)] = m[row * c + col];
      }
    }
    m = out;
  }

  if (orient.flipVertical) {
    const out = new Float64Array(r * c);
    for (let row = 0; row < r; row++) {
      for (let col = 0; col < c; col++) {
        out[(r - 1 - row) * c + col] = m[row * c + col];
      }
    }
    m = out;
  }

  return { matrix: m, rows: r, cols: c };
}
