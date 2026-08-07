import assert from "node:assert/strict";
import { test } from "node:test";

import { CELL_AREA_CM2, SENSOR_COUNT } from "../src/core/constants.js";
import { loadConfig } from "../src/core/config.js";
import { computeStats } from "../src/core/stats.js";
import { parsePlayback, serializePlayback } from "../src/core/playbackParser.js";
import { buildSmoothField } from "../src/render/interpolation.js";

test("stats: active count, max, avg, area buckets", () => {
  const cfg = loadConfig({}); // visible 10, medium 30, high 50
  // Four cells: NaN (excluded), 15 (active/low), 40 (medium), 60 (high).
  const p = Float64Array.of(Number.NaN, 15, 40, 60);
  const s = computeStats(p, cfg);
  assert.equal(s.activeCellCount, 3);
  assert.equal(s.maxPressure, 60);
  assert.equal(s.avgPressure, (15 + 40 + 60) / 3);
  assert.ok(Math.abs(s.contactAreaCm2 - 3 * CELL_AREA_CM2) < 1e-9);
  assert.ok(Math.abs(s.mediumAreaCm2 - 1 * CELL_AREA_CM2) < 1e-9); // only the 40
  assert.ok(Math.abs(s.highAreaCm2 - 1 * CELL_AREA_CM2) < 1e-9); // only the 60
});

test("playback round-trip preserves matrices", () => {
  const raw = new Float64Array(SENSOR_COUNT);
  for (let i = 0; i < SENSOR_COUNT; i++) raw[i] = (i * 7) % 4096;
  const text = serializePlayback([{ timestamp: "t0", raw }]);
  const frames = parsePlayback(text);
  assert.equal(frames.length, 1);
  assert.equal(frames[0].raw.length, SENSOR_COUNT);
  for (let i = 0; i < SENSOR_COUNT; i++) assert.equal(frames[0].raw[i], raw[i]);
});

test("smooth field keeps far-from-data region transparent (coverage 0)", () => {
  // 4x4 pressure with a single hot cell; corners should stay uncovered.
  const rows = 4;
  const cols = 4;
  const p = new Float64Array(rows * cols).fill(Number.NaN);
  p[0] = 50; // top-left only
  const field = buildSmoothField(p, rows, cols, 40, 40, {
    sigmaMin: 0.6,
    sigmaMax: 0.6,
    normLo: 10,
    normHi: 80,
  });
  // Opposite corner pixel must have ~zero coverage (transparent).
  const far = field.coverage[field.coverage.length - 1];
  assert.ok(far < 0.05, `far coverage ${far}`);
});
