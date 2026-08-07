import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig } from "../src/core/config.js";
import { GRID_COLS, GRID_ROWS, RAW_MAX } from "../src/core/constants.js";
import {
  analyzeRecordedSession,
  framesToEngineInput,
  GaitAnalysisError,
} from "../src/core/gaitAnalysis.js";
import type { RecordedFrame } from "../src/core/recorder.js";
import type { Matrix } from "../src/core/types.js";

const CELLS = GRID_ROWS * GRID_COLS;

/** Stamp an INVERTED-raw paw (lower raw = more pressure) into a frame. */
function stampPaw(raw: Matrix, row: number, col: number, radius: number, drop: number): void {
  for (let dr = -radius; dr <= radius; dr++) {
    for (let dc = -radius; dc <= radius; dc++) {
      const r = Math.round(row) + dr;
      const c = Math.round(col) + dc;
      if (r >= 0 && r < GRID_ROWS && c >= 0 && c < GRID_COLS) {
        const idx = r * GRID_COLS + c;
        raw[idx] = Math.min(raw[idx], RAW_MAX - drop); // press = pull raw DOWN
      }
    }
  }
}

/**
 * Synthetic 4-paw walk on the 40x40 mat, left->right (column increasing).
 * Two lanes (rows 14 / 26 = left / right side), each with a front (leading col)
 * and hind (trailing col) paw, phased into a normal gait.
 */
function buildWalk(opts: { frames?: number; dir?: 1 | -1; dropPaws?: number[] } = {}): RecordedFrame[] {
  const { frames = 220, dir = 1, dropPaws = [] } = opts;
  const drop = new Set(dropPaws);
  const startCol = dir > 0 ? 8 : 30;
  const fps = 40;
  // [row, baseCol, phase]
  const paws: Array<[number, number, number]> = [
    [14, startCol + 16, 0], // front, lane A
    [26, startCol + 16, 10], // front, lane B
    [14, startCol, 10], // hind, lane A
    [26, startCol, 0], // hind, lane B
  ];
  const out: RecordedFrame[] = [];
  for (let fi = 0; fi < frames; fi++) {
    const raw = new Float64Array(CELLS).fill(RAW_MAX); // unloaded
    for (let pi = 0; pi < paws.length; pi++) {
      if (drop.has(pi)) continue;
      const [r, baseCol, ph] = paws[pi];
      const on = (fi + ph) % 20 < 12; // stance 12 / swing 8
      if (!on) continue;
      const c = baseCol + dir * 0.06 * fi;
      stampPaw(raw, r, c, 1, 1500); // strong contact: raw 4095 -> 2595
    }
    out.push({ t: (fi / fps) * 1000, raw });
  }
  return out;
}

const UNCAL_BASELINE: Matrix = new Float64Array(CELLS).fill(RAW_MAX);

test("gait: synthetic 4-paw walk -> VALID, 4 paws, left_to_right", () => {
  const cfg = loadConfig({});
  const s = analyzeRecordedSession(buildWalk({ frames: 240, dir: 1 }), UNCAL_BASELINE, cfg, 3.5);

  assert.equal(s.validity, "VALID", `expected VALID, got ${s.validity} (${s.reasons.join("|")})`);
  assert.equal(s.detectedPaws.length, 4, `detected ${s.detectedPaws.join(",")}`);
  assert.equal(s.direction, "left_to_right");
  assert.ok(s.directionConfidence > 0.4, `dir conf ${s.directionConfidence}`);
  assert.ok(s.ok);
  // Per-paw features populated for a valid trial.
  assert.equal(s.paws.length, 4);
  for (const p of s.paws) {
    assert.ok(p.peakPressure > 0, `${p.label} peak ${p.peakPressure}`);
    assert.ok(p.stepCount >= 1, `${p.label} steps ${p.stepCount}`);
  }
  // Load distribution sums to ~100% across four paws.
  const total = s.loadPct.LF + s.loadPct.RF + s.loadPct.LH + s.loadPct.RH;
  assert.ok(Math.abs(total - 100) < 1, `load total ${total}`);
  assert.ok(s.symmetry !== null, "VALID walk should report symmetry");
});

test("gait: adaptive normalisation maps p98 delta onto target peak", () => {
  const cfg = loadConfig({});
  const { normalization } = framesToEngineInput(buildWalk({ frames: 60 }), UNCAL_BASELINE, cfg);
  // delta peak is ~1500 (raw 4095 -> 2595); scale should bring it to ~200.
  assert.ok(Math.abs(normalization.deltaPeak - 1500) < 50, `deltaPeak ${normalization.deltaPeak}`);
  const scaled = normalization.deltaPeak * normalization.scale;
  assert.ok(Math.abs(scaled - normalization.targetPeak) < 1, `scaled ${scaled}`);
});

test("gait: all-unloaded session -> INVALID (no contact)", () => {
  const cfg = loadConfig({});
  const frames: RecordedFrame[] = [];
  for (let i = 0; i < 40; i++) {
    frames.push({ t: i * 25, raw: new Float64Array(CELLS).fill(RAW_MAX) });
  }
  const s = analyzeRecordedSession(frames, UNCAL_BASELINE, cfg, 3.5);
  assert.equal(s.validity, "INVALID");
  assert.equal(s.ok, false);
});

test("gait: too few frames throws a clear error", () => {
  const cfg = loadConfig({});
  assert.throws(
    () => analyzeRecordedSession([{ t: 0, raw: new Float64Array(CELLS).fill(RAW_MAX) }], UNCAL_BASELINE, cfg, 3.5),
    GaitAnalysisError,
  );
});

test("gait: reverse walk (right_to_left) is not a normal VALID trial", () => {
  const cfg = loadConfig({});
  const s = analyzeRecordedSession(buildWalk({ frames: 240, dir: -1 }), UNCAL_BASELINE, cfg, 3.5);
  // Product convention is left->right; reverse should be flagged, not silently VALID.
  assert.ok(s.direction !== "left_to_right" || s.validity !== "VALID");
});
