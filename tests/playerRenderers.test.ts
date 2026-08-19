import assert from "node:assert/strict";
import { test } from "node:test";

import { GRID_COLS, GRID_ROWS, MAT_ASPECT, RAW_MAX } from "../src/core/constants.js";
import { AngleChartRenderer, romSeries } from "../src/player/renderers/angleChartRenderer.js";
import { COLORMAP_NAMES, buildLut, relativeLuminance } from "../src/player/renderers/colormap.js";
import { MatHeatmapRenderer } from "../src/player/renderers/matHeatmapRenderer.js";
import { SkeletonRenderer } from "../src/player/renderers/skeletonRenderer.js";
import { ANGLE_CONF_OFFSET, ANGLE_STRIDE, JOINTS, MAX_SLOT } from "../src/player/skeletonSchema.js";
import { SampleTrack } from "../src/player/track.js";
import { coverage, pixelAt, setupHarness } from "./playerRenderHarness.js";

const CELLS = GRID_ROWS * GRID_COLS;
const LOADED_CELL = 20 * GRID_COLS + 20;

test("both colormaps rise monotonically in lightness", () => {
  // This is the whole reason for choosing them: a ramp whose lightness reverses
  // draws a contour the data does not contain. A rainbow ramp fails this.
  //
  // The tolerance is not slack for the 17-stop interpolation. matplotlib's own
  // canonical 256-entry viridis dips by up to 2.83e-4 purely from 8-bit
  // quantisation (cividis by 3e-5), and this table matches that. A luminance
  // step of 3e-4 is orders of magnitude below anything an eye resolves; the
  // failure this guards against is a rainbow-style reversal, which is ~0.3.
  const IMPERCEPTIBLE = 1e-3;
  for (const name of COLORMAP_NAMES) {
    const lut = buildLut(name, 0);
    let previous = -1;
    let worstDip = 0;
    for (let i = 0; i < 256; i++) {
      const o = i * 4;
      const lum = relativeLuminance(lut[o], lut[o + 1], lut[o + 2]);
      if (previous >= 0) worstDip = Math.max(worstDip, previous - lum);
      assert.ok(
        lum >= previous - IMPERCEPTIBLE,
        `${name} lightness fell at step ${i}: ${lum} after ${previous}`,
      );
      previous = lum;
    }
    assert.ok(worstDip < 5e-4, `${name} worst dip ${worstDip} drifted from the canonical table`);
  }
});

test("the legacy rainbow ramp is the thing these replace", () => {
  // Guards the reasoning above rather than the new code: the existing live
  // colormap is not monotonic, which is why the player does not reuse it.
  const rainbow = [
    [40, 60, 200], [0, 170, 220], [40, 200, 90], [240, 220, 40], [245, 150, 30], [220, 30, 30],
  ];
  const lums = rainbow.map(([r, g, b]) => relativeLuminance(r, g, b));
  const monotonic = lums.every((l, i) => i === 0 || l >= lums[i - 1]);
  assert.equal(monotonic, false, "rainbow ramp unexpectedly monotonic; revisit the comparison");
});

/** Mat track with one loaded cell, on a jittered 39-45 Hz clock. */
function matFixture(opts?: { dropFrom?: number; dropTo?: number }): {
  track: SampleTrack;
  baseline: Float32Array;
  loadMax: number;
} {
  let s = 99;
  const rand = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
  const times: number[] = [];
  let t = 0;
  for (let i = 0; i < 200; i++) {
    const skip = opts && i >= (opts.dropFrom ?? -1) && i < (opts.dropTo ?? -1);
    if (!skip) times.push(t);
    t += 1e9 / (39 + rand() * 6);
  }
  const values = new Float32Array(times.length * CELLS).fill(RAW_MAX);
  for (let f = 0; f < times.length; f++) {
    // Ramp the load so interpolation between neighbours is observable.
    values[f * CELLS + LOADED_CELL] = RAW_MAX - 1000 - f;
  }
  const baseline = new Float32Array(CELLS).fill(RAW_MAX);
  return {
    track: new SampleTrack({
      name: "mat",
      timestampsNs: BigInt64Array.from(times.map((x) => BigInt(Math.round(x)))),
      values,
      stride: CELLS,
    }),
    baseline,
    loadMax: 1000 + times.length,
  };
}

test("a loaded cell paints colour while unloaded stays transparent", () => {
  const h = setupHarness();
  try {
    const { track, baseline, loadMax } = matFixture();
    const canvas = h.makeCanvas(100, Math.round(100 * MAT_ASPECT));
    const renderer = new MatHeatmapRenderer(canvas, {
      track, baseline, loadMax,
      rows: GRID_ROWS, cols: GRID_COLS,
      labels: { noData: "no data" },
      smooth: false,
    });
    renderer.draw(track.startNs);

    // The panel is exactly the mat's aspect here, so the drawn box fills it.
    const cell = (col: number, row: number): { x: number; y: number } => ({
      x: Math.round((col / 40) * canvas.width),
      y: Math.round((row / 40) * canvas.height),
    });
    const a = cell(20.5, 20.5);
    const b = cell(3.5, 3.5);
    const loaded = pixelAt(canvas, a.x, a.y);
    const unloaded = pixelAt(canvas, b.x, b.y);

    assert.ok(loaded.a > 200, `loaded cell should be opaque, got alpha ${loaded.a}`);
    assert.equal(unloaded.a, 0, "an unloaded cell must let the panel show through");
  } finally {
    h.cleanup();
  }
});

test("missing data is a grey hatch, never the colormap's low end", () => {
  const h = setupHarness();
  try {
    const { track, baseline, loadMax } = matFixture({ dropFrom: 80, dropTo: 120 });
    const canvas = h.makeCanvas(100, Math.round(100 * MAT_ASPECT));
    const renderer = new MatHeatmapRenderer(canvas, {
      track, baseline, loadMax,
      rows: GRID_ROWS, cols: GRID_COLS,
      labels: { noData: "no data" },
      smooth: false,
    });

    const gap = track.gaps();
    assert.equal(gap.length, 1, "fixture should contain exactly one hole");
    const midGap = (gap[0].startNs + gap[0].endNs) / 2n;
    assert.equal(track.gapAt(midGap), true);

    renderer.draw(midGap);
    const px = pixelAt(canvas, Math.round(canvas.width * 0.2), Math.round(canvas.height * 0.2));
    assert.ok(px.a > 200, "a gap must be covered, not left transparent like an unloaded cell");

    // And it must not be confusable with the colormap's zero colour.
    const lut = buildLut("viridis", 0);
    const zeroColour = { r: lut[0], g: lut[1], b: lut[2] };
    const distance =
      Math.abs(px.r - zeroColour.r) + Math.abs(px.g - zeroColour.g) + Math.abs(px.b - zeroColour.b);
    assert.ok(distance > 40, `gap colour ${JSON.stringify(px)} is too close to the scale's zero`);
  } finally {
    h.cleanup();
  }
});

test("the colour scale is fixed, so the same load looks the same in every frame", () => {
  const h = setupHarness();
  try {
    const { track, baseline } = matFixture();
    const canvas = h.makeCanvas(80, Math.round(80 * MAT_ASPECT));
    const make = (loadMax: number): MatHeatmapRenderer =>
      new MatHeatmapRenderer(canvas, {
        track, baseline, loadMax,
        rows: GRID_ROWS, cols: GRID_COLS,
        labels: { noData: "no data" },
        smooth: false,
      });

    const x = Math.round((20.5 / 40) * canvas.width);
    const y = Math.round((20.5 / 40) * canvas.height);

    const fixed = make(1200);
    fixed.draw(track.startNs);
    const early = pixelAt(canvas, x, y);
    fixed.draw(track.timeAt(150));
    const late = pixelAt(canvas, x, y);
    // The load ramps, so the colour must move, but both come off one scale.
    assert.notDeepEqual(early, late);

    // Re-normalising per frame would put the peak at the same colour every time.
    const rescaled = make(1000 + 150);
    rescaled.draw(track.timeAt(150));
    const withOtherScale = pixelAt(canvas, x, y);
    assert.notDeepEqual(
      late,
      withOtherScale,
      "colour must depend on the session scale, proving it is not per-frame",
    );
  } finally {
    h.cleanup();
  }
});

test("the heatmap keeps the mat's true portrait aspect", () => {
  const h = setupHarness();
  try {
    // Every cell loaded, so the painted region is the whole mat rather than one
    // cell, whose own aspect would be measured instead.
    const { track: jittered } = matFixture();
    const values = new Float32Array(jittered.count * CELLS).fill(RAW_MAX - 1200);
    const track = new SampleTrack({
      name: "mat-full",
      timestampsNs: jittered.timestampsNs,
      values,
      stride: CELLS,
    });
    const baseline = new Float32Array(CELLS).fill(RAW_MAX);

    // A square panel: the mat must not stretch to fill it.
    const canvas = h.makeCanvas(200, 200);
    new MatHeatmapRenderer(canvas, {
      track, baseline, loadMax: 1200,
      rows: GRID_ROWS, cols: GRID_COLS,
      labels: { noData: "no data" },
      smooth: false,
    }).draw(track.startNs);

    // Measure the painted bounding box: the mat is centred, so a top-left
    // assumption would report the wrong shape.
    const ctx = canvas.getContext("2d");
    assert.ok(ctx);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let minX = canvas.width;
    let maxX = -1;
    let minY = canvas.height;
    let maxY = -1;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        if (data[(y * canvas.width + x) * 4 + 3] > 0) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    assert.ok(maxX >= 0, "nothing was painted");
    const aspect = (maxY - minY + 1) / (maxX - minX + 1);
    assert.ok(
      Math.abs(aspect - MAT_ASPECT) < 0.15,
      `drawn aspect ${aspect.toFixed(3)} should match the mat's ${MAT_ASPECT.toFixed(3)}`,
    );

    // And it must sit centred, not pinned to a corner.
    const leftGap = minX;
    const rightGap = canvas.width - 1 - maxX;
    assert.ok(
      Math.abs(leftGap - rightGap) <= 2,
      `mat should be horizontally centred, gaps were ${leftGap} and ${rightGap}`,
    );
  } finally {
    h.cleanup();
  }
});

/** Pose track: a straight vertical chain, plus optional dropped frames. */
function poseFixture(opts?: { drop?: Set<number> }): { track: SampleTrack; slots: number } {
  const slots = MAX_SLOT + 1;
  const fps = 30;
  const kept: number[] = [];
  for (let i = 0; i < 60; i++) if (!opts?.drop?.has(i)) kept.push(i);

  const values = new Float32Array(kept.length * slots * 3);
  kept.forEach((frame, f) => {
    for (let s = 0; s < slots; s++) {
      const o = (f * slots + s) * 3;
      values[o] = 100 + s * 8;
      values[o + 1] = 100 + s * 4 + frame;
      // Slot 12 is deliberately unreliable, to exercise the threshold.
      values[o + 2] = s === 12 ? 0.1 : 0.9;
    }
  });

  return {
    slots,
    track: new SampleTrack({
      name: "pose",
      timestampsNs: BigInt64Array.from(kept.map((i) => BigInt(Math.round((i * 1e9) / fps)))),
      values,
      stride: slots * 3,
      irregular: false,
      gapThresholdNs: BigInt(Math.round((1e9 / fps) * 1.5)),
    }),
  };
}

test("skeleton draws nothing on a frame the detector never reported", () => {
  const h = setupHarness();
  try {
    const { track, slots } = poseFixture({ drop: new Set([30, 31, 32]) });
    const canvas = h.makeCanvas(320, 240);
    const renderer = new SkeletonRenderer(canvas, {
      track, slots, sourceWidth: 400, sourceHeight: 300,
    });

    renderer.draw(track.startNs);
    assert.ok(coverage(canvas) > 0, "a detected frame should draw");

    renderer.draw(BigInt(Math.round((31 * 1e9) / 30)));
    assert.equal(coverage(canvas), 0, "a dropped frame must not reuse the previous pose");
  } finally {
    h.cleanup();
  }
});

test("hiding a keypoint group removes exactly that group's ink", () => {
  const h = setupHarness();
  try {
    const { track, slots } = poseFixture();
    const canvas = h.makeCanvas(320, 240);
    const renderer = new SkeletonRenderer(canvas, {
      track, slots, sourceWidth: 400, sourceHeight: 300,
    });

    renderer.draw(track.startNs);
    const all = coverage(canvas);

    renderer.setGroupVisible("rear", false);
    renderer.draw(track.startNs);
    const withoutRear = coverage(canvas);
    assert.ok(withoutRear < all, "hiding the hindlimbs should remove ink");
    assert.ok(withoutRear > 0, "the forelimbs and spine should remain");

    renderer.setGroupVisible("front", false);
    renderer.setGroupVisible("spine", false);
    renderer.draw(track.startNs);
    assert.equal(coverage(canvas), 0, "hiding every group should clear the overlay");
  } finally {
    h.cleanup();
  }
});

/** Angle track derived from the ROM joints, with a hole in the middle. */
function angleFixture(): SampleTrack {
  const fps = 30;
  const frames = 120;
  const values = new Float32Array(frames * ANGLE_STRIDE);
  const elbow = JOINTS.find((j) => j.limb === "front_left" && j.en === "elbow")!;
  for (let f = 0; f < frames; f++) {
    const base = f * ANGLE_STRIDE;
    for (const j of JOINTS) {
      values[base + j.channel] = 120 + 20 * Math.sin((f / fps) * 4);
      values[base + ANGLE_CONF_OFFSET + j.channel] = 0.9;
    }
    // A stretch where the elbow confidence collapses: must break the line.
    if (f >= 50 && f < 60) values[base + ANGLE_CONF_OFFSET + elbow.channel] = 0.05;
  }
  return new SampleTrack({
    name: "angles",
    timestampsNs: BigInt64Array.from(
      Array.from({ length: frames }, (_, i) => BigInt(Math.round((i * 1e9) / fps))),
    ),
    values,
    stride: ANGLE_STRIDE,
    irregular: false,
  });
}

test("the angle chart draws a playhead at the centre of the window", () => {
  const h = setupHarness();
  try {
    const track = angleFixture();
    const canvas = h.makeCanvas(320, 140);
    new AngleChartRenderer(canvas, {
      track, series: romSeries(), title: "ROM",
    }).draw(BigInt(Math.round(2e9)));

    // The playhead is the accent colour; find it near the horizontal centre.
    const centre = Math.round((40 + 320 - 56) / 2);
    let found = false;
    for (let y = 30; y < 110; y++) {
      for (const x of [centre - 1, centre, centre + 1]) {
        const px = pixelAt(canvas, x, y);
        if (px.r > 180 && px.g < 140 && px.b < 110) found = true;
      }
    }
    assert.ok(found, "expected an accent-coloured playhead at the window centre");
  } finally {
    h.cleanup();
  }
});

/** Pixels close to a given colour, ignoring the static axis layer. */
function inkOfColour(
  canvas: HTMLCanvasElement,
  target: { r: number; g: number; b: number },
  tolerance = 60,
): number {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no context");
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let hits = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    if (
      Math.abs(d[i] - target.r) + Math.abs(d[i + 1] - target.g) + Math.abs(d[i + 2] - target.b) <
      tolerance
    ) {
      hits++;
    }
  }
  return hits;
}

test("low-confidence angles are dropped from the chart, not smoothed over", () => {
  const h = setupHarness();
  try {
    const track = angleFixture();
    const canvas = h.makeCanvas(320, 140);
    const FL = { r: 0xff, g: 0x3c, b: 0x3c };
    // Same window and the same data in view; only the threshold differs, so the
    // difference in ink is entirely the dropped low-confidence stretch.
    const centre = BigInt(Math.round((55 / 30) * 1e9)); // frames 50..59 at 30 fps

    const strict = new AngleChartRenderer(canvas, {
      track, series: romSeries(0.5).slice(0, 1), title: "elbow",
    });
    strict.draw(centre);
    const dropped = inkOfColour(canvas, FL);

    const permissive = new AngleChartRenderer(canvas, {
      track, series: romSeries(0).slice(0, 1), title: "elbow",
    });
    permissive.draw(centre);
    const drawnAnyway = inkOfColour(canvas, FL);

    assert.ok(dropped > 0, "the confident parts of the window should still draw");
    assert.ok(
      dropped < drawnAnyway,
      `thresholding must remove ink, got ${dropped} vs ${drawnAnyway} unfiltered`,
    );
  } finally {
    h.cleanup();
  }
});
