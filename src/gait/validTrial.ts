import type {
  DirectionResult,
  PawGaitConfig,
  PawLabel,
  PawTrack,
  StepRecord,
  TrialValidity,
  ValidTrialResult,
} from "./types.js";
import { stepsByLabel } from "./stepRecords.js";

const PAW_LABELS: readonly PawLabel[] = ["LF", "RF", "LH", "RH"];

function resolveLabel(track: PawTrack): PawLabel | null {
  const label = track.lockedLabel ?? track.label;
  return label === "Unknown" ? null : label;
}

function detectedLabels(tracks: readonly PawTrack[]): Set<PawLabel> {
  const set = new Set<PawLabel>();
  for (const t of tracks) {
    const label = resolveLabel(t);
    if (label) set.add(label);
  }
  return set;
}

/** 변동계수(%) — mean<=0 이면 0 */
function coefficientOfVariation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / values.length;
  if (mean <= 1e-9) return 0;
  let varSum = 0;
  for (const v of values) varSum += (v - mean) * (v - mean);
  const sd = Math.sqrt(varSum / values.length);
  return (sd / mean) * 100;
}

/** foot-strike(IC) 간격의 변동계수로 보행 리듬 안정성 측정 */
function rhythmCv(steps: readonly StepRecord[]): number {
  if (steps.length < 3) return 0;
  const starts = steps.map((s) => s.startFrame).sort((a, b) => a - b);
  const intervals: number[] = [];
  for (let i = 1; i < starts.length; i++) {
    const gap = starts[i]! - starts[i - 1]!;
    if (gap > 0) intervals.push(gap);
  }
  return coefficientOfVariation(intervals) / 100; // 0..n (비율)
}

/** 같은 라벨의 stance 구간이 서로 겹치는지(물리적으로 불가능) */
function hasContactOverlap(steps: readonly StepRecord[]): boolean {
  const byLabel = stepsByLabel(steps);
  for (const [, arr] of byLabel) {
    const sorted = [...arr].sort((a, b) => a.startFrame - b.startFrame);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]!.startFrame < sorted[i - 1]!.endFrame) return true;
    }
  }
  return false;
}

function countContactEvents(tracks: readonly PawTrack[]): number {
  let n = 0;
  for (const t of tracks) n += t.contactEvents.length;
  return n;
}

/**
 * Phase 6 — Valid Trial Detection.
 * 아래 조건을 모두 만족해야 VALID:
 *   1~4. LF/RF/LH/RH 모두 검출
 *   5.   진행 방향 일정 (direction != unknown, confidence 충분)
 *   6.   급격한 속도(리듬) 변화 없음
 *   7.   contact overlap 이상 없음
 *   (+)  최소 contact event 수 확보
 * 조건 위반 시 fatal 여부에 따라 PARTIAL(불완전·참고용) 또는 INVALID(분석 불가)로
 * 분류하고 사유(reasons)를 반드시 반환한다.
 */
export interface SamplingSufficiency {
  readonly effectiveHz: number;
  readonly samplesPerStance: number;
}

export function detectValidTrial(
  tracks: readonly PawTrack[],
  direction: DirectionResult,
  steps: readonly StepRecord[],
  cfg: PawGaitConfig,
  sampling?: SamplingSufficiency,
): ValidTrialResult {
  const detected = detectedLabels(tracks);
  const detectedPaws = PAW_LABELS.filter((p) => detected.has(p));
  const missingPaws = PAW_LABELS.filter((p) => !detected.has(p));

  const reasons: string[] = [];

  for (const p of missingPaws) {
    reasons.push(`${p} not detected`);
  }

  const directionUnstable =
    direction.direction === "unknown" || direction.confidence < cfg.directionMinConfidence;
  if (directionUnstable) {
    reasons.push("walking direction unstable");
  }

  // 샘플링 충분성: 중복 프레임 제거 후 실효 해상도가 stance 를 해상하지 못하면 degrade.
  // (sampling 미제공 시 게이트 생략 — 하위 호환)
  if (sampling) {
    const lowHz = sampling.effectiveHz > 0 && sampling.effectiveHz < cfg.minEffectiveHz;
    const fewSamples =
      steps.length > 0 && sampling.samplesPerStance < cfg.minSamplesPerStance;
    if (lowHz || fewSamples) {
      reasons.push(
        `insufficient sampling (~${sampling.effectiveHz.toFixed(1)}Hz, ` +
          `${sampling.samplesPerStance.toFixed(1)} samples/stance)`,
      );
    }
  }

  if (countContactEvents(tracks) < cfg.minContactEventsForTrial) {
    reasons.push("insufficient contact events");
  }

  if (rhythmCv(steps) > cfg.velocityCvMax) {
    reasons.push("walking speed unstable");
  }

  const overlap = hasContactOverlap(steps);
  if (overlap) {
    reasons.push("contact overlap anomaly");
  }

  // ── 3단계 등급 판정 (Live 경로와 통일) ──
  //  FATAL(→INVALID): 분석 자체가 불가능 —
  //      · 검출 발 < 2 (좌/우·앞/뒤 비교 불가)
  //      · 진행 방향 미확립 (정지/역보행 — 보행 아님)
  //      · 접지 겹침 (동일 라벨 stance 중첩 = 트래킹 이상)
  //  DEGRADING(→PARTIAL): 분석은 가능하나 불완전 —
  //      · 1~2발 누락, 샘플링/속도/접지수 부족
  //  이상 없으면 VALID.
  const fatal = detectedPaws.length < 2 || directionUnstable || overlap;

  let validity: TrialValidity;
  if (reasons.length === 0) {
    validity = "VALID";
  } else if (fatal) {
    validity = "INVALID";
  } else {
    validity = "PARTIAL";
  }

  let recommendation: string | null = null;
  if (validity === "INVALID") {
    recommendation = "재측정 필요";
  } else if (validity === "PARTIAL") {
    recommendation = "부분 분석 — 재측정 권장";
  }

  return {
    validity,
    reasons,
    detectedPaws,
    missingPaws,
    recommendation,
  };
}
