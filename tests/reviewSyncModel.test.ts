import assert from "node:assert/strict";
import { test } from "node:test";

import {
  durationsMatch,
  followerRate,
  followerTarget,
  shouldCorrect,
  toleranceFor,
  worstDrift,
} from "../src/player/reviewSyncModel.js";

test("a pane from the same clip maps one to one", () => {
  const base = { masterDuration: 10, followerDuration: 10, mapping: "shared" as const };
  assert.equal(followerTarget({ ...base, masterTime: 0 }), 0);
  assert.equal(followerTarget({ ...base, masterTime: 3.4 }), 3.4);
  assert.equal(followerTarget({ ...base, masterTime: 10 }), 10);
});

test("a pane from a different recording maps by duration fraction", () => {
  // The pressure mp4 covers 8 s of mat data against a 10 s clip.
  const base = { masterDuration: 10, followerDuration: 8, mapping: "proportional" as const };
  assert.equal(followerTarget({ ...base, masterTime: 0 }), 0);
  assert.equal(followerTarget({ ...base, masterTime: 5 }), 4);
  assert.equal(followerTarget({ ...base, masterTime: 10 }), 8);
});

test("targets are clamped inside the follower's own span", () => {
  const base = { masterDuration: 10, followerDuration: 4, mapping: "shared" as const };
  assert.equal(followerTarget({ ...base, masterTime: 9 }), 4, "cannot seek past the end");
  assert.equal(followerTarget({ ...base, masterTime: 1, offsetSec: -5 }), 0, "cannot seek before 0");
});

test("a manual offset shifts a pane without breaking the clamp", () => {
  const base = { masterDuration: 10, followerDuration: 10, mapping: "shared" as const };
  assert.equal(followerTarget({ ...base, masterTime: 3, offsetSec: 0.5 }), 3.5);
  assert.equal(followerTarget({ ...base, masterTime: 3, offsetSec: -0.5 }), 2.5);
  assert.equal(followerTarget({ ...base, masterTime: 9.8, offsetSec: 1 }), 10);
});

test("a pane with no duration yet reports zero rather than NaN", () => {
  assert.equal(
    followerTarget({ masterTime: 4, masterDuration: 10, followerDuration: 0, mapping: "shared" }),
    0,
  );
  assert.equal(
    followerTarget({ masterTime: 4, masterDuration: 0, followerDuration: 8, mapping: "proportional" }),
    0,
  );
});

test("a proportional pane runs at a scaled rate so it does not need constant seeking", () => {
  assert.equal(followerRate(1, 10, 8, "proportional"), 0.8);
  assert.equal(followerRate(2, 10, 8, "proportional"), 1.6);
  assert.equal(followerRate(0.5, 10, 20, "proportional"), 1);
  // A pane from the same clip just mirrors the master's rate.
  assert.equal(followerRate(2, 10, 10, "shared"), 2);
  assert.equal(followerRate(2, 10, 8, "shared"), 2);
});

test("an unmeasurable duration falls back to the master's rate", () => {
  assert.equal(followerRate(1.5, 0, 8, "proportional"), 1.5);
  assert.equal(followerRate(1.5, 10, 0, "proportional"), 1.5);
});

test("correction only fires once drift is visible", () => {
  assert.equal(shouldCorrect(0.01, 0.04), false);
  assert.equal(shouldCorrect(-0.01, 0.04), false);
  assert.equal(shouldCorrect(0.05, 0.04), true);
  assert.equal(shouldCorrect(-0.05, 0.04), true);
});

test("tolerance is one frame, floored so a fast pane is not corrected constantly", () => {
  assert.ok(Math.abs(toleranceFor(30) - 0.0333) < 1e-3);
  assert.equal(toleranceFor(120), 0.033, "a 120 fps pane still uses the floor");
  assert.ok(Math.abs(toleranceFor(10) - 0.1) < 1e-9, "a slow pane gets a wider tolerance");
  assert.equal(toleranceFor(0), toleranceFor(30), "unknown fps is treated as 30 fps");
});

test("worstDrift reports the pane that is furthest off", () => {
  assert.equal(
    worstDrift([
      { key: "analysis", driftSec: 0.01, corrected: false },
      { key: "pressure", driftSec: -0.12, corrected: true },
      { key: "angle", driftSec: 0.03, corrected: false },
    ]),
    0.12,
  );
  assert.equal(worstDrift([]), 0);
});

test("durationsMatch decides whether two panes are really the same clip", () => {
  assert.equal(durationsMatch(12.5, 12.5), true);
  assert.equal(durationsMatch(12.5, 12.52), true, "a frame of slack is fine");
  assert.equal(durationsMatch(12.5, 9.8), false, "a different recording is not the same clip");
  assert.equal(durationsMatch(0, 12.5), false, "an unloaded pane cannot be matched");
});
