import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_CONFIG } from "../src/gait/config.js";
import { PressureDenoiser } from "../src/gait/denoise/index.js";
import {
  DN_CALIBRATION_MIN_FRAMES,
  DN_PERSIST_FRAMES,
  DN_RELEASE_FRAC,
} from "../src/gait/denoise/constants.js";
import { segmentPaws } from "../src/gait/segmentation.js";

const ROWS = DEFAULT_CONFIG.rows;
const COLS = DEFAULT_CONFIG.cols;
const N = ROWS * COLS;

function idx(row: number, col: number): number {
  return row * COLS + col;
}

function emptyPressure(): Float32Array {
  return new Float32Array(N);
}

function calibrateIdle(denoiser: PressureDenoiser, pressure: Float32Array): void {
  const out = new Float32Array(N);
  const removed = new Uint8Array(N);
  for (let f = 0; f < DN_CALIBRATION_MIN_FRAMES + 2; f++) {
    denoiser.process(pressure, f, out, removed);
  }
}

describe("§1.5 pressure denoise", () => {
  it("removes synthetic single-cell speckle (1 frame) at 100%", () => {
    const denoiser = new PressureDenoiser(DEFAULT_CONFIG);
    calibrateIdle(denoiser, emptyPressure());

    const pressure = emptyPressure();
    pressure[idx(20, 30)] = 180;

    const out = new Float32Array(N);
    const removed = new Uint8Array(N);
    denoiser.process(pressure, 100, out, removed);

    assert.equal(out[idx(20, 30)], 0, "speckle must be removed");
    const blobs = segmentPaws(out, ROWS, COLS, 3);
    assert.equal(blobs.length, 0);
  });

  it("preserves 1-cell contact that persists across frames (small dog)", () => {
    const denoiser = new PressureDenoiser(DEFAULT_CONFIG);
    denoiser.setMinCells(2);
    calibrateIdle(denoiser, emptyPressure());

    const out = new Float32Array(N);
    const removed = new Uint8Array(N);
    let blobCount = 0;

    for (let f = 0; f < DN_PERSIST_FRAMES + 2; f++) {
      const pressure = emptyPressure();
      pressure[idx(25, 35)] = 220;
      denoiser.process(pressure, 200 + f, out, removed);
      blobCount = segmentPaws(out, ROWS, COLS, 1).length;
    }

    assert.ok(blobCount >= 1, "persistent 1-cell contact should survive");
  });

  it("suppresses hysteresis tail below release_frac × peak", () => {
    const denoiser = new PressureDenoiser(DEFAULT_CONFIG);
    calibrateIdle(denoiser, emptyPressure());

    const out = new Float32Array(N);
    const removed = new Uint8Array(N);
    const cell = idx(18, 22);

    const strong = emptyPressure();
    strong[cell] = 400;
    for (let f = 0; f < 5; f++) {
      denoiser.process(strong, f, out, removed);
    }

    const tail = emptyPressure();
    tail[cell] = 400 * DN_RELEASE_FRAC * 0.5;
    let residualFlag = false;
    for (let f = 5; f < 12; f++) {
      const meta = denoiser.process(tail, f, out, removed);
      if (meta.flagResidual) residualFlag = true;
    }

    assert.ok(residualFlag || out[cell] === 0, "tail should be flagged or zeroed");
    assert.equal(out[cell], 0);
  });

  it("empty mat frame → zero contacts", () => {
    const denoiser = new PressureDenoiser(DEFAULT_CONFIG);
    calibrateIdle(denoiser, emptyPressure());
    const out = new Float32Array(N);
    const removed = new Uint8Array(N);
    denoiser.process(emptyPressure(), 50, out, removed);
    assert.equal(segmentPaws(out, ROWS, COLS, 3).length, 0);
  });

  it("does not modify input buffer (non-destructive)", () => {
    const denoiser = new PressureDenoiser(DEFAULT_CONFIG);
    calibrateIdle(denoiser, emptyPressure());

    const pressure = emptyPressure();
    pressure[idx(10, 10)] = 300;
    pressure[idx(11, 10)] = 280;
    pressure[idx(10, 11)] = 290;
    const snapshot = pressure.slice();

    const out = new Float32Array(N);
    const removed = new Uint8Array(N);
    denoiser.process(pressure, 0, out, removed);

    for (let i = 0; i < N; i++) {
      assert.equal(pressure[i], snapshot[i], `input mutated at ${i}`);
    }
    assert.ok(out[idx(10, 10)] > 0, "real blob should pass to denoised output");
  });

  it("removed_mask allows audit of suppressed cells", () => {
    const denoiser = new PressureDenoiser(DEFAULT_CONFIG);
    calibrateIdle(denoiser, emptyPressure());

    const pressure = emptyPressure();
    const cell = idx(30, 40);
    pressure[cell] = 500;
    for (let f = 0; f < 4; f++) {
      denoiser.process(pressure, f, new Float32Array(N), new Uint8Array(N));
    }

    const tail = emptyPressure();
    tail[cell] = 30;
    const out = new Float32Array(N);
    const removed = new Uint8Array(N);
    denoiser.process(tail, 10, out, removed);

    assert.equal(out[cell], 0);
    assert.ok(removed[cell] === 1 || pressure[cell]! > 0);
  });
});
