import type {
  BBox,
  PawGaitConfig,
  PawLabel,
  PawLabelOrUnknown,
  PawTrack,
  StepRecord,
} from "./types.js";

function resolveContactLabel(track: PawTrack, eventIdx: number): PawLabelOrUnknown {
  const frozen = track.contactEventLabels[eventIdx];
  if (frozen) return frozen;
  return track.lockedLabel ?? track.label;
}

/** 세션 대표 프레임 간격(초). timestamps 우선, 없으면 1/hz. */
export function frameDtSec(timestampsMs: readonly number[], hz: number): number {
  if (timestampsMs.length >= 2) {
    const first = timestampsMs[0];
    const last = timestampsMs[timestampsMs.length - 1];
    if (
      Number.isFinite(first) &&
      Number.isFinite(last) &&
      (last as number) > (first as number)
    ) {
      return (last as number - (first as number)) / 1000 / (timestampsMs.length - 1);
    }
  }
  return hz > 0 ? 1 / hz : 0;
}

function eventDurationSec(
  startFrame: number,
  endFrame: number,
  timestampsMs: readonly number[],
  hz: number,
): number {
  const ts0 = timestampsMs[startFrame];
  const ts1 = timestampsMs[endFrame];
  if (Number.isFinite(ts0) && Number.isFinite(ts1) && (ts1 as number) >= (ts0 as number)) {
    return ((ts1 as number) - (ts0 as number)) / 1000;
  }
  return hz > 0 ? Math.max(0, endFrame - startFrame) / hz : 0;
}

function contactConfidence(
  peak: number,
  durationFrames: number,
  cfg: PawGaitConfig,
): number {
  const ampScore = Math.min(1, peak / Math.max(1, cfg.contactThreshold * 2));
  const durScore = Math.min(1, durationFrames / 3);
  return Math.max(0, Math.min(1, ampScore * 0.6 + durScore * 0.4));
}

/**
 * Phase 2 출력 — 발 ID별 contactEvent 를 footfall(한걸음) 단위 StepRecord 로 승격.
 * track 의 parallel array(frameIndices / pressureHistory / history / centroidHistory)를
 * 사용해 stance 구간 지표를 집계한다. impulse 는 Σ(pressure · dt) 로 시간가중.
 */
export function buildStepRecords(
  tracks: readonly PawTrack[],
  hz: number,
  timestampsMs: readonly number[],
  cfg: PawGaitConfig,
): StepRecord[] {
  const dt = frameDtSec(timestampsMs, hz);
  const records: StepRecord[] = [];
  let contactId = 0;

  for (const track of tracks) {
    const frames = track.frameIndices;
    const pressures = track.pressureHistory;
    const blobs = track.history;
    const centroids = track.centroidHistory;

    for (let ei = 0; ei < track.contactEvents.length; ei++) {
      const ev = track.contactEvents[ei]!;
      const label: PawLabelOrUnknown = resolveContactLabel(track, ei);
      let peak = 0;
      let pSum = 0;
      let nSamples = 0;
      let maxArea = 0;
      let areaSum = 0;
      let minRow = Number.POSITIVE_INFINITY;
      let maxRow = Number.NEGATIVE_INFINITY;
      let minCol = Number.POSITIVE_INFINITY;
      let maxCol = Number.NEGATIVE_INFINITY;
      let pathLen = 0;
      let prevCol = Number.NaN;
      let prevRow = Number.NaN;

      for (let i = 0; i < frames.length; i++) {
        const fi = frames[i]!;
        if (fi < ev.startFrame || fi > ev.endFrame) continue;
        const p = pressures[i] ?? 0;
        pSum += p;
        if (p > peak) peak = p;
        nSamples++;

        const b = blobs[i];
        if (b) {
          if (b.area > maxArea) maxArea = b.area;
          areaSum += b.area;
          if (b.bbox.minRow < minRow) minRow = b.bbox.minRow;
          if (b.bbox.maxRow > maxRow) maxRow = b.bbox.maxRow;
          if (b.bbox.minCol < minCol) minCol = b.bbox.minCol;
          if (b.bbox.maxCol > maxCol) maxCol = b.bbox.maxCol;
        }

        const cp = centroids[i];
        if (cp) {
          if (Number.isFinite(prevCol) && Number.isFinite(prevRow)) {
            pathLen += Math.hypot(cp.col - prevCol, cp.row - prevRow);
          }
          prevCol = cp.col;
          prevRow = cp.row;
        }
      }

      const durationFrames = Math.max(0, ev.endFrame - ev.startFrame);
      const bbox: BBox = Number.isFinite(minRow)
        ? { minRow, maxRow, minCol, maxCol }
        : { minRow: 0, maxRow: 0, minCol: 0, maxCol: 0 };

      records.push({
        contactId: contactId++,
        trackId: track.trackId,
        label,
        startFrame: ev.startFrame,
        endFrame: ev.endFrame,
        durationSec: eventDurationSec(ev.startFrame, ev.endFrame, timestampsMs, hz),
        peakPressure: peak,
        pressureImpulse: pSum * dt,
        meanPressure: nSamples > 0 ? pSum / nSamples : 0,
        maxArea,
        meanArea: nSamples > 0 ? areaSum / nSamples : 0,
        bbox,
        copPathLength: pathLen,
        confidence: contactConfidence(peak, durationFrames, cfg),
      });
    }
  }

  records.sort((a, b) => a.startFrame - b.startFrame || a.trackId - b.trackId);
  return records;
}

/** 라벨이 확정된(Unknown 아님) 발만 추린 step 목록 */
export function stepsByLabel(steps: readonly StepRecord[]): Map<PawLabel, StepRecord[]> {
  const map = new Map<PawLabel, StepRecord[]>();
  for (const s of steps) {
    if (s.label === "Unknown") continue;
    const arr = map.get(s.label);
    if (arr) arr.push(s);
    else map.set(s.label, [s]);
  }
  return map;
}
