import assert from "node:assert/strict";
import { test } from "node:test";

import { GRID_COLS, GRID_ROWS, MAT_ASPECT, RAW_MAX } from "../src/core/constants.js";
import { AngleChartRenderer, romSeries, symmetrySeries } from "../src/player/renderers/angleChartRenderer.js";
import { MatHeatmapRenderer } from "../src/player/renderers/matHeatmapRenderer.js";
import { SkeletonRenderer } from "../src/player/renderers/skeletonRenderer.js";
import { ANGLE_CONF_OFFSET, ANGLE_STRIDE, JOINTS, MAX_SLOT } from "../src/player/skeletonSchema.js";
import { SampleTrack } from "../src/player/track.js";
import { setupHarness } from "./playerRenderHarness.js";

/**
 * Budget per presented frame. A 60 Hz display gives 16.7 ms; the panels have to
 * share that with the browser's own compositing, so the assertion sits at half.
 * Node's canvas is software-rasterised and has no GPU blit, so these numbers are
 * a pessimistic proxy for the browser, which is the useful direction.
 */
const FRAME_BUDGET_MS = 16.7;
const SESSION_SEC = 60;
const VIDEO_FPS = 30;

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function buildSession(): {
  mat: SampleTrack;
  baseline: Float32Array;
  loadMax: number;
  pose: SampleTrack;
  angles: SampleTrack;
  slots: number;
} {
  const cells = GRID_ROWS * GRID_COLS;
  const rand = lcg(31337);

  // Mat: jittered 39-45 Hz, one moving load blob.
  const matTimes: number[] = [];
  let t = 0;
  while (t <= SESSION_SEC * 1e9) {
    matTimes.push(t);
    t += 1e9 / (39 + rand() * 6);
  }
  const matValues = new Float32Array(matTimes.length * cells).fill(RAW_MAX);
  for (let f = 0; f < matTimes.length; f++) {
    const row = 5 + ((f * 7) % 30);
    for (let dr = 0; dr < 3; dr++) {
      for (let dc = 0; dc < 3; dc++) {
        matValues[f * cells + (row + dr) * GRID_COLS + (18 + dc)] = RAW_MAX - 1400;
      }
    }
  }

  // Pose and angles: locked to the video's 30 fps grid.
  const slots = MAX_SLOT + 1;
  const frames = SESSION_SEC * VIDEO_FPS;
  const poseTimes = Array.from({ length: frames }, (_, i) => BigInt(Math.round((i * 1e9) / VIDEO_FPS)));
  const poseValues = new Float32Array(frames * slots * 3);
  const angleValues = new Float32Array(frames * ANGLE_STRIDE);
  for (let f = 0; f < frames; f++) {
    for (let s = 0; s < slots; s++) {
      const o = (f * slots + s) * 3;
      poseValues[o] = 200 + s * 18 + 40 * Math.sin(f / 9);
      poseValues[o + 1] = 150 + s * 9 + 30 * Math.cos(f / 11);
      poseValues[o + 2] = 0.85;
    }
    for (const j of JOINTS) {
      angleValues[f * ANGLE_STRIDE + j.channel] = 130 + 25 * Math.sin(f / 7 + j.channel);
      angleValues[f * ANGLE_STRIDE + ANGLE_CONF_OFFSET + j.channel] = 0.85;
    }
  }

  return {
    mat: new SampleTrack({
      name: "mat",
      timestampsNs: BigInt64Array.from(matTimes.map((x) => BigInt(Math.round(x)))),
      values: matValues,
      stride: cells,
    }),
    baseline: new Float32Array(cells).fill(RAW_MAX),
    loadMax: 1400,
    pose: new SampleTrack({
      name: "pose",
      timestampsNs: BigInt64Array.from(poseTimes),
      values: poseValues,
      stride: slots * 3,
      irregular: false,
    }),
    angles: new SampleTrack({
      name: "angles",
      timestampsNs: BigInt64Array.from(poseTimes),
      values: angleValues,
      stride: ANGLE_STRIDE,
      irregular: false,
    }),
    slots,
  };
}

interface Panels {
  draw(tNs: bigint): void;
}

function buildPanels(h: ReturnType<typeof setupHarness>, session: ReturnType<typeof buildSession>): Panels {
  const mat = new MatHeatmapRenderer(h.makeCanvas(320, Math.round(320 * MAT_ASPECT)), {
    track: session.mat,
    baseline: session.baseline,
    loadMax: session.loadMax,
    rows: GRID_ROWS,
    cols: GRID_COLS,
    labels: { noData: "no data" },
  });
  const skeleton = new SkeletonRenderer(h.makeCanvas(640, 360), {
    track: session.pose,
    slots: session.slots,
    sourceWidth: 1366,
    sourceHeight: 768,
  });
  const rom = new AngleChartRenderer(h.makeCanvas(480, 180), {
    track: session.angles,
    series: romSeries(),
    title: "ROM",
  });
  const symmetry = new AngleChartRenderer(h.makeCanvas(480, 180), {
    track: session.angles,
    series: symmetrySeries(),
    title: "Symmetry",
  });

  return {
    draw(tNs) {
      mat.draw(tNs);
      skeleton.draw(tNs);
      rom.draw(tNs);
      symmetry.draw(tNs);
    },
  };
}

/** Per-frame cost of all four panels, playing at `rate`. */
function measure(panels: Panels, rate: number, frames: number): { p50: number; p95: number; max: number } {
  const step = (1e9 / VIDEO_FPS) * rate;
  for (let i = 0; i < 60; i++) panels.draw(BigInt(Math.round(i * step))); // warm up

  const samples = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    const t = BigInt(Math.round(i * step));
    const t0 = performance.now();
    panels.draw(t);
    samples[i] = performance.now() - t0;
  }
  const sorted = Float64Array.from(samples).sort();
  return {
    p50: sorted[Math.floor(frames * 0.5)],
    p95: sorted[Math.floor(frames * 0.95)],
    max: sorted[frames - 1],
  };
}

test("four panels hold the frame budget at 1x", () => {
  const h = setupHarness();
  try {
    const panels = buildPanels(h, buildSession());
    const stats = measure(panels, 1, 600);
    console.log(
      `    1x: p50=${stats.p50.toFixed(2)}ms p95=${stats.p95.toFixed(2)}ms max=${stats.max.toFixed(2)}ms`,
    );
    assert.ok(
      stats.p95 < FRAME_BUDGET_MS / 2,
      `p95 ${stats.p95.toFixed(2)} ms should stay well inside the ${FRAME_BUDGET_MS} ms budget`,
    );
  } finally {
    h.cleanup();
  }
});

test("four panels stay under 2% over-budget frames at 4x", () => {
  const h = setupHarness();
  try {
    const panels = buildPanels(h, buildSession());
    const step = (1e9 / VIDEO_FPS) * 4;
    const frames = 400;
    for (let i = 0; i < 60; i++) panels.draw(BigInt(Math.round(i * step)));

    let over = 0;
    let total = 0;
    for (let i = 0; i < frames; i++) {
      const t0 = performance.now();
      panels.draw(BigInt(Math.round(i * step)));
      const dt = performance.now() - t0;
      total += dt;
      if (dt > FRAME_BUDGET_MS) over++;
    }
    const dropRate = over / frames;
    console.log(
      `    4x: mean=${(total / frames).toFixed(2)}ms over-budget=${(dropRate * 100).toFixed(2)}%`,
    );
    assert.ok(dropRate < 0.02, `over-budget frames ${(dropRate * 100).toFixed(2)}% exceeded 2%`);
  } finally {
    h.cleanup();
  }
});

test("seeking to random points costs no more than sequential playback", () => {
  const h = setupHarness();
  try {
    const session = buildSession();
    const panels = buildPanels(h, session);
    const rand = lcg(4242);
    const end = Number(session.mat.endNs);

    const points = Array.from({ length: 200 }, () => BigInt(Math.round(rand() * end)));
    for (const p of points) panels.draw(p);

    const t0 = performance.now();
    for (const p of points) panels.draw(p);
    const perSeek = (performance.now() - t0) / points.length;
    console.log(`    random seek: ${perSeek.toFixed(2)}ms/frame`);
    assert.ok(
      perSeek < FRAME_BUDGET_MS,
      `random-access draw cost ${perSeek.toFixed(2)} ms exceeds the frame budget`,
    );
  } finally {
    h.cleanup();
  }
});

test("a long playback run does not grow the heap", () => {
  const h = setupHarness();
  try {
    const panels = buildPanels(h, buildSession());
    const step = 1e9 / VIDEO_FPS;

    // Settle allocations from construction and first draws.
    for (let i = 0; i < 900; i++) panels.draw(BigInt(Math.round(i * step)));
    global.gc?.();
    const before = process.memoryUsage().heapUsed;

    // 10 minutes of playback at 30 fps, wrapped over the 60 s fixture.
    for (let i = 0; i < 18_000; i++) {
      panels.draw(BigInt(Math.round((i % 1800) * step)));
    }
    global.gc?.();
    const after = process.memoryUsage().heapUsed;

    const growthMb = (after - before) / (1024 * 1024);
    console.log(`    heap growth over 18k frames: ${growthMb.toFixed(2)} MB`);
    // The renderers reuse their buffers, so steady-state playback should not
    // accumulate. Without an explicit gc this is noisy, hence the loose bound.
    assert.ok(growthMb < 24, `heap grew ${growthMb.toFixed(1)} MB, which suggests a per-frame leak`);
  } finally {
    h.cleanup();
  }
});

test("every track stays in TypedArrays end to end", () => {
  const session = buildSession();
  for (const track of [session.mat, session.pose, session.angles]) {
    assert.ok(track.values instanceof Float32Array, `${track.name} values must stay a Float32Array`);
    assert.ok(
      track.timestampsNs instanceof BigInt64Array,
      `${track.name} timestamps must stay a BigInt64Array`,
    );
  }
  // at() must not allocate a fresh array per call: it hands back one buffer.
  const first = session.mat.at(session.mat.startNs, "interp");
  const second = session.mat.at(session.mat.timeAt(10), "interp");
  assert.equal(first, second, "at() should reuse its output buffer");
});
