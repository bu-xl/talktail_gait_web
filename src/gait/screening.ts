import type {
  ClassifiedPaw,
  DirectionResult,
  GaitMotionFeatures,
  GaitScreening,
  PawGaitConfig,
  PawLabel,
  PawTrack,
  PawTrialFeatures,
  PreprocessMeta,
  DenoiseMeta,
  StepRecord,
  SymmetryReport,
  WalkingDirection,
} from "./types.js";

/** preproc 메타 미제공 시 기본값 (하위 호환) */
const EMPTY_PREPROCESS_META: PreprocessMeta = {
  baselineInvalid: false,
  hotPixelCount: 0,
  hotPixels: [],
  noiseFloorBefore: 0,
  noiseFloorAfter: 0,
  noiseFloorDropPct: 0,
};
import { buildStepRecords } from "./stepRecords.js";
import { detectValidTrial } from "./validTrial.js";
import { extractTrialFeatures } from "./trialFeatures.js";
import { buildSymmetryReport } from "./gaitFeatures.js";

function featureByLabel(
  features: readonly PawTrialFeatures[],
  label: PawLabel,
): PawTrialFeatures | null {
  for (const f of features) if (f.label === label) return f;
  return null;
}

function impulseOf(features: readonly PawTrialFeatures[], label: PawLabel): number {
  return featureByLabel(features, label)?.pressureImpulse ?? 0;
}

function directionKo(direction: WalkingDirection): string {
  switch (direction) {
    case "left_to_right":
      return "왼→오른쪽";
    case "right_to_left":
      return "오른→왼쪽";
    default:
      return "불명";
  }
}

function buildSummary(
  direction: DirectionResult,
  validTrial: GaitScreening["validTrial"],
  steps: readonly StepRecord[],
  symmetry: GaitScreening["symmetry"],
  cfg: PawGaitConfig,
): string {
  if (validTrial.validity === "INVALID") {
    const detected = validTrial.detectedPaws.length > 0 ? validTrial.detectedPaws.join(", ") : "없음";
    const reasons = validTrial.reasons.length > 0 ? validTrial.reasons.join("; ") : "알 수 없음";
    return [
      "분석 상태: INVALID",
      `사유: ${reasons}`,
      `검출 발: ${detected}`,
      `권장 사항: ${validTrial.recommendation ?? "재측정 필요"}`,
    ].join("\n");
  }

  if (validTrial.validity === "PARTIAL") {
    const detected = validTrial.detectedPaws.length > 0 ? validTrial.detectedPaws.join(", ") : "없음";
    const missing = validTrial.missingPaws.length > 0 ? validTrial.missingPaws.join(", ") : "없음";
    const reasons = validTrial.reasons.length > 0 ? validTrial.reasons.join("; ") : "알 수 없음";
    return [
      "분석 상태: PARTIAL (부분 분석 · 참고용)",
      `사유: ${reasons}`,
      `검출 발: ${detected} (${validTrial.detectedPaws.length}/4) · 누락: ${missing}`,
      `권장 사항: ${validTrial.recommendation ?? "재측정 권장"}`,
      "※ 임상 비교 수치는 참고용이며 정상/이상 판정에 사용할 수 없습니다.",
      "※ 객관적 보행 스크리닝 지표이며 의료적 진단이 아닙니다.",
    ].join("\n");
  }

  const lines = [
    "분석 상태: VALID",
    `진행 방향: ${directionKo(direction.direction)} (신뢰도 ${direction.confidence.toFixed(2)})`,
    `검출 발: ${validTrial.detectedPaws.join(", ")} (${validTrial.detectedPaws.length}/4)`,
    `한걸음(footfall) 수: ${steps.length}`,
  ];
  if (symmetry) {
    lines.push(
      `좌우 대칭지수(SI) — 앞발 ${symmetry.fore.symmetryIndex.toFixed(1)}%, ` +
        `뒷발 ${symmetry.hind.symmetryIndex.toFixed(1)}% (참고 지표)`,
    );
  }
  lines.push("※ 객관적 보행 스크리닝 지표이며 의료적 진단이 아닙니다.");
  lines.push(`※ 결과 확정에는 최소 ${cfg.minValidTrials}회 VALID 측정 권장.`);
  return lines.join("\n");
}

function medianSorted(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** 내용 변화 Δt 중앙값 기반 실효 샘플링율. 유효 Δt 부족 시 fallbackHz. */
function computeEffectiveHz(timestampsMs: readonly number[], fallbackHz: number): number {
  const deltas: number[] = [];
  for (let i = 1; i < timestampsMs.length; i++) {
    const a = timestampsMs[i - 1];
    const b = timestampsMs[i];
    if (a !== undefined && b !== undefined && Number.isFinite(a) && Number.isFinite(b)) {
      const d = b - a;
      if (d > 2 && d < 2000) deltas.push(d);
    }
  }
  if (deltas.length < 2) return fallbackHz;
  const med = medianSorted(deltas);
  return med > 0 ? 1000 / med : fallbackHz;
}

/** 중앙값 stance 를 해상하는 고유 샘플 수 (frame index 구간 길이의 중앙값). */
function computeSamplesPerStance(steps: readonly StepRecord[]): number {
  if (steps.length === 0) return 0;
  return medianSorted(steps.map((s) => s.endFrame - s.startFrame + 1));
}

/**
 * 단일 세션 종합 스크리닝 — Phase 2(steps) → 6(valid) → 7(features) 를 묶는다.
 * 리포트 정책: INVALID 면 features=[], symmetry=null 로 임상 수치를 만들지 않는다.
 */
export function buildScreening(
  tracks: readonly PawTrack[],
  direction: DirectionResult,
  classified: readonly ClassifiedPaw[],
  motion: GaitMotionFeatures | null,
  frameCount: number,
  durationSec: number,
  fps: number,
  hz: number,
  timestampsMs: readonly number[],
  cfg: PawGaitConfig,
  preprocessing: PreprocessMeta = EMPTY_PREPROCESS_META,
  denoise: DenoiseMeta | null = null,
): GaitScreening {
  const steps = buildStepRecords(tracks, hz, timestampsMs, cfg);

  const effectiveHz = computeEffectiveHz(timestampsMs, fps > 0 ? fps : hz);
  const samplesPerStance = computeSamplesPerStance(steps);
  const samplingNote =
    effectiveHz < cfg.minEffectiveHz ||
    (steps.length > 0 && samplesPerStance < cfg.minSamplesPerStance)
      ? `샘플링 부족: 실효 ~${effectiveHz.toFixed(1)}Hz, stance당 ${samplesPerStance.toFixed(1)}프레임 ` +
        `(권장 ≥${cfg.minEffectiveHz}Hz · ≥${cfg.minSamplesPerStance}프레임). 펌웨어 스캔율 상향 필요.`
      : null;

  const validTrial = detectValidTrial(tracks, direction, steps, cfg, {
    effectiveHz,
    samplesPerStance,
  });

  let features: readonly PawTrialFeatures[] = [];
  let symmetry: GaitScreening["symmetry"] = null;
  let summaryMotion: GaitMotionFeatures | null = null;

  // VALID/PARTIAL 모두 features 생성(검출 발 한정). 좌우 비교가 필요한 symmetry/motion 은
  // 4발 모두 검출된 경우에만 채운다(누락 발이 있으면 SI 가 오도될 수 있으므로 null).
  const reportable = validTrial.validity === "VALID" || validTrial.validity === "PARTIAL";
  const allPawsDetected = validTrial.detectedPaws.length === 4;
  if (reportable) {
    features = extractTrialFeatures(steps, hz, timestampsMs);
    if (allPawsDetected) {
      const fore: SymmetryReport = buildSymmetryReport(
        impulseOf(features, "LF"),
        impulseOf(features, "RF"),
        cfg.symmetryWarnPct,
        cfg.symmetryAbnormalPct,
      );
      const hind: SymmetryReport = buildSymmetryReport(
        impulseOf(features, "LH"),
        impulseOf(features, "RH"),
        cfg.symmetryWarnPct,
        cfg.symmetryAbnormalPct,
      );
      symmetry = { fore, hind };
      summaryMotion = motion;
    }
  }

  const summary = buildSummary(direction, validTrial, steps, symmetry, cfg);

  return {
    frameCount,
    durationSec,
    fps,
    effectiveHz,
    samplesPerStance,
    samplingNote,
    direction,
    paws: classified,
    steps,
    validTrial,
    features,
    symmetry,
    motion: summaryMotion,
    summary,
    preprocessing,
    denoise,
  };
}
