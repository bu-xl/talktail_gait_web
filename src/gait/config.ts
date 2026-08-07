import type { PawGaitConfig } from "./types.js";

/** viewer 히트맵·말티즈 기준 체중(kg) — 감도 스케일 원점 */
export const WEIGHT_REF_KG = 3.5;

/** 소형견 상한(kg). 3~4kg 말티즈·요크셔 등 — 별도 저압 프로파일 적용 */
export const SMALL_DOG_MAX_KG = 5.0;

/**
 * 체중(kg)에 따라 접지·세그멘테이션·라벨 게이트를 스케일한다.
 * ≤5kg 소형견은 contact 55·minArea 14 기준(중형 80·20 대비)으로 4발 누락을 줄인다.
 */
export function configForWeightKg(weightKg?: number): Partial<PawGaitConfig> {
  const w =
    Number.isFinite(weightKg) && weightKg! > 0
      ? Math.max(0.4, Math.min(80, weightKg!))
      : WEIGHT_REF_KG;
  const ratio = w / WEIGHT_REF_KG;
  const sqrtRatio = Math.sqrt(ratio);
  const small = w <= SMALL_DOG_MAX_KG;

  const contactBase = small ? 55 : 80;
  const areaBase = small ? 14 : 20;
  const noiseBase = small ? 3 : 5;

  return {
    noiseThreshold: Math.max(1, Math.round(noiseBase * ratio)),
    hotPixelMinNeighbors: small ? 1 : 2,
    minPawArea: Math.max(5, Math.round(areaBase * sqrtRatio)),
    contactThreshold: Math.max(10, Math.round(contactBase * ratio)),
    contactThresholdRatio: small ? 0.06 : 0.12,
    releaseThresholdRatio: small ? 0.04 : 0.08,
    minConfidence: small ? 0.46 : 0.62,
    directionMinConfidence: small ? 0.40 : 0.55,
    labelLockConfidence: small ? 0.52 : 0.68,
    minCyclesBeforeClassify: small ? 1 : 2,
    maxTrackDistance: Math.round((small ? 20 : 18) * Math.min(1.3, 0.95 + sqrtRatio * 0.1)),
    trackTimeoutMs: small ? 800 : 500,
    baselineWarmupFrames: small ? 5 : 8,
  };
}

/** 라이브 캡처·idle 판정용 프레임 압력 합 하한 (체중 비례) */
export function pressureSumThresholdForWeightKg(weightKg?: number): number {
  const w =
    Number.isFinite(weightKg) && weightKg! > 0
      ? Math.max(0.4, Math.min(80, weightKg!))
      : WEIGHT_REF_KG;
  if (w <= SMALL_DOG_MAX_KG) {
    return Math.max(40, Math.round(260 * (w / WEIGHT_REF_KG)));
  }
  return Math.max(60, Math.round(400 * (w / WEIGHT_REF_KG)));
}

/**
 * 기본 설정.
 * 현재 제품 샘플링 = 38Hz (1 frame ≈ 26.3ms). 명세에 따라 38Hz를 기준으로 한다.
 * 향후 60Hz 이상으로 올라가면 sampleHz만 바꾸면 모든 시간 계산이 frame 기반으로
 * 따라온다.
 */
export const DEFAULT_CONFIG: PawGaitConfig = {
  rows: 72,
  cols: 80,
  sampleHz: 38,

  // Phase 1 — preprocessing
  noiseThreshold: 5,
  baselineLeak: 0.05,
  baselineWarmupFrames: 8,
  hotPixelActiveRatio: 0.9,
  hotPixelMinNeighbors: 2,
  denoiseEnabled: true,

  // Phase 2 — segmentation
  minPawArea: 20,
  morphologyEnabled: true,
  morphologyKernelSize: 3,
  morphologyKernelSizes: [3, 5],

  // Phase 3 — tracking
  maxTrackDistance: 18,
  trackTimeoutMs: 500,
  maxTrackHistoryFrames: 512,

  // Phase 4 — contact / hysteresis
  contactThreshold: 80,
  contactThresholdRatio: 0.12,
  releaseThresholdRatio: 0.08,

  // Phase 4 — direction
  bodyDirectionWindowFrames: 24,
  directionMinConfidence: 0.6,

  // Phase 5 — labeling
  minConfidence: 0.65,
  minCyclesBeforeClassify: 2,
  frontLoadRatioMin: 0.55,
  frontLoadRatioMax: 0.65,
  labelLockConfidence: 0.72,

  // Phase 6 — valid-trial gating
  velocityCvMax: 0.6,
  minContactEventsForTrial: 4,

  // Phase 6 — sampling sufficiency (중복 프레임 제거 후 실효 해상도 게이트)
  // 실효 Hz 또는 stance 당 고유 샘플 수가 이 값 미만이면 해당 trial 을 INVALID 로 본다.
  // (38Hz 합성/정상 데이터는 통과, ~5Hz 재기록 데이터는 게이팅된다.)
  minEffectiveHz: 15,
  minSamplesPerStance: 3,

  // Phase 7 — feature / multi-trial
  symmetryWarnPct: 10,
  symmetryAbnormalPct: 20,
  cvWarnPct: 20,
  minValidTrials: 3,
};

export function frameToMs(frameIndex: number, hz: number): number {
  if (hz <= 0) return 0;
  return (frameIndex / hz) * 1000;
}

export function frameToSec(frameCount: number, hz: number): number {
  if (hz <= 0) return 0;
  return frameCount / hz;
}

export function msToFrames(ms: number, hz: number): number {
  if (hz <= 0) return 0;
  return Math.ceil((ms / 1000) * hz);
}
