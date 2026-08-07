/**
 * Export recorded raw frames to a CSV that the `canine_gait` Python engine can
 * ingest directly.
 *
 * Header convention (matches canine_gait's `p_{row}_{col}` grid auto-detection):
 *
 *   frame_id,time,p_0_0,p_0_1,...,p_0_39,p_1_0,...,p_39_39
 *
 * - `frame_id`  : 0-based frame index.
 * - `time`      : seconds (float) from the start of the recording.
 * - `p_R_C`     : RAW sensor value (0..4095) at row R, col C, row-major.
 *
 * The engine performs its own baseline/calibration, so RAW values are exported
 * (not the relative/mmHg pressure shown on screen).
 */

import { GRID_COLS, GRID_ROWS } from "./constants.js";
import type { RecordedFrame } from "./recorder.js";

/** Build the `p_R_C` column header list for a rows x cols grid (row-major). */
export function pressureColumnHeaders(rows = GRID_ROWS, cols = GRID_COLS): string[] {
  const cols_: string[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) cols_.push(`p_${r}_${c}`);
  }
  return cols_;
}

/**
 * Serialise recorded frames to canine_gait-compatible CSV text. Raw values are
 * written as integers; `time` is seconds with millisecond precision.
 */
export function framesToCanineGaitCsv(
  frames: readonly RecordedFrame[],
  rows = GRID_ROWS,
  cols = GRID_COLS,
): string {
  const header = ["frame_id", "time", ...pressureColumnHeaders(rows, cols)].join(",");
  const lines: string[] = [header];
  const cells = rows * cols;

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const row = new Array<string>(cells + 2);
    row[0] = String(i);
    row[1] = (f.t / 1000).toFixed(3);
    for (let k = 0; k < cells; k++) {
      const v = f.raw[k];
      // Raw ADC counts are integers; round defensively in case of float drift.
      row[k + 2] = Number.isFinite(v) ? String(Math.round(v)) : "";
    }
    lines.push(row.join(","));
  }

  return lines.join("\n") + "\n";
}
