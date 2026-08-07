import assert from "node:assert/strict";
import { test } from "node:test";

import { SessionRecorder } from "../src/core/recorder.js";
import { framesToCanineGaitCsv, pressureColumnHeaders } from "../src/core/csvExport.js";
import { maxProjection, meanProjection } from "../src/core/projection.js";
import { colorizeFrames } from "../src/export/heatmapFrames.js";
import { encodeHeatmapGif } from "../src/export/gifExport.js";
import { buildLut } from "../src/render/colormap.js";
import { loadConfig } from "../src/core/config.js";

test("recorder captures frames only while recording, with copies", () => {
  const rec = new SessionRecorder();
  const raw = Float64Array.of(1, 2, 3, 4);
  rec.add(raw, 0); // ignored: not recording
  assert.equal(rec.frameCount, 0);

  rec.start(1000);
  rec.add(raw, 1000);
  raw[0] = 999; // mutate after add -> stored copy must be unaffected
  rec.add(raw, 1025);
  rec.stop();

  assert.equal(rec.frameCount, 2);
  assert.equal(rec.getFrames()[0].raw[0], 1, "stored frame is a copy");
  assert.equal(rec.getFrames()[0].t, 0, "t is relative to start");
  assert.equal(rec.getFrames()[1].t, 25);
  assert.ok(Math.abs(rec.durationSec - 0.025) < 1e-9);
});

test("CSV header + rows match canine_gait p_R_C convention", () => {
  const headers = pressureColumnHeaders(2, 3);
  assert.deepEqual(headers, ["p_0_0", "p_0_1", "p_0_2", "p_1_0", "p_1_1", "p_1_2"]);

  const rec = new SessionRecorder();
  rec.start(0);
  rec.add(Float64Array.of(4095, 4000, 10, 20, 30, 40), 0);
  rec.add(Float64Array.of(4095, 3999, 11, 21, 31, 41), 100);
  rec.stop();

  const csv = framesToCanineGaitCsv(rec.getFrames(), 2, 3);
  const lines = csv.trim().split("\n");
  assert.equal(lines[0], "frame_id,time,p_0_0,p_0_1,p_0_2,p_1_0,p_1_1,p_1_2");
  assert.equal(lines[1], "0,0.000,4095,4000,10,20,30,40");
  assert.equal(lines[2], "1,0.100,4095,3999,11,21,31,41");
});

test("projections are NaN-aware (peak and in-contact mean)", () => {
  const N = Number.NaN;
  const frames = [Float64Array.of(N, 10, 50), Float64Array.of(20, N, 30), Float64Array.of(N, 40, 10)];
  const peak = maxProjection(frames);
  assert.equal(peak[0], 20);
  assert.equal(peak[1], 40);
  assert.equal(peak[2], 50);

  const mean = meanProjection(frames);
  assert.equal(mean[0], 20); // only one visible sample
  assert.equal(mean[1], (10 + 40) / 2);
  assert.equal(mean[2], (50 + 30 + 10) / 3);
});

test("GIF export produces a valid animated GIF89a", () => {
  const cfg = loadConfig({});
  const rows = 8;
  const cols = 8;
  // Two pressure frames with a moving hot spot.
  const f1 = new Float64Array(rows * cols).fill(Number.NaN);
  const f2 = new Float64Array(rows * cols).fill(Number.NaN);
  f1[rows * 2 + 2] = 60;
  f2[rows * 5 + 5] = 60;
  const frames = colorizeFrames([f1, f2], rows, cols, 32, 64, cfg);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].length, 32 * 64 * 4);

  const bytes = encodeHeatmapGif({
    frames,
    width: 32,
    height: 64,
    delayMs: 40,
    lut: buildLut(cfg.pressure_thresholds.visible_min_mmhg, cfg.colorbar_range),
  });
  // GIF89a magic header + GIF trailer 0x3B.
  const header = String.fromCharCode(...bytes.slice(0, 6));
  assert.equal(header, "GIF89a");
  assert.equal(bytes[bytes.length - 1], 0x3b);
  assert.ok(bytes.length > 100, `gif too small: ${bytes.length} bytes`);
});
