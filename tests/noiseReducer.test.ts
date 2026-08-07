import assert from "node:assert/strict";
import { test } from "node:test";

import { minNeighborGate, spatialMedian } from "../src/core/noiseReducer.js";
import { loadConfig } from "../src/core/config.js";
import { ProcessingPipeline } from "../src/core/pipeline.js";

test("spatial median removes a single-pixel spike", () => {
  // Flat field of 100 with one 4000 spike in the centre of a 3x3.
  const m = new Float64Array(9).fill(100);
  m[4] = 4000;
  const out = spatialMedian(m, 3, 3, 3);
  assert.equal(out[4], 100, "spike replaced by neighbourhood median");
});

test("min-neighbour gate drops an isolated visible cell", () => {
  const N = Number.NaN;
  // 3x3: only the centre is visible -> 0 visible neighbours -> removed.
  const iso = Float64Array.of(N, N, N, N, 50, N, N, N, N);
  const g = minNeighborGate(iso, 3, 3, 2);
  assert.ok(Number.isNaN(g[4]), "isolated cell removed");

  // A 2x2 block: each cell has 3 visible neighbours -> all survive.
  const blob = Float64Array.of(50, 50, N, 50, 50, N, N, N, N);
  const g2 = minNeighborGate(blob, 3, 3, 2);
  assert.equal(g2[0], 50);
  assert.equal(g2[1], 50);
  assert.equal(g2[3], 50);
  assert.equal(g2[4], 50);
});

test("pipeline removes isolated speckle but keeps a real contact blob", () => {
  // Uncalibrated, relative scale. Build a 40x40 raw frame (unloaded ~4095) with:
  //   - a connected 3x3 pressed blob (raw low -> high pressure), and
  //   - one isolated pressed cell far away (a stuck/offset sensor = speckle).
  const cfg = loadConfig({}); // noise defaults: spatial_median on, min_neighbors 2
  const pipe = new ProcessingPipeline(cfg);
  const raw = new Float64Array(40 * 40).fill(4095);
  const at = (r: number, c: number): number => r * 40 + c;
  // Real blob at rows 10-12, cols 10-12 (raw 3500 -> clear contact).
  for (let r = 10; r <= 12; r++) for (let c = 10; c <= 12; c++) raw[at(r, c)] = 3500;
  // Isolated speckle at (30,30).
  raw[at(30, 30)] = 3500;

  const frame = pipe.process(raw);
  // Blob centre stays visible...
  assert.ok(!Number.isNaN(frame.pressure[at(11, 11)]), "blob centre kept");
  // ...isolated speckle is gone.
  assert.ok(Number.isNaN(frame.pressure[at(30, 30)]), "isolated speckle removed");
});

test("pipeline keeps a WEAK 2-cell contact (default sensitivity)", () => {
  const cfg = loadConfig({}); // defaults: spatial_median off, min_neighbors 1
  const pipe = new ProcessingPipeline(cfg);
  const raw = new Float64Array(40 * 40).fill(4095);
  const at = (r: number, c: number): number => r * 40 + c;
  // Two adjacent lightly-pressed cells (each has exactly one visible neighbour).
  raw[at(20, 20)] = 3700;
  raw[at(20, 21)] = 3700;
  const frame = pipe.process(raw);
  assert.ok(!Number.isNaN(frame.pressure[at(20, 20)]), "weak contact cell A kept");
  assert.ok(!Number.isNaN(frame.pressure[at(20, 21)]), "weak contact cell B kept");
});
