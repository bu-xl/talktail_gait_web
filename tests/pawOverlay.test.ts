import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig } from "../src/core/config.js";
import { GRID_COLS, GRID_ROWS, RAW_MAX } from "../src/core/constants.js";
import { buildEngineConfig, framesToEngineInput } from "../src/core/gaitAnalysis.js";
import type { RecordedFrame } from "../src/core/recorder.js";
import type { Matrix } from "../src/core/types.js";
import {
  PawGaitEngine,
  buildPawSummaryOverlay,
  buildSessionOverlayFrames,
  countLabeled,
  fieldStatsInBBox,
} from "../src/gait/index.js";
import { buildAnnotatedPalette } from "../src/export/annotatedExport.js";
import { pawTrackToCsv } from "../src/export/pawTrackCsv.js";
import { buildLut } from "../src/render/colormap.js";

const CELLS = GRID_ROWS * GRID_COLS;
const PAW_LABELS = ["LF", "RF", "LH", "RH"] as const;

/** Inverted-raw paw stamp (lower raw = more pressure). */
function stampPaw(raw: Matrix, row: number, col: number, radius: number, drop: number): void {
  for (let dr = -radius; dr <= radius; dr++) {
    for (let dc = -radius; dc <= radius; dc++) {
      const r = Math.round(row) + dr;
      const c = Math.round(col) + dc;
      if (r >= 0 && r < GRID_ROWS && c >= 0 && c < GRID_COLS) {
        const idx = r * GRID_COLS + c;
        raw[idx] = Math.min(raw[idx], RAW_MAX - drop);
      }
    }
  }
}

/** Synthetic 4-paw walk, left->right (same shape as the gait analysis test). */
function buildWalk(frames = 240): RecordedFrame[] {
  const startCol = 8;
  const fps = 40;
  const paws: Array<[number, number, number]> = [
    [14, startCol + 16, 0],
    [26, startCol + 16, 10],
    [14, startCol, 10],
    [26, startCol, 0],
  ];
  const out: RecordedFrame[] = [];
  for (let fi = 0; fi < frames; fi++) {
    const raw = new Float64Array(CELLS).fill(RAW_MAX);
    for (const [r, baseCol, ph] of paws) {
      if ((fi + ph) % 20 >= 12) continue; // stance 12 / swing 8
      stampPaw(raw, r, baseCol + 0.06 * fi, 1, 1500);
    }
    out.push({ t: (fi / fps) * 1000, raw });
  }
  return out;
}

const UNCAL_BASELINE: Matrix = new Float64Array(CELLS).fill(RAW_MAX);

function runSession(frames: RecordedFrame[]) {
  const cfg = loadConfig({});
  const { flat, timestamps } = framesToEngineInput(frames, UNCAL_BASELINE, cfg);
  const span = timestamps[timestamps.length - 1]! - timestamps[0]!;
  const fps = ((flat.length - 1) / span) * 1000;
  const engine = new PawGaitEngine({
    ...buildEngineConfig(cfg.gait, 3.5, fps),
    maxTrackHistoryFrames: flat.length + 2,
  });
  engine.processFlatSession(flat, timestamps, fps);
  return { cfg, engine, frameCount: flat.length, timestamps };
}

test("overlay: session frames carry stable final paw labels", () => {
  const { engine, frameCount } = runSession(buildWalk(240));
  const frames = buildSessionOverlayFrames(engine.getTracks(), frameCount, { includeUnknown: true });

  assert.equal(frames.length, frameCount, "one overlay frame per recorded frame");

  // Every item's bbox is in-grid and its label is one of the five.
  const allowed = new Set([...PAW_LABELS, "Unknown"]);
  let maxItems = 0;
  const labelsSeen = new Set<string>();
  for (const f of frames) {
    maxItems = Math.max(maxItems, f.items.length);
    for (const it of f.items) {
      assert.ok(allowed.has(it.label), `unexpected label ${it.label}`);
      assert.ok(it.bbox.minRow >= 0 && it.bbox.maxRow < GRID_ROWS, "bbox rows in grid");
      assert.ok(it.bbox.minCol >= 0 && it.bbox.maxCol < GRID_COLS, "bbox cols in grid");
      if (it.label !== "Unknown") labelsSeen.add(it.label);
    }
  }
  // A clean 4-paw walk should produce multiple simultaneous contacts and resolve
  // all four real labels.
  assert.ok(maxItems >= 2, `expected overlapping contacts, got max ${maxItems}`);
  assert.equal(labelsSeen.size, 4, `expected 4 labels, got ${[...labelsSeen].join(",")}`);
});

test("overlay: peak summary has one item per detected paw", () => {
  const { engine } = runSession(buildWalk(240));
  const summary = buildPawSummaryOverlay(engine.getTracks());
  const labels = summary.items.map((i) => i.label);
  assert.equal(new Set(labels).size, labels.length, "labels unique in summary");
  assert.equal(labels.length, 4, `expected 4 summary paws, got ${labels.join(",")}`);
  assert.equal(countLabeled(summary), 4);
});

test("overlay: paw-track CSV has a header + one row per item", () => {
  const { engine, frameCount, cfg } = runSession(buildWalk(120));
  const frames = buildSessionOverlayFrames(engine.getTracks(), frameCount, {
    includeUnknown: cfg.paw_overlay.show_unknown,
  });
  // Synthesise display fields (positive pressure where a paw pressed).
  const displayFields: Matrix[] = [];
  const ts: number[] = [];
  for (let i = 0; i < frameCount; i++) {
    displayFields.push(new Float64Array(CELLS));
    ts.push(i / 40);
  }
  for (const f of frames) {
    for (const it of f.items) {
      displayFields[f.frameIndex]![it.bbox.minRow * GRID_COLS + it.bbox.minCol] = 42;
    }
  }
  const csv = pawTrackToCsv(frames, displayFields, ts, GRID_COLS);
  const lines = csv.trim().split("\n");
  const totalItems = frames.reduce((s, f) => s + f.items.length, 0);
  assert.equal(lines.length, totalItems + 1, "header + one row per item");
  assert.ok(lines[0]!.startsWith("frame,time_s,track_id,paw,"), "csv header present");
  assert.ok(/(,LF,|,RF,|,LH,|,RH,)/.test(csv), "csv contains real paw labels");
});

test("overlay: fieldStatsInBBox returns peak + summed force, ignoring NaN/0", () => {
  const cols = 4;
  const field = new Float64Array([
    0, 0, 0, 0,
    0, 10, 20, 0,
    0, NaN, 5, 0,
    0, 0, 0, 0,
  ]);
  const stats = fieldStatsInBBox(field, cols, { minRow: 1, maxRow: 2, minCol: 1, maxCol: 2 });
  assert.equal(stats.peak, 20);
  assert.equal(stats.force, 35); // 10 + 20 + 5 (NaN ignored)
  assert.equal(stats.cells, 3);
});

test("overlay: annotated GIF palette includes paw + chrome colours, <=256", () => {
  const lut = buildLut(10, [10, 80]);
  const bg: [number, number, number] = [5, 7, 10];
  const palette = buildAnnotatedPalette(lut, bg);
  assert.ok(palette.length > 16 && palette.length <= 256, `palette size ${palette.length}`);
  const has = (c: number[]): boolean => palette.some((p) => p[0] === c[0] && p[1] === c[1] && p[2] === c[2]);
  assert.ok(has([5, 7, 10]), "background present");
  assert.ok(has([255, 255, 255]), "white present");
  assert.ok(has([0, 0, 0]), "black present");
  assert.ok(has([60, 130, 246]), "LF blue present");
  assert.ok(has([235, 70, 60]), "RF red present");
  assert.ok(has([40, 200, 220]), "LH cyan present");
  assert.ok(has([255, 150, 40]), "RH orange present");
  // No duplicate entries (stable palette).
  const keys = new Set(palette.map((p) => p.join(",")));
  assert.equal(keys.size, palette.length, "palette entries unique");
});
