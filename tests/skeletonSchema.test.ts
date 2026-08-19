import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  ANGLE_CONF_OFFSET,
  ANGLE_STRIDE,
  JOINTS,
  LIMBS,
  MAX_SLOT,
  angleAt,
  computeAngleSample,
  segmentGroundAngle,
} from "../src/player/skeletonSchema.js";

/**
 * Reference values produced by the definition source itself
 * (`pawpose.overlay.angles`), so the port is checked against the server rather
 * than against my own arithmetic.
 */
type RefCase = {
  v: [number, number];
  a: [number, number];
  b: [number, number];
  angle_at: number | null;
  seg: number | null;
};
const REFERENCE: RefCase[] = JSON.parse(
  readFileSync(new URL("./fixtures_angle_reference.json", import.meta.url), "utf8"),
);

test("angleAt matches the Python definition source", () => {
  for (const c of REFERENCE) {
    const got = angleAt(c.v[0], c.v[1], c.a[0], c.a[1], c.b[0], c.b[1]);
    assert.ok(c.angle_at !== null);
    assert.ok(
      Math.abs(got - c.angle_at) < 1e-9,
      `angle_at mismatch: got ${got}, expected ${c.angle_at}`,
    );
  }
});

test("segmentGroundAngle matches the Python definition source", () => {
  for (const c of REFERENCE) {
    const got = segmentGroundAngle(c.a[0], c.a[1], c.b[0], c.b[1]);
    assert.ok(c.seg !== null);
    assert.ok(Math.abs(got - c.seg) < 1e-9, `seg mismatch: got ${got}, expected ${c.seg}`);
  }
});

test("angleAt covers the documented 0..180 range and is y-flip invariant", () => {
  assert.equal(angleAt(0, 0, 1, 0, 0, 1), 90);
  assert.equal(angleAt(0, 0, 1, 0, -1, 0), 180);
  assert.equal(angleAt(0, 0, 1, 0, 1, 0), 0);
  // Same geometry with y mirrored must give the same angle.
  assert.equal(angleAt(0, 0, 1, 0, 0, -1), 90);
  assert.ok(Number.isNaN(angleAt(0, 0, 0, 0, 1, 1)), "degenerate arm must be NaN");
});

test("segmentGroundAngle folds to the acute angle", () => {
  assert.equal(segmentGroundAngle(0, 0, 10, 0), 0); // horizontal
  assert.equal(segmentGroundAngle(0, 0, 0, 10), 90); // vertical
  assert.equal(segmentGroundAngle(0, 0, 10, 10), 45);
  assert.equal(segmentGroundAngle(0, 0, -10, 10), 45, "must not report the obtuse supplement");
  assert.ok(Number.isNaN(segmentGroundAngle(3, 3, 3, 3)));
});

test("the joint table is the 16 joints the server reports, in a stable order", () => {
  assert.equal(JOINTS.length, 16);
  assert.equal(ANGLE_STRIDE, 32);
  assert.equal(ANGLE_CONF_OFFSET, 16);
  assert.deepEqual(
    JOINTS.map((j) => `${j.limb}.${j.ko}`),
    [
      "front_left.어깨", "front_left.팔꿈치", "front_left.앞발목", "front_left.앞발",
      "front_right.어깨", "front_right.팔꿈치", "front_right.앞발목", "front_right.앞발",
      "rear_left.고관절", "rear_left.무릎", "rear_left.뒷발목", "rear_left.뒷발",
      "rear_right.고관절", "rear_right.무릎", "rear_right.뒷발목", "rear_right.뒷발",
    ],
  );
  JOINTS.forEach((j, i) => assert.equal(j.channel, i, "channel must equal position"));
  // Paw joints are ground inclinations, the rest are true joint angles.
  assert.deepEqual(
    JOINTS.filter((j) => j.kind === "segment_ground").map((j) => j.en),
    ["front_paw", "front_paw", "rear_paw", "rear_paw"],
  );
  assert.equal(MAX_SLOT, 21);
  assert.equal(LIMBS.length, 4);
});

test("computeAngleSample writes NaN for slots the detector did not produce", () => {
  const out = new Float32Array(ANGLE_STRIDE);
  // Only 8 slots present: every definition needing slot >= 8 must be NaN.
  computeAngleSample(new Float32Array(8 * 3), out);
  const frontLeftShoulder = JOINTS.find((j) => j.limb === "front_left" && j.en === "shoulder");
  const rearLeftKnee = JOINTS.find((j) => j.limb === "rear_left" && j.en === "knee");
  assert.ok(frontLeftShoulder && rearLeftKnee);
  assert.ok(Number.isNaN(out[rearLeftKnee.channel]), "slot 15 is absent, must be NaN");
  // Present but all-zero coordinates are degenerate, so also NaN, never 0 deg.
  assert.ok(Number.isNaN(out[frontLeftShoulder.channel]));
});

test("computeAngleSample fills a right angle and its confidence floor", () => {
  const kps = new Float32Array((MAX_SLOT + 1) * 3);
  const put = (slot: number, x: number, y: number, c: number): void => {
    kps[slot * 3] = x;
    kps[slot * 3 + 1] = y;
    kps[slot * 3 + 2] = c;
  };
  // front_left shoulder = angle at slot 4 between slot 3 and slot 5.
  put(3, 10, 0, 0.9);
  put(4, 0, 0, 0.7);
  put(5, 0, 10, 0.4);

  const out = new Float32Array(ANGLE_STRIDE);
  computeAngleSample(kps, out);
  const shoulder = JOINTS.find((j) => j.limb === "front_left" && j.en === "shoulder");
  assert.ok(shoulder);
  assert.equal(out[shoulder.channel], 90);
  assert.ok(
    Math.abs(out[ANGLE_CONF_OFFSET + shoulder.channel] - 0.4) < 1e-6,
    "confidence must be the minimum across the three slots",
  );
});
