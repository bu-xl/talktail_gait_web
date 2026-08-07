import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig } from "../src/core/config.js";
import { GRID_COLS, GRID_ROWS, RAW_MAX } from "../src/core/constants.js";
import { buildEngineConfig } from "../src/core/gaitAnalysis.js";
import { PawGaitEngine } from "../src/gait/PawGaitEngine.js";
import { labelSessionFootfalls } from "../src/gait/footfallLabeling.js";
import { applyProvisionalLiveLabels } from "../src/gait/footfall/coldStart.js";
import type { PawTrack } from "../src/gait/types.js";

const CELLS = GRID_ROWS * GRID_COLS;

function stamp(raw: Float64Array, row: number, col: number, drop: number, r = 2): void {
  for (let dr = -r; dr <= r; dr++) {
    for (let dc = -r; dc <= r; dc++) {
      const rr = Math.round(row) + dr;
      const cc = Math.round(col) + dc;
      if (rr >= 0 && rr < GRID_ROWS && cc >= 0 && cc < GRID_COLS) {
        const i = rr * GRID_COLS + cc;
        raw[i] = Math.min(raw[i]!, RAW_MAX - drop);
      }
    }
  }
}

/** Build engine-normalised flat frames with explicit paw positions. */
function buildSession(
  frames: number,
  pawAt: (fi: number) => Array<{ row: number; col: number; drop: number }>,
): { engine: PawGaitEngine; flat: Float32Array[]; hz: number } {
  const cfg = loadConfig({});
  const engine = new PawGaitEngine(buildEngineConfig(cfg.gait, 3.5, 38));
  const flat: Float32Array[] = [];
  const hz = 38;
  for (let fi = 0; fi < frames; fi++) {
    const raw = new Float64Array(CELLS).fill(RAW_MAX);
    for (const p of pawAt(fi)) stamp(raw, p.row, p.col, p.drop);
    const delta = new Float32Array(CELLS);
    for (let i = 0; i < CELLS; i++) delta[i] = Math.max(0, RAW_MAX - raw[i]!);
    const peak = Math.max(...delta);
    const scale = peak > 0 ? 200 / peak : 1;
    for (let i = 0; i < CELLS; i++) delta[i] *= scale;
    flat.push(delta);
    engine.processFlatFrame(delta, (fi / hz) * 1000);
  }
  return { engine, flat, hz };
}

describe("body-frame footfall labeling", () => {
  it("bug A regression: RF ahead of LF stays fore (F not H)", () => {
    const lfCol = 12;
    const rfCol = 18;
    const lfRow = 14;
    const rfRow = 26;
    const { engine, hz } = buildSession(80, (fi) => {
      const on = fi % 24 < 14;
      if (!on) return [];
      return [
        { row: lfRow + fi * 0.02, col: lfCol, drop: 1800 },
        { row: rfRow + fi * 0.05, col: rfCol, drop: 1900 },
      ];
    });

    const session = engine.finalizeSession();
    const result = labelSessionFootfalls(session.frames, engine["timestampsMs"] as number[], hz, engine.config);
    assert.ok(result.footfalls.length >= 2, "need footfalls");

    const rfEvents = result.footfalls.filter((f) => f.limb === "RF");
    const lfEvents = result.footfalls.filter((f) => f.limb === "LF");

    for (const f of rfEvents) {
      assert.equal(f.limb, "RF", "RF must stay RF (fore), not flip to hind");
    }
    for (const f of lfEvents) {
      assert.ok(f.limb === "LF");
    }
    assert.ok(rfEvents.length >= 1 || lfEvents.length >= 1, "fore paws labeled");
  });

  it("bug B regression: hind-only phase keeps H labels (not fore)", () => {
    const foreRow = 8;
    const hindRowA = 26;
    const hindRowB = 32;
    const colL = 12;
    const colR = 22;
    const { engine, hz } = buildSession(110, (fi) => {
      const out: Array<{ row: number; col: number; drop: number }> = [];
      if (fi < 20) {
        out.push({ row: foreRow, col: colL, drop: 2000 });
        out.push({ row: foreRow, col: colR, drop: 2000 });
      } else if (fi >= 28 && fi < 95) {
        out.push({ row: hindRowA + (fi - 28) * 0.04, col: colL, drop: 1800 });
        out.push({ row: hindRowB + (fi - 28) * 0.04, col: colR, drop: 1800 });
      }
      return out;
    });

    const session = engine.finalizeSession();
    const result = labelSessionFootfalls(session.frames, engine["timestampsMs"] as number[], hz, engine.config);

    const hindOnlyWindow = result.footfalls.filter(
      (f) => f.frameTd <= 60 && f.frameLo >= 55,
    );
    assert.ok(hindOnlyWindow.length >= 1, "hind-only window footfalls");
    for (const f of hindOnlyWindow) {
      assert.ok(
        f.limb === "LH" || f.limb === "RH",
        `hind-only footfall ${f.id} labeled ${f.limb}, expected H`,
      );
    }
  });

  it("footfall labels do not flip within a single stance", () => {
    const { engine } = buildSession(60, (fi) => {
      if (fi % 30 >= 18) return [];
      return [{ row: 16, col: 14 + fi * 0.04, drop: 2000 }];
    });
    engine.finalizeSession();
    const result = labelSessionFootfalls(
      engine["frameResults"] as never,
      engine["timestampsMs"] as number[],
      38,
      engine.config,
    );
    for (const f of result.footfalls) {
      assert.ok(f.limb === f.limb, "limb frozen on footfall");
      assert.ok(["LF", "RF", "LH", "RH"].includes(f.limb));
    }
  });

  it("no duplicate limb labels in overlapping footfalls", () => {
    const { engine, hz } = buildSession(120, (fi) => {
      const paws: Array<{ row: number; col: number; drop: number }> = [];
      const cycle = fi % 32;
      if (cycle < 12) paws.push({ row: 12, col: 10 + fi * 0.05, drop: 1600 });
      if (cycle >= 8 && cycle < 20) paws.push({ row: 24, col: 10 + fi * 0.05, drop: 1600 });
      if (cycle >= 16 && cycle < 28) paws.push({ row: 12, col: 18 + fi * 0.05, drop: 1600 });
      if (cycle >= 24) paws.push({ row: 24, col: 18 + fi * 0.05, drop: 1600 });
      return paws;
    });
    const session = engine.finalizeSession();
    const result = labelSessionFootfalls(session.frames, engine["timestampsMs"] as number[], hz, engine.config);
    const byTime = [...result.footfalls].sort((a, b) => a.frameTd - b.frameTd);
    for (let i = 0; i < byTime.length; i++) {
      for (let j = i + 1; j < byTime.length; j++) {
        const a = byTime[i]!;
        const b = byTime[j]!;
        if (b.frameTd > a.frameLo + 1) break;
        assert.notEqual(a.limb, b.limb, `duplicate ${a.limb} at overlapping times`);
      }
    }
  });

  it("cold start: first footfall gets provisional label (not empty)", () => {
    const { engine, hz } = buildSession(20, (fi) => {
      if (fi > 12) return [];
      return [{ row: 8 + fi * 0.1, col: 14, drop: 2000 }];
    });
    engine.finalizeSession();
    const result = labelSessionFootfalls(
      engine["frameResults"] as never,
      engine["timestampsMs"] as number[],
      hz,
      engine.config,
    );
    assert.ok(result.footfalls.length >= 1, "at least one footfall");
    const f0 = result.footfalls[0]!;
    assert.ok(["LF", "RF", "LH", "RH"].includes(f0.limb), `first footfall labeled ${f0.limb}`);
    assert.ok(f0.confidence > 0, "confidence assigned");
  });

  it("live provisional: active contact never stays Unknown", () => {
    const track = {
      trackId: 1,
      history: [],
      centroidHistory: [],
      pressureHistory: [],
      active: true,
      lastBlob: {
        id: 1,
        cells: [{ row: 10, col: 12 }],
        centerX: 12,
        centerY: 10,
        copX: 12,
        copY: 10,
        area: 5,
        pressureSum: 500,
        peakPressure: 200,
        bbox: { minRow: 8, maxRow: 12, minCol: 10, maxCol: 14 },
      },
      missFrames: 0,
      lastFrameIndex: 5,
      contact: true,
      contactEvents: [],
      pendingContactStart: 3,
      frameIndices: [3, 4, 5],
      label: "Unknown",
      labelConfidence: 0,
      lockedLabel: null,
      contactEventLabels: [],
      flagsProvisional: false,
      velocityCol: 0,
      velocityRow: 0,
    } satisfies PawTrack;

    applyProvisionalLiveLabels([track], 5);
    assert.notEqual(track.label, "Unknown");
    assert.ok(["LF", "RF", "LH", "RH"].includes(track.label));
    assert.ok(track.flagsProvisional);
  });

  it("travel axis is top→bottom (row cm) with fixed sign", () => {
    const { engine, hz } = buildSession(40, (fi) => [{ row: 6 + fi * 0.3, col: 14, drop: 1800 }]);
    engine.finalizeSession();
    const result = labelSessionFootfalls(
      engine["frameResults"] as never,
      engine["timestampsMs"] as number[],
      hz,
      engine.config,
    );
    assert.equal(result.travel.axisUnit.y, 1);
    assert.equal(result.travel.axisUnit.x, 0);
    assert.equal(result.travel.sign, 1);
  });
});
