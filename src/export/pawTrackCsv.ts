/**
 * Paw-tracking CSV — one row per detected paw per frame, for gait analysis in a
 * spreadsheet / external tool. Complements the raw `p_R_C` pressure CSV: instead
 * of pixels it records WHERE each labelled paw was and HOW hard it pressed.
 *
 * Columns:
 *   frame      0-based frame index
 *   time_s     seconds from recording start
 *   track_id   stable per-paw id (same paw keeps its id across frames)
 *   paw        LF | RF | LH | RH | Unknown
 *   confidence label confidence 0..1
 *   row, col   pressure-weighted centre (grid units; row=y, col=x)
 *   peak       peak display pressure inside the paw box (heatmap unit)
 *   force      summed display pressure inside the paw box (load proxy)
 *   area       contact cell count
 *   bbox_*     integer grid bounding box (inclusive)
 */

import { fieldStatsInBBox, type PawOverlayFrame } from "../gait/index.js";
import type { Matrix } from "../core/types.js";

const HEADER = [
  "frame",
  "time_s",
  "track_id",
  "paw",
  "confidence",
  "row",
  "col",
  "peak",
  "force",
  "area",
  "bbox_min_row",
  "bbox_max_row",
  "bbox_min_col",
  "bbox_max_col",
].join(",");

export function pawTrackToCsv(
  overlayFrames: readonly PawOverlayFrame[],
  displayFields: readonly Matrix[],
  timestampsSec: readonly number[],
  cols: number,
): string {
  const lines: string[] = [HEADER];

  for (let fi = 0; fi < overlayFrames.length; fi++) {
    const frame = overlayFrames[fi]!;
    if (frame.items.length === 0) continue;
    const field = displayFields[fi];
    const tSec = timestampsSec[fi] ?? 0;

    for (const item of frame.items) {
      const stats = field ? fieldStatsInBBox(field, cols, item.bbox) : { peak: 0, force: 0 };
      lines.push(
        [
          fi,
          tSec.toFixed(3),
          item.trackId,
          item.label,
          item.confidence.toFixed(2),
          item.copRow.toFixed(2),
          item.copCol.toFixed(2),
          Math.round(stats.peak),
          Math.round(stats.force),
          item.area,
          item.bbox.minRow,
          item.bbox.maxRow,
          item.bbox.minCol,
          item.bbox.maxCol,
        ].join(","),
      );
    }
  }

  return lines.join("\n") + "\n";
}
