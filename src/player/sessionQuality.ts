/**
 * Session quality, stated plainly.
 *
 * The rule this follows: never hide a bad number, and never invent a good one.
 * A metric this pipeline cannot measure is reported as unavailable rather than
 * shown as a reassuring zero.
 */

import type { PoseTracks } from "./trackLoader.js";
import type { SampleTrack } from "./track.js";

/**
 * Where the mat's per-sample timestamps came from.
 *
 * `firmware`  - the mat stamped the sample itself; sub-millisecond and immune
 *               to host scheduling.
 * `host_arrival` - the host stamped the sample when it arrived over serial, so
 *               it carries USB and scheduling jitter. This is what the current
 *               recorder does: `SessionRecorder.add()` stamps with
 *               `performance.now()`, and the CSV export rounds that to 1 ms.
 * `host_arrival_regressed` - host arrival times fitted to a line to remove
 *               jitter, which also removes real rate variation.
 */
export type TimestampSource = "firmware" | "host_arrival" | "host_arrival_regressed";

export type MetricStatus = "good" | "warn" | "bad" | "unavailable";

export interface QualityMetric {
  key: string;
  label: string;
  /** Formatted value, or null when this pipeline cannot measure it. */
  value: string | null;
  status: MetricStatus;
  /** Why it cannot be measured, when status is `unavailable`. */
  note?: string;
}

export interface QualityReport {
  metrics: QualityMetric[];
  /** Headline warnings to show without needing a click. */
  warnings: string[];
  /** True when at least one metric is bad enough to distrust the sync. */
  syncSuspect: boolean;
}

export interface QualityInput {
  matTotal: SampleTrack | null;
  pose: PoseTracks | null;
  timestampSource: TimestampSource;
  /** Expected mat sampling band, Hz. */
  rateBandHz?: [number, number];
  /** Per-sample timestamp quantisation, ns. 1 ms for the current CSV export. */
  timestampQuantumNs?: number;
  /** Clock round-trip against the capture device, when a session hub reported it. */
  clockRttMs?: number | null;
  /** Row-to-row acquisition skew across one mat frame, ns, when known. */
  scanSkewNs?: number | null;
}

const MISSING_WARN = 0.01;
const MISSING_BAD = 0.05;

export function assessSession(input: QualityInput): QualityReport {
  const metrics: QualityMetric[] = [];
  const warnings: string[] = [];
  let syncSuspect = false;

  metrics.push(timestampSourceMetric(input.timestampSource));
  if (input.timestampSource !== "firmware") {
    warnings.push(
      "매트 시각이 추정값입니다. 호스트 도착 시각으로 기록되어 USB·스케줄링 지터가 섞여 있습니다.",
    );
    syncSuspect = true;
  }

  const quantumNs = input.timestampQuantumNs ?? 0;
  if (quantumNs > 0) {
    metrics.push({
      key: "timestamp_quantum",
      label: "매트 시각 해상도",
      value: `${(quantumNs / 1e6).toFixed(1)} ms`,
      status: quantumNs > 2e6 ? "warn" : "good",
    });
  }

  const track = input.matTotal;
  if (!track || track.count < 2) {
    metrics.push({
      key: "mat_period",
      label: "매트 주기 p50/p95",
      value: null,
      status: "unavailable",
      note: "매트 데이터가 없습니다.",
    });
  } else {
    const stats = track.periodStats();
    const [loHz, hiHz] = input.rateBandHz ?? [39, 45];
    const inBand = stats.medianHz >= loHz && stats.medianHz <= hiHz;
    metrics.push({
      key: "mat_period",
      label: "매트 주기 p50/p95",
      value: `${(stats.p50 / 1e6).toFixed(1)} / ${(stats.p95 / 1e6).toFixed(1)} ms (${stats.medianHz.toFixed(1)} Hz)`,
      status: inBand ? "good" : "warn",
    });
    if (!inBand) {
      warnings.push(
        `매트 샘플레이트 ${stats.medianHz.toFixed(1)}Hz 가 예상 범위 ${loHz}-${hiHz}Hz 를 벗어났습니다.`,
      );
    }

    const missing = track.missingRatio();
    const missingStatus: MetricStatus =
      missing >= MISSING_BAD ? "bad" : missing >= MISSING_WARN ? "warn" : "good";
    metrics.push({
      key: "mat_missing",
      label: "매트 결측률",
      value: `${(missing * 100).toFixed(2)}% (${track.gaps().length}구간)`,
      status: missingStatus,
    });
    if (missingStatus === "bad") {
      warnings.push(
        `매트 데이터의 ${(missing * 100).toFixed(1)}% 가 비어 있습니다. 결측 구간의 지표는 신뢰하지 마세요.`,
      );
      syncSuspect = true;
    }
  }

  if (!input.pose) {
    metrics.push({
      key: "dropped_frames",
      label: "미검출 프레임",
      value: null,
      status: "unavailable",
      note: "포즈 데이터가 없습니다.",
    });
  } else {
    const { totalFrames, detectedFrames } = input.pose;
    const dropped = Math.max(0, totalFrames - detectedFrames);
    const ratio = totalFrames > 0 ? dropped / totalFrames : 0;
    const status: MetricStatus = ratio >= 0.2 ? "bad" : ratio >= 0.05 ? "warn" : "good";
    metrics.push({
      key: "dropped_frames",
      label: "미검출 프레임",
      value: `${dropped} / ${totalFrames} (${(ratio * 100).toFixed(1)}%)`,
      status,
    });
    if (status === "bad") {
      warnings.push(
        `영상 ${(ratio * 100).toFixed(0)}% 에서 개를 찾지 못했습니다. 골격·각도 구간이 비어 있습니다.`,
      );
    }
  }

  metrics.push(
    input.clockRttMs == null
      ? {
          key: "clock_rtt",
          label: "클럭 RTT",
          value: null,
          status: "unavailable",
          note: "이 재생 경로에는 기기 동기화 허브가 없습니다. 저장된 파일만 읽습니다.",
        }
      : {
          key: "clock_rtt",
          label: "클럭 RTT",
          value: `${input.clockRttMs.toFixed(0)} ms`,
          status: input.clockRttMs > 80 ? "warn" : "good",
        },
  );

  metrics.push(
    input.scanSkewNs == null
      ? {
          key: "scan_skew",
          label: "스캔 스큐",
          value: null,
          status: "unavailable",
          note: "펌웨어가 행별 취득 시각을 보고하지 않습니다.",
        }
      : {
          key: "scan_skew",
          label: "스캔 스큐",
          value: `${(input.scanSkewNs / 1e6).toFixed(2)} ms`,
          status: input.scanSkewNs > 5e6 ? "warn" : "good",
        },
  );

  if (syncSuspect) {
    warnings.unshift("이 세션의 동기화 신뢰도가 낮습니다.");
  }

  return { metrics, warnings, syncSuspect };
}

function timestampSourceMetric(source: TimestampSource): QualityMetric {
  const label = "타임스탬프 출처";
  if (source === "firmware") return { key: "timestamp_source", label, value: "firmware", status: "good" };
  if (source === "host_arrival") {
    return { key: "timestamp_source", label, value: "host_arrival", status: "warn" };
  }
  return { key: "timestamp_source", label, value: "host_arrival_regressed", status: "bad" };
}
