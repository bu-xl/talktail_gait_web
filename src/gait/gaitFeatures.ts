import type {
  GaitMotionFeatures,
  PawPressureFeatures,
  PawTemporalFeatures,
  PawTrack,
  SymmetryReport,
} from "./types.js";
import { frameToMs } from "./config.js";

export function extractPressureFeatures(track: PawTrack): PawPressureFeatures {
  const blobs = track.history;
  if (blobs.length === 0) {
    return { peakPressure: 0, meanPressure: 0, contactArea: 0, pressureIntegral: 0 };
  }
  let peak = 0;
  let sum = 0;
  let area = 0;
  for (const b of blobs) {
    if (b.peakPressure > peak) peak = b.peakPressure;
    sum += b.pressureSum;
    area += b.area;
  }
  const mean = sum / blobs.length;
  return {
    peakPressure: peak,
    meanPressure: mean,
    contactArea: area / blobs.length,
    pressureIntegral: sum,
  };
}

/**
 * 프레임 구간의 경과 시간(ms). timestamps 가 있으면 실제 wall-clock(가변 dt)을,
 * 없으면 frame 수 × (1/hz) 폴백을 쓴다. 중복 프레임 제거 후 frame index 가 고유
 * 센서 프레임을 가리키므로, timestamps 기반 계산이 곧 정확한 stance/swing 시간이 된다.
 */
function spanMs(
  fromFrame: number,
  toFrame: number,
  hz: number,
  timestampsMs?: readonly number[],
): number {
  if (timestampsMs) {
    const a = timestampsMs[fromFrame];
    const b = timestampsMs[toFrame];
    if (a !== undefined && b !== undefined && Number.isFinite(a) && Number.isFinite(b) && b >= a) {
      return b - a;
    }
  }
  return frameToMs(toFrame - fromFrame, hz);
}

export function extractTemporalFeatures(
  track: PawTrack,
  frameIndex: number,
  hz: number,
  timestampsMs?: readonly number[],
): PawTemporalFeatures {
  const events = track.contactEvents;
  let stanceMs = 0
  for (const e of events) {
    stanceMs += spanMs(e.startFrame, e.endFrame, hz, timestampsMs);
  }
  const open = track.pendingContactStart;
  if (open !== null && track.contact) {
    stanceMs += spanMs(open, frameIndex, hz, timestampsMs);
  }

  let swingMs = 0;
  for (let i = 1; i < events.length; i++) {
    swingMs += spanMs(events[i - 1]!.endFrame, events[i]!.startFrame, hz, timestampsMs);
  }

  const strideMs = stanceMs + swingMs;
  const duty = strideMs > 0 ? stanceMs / strideMs : 0;

  return {
    stanceTimeMs: stanceMs,
    swingTimeMs: swingMs,
    strideTimeMs: strideMs,
    dutyFactor: duty,
  };
}

export function symmetryIndex(left: number, right: number): number {
  const denom = 0.5 * (left + right);
  if (denom <= 1e-9) return 0;
  return (Math.abs(left - right) / denom) * 100;
}

export function buildSymmetryReport(
  left: number,
  right: number,
  warnPct: number,
  abnormalPct: number,
): SymmetryReport {
  const si = symmetryIndex(left, right);
  return {
    symmetryIndex: si,
    leftMetric: left,
    rightMetric: right,
    warning: si >= warnPct,
    abnormalSuspect: si >= abnormalPct,
  };
}

export function extractMotionFeatures(
  tracks: readonly PawTrack[],
  durationMs: number,
  hz: number,
): GaitMotionFeatures | null {
  const active = tracks.filter((t) => t.centroidHistory.length >= 2);
  if (active.length === 0 || durationMs <= 0) return null;

  let stepLenSum = 0;
  let stepN = 0;
  for (const t of active) {
    const h = t.centroidHistory;
    for (let i = 1; i < h.length; i++) {
      const a = h[i - 1]!;
      const b = h[i]!;
      stepLenSum += Math.hypot(b.col - a.col, b.row - a.row);
      stepN++;
    }
  }
  const stepLength = stepN > 0 ? stepLenSum / stepN : 0;

  let strideCount = 0;
  for (const t of active) strideCount += t.contactEvents.length;
  const cadenceHz = durationMs > 0 ? strideCount / (durationMs / 1000) / 2 : 0;
  const strideLength = stepLength * 2;
  const velocity = durationMs > 0 ? (strideLength * strideCount) / (durationMs / 1000) : 0;

  return {
    stepLength,
    strideLength,
    cadenceHz,
    velocity,
  };
}
