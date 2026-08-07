/**
 * Serialise a GaitSummary into a human- and spreadsheet-friendly CSV report:
 * an overview block (key/value) followed by a per-paw metrics table.
 */

import type { GaitSummary } from "../core/gaitAnalysis.js";

const f = (x: number | null | undefined, d = 2): string =>
  x == null || !Number.isFinite(x) ? "" : x.toFixed(d);

/** Escape a CSV field (quote if it contains comma, quote or newline). */
function esc(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function row(...cells: Array<string | number>): string {
  return cells.map((c) => esc(String(c))).join(",");
}

export function gaitSummaryToCsv(s: GaitSummary): string {
  const lines: string[] = [];

  lines.push(row("section", "metric", "value"));
  lines.push(row("overview", "analyzed_at", s.analyzedAt));
  lines.push(row("overview", "validity", s.validity));
  lines.push(row("overview", "ok_for_clinical_use", s.ok ? "yes" : "no"));
  lines.push(row("overview", "dog_weight_kg", f(s.weightKg, 2)));
  lines.push(row("overview", "direction", s.direction));
  lines.push(row("overview", "direction_confidence", f(s.directionConfidence, 2)));
  lines.push(row("overview", "detected_paws", s.detectedPaws.join(" ")));
  lines.push(row("overview", "missing_paws", s.missingPaws.join(" ")));
  lines.push(row("overview", "frame_count", s.frameCount));
  lines.push(row("overview", "duration_sec", f(s.durationSec, 2)));
  lines.push(row("overview", "fps", f(s.fps, 1)));
  lines.push(row("overview", "effective_hz", f(s.effectiveHz, 1)));
  lines.push(row("overview", "samples_per_stance", f(s.samplesPerStance, 1)));
  lines.push(row("overview", "cadence_hz", f(s.cadenceHz, 2)));
  lines.push(row("overview", "velocity_cells_per_s", f(s.velocity, 2)));
  lines.push(row("overview", "step_length_cells", f(s.stepLength, 2)));
  lines.push(row("overview", "stride_length_cells", f(s.strideLength, 2)));
  lines.push(row("overview", "load_fore_pct", f(s.loadDist.forePct, 1)));
  lines.push(row("overview", "load_hind_pct", f(s.loadDist.hindPct, 1)));
  lines.push(row("overview", "load_left_pct", f(s.loadDist.leftPct, 1)));
  lines.push(row("overview", "load_right_pct", f(s.loadDist.rightPct, 1)));
  if (s.symmetry) {
    lines.push(row("symmetry", "fore_index_pct", f(s.symmetry.fore.symmetryIndex, 1)));
    lines.push(row("symmetry", "fore_warning", s.symmetry.fore.warning ? "yes" : "no"));
    lines.push(row("symmetry", "hind_index_pct", f(s.symmetry.hind.symmetryIndex, 1)));
    lines.push(row("symmetry", "hind_warning", s.symmetry.hind.warning ? "yes" : "no"));
  }
  // Absolute-unit clinical metrics (now that the true cell pitch is known).
  const c = s.clinical;
  lines.push(row("clinical", "speed_m_s", f(c.speedMs, 2)));
  lines.push(row("clinical", "speed_km_h", f(c.speedKmh, 2)));
  lines.push(row("clinical", "stride_length_cm", f(c.strideLengthCm, 1)));
  lines.push(row("clinical", "step_length_cm", f(c.stepLengthCm, 1)));
  lines.push(row("clinical", "step_width_cm", f(c.stepWidthCm, 1)));
  lines.push(row("clinical", "cadence_steps_min", f(c.cadenceStepsMin, 0)));
  lines.push(row("clinical", "double_support_sec", f(c.doubleSupportSec, 2)));
  lines.push(row("clinical", "double_support_pct", f(c.doubleSupportPct, 1)));
  if (c.cop) {
    lines.push(row("clinical", "cop_path_length_cm", f(c.cop.pathLengthCm, 1)));
    lines.push(row("clinical", "cop_area_cm2", f(c.cop.areaCm2, 1)));
    lines.push(row("clinical", "cop_mean_velocity_cm_s", f(c.cop.meanVelCmS, 1)));
  }
  lines.push(row("clinical", "paw_sequence", c.pawSequence.join(" ")));
  lines.push(
    row("clinical", "sequence_regular", c.sequenceRegular == null ? "" : c.sequenceRegular ? "yes" : "no"),
  );
  for (const fl of c.flags) {
    lines.push(row("flag", `${fl.type} (${fl.severity})`, fl.detail));
  }
  if (s.recommendation) lines.push(row("overview", "recommendation", s.recommendation));
  if (s.reasons.length) lines.push(row("overview", "reasons", s.reasons.join("; ")));
  lines.push(
    row("preprocessing", "hot_pixels", s.preprocessing.hotPixelCount),
  );
  lines.push(
    row("preprocessing", "baseline_invalid", s.preprocessing.baselineInvalid ? "yes" : "no"),
  );

  lines.push("");
  lines.push(
    row(
      "paw",
      "detected",
      "load_pct",
      "peak_pressure",
      "pressure_impulse",
      "contact_area",
      "contact_time_sec",
      "total_pressure_index",
      "paw_path_length",
      "step_count",
    ),
  );
  for (const p of s.paws) {
    lines.push(
      row(
        p.label,
        p.detected ? "yes" : "no",
        f(p.loadPct, 1),
        f(p.peakPressure, 1),
        f(p.pressureImpulse, 1),
        f(p.contactArea, 1),
        f(p.contactTimeSec, 3),
        f(p.totalPressureIndex, 1),
        f(p.pawPathLength, 2),
        p.stepCount,
      ),
    );
  }

  return lines.join("\n") + "\n";
}
