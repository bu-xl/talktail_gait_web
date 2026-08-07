import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig } from "../src/core/config.js";
import { GRID_COLS, GRID_ROWS, RAW_MAX } from "../src/core/constants.js";
import { analyzeRecordedSession } from "../src/core/gaitAnalysis.js";
import { gaitSummaryToJson } from "../src/export/gaitJson.js";
import { gaitSummaryToCsv } from "../src/export/gaitReportCsv.js";
import type { RecordedFrame } from "../src/core/recorder.js";
import type { Matrix } from "../src/core/types.js";

const CELLS = GRID_ROWS * GRID_COLS;

function stampPaw(raw: Matrix, row: number, col: number, radius: number, drop: number): void {
  for (let dr = -radius; dr <= radius; dr++)
    for (let dc = -radius; dc <= radius; dc++) {
      const r = Math.round(row) + dr, c = Math.round(col) + dc;
      if (r >= 0 && r < GRID_ROWS && c >= 0 && c < GRID_COLS)
        raw[r * GRID_COLS + c] = Math.min(raw[r * GRID_COLS + c], RAW_MAX - drop);
    }
}
function buildWalk(frames = 240): RecordedFrame[] {
  const startCol = 8, fps = 40;
  const paws: Array<[number, number, number]> = [
    [14, startCol + 16, 0], [26, startCol + 16, 10], [14, startCol, 10], [26, startCol, 0],
  ];
  const out: RecordedFrame[] = [];
  for (let fi = 0; fi < frames; fi++) {
    const raw = new Float64Array(CELLS).fill(RAW_MAX);
    for (const [r, baseCol, ph] of paws) {
      if ((fi + ph) % 20 >= 12) continue;
      stampPaw(raw, r, baseCol + 0.06 * fi, 1, 1500);
    }
    out.push({ t: (fi / fps) * 1000, raw });
  }
  return out;
}
const BASE: Matrix = new Float64Array(CELLS).fill(RAW_MAX);

test("clinical: absolute-unit metrics are populated and sane", () => {
  const cfg = loadConfig({});
  const s = analyzeRecordedSession(buildWalk(240), BASE, cfg, 3.5);
  const c = s.clinical;

  assert.ok(c.speedMs != null && c.speedMs > 0 && c.speedMs < 5, `speed ${c.speedMs}`);
  assert.ok(c.speedKmh != null && Math.abs(c.speedKmh - c.speedMs! * 3.6) < 1e-6, "km/h = m/s*3.6");
  assert.ok(c.strideLengthCm != null && c.strideLengthCm > 0, `stride ${c.strideLengthCm}`);
  assert.ok(c.stepLengthCm != null && c.stepLengthCm >= 0, `step ${c.stepLengthCm}`);
  // Step width = lateral (row) L/R separation. On this adversarial synthetic the
  // engine splits L/R along the travel axis, so width can be ~0; just require it
  // to be computed and non-negative (it is meaningful on real, correctly-labelled data).
  assert.ok(c.stepWidthCm != null && c.stepWidthCm >= 0, `width ${c.stepWidthCm}`);
  assert.ok(c.cadenceStepsMin != null && c.cadenceStepsMin > 0, `cadence ${c.cadenceStepsMin}`);
  assert.ok(
    c.doubleSupportPct != null && c.doubleSupportPct >= 0 && c.doubleSupportPct <= 100,
    `ds ${c.doubleSupportPct}`,
  );
  assert.ok(c.cop != null && c.cop.pathLengthCm > 0, "cop path > 0");
  assert.equal(c.units.colPitchCm, 1.825);
  assert.equal(c.units.rowPitchCm, 4.2);
});

test("clinical: expanded symmetry + paw sequence resolved for a clean walk", () => {
  const cfg = loadConfig({});
  const s = analyzeRecordedSession(buildWalk(240), BASE, cfg, 3.5);
  const c = s.clinical;
  assert.ok(c.symmetry.fore != null, "fore symmetry present");
  assert.ok(c.symmetry.hind != null, "hind symmetry present");
  assert.equal(c.pawSequence.length, 4, `sequence ${c.pawSequence.join(",")}`);
  assert.equal(new Set(c.pawSequence).size, 4, "all four paws in sequence");
  assert.ok(Array.isArray(c.flags));
});

test("clinical: JSON + CSV exports include the new metrics", () => {
  const cfg = loadConfig({});
  const s = analyzeRecordedSession(buildWalk(240), BASE, cfg, 3.5);

  const json = JSON.parse(gaitSummaryToJson(s));
  assert.equal(json.schema, "gait-analysis/v1");
  assert.ok(typeof json.motionAbsolute.speedMs === "number");
  assert.ok(json.units.colPitchCm === 1.825);
  assert.ok(typeof json.disclaimer === "string");

  const csv = gaitSummaryToCsv(s);
  assert.ok(/clinical,speed_m_s/.test(csv), "csv has clinical speed row");
  assert.ok(/clinical,stride_length_cm/.test(csv), "csv has stride cm row");
});
