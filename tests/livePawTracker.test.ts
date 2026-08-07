import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig } from "../src/core/config.js";
import { GRID_COLS, GRID_ROWS, RAW_MAX } from "../src/core/constants.js";
import { LivePawTracker } from "../src/core/livePawTracker.js";
import type { Matrix } from "../src/core/types.js";

const CELLS = GRID_ROWS * GRID_COLS;

function baselineFull(value = RAW_MAX): Matrix {
  return new Float64Array(CELLS).fill(value);
}

function rawEmpty(): Matrix {
  return new Float64Array(CELLS).fill(RAW_MAX);
}

function stampLoad(raw: Matrix, row: number, col: number, drop: number, radius = 2): void {
  for (let dr = -radius; dr <= radius; dr++) {
    for (let dc = -radius; dc <= radius; dc++) {
      const r = row + dr;
      const c = col + dc;
      if (r >= 0 && r < GRID_ROWS && c >= 0 && c < GRID_COLS) {
        raw[r * GRID_COLS + c] = Math.min(raw[r * GRID_COLS + c]!, RAW_MAX - drop);
      }
    }
  }
}

describe("LivePawTracker", () => {
  it("returns null on an empty mat (no overlay boxes)", () => {
    const cfg = loadConfig({});
    const tracker = new LivePawTracker(cfg, 3.5, 38);
    const base = baselineFull();
    const out = tracker.process(rawEmpty(), base, 0);
    assert.equal(out, null);
  });

  it("does not show paw boxes after a walk when only jitter remains", () => {
    const cfg = loadConfig({});
    const tracker = new LivePawTracker(cfg, 3.5, 38);
    const base = baselineFull();
    let t = 0;

    // Simulate a short loaded contact (dog on mat).
    for (let i = 0; i < 30; i++) {
      const raw = rawEmpty();
      stampLoad(raw, 20, 20, 900, 3);
      stampLoad(raw, 28, 20, 900, 3);
      tracker.process(raw, base, (t += 26));
    }

    // Dog left — faint speckle only (below load gates).
    let noiseOverlay = null;
    for (let i = 0; i < 80; i++) {
      const raw = rawEmpty();
      stampLoad(raw, 12 + (i % 3), 10 + (i % 4), 35, 0);
      noiseOverlay = tracker.process(raw, base, (t += 26));
    }

    assert.equal(noiseOverlay, null);
    assert.equal(tracker.getStatus().active, false);
  });

  it("resets tracking state after unload", () => {
    const cfg = loadConfig({});
    const tracker = new LivePawTracker(cfg, 3.5, 38);
    const base = baselineFull();
    let t = 0;

    for (let i = 0; i < 40; i++) {
      const raw = rawEmpty();
      stampLoad(raw, 18, 18, 1100, 4);
      stampLoad(raw, 26, 18, 1100, 4);
      stampLoad(raw, 18, 26, 1100, 4);
      stampLoad(raw, 26, 26, 1100, 4);
      tracker.process(raw, base, (t += 26));
    }

    for (let i = 0; i < 60; i++) {
      tracker.process(rawEmpty(), base, (t += 26));
    }

    assert.equal(tracker.getStatus().tracking, false);
    assert.equal(tracker.getStatus().active, false);
  });
});
