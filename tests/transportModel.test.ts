import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RepeatRange,
  clampToSession,
  formatMasterTime,
  fractionOf,
  isTextEntryTag,
  keyToAction,
  masterAtFraction,
} from "../src/player/transportModel.js";

const S = 1_000_000_000n;

test("keyboard map covers the documented shortcuts", () => {
  assert.deepEqual(keyToAction({ key: " " }), { kind: "toggle-play" });
  assert.deepEqual(keyToAction({ key: "ArrowLeft" }), { kind: "step-frames", frames: -1 });
  assert.deepEqual(keyToAction({ key: "ArrowRight" }), { kind: "step-frames", frames: 1 });
  assert.deepEqual(keyToAction({ key: "ArrowLeft", shiftKey: true }), {
    kind: "step-seconds",
    seconds: -1,
  });
  assert.deepEqual(keyToAction({ key: "ArrowRight", shiftKey: true }), {
    kind: "step-seconds",
    seconds: 1,
  });
  assert.deepEqual(keyToAction({ key: "[" }), { kind: "mark-a" });
  assert.deepEqual(keyToAction({ key: "]" }), { kind: "mark-b" });
  assert.deepEqual(keyToAction({ key: "L" }), { kind: "toggle-loop" });
  assert.deepEqual(keyToAction({ key: "l" }), { kind: "toggle-loop" });
  assert.deepEqual(keyToAction({ key: "0" }), { kind: "seek-fraction", fraction: 0 });
  assert.deepEqual(keyToAction({ key: "7" }), { kind: "seek-fraction", fraction: 0.7 });
  assert.equal(keyToAction({ key: "q" }), null);
});

test("modified keystrokes stay with the browser", () => {
  // Cmd+R must reload and Ctrl+A must select, not seek or toggle playback.
  assert.equal(keyToAction({ key: "r", metaKey: true }), null);
  assert.equal(keyToAction({ key: " ", ctrlKey: true }), null);
  assert.equal(keyToAction({ key: "ArrowRight", altKey: true }), null);
  assert.equal(keyToAction({ key: "5", metaKey: true }), null);
});

test("shortcuts are suppressed while typing", () => {
  assert.equal(isTextEntryTag("INPUT"), true);
  assert.equal(isTextEntryTag("TEXTAREA"), true);
  assert.equal(isTextEntryTag("SELECT"), true);
  assert.equal(isTextEntryTag("DIV", true), true, "contenteditable counts as typing");
  assert.equal(isTextEntryTag("DIV"), false);
  assert.equal(isTextEntryTag(undefined), false);
});

test("seeks are clamped to the session", () => {
  const t0 = 100n * S;
  const duration = 10e9;
  assert.equal(clampToSession(t0 - 5n * S, t0, duration), t0);
  assert.equal(clampToSession(t0 + 20n * S, t0, duration), t0 + 10n * S);
  assert.equal(clampToSession(t0 + 4n * S, t0, duration), t0 + 4n * S);
  // With no known duration the upper bound cannot be enforced, only the lower.
  assert.equal(clampToSession(t0 + 999n * S, t0, 0), t0 + 999n * S);
});

test("fraction and master time round-trip", () => {
  const t0 = 42n * S;
  const duration = 8e9;
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    const t = masterAtFraction(f, t0, duration);
    assert.ok(Math.abs(fractionOf(t, t0, duration) - f) < 1e-9, `round-trip failed at ${f}`);
  }
  assert.equal(masterAtFraction(-1, t0, duration), t0, "fraction is clamped low");
  assert.equal(masterAtFraction(2, t0, duration), t0 + 8n * S, "fraction is clamped high");
  assert.equal(fractionOf(t0, t0, 0), 0, "no duration means no progress");
});

test("time reads as mm:ss.mmm, with the raw stamp in developer mode", () => {
  const t0 = 1_000n * S;
  assert.equal(formatMasterTime(t0, t0), "0:00.000");
  assert.equal(formatMasterTime(t0 + 1_234_000_000n, t0), "0:01.234");
  assert.equal(formatMasterTime(t0 + 61_500_000_000n, t0), "1:01.500");
  assert.equal(formatMasterTime(t0 - 5n * S, t0), "0:00.000", "before the start clamps to zero");
  assert.ok(formatMasterTime(t0 + S, t0, true).endsWith("1001000000000 ns"));
});

test("A-B range wraps playback back to A", () => {
  const range = new RepeatRange();
  range.markA(2n * S);
  range.markB(5n * S);
  assert.equal(range.isComplete, true);
  assert.equal(range.enabled, false);
  assert.equal(range.wrapTarget(9n * S, true), null, "no wrap until looping is on");

  range.toggleLoop();
  assert.equal(range.enabled, true);
  assert.equal(range.wrapTarget(3n * S, true), null, "inside the range plays on");
  assert.equal(range.wrapTarget(5n * S, true), 2n * S, "reaching B wraps to A");
  assert.equal(range.wrapTarget(6n * S, true), 2n * S);
  assert.equal(range.wrapTarget(1n * S, true), 2n * S, "before A jumps forward into the range");
});

test("a paused user can scrub outside the loop without being yanked back", () => {
  const range = new RepeatRange();
  range.markA(2n * S);
  range.markB(5n * S);
  range.toggleLoop();
  assert.equal(range.wrapTarget(8n * S, false), null);
  assert.equal(range.wrapTarget(8n * S, true), 2n * S);
});

test("marking the ends out of order clears the other end instead of inverting", () => {
  const range = new RepeatRange();
  range.markA(5n * S);
  range.markB(3n * S); // before A
  assert.equal(range.aNs, null);
  assert.equal(range.bNs, 3n * S);
  assert.equal(range.isComplete, false);

  range.markA(1n * S);
  assert.equal(range.isComplete, true);

  range.markB(0n); // before A again
  assert.equal(range.aNs, null);
  assert.equal(range.enabled, false, "an incomplete range must not stay looping");
});

test("looping cannot be enabled without both ends", () => {
  const range = new RepeatRange();
  range.toggleLoop();
  assert.equal(range.enabled, false);
  range.markA(1n * S);
  range.toggleLoop();
  assert.equal(range.enabled, false, "one end is not a range");
  range.markB(2n * S);
  range.toggleLoop();
  assert.equal(range.enabled, true);
  range.clear();
  assert.equal(range.enabled, false);
  assert.equal(range.wrapTarget(9n * S, true), null);
});
