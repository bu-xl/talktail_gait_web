import assert from "node:assert/strict";
import { test } from "node:test";

import { assessSession } from "../src/player/sessionQuality.js";
import type { QualityInput } from "../src/player/sessionQuality.js";
import { SampleTrack } from "../src/player/track.js";

/** Mat load track on a jittered 39-45 Hz clock, optionally with a hole. */
function matTrack(opts?: { dropFrom?: number; dropTo?: number; hz?: [number, number] }): SampleTrack {
  let s = 5;
  const rand = (): number => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
  const [lo, hi] = opts?.hz ?? [39, 45];
  const times: number[] = [];
  let t = 0;
  for (let i = 0; i < 800; i++) {
    const skip = opts && i >= (opts.dropFrom ?? -1) && i < (opts.dropTo ?? -1);
    if (!skip) times.push(t);
    t += 1e9 / (lo + rand() * (hi - lo));
  }
  return new SampleTrack({
    name: "mat_total",
    timestampsNs: BigInt64Array.from(times.map((x) => BigInt(Math.round(x)))),
    values: new Float32Array(times.length),
    stride: 1,
  });
}

function pose(totalFrames: number, detectedFrames: number): QualityInput["pose"] {
  return {
    pose: null as never,
    angles: null as never,
    slots: 22,
    width: 1366,
    height: 768,
    limbChains: null,
    totalFrames,
    detectedFrames,
    periodNs: 1e9 / 30,
  };
}

const base: QualityInput = {
  matTotal: null,
  pose: null,
  timestampSource: "firmware",
};

function metric(report: ReturnType<typeof assessSession>, key: string) {
  const m = report.metrics.find((x) => x.key === key);
  assert.ok(m, `missing metric ${key}`);
  return m;
}

test("host-arrival timestamps are called out as estimates", () => {
  const report = assessSession({ ...base, matTotal: matTrack(), timestampSource: "host_arrival" });
  assert.equal(metric(report, "timestamp_source").value, "host_arrival");
  assert.equal(metric(report, "timestamp_source").status, "warn");
  assert.equal(report.syncSuspect, true);
  assert.ok(
    report.warnings.some((w) => w.includes("추정값")),
    `expected an estimate warning, got ${JSON.stringify(report.warnings)}`,
  );
  assert.equal(report.warnings[0], "이 세션의 동기화 신뢰도가 낮습니다.");
});

test("firmware timestamps raise no sync warning", () => {
  const report = assessSession({ ...base, matTotal: matTrack(), timestampSource: "firmware" });
  assert.equal(metric(report, "timestamp_source").status, "good");
  assert.equal(report.syncSuspect, false);
  assert.deepEqual(report.warnings, []);
});

test("regressed host timestamps are worse than raw host arrival", () => {
  const report = assessSession({
    ...base,
    matTotal: matTrack(),
    timestampSource: "host_arrival_regressed",
  });
  assert.equal(metric(report, "timestamp_source").status, "bad");
  assert.equal(report.syncSuspect, true);
});

test("metrics this pipeline cannot measure are unavailable, not zero", () => {
  const report = assessSession({ ...base, matTotal: matTrack() });
  const rtt = metric(report, "clock_rtt");
  assert.equal(rtt.value, null);
  assert.equal(rtt.status, "unavailable");
  assert.ok(rtt.note && rtt.note.length > 0, "an unavailable metric must say why");

  const skew = metric(report, "scan_skew");
  assert.equal(skew.value, null);
  assert.equal(skew.status, "unavailable");
  assert.ok(skew.note);
});

test("mat period is reported and flagged when it leaves the expected band", () => {
  const healthy = assessSession({ ...base, matTotal: matTrack() });
  assert.equal(metric(healthy, "mat_period").status, "good");
  assert.ok(metric(healthy, "mat_period").value?.includes("Hz"));

  const slow = assessSession({ ...base, matTotal: matTrack({ hz: [20, 24] }) });
  assert.equal(metric(slow, "mat_period").status, "warn");
  assert.ok(slow.warnings.some((w) => w.includes("샘플레이트")));
});

test("a large data hole is called bad and drags the session down with it", () => {
  const report = assessSession({ ...base, matTotal: matTrack({ dropFrom: 100, dropTo: 300 }) });
  const missing = metric(report, "mat_missing");
  assert.equal(missing.status, "bad");
  assert.ok(missing.value?.includes("1구간"));
  assert.equal(report.syncSuspect, true);
  assert.ok(report.warnings.some((w) => w.includes("결측")));
});

test("a clean recording reports no missing data", () => {
  const report = assessSession({ ...base, matTotal: matTrack() });
  const missing = metric(report, "mat_missing");
  assert.equal(missing.status, "good");
  assert.ok(missing.value?.startsWith("0.00%"));
});

test("undetected video frames are surfaced with their share", () => {
  const clean = assessSession({ ...base, pose: pose(1000, 990) });
  assert.equal(metric(clean, "dropped_frames").status, "good");

  const rough = assessSession({ ...base, pose: pose(1000, 700) });
  assert.equal(metric(rough, "dropped_frames").status, "bad");
  assert.ok(metric(rough, "dropped_frames").value?.includes("300 / 1000"));
  assert.ok(rough.warnings.some((w) => w.includes("개를 찾지 못했습니다")));
});

test("timestamp quantisation is shown when the format imposes one", () => {
  const report = assessSession({ ...base, matTotal: matTrack(), timestampQuantumNs: 1e6 });
  const q = metric(report, "timestamp_quantum");
  assert.equal(q.value, "1.0 ms");
  assert.equal(q.status, "good", "1 ms is well inside the ~12 ms half-period budget");

  const coarse = assessSession({ ...base, matTotal: matTrack(), timestampQuantumNs: 5e6 });
  assert.equal(metric(coarse, "timestamp_quantum").status, "warn");
});

test("a session with no mat data says so instead of reporting a perfect rate", () => {
  const report = assessSession({ ...base, matTotal: null });
  assert.equal(metric(report, "mat_period").status, "unavailable");
  assert.equal(metric(report, "mat_period").value, null);
});

test("clock RTT is graded when a hub did report it", () => {
  const fast = assessSession({ ...base, matTotal: matTrack(), clockRttMs: 20 });
  assert.equal(metric(fast, "clock_rtt").status, "good");
  const slow = assessSession({ ...base, matTotal: matTrack(), clockRttMs: 140 });
  assert.equal(metric(slow, "clock_rtt").status, "warn");
  assert.equal(metric(slow, "clock_rtt").value, "140 ms");
});
