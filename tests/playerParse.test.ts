import assert from "node:assert/strict";
import { test } from "node:test";

import { GRID_COLS, GRID_ROWS, RAW_MAX, SENSOR_COUNT } from "../src/core/constants.js";
import { framesToCanineGaitCsv } from "../src/core/csvExport.js";
import type { RecordedFrame } from "../src/core/recorder.js";
import {
  parseKeypointsJson,
  parsePressureCsv,
  regularGapThresholdNs,
} from "../src/player/parse.js";
import { ANGLE_CONF_OFFSET, ANGLE_STRIDE, JOINTS, MAX_SLOT } from "../src/player/skeletonSchema.js";
import { SampleTrack } from "../src/player/track.js";

const MS = 1_000_000;

/** Frames on a jittered 39-45 Hz clock, with one loaded cell that varies. */
function recordedFrames(count: number): RecordedFrame[] {
  let s = 4242;
  const rand = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
  const out: RecordedFrame[] = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    const raw = new Float64Array(SENSOR_COUNT).fill(RAW_MAX);
    // A single cell under load for the middle third of the recording.
    if (i > count / 3 && i < (count * 2) / 3) raw[800] = 3000;
    out.push({ t, raw });
    t += 1000 / (39 + rand() * 6);
  }
  return out;
}

test("pressure CSV round-trips through the exporter without resampling", () => {
  const frames = recordedFrames(300);
  const parsed = parsePressureCsv(framesToCanineGaitCsv(frames));

  assert.equal(parsed.frames, frames.length);
  assert.equal(parsed.rows, GRID_ROWS);
  assert.equal(parsed.cols, GRID_COLS);

  for (let i = 0; i < frames.length; i++) {
    // `framesToCanineGaitCsv` writes `time` as seconds with 3 decimals, so the
    // file itself quantises to 1 ms and the parser can only be as exact as that.
    const expectedNs = Math.round(frames[i].t * 1e6);
    const gotNs = Number(parsed.timestampsNs[i]);
    assert.ok(
      Math.abs(gotNs - expectedNs) <= 500_000,
      `frame ${i}: got ${gotNs} ns, expected ${expectedNs} ns`,
    );
    assert.equal(parsed.raw[i * SENSOR_COUNT + 800], frames[i].raw[800]);
  }
});

test("CSV timestamps carry 1 ms of quantisation, well inside the half-period budget", () => {
  const frames = recordedFrames(300);
  const parsed = parsePressureCsv(framesToCanineGaitCsv(frames));

  let worst = 0;
  for (let i = 0; i < frames.length; i++) {
    worst = Math.max(worst, Math.abs(Number(parsed.timestampsNs[i]) - frames[i].t * 1e6));
  }
  // The exporter's `toFixed(3)` rounds to the nearest millisecond.
  assert.ok(worst <= 500_000, `worst timestamp error ${worst} ns exceeds the 0.5 ms rounding`);
  // Half a mat period is ~12 ms, so this cannot push a lookup onto the wrong
  // sample. It does mean sub-millisecond mat timing is not recoverable from CSV.
  assert.ok(worst < 12 * MS / 10, "quantisation must stay an order below the half-period budget");
});

test("parsed timestamps stay irregular instead of snapping to a nominal rate", () => {
  const parsed = parsePressureCsv(framesToCanineGaitCsv(recordedFrames(400)));
  const track = new SampleTrack({
    name: "mat",
    timestampsNs: parsed.timestampsNs,
    values: parsed.raw,
    stride: SENSOR_COUNT,
  });
  const stats = track.periodStats();
  assert.ok(stats.medianHz > 39 && stats.medianHz < 45, `medianHz=${stats.medianHz}`);
  assert.ok(stats.max - stats.min > 2 * MS, "period spread was flattened out");
});

test("baseline finds the unloaded level and totals track the load", () => {
  const frames = recordedFrames(300);
  const parsed = parsePressureCsv(framesToCanineGaitCsv(frames));

  assert.equal(parsed.baseline[0], RAW_MAX, "an always-unloaded cell must sit at the ADC ceiling");
  assert.equal(parsed.baseline[800], RAW_MAX, "p95 must reject the loaded minority");

  const loadedIdx = Math.floor(frames.length / 2);
  assert.ok(parsed.totals[0] === 0, "unloaded frames must total zero");
  assert.ok(
    Math.abs(parsed.totals[loadedIdx] - (RAW_MAX - 3000)) < 1,
    `loaded frame total was ${parsed.totals[loadedIdx]}`,
  );
});

test("a CSV missing its grid columns fails with a specific message", () => {
  assert.throws(() => parsePressureCsv("frame_id,time\n0,0.0\n"), /no p_ROW_COL grid columns/);
  assert.throws(() => parsePressureCsv("frame_id,p_0_0\n0,1\n"), /no 'time' column/);
  assert.throws(() => parsePressureCsv("frame_id,time,p_0_0\n0,0.0,1\n"), /expected 1600/);
});

/** Minimal keypoints document in the shape `pawpose.job.run_video` writes. */
function keypointDoc(opts?: { drop?: number[]; frames?: number }): unknown {
  const total = opts?.frames ?? 10;
  const drop = new Set(opts?.drop ?? []);
  const slots = MAX_SLOT + 1;
  return {
    width: 1366,
    height: 768,
    fps_source: 30,
    frames: total,
    frames_detected: total - drop.size,
    schema: { n_slots: slots, limb_chains: { FL: [3, 4, 5, 6, 7] } },
    per_frame: Array.from({ length: total }, (_, i) => {
      if (drop.has(i)) return { i, detected: false };
      const kp = Array.from({ length: slots }, (_, s) => [s * 10 + i, s * 5, 0.8]);
      // front_left shoulder: vertex 4 with arms 3 and 5 at a right angle.
      kp[3] = [10, 0, 0.9];
      kp[4] = [0, 0, 0.7];
      kp[5] = [0, 10, 0.6];
      return { i, detected: true, bbox: [0, 0, 100, 100], det_score: 0.9, keypoints: kp };
    }),
  };
}

test("keypoints frame indices become timestamps on the video's own frame grid", () => {
  const parsed = parseKeypointsJson(keypointDoc({ frames: 10 }) as never);
  assert.equal(parsed.frames, 10);
  assert.equal(parsed.slots, MAX_SLOT + 1);
  assert.equal(parsed.width, 1366);
  assert.ok(Math.abs(parsed.periodNs - 1e9 / 30) < 1e-6);
  for (let i = 0; i < 10; i++) {
    assert.equal(Number(parsed.timestampsNs[i]), Math.round((i * 1e9) / 30));
  }
});

test("undetected frames are dropped, never zero-filled", () => {
  const parsed = parseKeypointsJson(keypointDoc({ frames: 10, drop: [4, 5] }) as never);
  assert.equal(parsed.frames, 8);
  assert.equal(parsed.detectedFrames, 8);
  assert.equal(parsed.totalFrames, 10);
  // Frame 3 then frame 6: the hole is preserved in the timestamps.
  const times = Array.from(parsed.timestampsNs, (t) => Math.round(Number(t) / (1e9 / 30)));
  assert.deepEqual(times, [0, 1, 2, 3, 6, 7, 8, 9]);
});

test("a dropped pose frame reads as a gap, not as an interpolated pose", () => {
  const parsed = parseKeypointsJson(keypointDoc({ frames: 10, drop: [4, 5] }) as never);
  const track = new SampleTrack({
    name: "pose",
    timestampsNs: parsed.timestampsNs,
    values: parsed.keypoints,
    stride: parsed.slots * 3,
    irregular: false,
    gapThresholdNs: regularGapThresholdNs(parsed.periodNs),
  });

  const frameNs = (i: number): number => (i * 1e9) / 30;
  assert.equal(track.gapAtNs(frameNs(3)), false);
  assert.equal(track.gapAtNs(frameNs(4)), true, "frame 4 was never detected");
  assert.equal(track.gapAtNs(frameNs(5)), true, "frame 5 was never detected");
  assert.equal(track.gapAtNs(frameNs(6)), false);
  assert.equal(track.atNs(frameNs(4.5), "nearest"), null, "must not bridge the hole");
  assert.equal(track.gaps().length, 1);
});

test("a single dropped frame still counts as missing on a regular track", () => {
  const parsed = parseKeypointsJson(keypointDoc({ frames: 10, drop: [4] }) as never);
  const withRule = new SampleTrack({
    name: "pose",
    timestampsNs: parsed.timestampsNs,
    values: parsed.keypoints,
    stride: parsed.slots * 3,
    gapThresholdNs: regularGapThresholdNs(parsed.periodNs),
  });
  assert.equal(withRule.gapAtNs((4 * 1e9) / 30), true);

  // Without the regular-grid rule the default 2 x p95 threshold would miss it,
  // which is exactly why the loader sets the threshold explicitly.
  const withDefault = new SampleTrack({
    name: "pose",
    timestampsNs: parsed.timestampsNs,
    values: parsed.keypoints,
    stride: parsed.slots * 3,
  });
  assert.equal(withDefault.gapAtNs((4 * 1e9) / 30), false);
});

test("angles are derived per pose frame with the confidence floor", () => {
  const parsed = parseKeypointsJson(keypointDoc({ frames: 4 }) as never);
  const shoulder = JOINTS.find((j) => j.limb === "front_left" && j.en === "shoulder");
  assert.ok(shoulder);
  for (let f = 0; f < parsed.frames; f++) {
    const base = f * ANGLE_STRIDE;
    assert.equal(parsed.angles[base + shoulder.channel], 90);
    assert.ok(Math.abs(parsed.angles[base + ANGLE_CONF_OFFSET + shoulder.channel] - 0.6) < 1e-6);
  }
});

test("an all-undetected clip fails with a message naming the cause", () => {
  assert.throws(
    () => parseKeypointsJson(keypointDoc({ frames: 5, drop: [0, 1, 2, 3, 4] }) as never),
    /no detected frames/,
  );
  assert.throws(
    () => parseKeypointsJson({ per_frame: [{ i: 0, detected: true, keypoints: [] }] } as never),
    /no usable fps_source/,
  );
});
