import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig } from "../src/core/config.js";
import {
  buildBaseline,
  deltaToMmHg,
  PressureCalibrator,
  rawToDelta,
} from "../src/core/pressureCalibrator.js";

test("buildBaseline is the per-cell median", () => {
  const frames = [Float64Array.of(4095, 100), Float64Array.of(4090, 200), Float64Array.of(4080, 300)];
  const base = buildBaseline(frames, 2);
  assert.equal(base[0], 4090);
  assert.equal(base[1], 200);
});

test("rawToDelta = max(0, baseline - raw); lower raw => higher pressure", () => {
  const raw = Float64Array.of(4000, 4100);
  const base = Float64Array.of(4095, 4095);
  const d = rawToDelta(raw, base);
  assert.equal(d[0], 95); // loaded
  assert.equal(d[1], 0); // above baseline -> clamped
});

test("linear_scale formula (test mode)", () => {
  const cfg = loadConfig({ formula: "linear_scale", scale: 0.1 });
  assert.equal(deltaToMmHg(500, cfg), 50);
});

test("piecewise_linear uses the matching range coefficients", () => {
  const cfg = loadConfig({
    formula: "piecewise_linear",
    x_ranges: [
      [0, 300],
      [300, 800],
    ],
    coefficients: [
      [0.1, 0],
      [0.05, 15],
    ],
  });
  assert.equal(deltaToMmHg(200, cfg), 20); // 0.1*200
  assert.equal(deltaToMmHg(400, cfg), 35); // 0.05*400 + 15
});

test("threshold sets sub-visible cells to NaN; relative => unit 'rel'", () => {
  // deadband 0 to isolate the formula+threshold from the noise dead-band stage.
  const cfg = loadConfig({ formula: "relative", scale: 0.1, noise: { deadband_raw: 0 } }); // delta*0.1
  const cal = new PressureCalibrator(cfg); // fallback baseline 4095
  // raw 4095 -> delta 0 -> 0 (NaN); raw 3895 -> delta 200 -> 20 (visible)
  const raw = Float64Array.of(4095, 3895);
  const frame = cal.toPressureFrame(raw);
  assert.ok(Number.isNaN(frame.pressure[0]));
  assert.equal(frame.pressure[1], 20);
  assert.equal(frame.unit, "rel");
  assert.equal(frame.state, "uncalibrated");
});

test("calibrated state requires piecewise_linear AND a real baseline", () => {
  const cfg = loadConfig({ formula: "piecewise_linear", coefficients: [[0.1, 0]], x_ranges: [[0, 5000]] });
  const cal = new PressureCalibrator(cfg);
  let frame = cal.toPressureFrame(Float64Array.of(4095));
  assert.equal(frame.state, "uncalibrated"); // no baseline yet
  cal.collectBaselineFrame(Float64Array.of(4095), 1); // builds baseline
  frame = cal.toPressureFrame(Float64Array.of(3000));
  assert.equal(frame.state, "calibrated");
  assert.equal(frame.unit, "mmHg");
});
