/**
 * Parser for saved recordings.
 *
 * File format (one block per frame):
 *
 *   <timestamp>:
 *   v v v ... (40 numbers)
 *   ... (40 lines total)
 *   <timestamp>:
 *   ...
 *
 * Each block is one frame: a timestamp line ending in ':' followed by 40 rows of
 * 40 whitespace/comma-separated raw values, reshaped row-major into a 40x40
 * matrix — the same shape produced by the live serial parser, so playback runs
 * the identical downstream pipeline (calibrate -> pressure -> threshold -> render).
 */

import { GRID_COLS, GRID_ROWS, SENSOR_COUNT } from "./constants.js";
import type { Matrix } from "./types.js";

export interface PlaybackFrame {
  timestamp: string;
  /** row-major 40x40 raw matrix */
  raw: Matrix;
}

const TIMESTAMP_LINE = /:\s*$/;

/** Parse the full recording text into ordered playback frames. */
export function parsePlayback(text: string, rows = GRID_ROWS, cols = GRID_COLS): PlaybackFrame[] {
  const lines = text.split(/\r?\n/);
  const frames: PlaybackFrame[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line === "") {
      i++;
      continue;
    }
    if (TIMESTAMP_LINE.test(line)) {
      const timestamp = line.replace(TIMESTAMP_LINE, "").trim();
      const { matrix, next } = readMatrixBlock(lines, i + 1, rows, cols);
      if (matrix) frames.push({ timestamp, raw: matrix });
      i = next;
    } else {
      // Tolerate headerless blocks: a run of numeric rows with no timestamp.
      const { matrix, next } = readMatrixBlock(lines, i, rows, cols);
      if (matrix) {
        frames.push({ timestamp: String(frames.length), raw: matrix });
        i = next;
      } else {
        i++; // skip unrecognised line
      }
    }
  }
  return frames;
}

function readMatrixBlock(
  lines: string[],
  start: number,
  rows: number,
  cols: number,
): { matrix: Matrix | null; next: number } {
  const matrix = new Float64Array(rows * cols);
  let r = 0;
  let i = start;
  while (i < lines.length && r < rows) {
    const raw = lines[i].trim();
    if (raw === "") {
      i++;
      continue;
    }
    if (TIMESTAMP_LINE.test(raw)) break; // next block started early
    const nums = raw.split(/[\s,]+/).filter((s) => s.length > 0).map(Number);
    if (nums.length === 0 || nums.some((n) => Number.isNaN(n))) break;
    for (let c = 0; c < cols; c++) matrix[r * cols + c] = nums[c] ?? 0;
    r++;
    i++;
  }
  if (r !== rows) return { matrix: null, next: Math.max(i, start + 1) };
  if (matrix.length !== SENSOR_COUNT) return { matrix: null, next: i };
  return { matrix, next: i };
}

/**
 * Serialise raw matrices back to the saved-file format (for the recorder).
 */
export function serializePlayback(
  frames: Array<{ timestamp: string; raw: Matrix }>,
  rows = GRID_ROWS,
  cols = GRID_COLS,
): string {
  const out: string[] = [];
  for (const { timestamp, raw } of frames) {
    out.push(`${timestamp}:`);
    for (let r = 0; r < rows; r++) {
      const row: number[] = [];
      for (let c = 0; c < cols; c++) row.push(raw[r * cols + c]);
      out.push(row.join(" "));
    }
  }
  return out.join("\n") + "\n";
}
