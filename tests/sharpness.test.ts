import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSmoothField,
  nearestUpsample,
  SmoothFieldScratch,
} from "../src/render/interpolation.js";

test("nearest upsample renders crisp per-cell blocks (no interpolation)", () => {
  // 2x2 with distinct values -> each maps to a solid quadrant, no blended edges.
  const src = Float64Array.of(10, 20, 30, 40);
  const out = nearestUpsample(src, 2, 2, 4, 4);
  // Top-left quadrant all 10, top-right all 20, etc. Only the 4 source values
  // ever appear (no averaged in-between values).
  const unique = new Set(out);
  assert.deepEqual([...unique].sort((a, b) => a - b), [10, 20, 30, 40]);
  assert.equal(out[0], 10); // top-left
  assert.equal(out[3], 20); // top-right
  assert.equal(out[12], 30); // bottom-left
  assert.equal(out[15], 40); // bottom-right
});

test("sharp mode (sigma 0, nearest) keeps a single hot cell from bleeding", () => {
  const rows = 4;
  const cols = 4;
  const p = new Float64Array(rows * cols).fill(Number.NaN);
  p[0] = 50; // one hot cell, top-left
  const scratch = new SmoothFieldScratch(rows, cols, 40, 40);
  const field = buildSmoothField(p, rows, cols, 40, 40, {
    sigmaMin: 0,
    sigmaMax: 0,
    normLo: 10,
    normHi: 80,
    nearest: true,
    scratch,
  });

  // The hot cell's own block is fully covered...
  assert.ok(field.coverage[0] > 0.99, `near coverage ${field.coverage[0]}`);
  // ...and the neighbouring block (2nd cell column) is completely uncovered:
  // with no blur and nearest upsampling there is zero spatial spread.
  const neighbourPx = Math.floor((1 * 40) / cols); // x of the 2nd source cell
  assert.equal(field.coverage[neighbourPx], 0, "no bleed into the next cell");
  assert.equal(field.coverage[field.coverage.length - 1], 0, "far corner stays 0");
});

test("adaptive blur: higher pressure spreads wider than lower pressure", () => {
  // 1x9 grid, a single hot cell at the centre; measure coverage 2 cells away.
  const rows = 1;
  const cols = 9;
  const center = 4;
  const offset = 2;
  const opts = { sigmaMin: 0.4, sigmaMax: 1.6, normLo: 10, normHi: 80 };

  const low = new Float64Array(rows * cols).fill(Number.NaN);
  low[center] = 15; // light touch
  const high = new Float64Array(rows * cols).fill(Number.NaN);
  high[center] = 70; // hard press

  // dst == grid so we read grid-level coverage directly (no upsample blending).
  const fLow = buildSmoothField(low, rows, cols, cols, rows, opts);
  const fHigh = buildSmoothField(high, rows, cols, cols, rows, opts);

  const covLow = fLow.coverage[center + offset];
  const covHigh = fHigh.coverage[center + offset];
  assert.ok(
    covHigh > covLow * 3,
    `high press should bleed much more: high=${covHigh} low=${covLow}`,
  );
});

test("sigma 0 disables the gaussian blur (bilinear gradients only)", () => {
  // A flat field must pass through unchanged (no blur attenuation at edges).
  const rows = 4;
  const cols = 4;
  const p = new Float64Array(rows * cols).fill(30);
  const field = buildSmoothField(p, rows, cols, 8, 8, {
    sigmaMin: 0,
    sigmaMax: 0,
    normLo: 10,
    normHi: 80,
  });
  for (let i = 0; i < field.value.length; i++) {
    assert.ok(Math.abs(field.value[i] - 30) < 1e-9, `value ${field.value[i]}`);
    assert.ok(field.coverage[i] > 0.99);
  }
});
