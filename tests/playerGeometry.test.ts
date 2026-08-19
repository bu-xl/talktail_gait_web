import assert from "node:assert/strict";
import { test } from "node:test";

import { findContactEvents, findContactSpans, suggestThreshold } from "../src/player/contactEvents.js";
import {
  UNIT_SQUARE,
  affineApproximation,
  applyHomography,
  calibrationToHomography,
  computeHomography,
  invertHomography,
} from "../src/player/homography.js";
import { SampleTrack } from "../src/player/track.js";

const MS = 1_000_000;

test("homography reproduces the correspondences it was built from", () => {
  const dst = [
    { x: 0.12, y: 0.20 },
    { x: 0.88, y: 0.14 },
    { x: 0.95, y: 0.82 },
    { x: 0.05, y: 0.75 },
  ];
  const h = computeHomography(UNIT_SQUARE, dst);
  assert.ok(h, "expected a solvable system");
  UNIT_SQUARE.forEach((src, i) => {
    const got = applyHomography(h, src.x, src.y);
    assert.ok(got);
    assert.ok(Math.abs(got.x - dst[i].x) < 1e-9, `corner ${i} x: ${got.x} vs ${dst[i].x}`);
    assert.ok(Math.abs(got.y - dst[i].y) < 1e-9, `corner ${i} y: ${got.y} vs ${dst[i].y}`);
  });
});

test("an identity calibration is the identity transform", () => {
  const h = computeHomography(UNIT_SQUARE, UNIT_SQUARE);
  assert.ok(h);
  for (const [x, y] of [[0.3, 0.7], [0.5, 0.5], [0.91, 0.02]]) {
    const p = applyHomography(h, x, y);
    assert.ok(p);
    assert.ok(Math.abs(p.x - x) < 1e-12 && Math.abs(p.y - y) < 1e-12);
  }
});

test("the inverse turns a video point back into mat coordinates", () => {
  const h = computeHomography(UNIT_SQUARE, [
    { x: 0.10, y: 0.30 },
    { x: 0.80, y: 0.10 },
    { x: 0.98, y: 0.70 },
    { x: 0.22, y: 0.92 },
  ]);
  assert.ok(h);
  const inv = invertHomography(h);
  assert.ok(inv);

  for (const [x, y] of [[0.2, 0.4], [0.75, 0.6], [0.5, 0.9]]) {
    const forward = applyHomography(h, x, y);
    assert.ok(forward);
    const back = applyHomography(inv, forward.x, forward.y);
    assert.ok(back);
    assert.ok(
      Math.abs(back.x - x) < 1e-9 && Math.abs(back.y - y) < 1e-9,
      `round-trip drifted: (${x}, ${y}) -> (${back.x}, ${back.y})`,
    );
  }
});

test("degenerate calibrations are rejected instead of producing nonsense", () => {
  // Three corners on one line: no projective transform fits.
  assert.equal(
    computeHomography(UNIT_SQUARE, [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 },
      { x: 0.2, y: 0.9 },
    ]),
    null,
  );
  // All four corners dragged onto the same spot.
  assert.equal(
    computeHomography(UNIT_SQUARE, [
      { x: 0.4, y: 0.4 },
      { x: 0.4, y: 0.4 },
      { x: 0.4, y: 0.4 },
      { x: 0.4, y: 0.4 },
    ]),
    null,
  );
  assert.equal(computeHomography(UNIT_SQUARE, [{ x: 0, y: 0 }]), null);
});

test("a parallelogram gets an affine fast path, a keystoned quad does not", () => {
  const parallelogram = computeHomography(UNIT_SQUARE, [
    { x: 0.10, y: 0.10 },
    { x: 0.60, y: 0.10 },
    { x: 0.70, y: 0.60 },
    { x: 0.20, y: 0.60 },
  ]);
  assert.ok(parallelogram);
  assert.ok(
    affineApproximation(parallelogram, 0.5, 1000, 1000),
    "a parallelogram is exactly affine and should take the fast path",
  );

  const keystoned = computeHomography(UNIT_SQUARE, [
    { x: 0.30, y: 0.10 },
    { x: 0.70, y: 0.10 },
    { x: 0.95, y: 0.90 },
    { x: 0.05, y: 0.90 },
  ]);
  assert.ok(keystoned);
  assert.equal(
    affineApproximation(keystoned, 0.5, 1000, 1000),
    null,
    "a keystoned mat needs subdivision, not a single affine transform",
  );
});

test("calibrationToHomography maps the mat grid onto the stored quad", () => {
  const corners = [
    { x: 0.2, y: 0.3 },
    { x: 0.8, y: 0.25 },
    { x: 0.85, y: 0.9 },
    { x: 0.15, y: 0.88 },
  ] as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
  const h = calibrationToHomography({ corners });
  assert.ok(h);
  const centre = applyHomography(h, 0.5, 0.5);
  assert.ok(centre);
  assert.ok(centre.x > 0.15 && centre.x < 0.85 && centre.y > 0.25 && centre.y < 0.9);
});

/** Load track with square contacts on a jittered mat clock. */
function loadTrack(opts?: { dropFrom?: number; dropTo?: number }): SampleTrack {
  let s = 7;
  const rand = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
  const times: number[] = [];
  const values: number[] = [];
  let t = 0;
  for (let i = 0; i < 400; i++) {
    const skip = opts && i >= (opts.dropFrom ?? -1) && i < (opts.dropTo ?? -1);
    if (!skip) {
      times.push(t);
      // Two clean contacts: 1.0-2.0 s and 3.0-4.0 s.
      const sec = t / 1e9;
      const down = (sec >= 1 && sec < 2) || (sec >= 3 && sec < 4);
      values.push(down ? 1000 : 0);
    }
    t += 1e9 / (39 + rand() * 6);
  }
  return new SampleTrack({
    name: "mat_total",
    timestampsNs: BigInt64Array.from(times.map((x) => BigInt(Math.round(x)))),
    values: Float32Array.from(values),
    stride: 1,
  });
}

test("contact times are interpolated between samples, not snapped to one", () => {
  const track = loadTrack();
  const events = findContactEvents(track, { enter: 500, exit: 375 });
  const strikes = events.filter((e) => e.kind === "strike");
  assert.equal(strikes.length, 2, `expected 2 strikes, got ${strikes.length}`);

  const firstStrikeSec = Number(strikes[0].tNs) / 1e9;
  assert.ok(
    Math.abs(firstStrikeSec - 1) < 0.03,
    `first strike at ${firstStrikeSec}s, expected ~1.0s`,
  );

  // The crossing must sit strictly between the two bracketing samples, which is
  // only possible because it was interpolated.
  const [lo, hi] = strikes[0].betweenIndices;
  const loNs = Number(track.timeAt(lo));
  const hiNs = Number(track.timeAt(hi));
  assert.ok(
    Number(strikes[0].tNs) > loNs && Number(strikes[0].tNs) < hiNs,
    "crossing time should fall between the bracketing samples",
  );
  assert.ok(hi === lo + 1);
});

test("hysteresis stops a signal sitting on the threshold from chattering", () => {
  const times: number[] = [];
  const values: number[] = [];
  for (let i = 0; i < 60; i++) {
    times.push(i * 24 * MS);
    // Dithering right at the entry level.
    values.push(i < 10 ? 0 : 500 + (i % 2 === 0 ? 8 : -8));
  }
  const track = new SampleTrack({
    name: "dither",
    timestampsNs: BigInt64Array.from(times.map((x) => BigInt(x))),
    values: Float32Array.from(values),
    stride: 1,
  });

  const withHysteresis = findContactEvents(track, { enter: 500, exit: 375 });
  assert.equal(withHysteresis.length, 1, "one strike, no chatter");
  assert.equal(withHysteresis[0].kind, "strike");

  const withoutHysteresis = findContactEvents(track, { enter: 500, exit: 500 });
  assert.ok(
    withoutHysteresis.length > 5,
    `without hysteresis the same signal should chatter, got ${withoutHysteresis.length}`,
  );
});

test("a data hole closes the contact instead of assuming the paw stayed down", () => {
  // Drop samples in the middle of the first contact (roughly 1.0-2.0 s).
  const track = loadTrack({ dropFrom: 60, dropTo: 75 });
  assert.equal(track.gaps().length, 1);

  const events = findContactEvents(track, { enter: 500, exit: 375 });
  const lifts = events.filter((e) => e.kind === "lift");
  assert.ok(lifts.length >= 2, "the hole should produce an extra lift, not be bridged");

  const spans = findContactSpans(track, { enter: 500, exit: 375 });
  const gap = track.gaps()[0];
  for (const span of spans) {
    const overlaps = span.startNs < gap.endNs && span.endNs > gap.startNs;
    assert.equal(overlaps, false, "no contact span may cover a hole in the data");
  }
});

test("contact spans pair strikes with lifts and honour a minimum duration", () => {
  const track = loadTrack();
  const spans = findContactSpans(track, { enter: 500, exit: 375 });
  assert.equal(spans.length, 2);
  for (const span of spans) {
    const durationSec = Number(span.endNs - span.startNs) / 1e9;
    assert.ok(Math.abs(durationSec - 1) < 0.06, `span lasted ${durationSec}s, expected ~1s`);
    assert.equal(span.openEnded, false);
  }

  const filtered = findContactSpans(track, { enter: 500, exit: 375, minDurationNs: 2e9 });
  assert.equal(filtered.length, 0, "a 2 s minimum should reject both 1 s contacts");
});

test("a contact still down at the end is reported as open-ended", () => {
  const times = Array.from({ length: 50 }, (_, i) => BigInt(i * 24 * MS));
  const values = Float32Array.from(times.map((_, i) => (i >= 20 ? 1000 : 0)));
  const track = new SampleTrack({
    name: "still-down",
    timestampsNs: BigInt64Array.from(times),
    values,
    stride: 1,
  });
  const spans = findContactSpans(track, { enter: 500, exit: 375 });
  assert.equal(spans.length, 1);
  assert.equal(spans[0].openEnded, true);
  assert.equal(spans[0].endNs, track.endNs);
});

test("the suggested threshold scales with the session's own peak", () => {
  const track = loadTrack();
  const opts = suggestThreshold(track);
  assert.ok(opts.enter > 0 && opts.enter < 1000);
  assert.ok((opts.exit ?? 0) < opts.enter, "exit must sit below enter for hysteresis");
  assert.equal(findContactSpans(track, opts).length, 2);
});

test("an inverted threshold pair is rejected rather than silently swapped", () => {
  assert.throws(
    () => findContactEvents(loadTrack(), { enter: 100, exit: 500 }),
    /must not exceed/,
  );
});
