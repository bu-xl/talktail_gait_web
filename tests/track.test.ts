import assert from "node:assert/strict";
import { test } from "node:test";

import { EmptyTrack, SampleTrack } from "../src/player/track.js";

const MS = 1_000_000; // ns per ms

/** Deterministic LCG so the jittered fixtures are reproducible across runs. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

/**
 * Mat-like track whose period wanders across 39..45 Hz.
 * Channel 0 of every sample carries its own index, so a `nearest` lookup can be
 * traced back to the exact sample it picked.
 */
function jitteredTrack(opts?: {
  durationSec?: number;
  stride?: number;
  seed?: number;
  /** Drop every sample inside this half-open span (ns) to punch a hole. */
  dropSpanNs?: [number, number];
}): SampleTrack {
  const durationSec = opts?.durationSec ?? 60;
  const stride = opts?.stride ?? 1;
  const rand = lcg(opts?.seed ?? 12345);

  const times: number[] = [];
  let t = 0;
  while (t <= durationSec * 1e9) {
    const inDrop =
      opts?.dropSpanNs !== undefined && t >= opts.dropSpanNs[0] && t < opts.dropSpanNs[1];
    if (!inDrop) times.push(t);
    // Uniform over [22.222 ms, 25.641 ms] == 45 Hz .. 39 Hz.
    const hz = 39 + rand() * 6;
    t += 1e9 / hz;
  }

  const timestampsNs = BigInt64Array.from(times.map((x) => BigInt(Math.round(x))));
  const values = new Float32Array(times.length * stride);
  for (let i = 0; i < times.length; i++) {
    values[i * stride] = i;
    for (let k = 1; k < stride; k++) values[i * stride + k] = i + k / 1000;
  }
  return new SampleTrack({ name: "mat", timestampsNs, values, stride });
}

test("at('nearest') always lands within half a sample period of the query", () => {
  const track = jitteredTrack({ durationSec: 60 });
  const { p50 } = track.periodStats();
  const halfPeriod = p50 / 2;

  // Half a period at the slowest allowed rate (39 Hz) is ~12.8 ms; the p50-based
  // bound below is tighter, so allow the worst-case interval as the hard ceiling.
  const ceiling = track.periodStats().max / 2;

  let worst = 0;
  const start = Number(track.startNs);
  const end = Number(track.endNs);
  for (let i = 0; i < 5000; i++) {
    const t = start + ((end - start) * i) / 5000;
    const sample = track.atNs(t, "nearest");
    assert.ok(sample, `no sample at ${t}`);
    const index = Math.round(sample[0]);
    const delta = Math.abs(Number(track.timestampsNs[index]) - t);
    if (delta > worst) worst = delta;
  }

  assert.ok(
    worst <= ceiling,
    `worst nearest-miss ${(worst / MS).toFixed(3)} ms exceeds half the max period ${(ceiling / MS).toFixed(3)} ms`,
  );
  assert.ok(
    worst < 13 * MS,
    `worst nearest-miss ${(worst / MS).toFixed(3)} ms exceeds the 13 ms half-period budget`,
  );
  assert.ok(halfPeriod > 11 * MS && halfPeriod < 13 * MS, `unexpected p50 ${p50 / MS} ms`);
});

test("periodStats reports a rate inside the 39-45 Hz band", () => {
  const stats = jitteredTrack({ durationSec: 60 }).periodStats();
  assert.ok(stats.medianHz > 39 && stats.medianHz < 45, `medianHz=${stats.medianHz}`);
  assert.ok(stats.min >= 1e9 / 45 - 1, `min period too short: ${stats.min}`);
  assert.ok(stats.max <= 1e9 / 39 + 1, `max period too long: ${stats.max}`);
});

test("interp blends the bracketing samples instead of repeating one", () => {
  const timestampsNs = BigInt64Array.from([0n, 20n * BigInt(MS), 40n * BigInt(MS)]);
  const values = Float32Array.from([0, 10, 30]);
  const track = new SampleTrack({ name: "angle", timestampsNs, values, stride: 1 });

  assert.equal(track.atNs(0, "interp")?.[0], 0);
  assert.equal(track.atNs(10 * MS, "interp")?.[0], 5);
  assert.equal(track.atNs(20 * MS, "interp")?.[0], 10);
  assert.equal(track.atNs(30 * MS, "interp")?.[0], 20);
  assert.equal(track.atNs(40 * MS, "interp")?.[0], 30);

  // nearest snaps, so consecutive queries inside one interval repeat a value.
  assert.equal(track.atNs(9 * MS, "nearest")?.[0], 0);
  assert.equal(track.atNs(11 * MS, "nearest")?.[0], 10);
});

test("at() returns null outside the track span", () => {
  const track = jitteredTrack({ durationSec: 2 });
  assert.equal(track.atNs(-1, "interp"), null);
  assert.equal(track.atNs(Number(track.endNs) + 1, "interp"), null);
});

test("gapAt is true only inside the dropped span", () => {
  const dropStart = 10e9;
  const dropEnd = 10.5e9;
  const track = jitteredTrack({ durationSec: 20, dropSpanNs: [dropStart, dropEnd] });

  const gaps = track.gaps();
  assert.equal(gaps.length, 1, `expected exactly one gap, got ${gaps.length}`);

  const gapLo = Number(gaps[0].startNs);
  const gapHi = Number(gaps[0].endNs);
  // The hole is bounded by the surviving samples either side of the dropped span.
  assert.ok(gapLo < dropStart, `gap starts at ${gapLo}, expected before ${dropStart}`);
  assert.ok(gapHi >= dropEnd, `gap ends at ${gapHi}, expected at/after ${dropEnd}`);
  assert.ok(gapHi - gapLo > 0.5e9);

  // Strictly inside the hole -> missing.
  for (let i = 1; i < 20; i++) {
    const t = gapLo + ((gapHi - gapLo) * i) / 20;
    assert.ok(track.gapAtNs(t), `expected a gap at ${t}`);
    assert.equal(track.atNs(t, "interp"), null, `must not interpolate across the gap at ${t}`);
  }

  // Everywhere else inside the track -> present.
  const start = Number(track.startNs);
  const end = Number(track.endNs);
  for (let i = 0; i <= 2000; i++) {
    const t = start + ((end - start) * i) / 2000;
    if (t >= gapLo && t <= gapHi) continue;
    assert.equal(track.gapAtNs(t), false, `unexpected gap at ${t}`);
  }
});

test("gapAt is true outside the track, so 'no data' never reads as pressure zero", () => {
  const track = jitteredTrack({ durationSec: 2 });
  assert.equal(track.gapAtNs(-1), true);
  assert.equal(track.gapAtNs(Number(track.endNs) + 1), true);
  assert.equal(track.gapAtNs(Number(track.startNs)), false);
});

test("offsetNs shifts the track onto the master clock", () => {
  const timestampsNs = BigInt64Array.from([0n, 10n * BigInt(MS)]);
  const values = Float32Array.from([1, 2]);
  const offsetNs = BigInt(500 * MS);
  const track = new SampleTrack({ name: "shifted", timestampsNs, values, stride: 1, offsetNs });

  assert.equal(track.startNs, offsetNs);
  assert.equal(track.at(offsetNs, "interp")?.[0], 1);
  assert.equal(track.at(offsetNs + BigInt(10 * MS), "interp")?.[0], 2);
  assert.equal(track.at(0n, "interp"), null);
});

test("windowRange covers the samples inside a centred span", () => {
  const track = jitteredTrack({ durationSec: 20 });
  const centre = BigInt(Math.round(10e9));
  const span = BigInt(Math.round(6e9)); // +/- 3 s

  const range = track.windowRange(centre, span);
  assert.ok(range);
  const loNs = Number(track.timeAt(range.start));
  const hiNs = Number(track.timeAt(range.end));
  assert.ok(loNs >= 7e9 - 1, `window starts too early: ${loNs}`);
  assert.ok(hiNs <= 13e9 + 1, `window ends too late: ${hiNs}`);

  // Nothing inside the span may be left out.
  assert.ok(range.start === 0 || Number(track.timeAt(range.start - 1)) < 7e9);
  assert.ok(
    range.end === track.count - 1 || Number(track.timeAt(range.end + 1)) > 13e9,
  );

  const samples = track.window(centre, span);
  assert.equal(samples.length, range.end - range.start + 1);
});

test("scrubbing back and forth returns the same sample as a cold lookup", () => {
  const track = jitteredTrack({ durationSec: 60 });
  const probes = [0.1, 55, 3, 42, 42.001, 7, 59.9, 0.2, 30];
  const seen: number[] = [];
  for (const sec of probes) {
    const s = track.atNs(sec * 1e9, "nearest");
    assert.ok(s);
    seen.push(s[0]);
  }
  // A fresh track has a cold cursor; results must not depend on the search hint.
  const cold = jitteredTrack({ durationSec: 60 });
  probes.forEach((sec, i) => {
    const s = cold.atNs(sec * 1e9, "nearest");
    assert.ok(s);
    assert.equal(s[0], seen[i], `hint-dependent result at ${sec}s`);
  });
});

test("10k sequential lookups on a 60 s mat-rate track stay under 5 ms", () => {
  const track = jitteredTrack({ durationSec: 60 });
  const start = Number(track.startNs);
  const end = Number(track.endNs);
  const step = (end - start) / 10_000;

  // Warm up so the measurement is not dominated by first-call JIT.
  for (let i = 0; i < 10_000; i++) track.atNs(start + step * i, "interp");

  const t0 = performance.now();
  for (let i = 0; i < 10_000; i++) track.atNs(start + step * i, "interp");
  const elapsed = performance.now() - t0;

  assert.ok(elapsed < 5, `10k lookups took ${elapsed.toFixed(3)} ms (budget 5 ms)`);
});

test("10k lookups over the full 1600-cell mat payload stay inside a frame budget", () => {
  const track = jitteredTrack({ durationSec: 60, stride: 1600 });
  const start = Number(track.startNs);
  const end = Number(track.endNs);
  const step = (end - start) / 10_000;

  for (let i = 0; i < 2000; i++) track.atNs(start + step * i, "interp");

  const t0 = performance.now();
  for (let i = 0; i < 10_000; i++) track.atNs(start + step * i, "interp");
  const elapsed = performance.now() - t0;

  // 10k full-mat interpolations is ~5.5 minutes of 30 fps playback. The number
  // that matters is per-call cost staying well under one 33 ms frame.
  const perCallMs = elapsed / 10_000;
  assert.ok(
    perCallMs < 1,
    `full-mat interp costs ${perCallMs.toFixed(4)} ms/call (budget 1 ms)`,
  );
});

test("valueRange scans the session once and ignores NaN", () => {
  const timestampsNs = BigInt64Array.from([0n, 1n, 2n]);
  const values = Float32Array.from([5, Number.NaN, -3]);
  const track = new SampleTrack({ name: "r", timestampsNs, values, stride: 1 });
  assert.deepEqual(track.valueRange(), { min: -3, max: 5 });
  assert.equal(track.valueRange(), track.valueRange(), "range should be cached");
});

test("missingRatio reports the fraction of the session with no data", () => {
  const track = jitteredTrack({ durationSec: 20, dropSpanNs: [10e9, 11e9] });
  const ratio = track.missingRatio();
  assert.ok(ratio > 0.04 && ratio < 0.07, `missingRatio=${ratio}`);
});

test("out-of-order timestamps are rejected at construction", () => {
  assert.throws(
    () =>
      new SampleTrack({
        name: "bad",
        timestampsNs: BigInt64Array.from([0n, 20n, 10n]),
        values: Float32Array.from([0, 1, 2]),
        stride: 1,
      }),
    /ascending/,
  );
});

test("mismatched value length is rejected at construction", () => {
  assert.throws(
    () =>
      new SampleTrack({
        name: "bad",
        timestampsNs: BigInt64Array.from([0n, 1n]),
        values: Float32Array.from([0, 1, 2]),
        stride: 2,
      }),
    /values length/,
  );
});

test("EmptyTrack answers 'no data' for every query", () => {
  const track = new EmptyTrack("mat", "parse failed");
  assert.equal(track.at(), null);
  assert.deepEqual(track.window(), []);
  assert.equal(track.gapAt(), true);
  assert.equal(track.reason, "parse failed");
});
