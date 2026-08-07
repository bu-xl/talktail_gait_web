import type { DenoiseMeta } from "./denoise/types.js";

export type { DenoiseMeta };

/** 2D grid point — row = y, col = x */
export interface Point {
  readonly row: number;
  readonly col: number;
}

export interface Vector2 {
  readonly x: number;
  readonly y: number;
}

/** rows × cols (default 72 × 80) */
export type PressureFrame = readonly (readonly number[])[];

export type PawLabel = "LF" | "RF" | "LH" | "RH";
export type PawLabelOrUnknown = PawLabel | "Unknown";

/** 정수 grid 경계 상자 (row/col 포함 범위) */
export interface BBox {
  readonly minRow: number;
  readonly maxRow: number;
  readonly minCol: number;
  readonly maxCol: number;
}

export interface PawBlob {
  readonly id: number;
  readonly cells: readonly Point[];
  /** 기하 중심 (area 가중 X) — 추적 안정용, 기존 동작 유지 */
  readonly centerX: number;
  readonly centerY: number;
  /** 압력 가중 중심 (center of pressure) — 리포트/스텝 기록용 */
  readonly copX: number;
  readonly copY: number;
  readonly area: number;
  readonly pressureSum: number;
  readonly peakPressure: number;
  readonly bbox: BBox;
}

export interface PawTrack {
  readonly trackId: number;
  history: PawBlob[];
  centroidHistory: Point[];
  pressureHistory: number[];
  active: boolean;
  /** runtime — last matched blob snapshot */
  lastBlob: PawBlob | null;
  missFrames: number;
  lastFrameIndex: number;
  contact: boolean;
  contactEvents: ContactEvent[];
  pendingContactStart: number | null;
  /** pressureHistory 와 동일 길이 — 프레임 인덱스 */
  frameIndices: number[];
  /** 세션 확정 라벨 (Unknown 가능) */
  label: PawLabelOrUnknown;
  labelConfidence: number;
  lockedLabel: PawLabel | null;
  /** Frozen limb per contactEvents[i] — assigned once at stance close, never recomputed. */
  contactEventLabels: (PawLabel | null)[];
  /** True while label came from cold-start seed (not yet session-confirmed). */
  flagsProvisional: boolean;
  velocityCol: number;
  velocityRow: number;
}

export interface ContactEvent {
  readonly startFrame: number;
  readonly endFrame: number;
}

/**
 * Phase 0 — 전처리 품질 메타. 리포트 상단 배지·JSON export 가 소비한다.
 * 측정 신뢰성(무부하 baseline 확보·hot pixel 제거·노이즈 floor 감소)을 정량화한다.
 */
export interface PreprocessMeta {
  /** warmup 동안 지속 부하로 무부하 baseline 창을 못 잡음 → 경고 */
  readonly baselineInvalid: boolean;
  /** 영구 마스킹된 stuck/flicker hot pixel 수 */
  readonly hotPixelCount: number;
  /** hot pixel 평면 인덱스(row*cols+col) 목록 */
  readonly hotPixels: readonly number[];
  /** warmup 평균 픽셀값 (baseline 차감 전) */
  readonly noiseFloorBefore: number;
  /** warmup 평균 픽셀값 (baseline 차감 후) */
  readonly noiseFloorAfter: number;
  /** baseline 차감에 의한 노이즈 floor 감소율(%) */
  readonly noiseFloorDropPct: number;
}

export interface PawGaitConfig {
  readonly rows: number;
  readonly cols: number;
  readonly sampleHz: number;

  // Phase 1 — preprocessing
  readonly noiseThreshold: number;
  /** baseline 추정 running-min 누수율 (drift 추종) */
  readonly baselineLeak: number;
  /** baseline warmup 프레임 수 (이전엔 hot-pixel 영구 마스킹 보류) */
  readonly baselineWarmupFrames: number;
  /** 이 비율 이상 프레임에서 켜져 있으면 stuck/hot pixel로 영구 마스킹 */
  readonly hotPixelActiveRatio: number;
  /** 활성 이웃이 이 값 미만이면 고립 핫셀로 간주해 프레임 단위 제거 */
  readonly hotPixelMinNeighbors: number;
  /** §1.5 — cell-adaptive speckle/residual denoise before blob detection */
  readonly denoiseEnabled: boolean;

  // Phase 2 — segmentation
  readonly minPawArea: number;
  /** M1 — MORPH_CLOSE on binary mask before CCL */
  readonly morphologyEnabled: boolean;
  /** Active closing kernel (3 or 5). See morphologyKernelSizes for experiments. */
  readonly morphologyKernelSize: number;
  /** Allowed kernel sizes for tuning / A-B tests */
  readonly morphologyKernelSizes: readonly number[];

  // Phase 3 — tracking
  readonly maxTrackDistance: number;
  readonly trackTimeoutMs: number;
  readonly maxTrackHistoryFrames: number;

  // Phase 4 — contact / hysteresis
  readonly contactThreshold: number;
  readonly contactThresholdRatio: number;
  readonly releaseThresholdRatio: number;

  // Phase 4 — direction
  readonly bodyDirectionWindowFrames: number;
  /** 진행 방향 coherence 가 이 값 미만이면 unknown */
  readonly directionMinConfidence: number;

  // Phase 5 — labeling
  readonly minConfidence: number;
  readonly minCyclesBeforeClassify: number;
  readonly frontLoadRatioMin: number;
  readonly frontLoadRatioMax: number;
  readonly labelLockConfidence: number;

  // Phase 6 — valid-trial gating
  /** 세션 내 통과 속도 변동계수 상한 (급격한 속도 변화 검출) */
  readonly velocityCvMax: number;
  /** 유효 trial 최소 접촉 이벤트 수 */
  readonly minContactEventsForTrial: number;

  // Phase 6 — sampling sufficiency (중복 제거 후 실효 해상도)
  /** 실효 샘플링율 하한(Hz). 미만이면 stance 해상 불가로 INVALID */
  readonly minEffectiveHz: number;
  /** 중앙값 stance 를 해상하는 최소 고유 샘플 수. 미만이면 INVALID */
  readonly minSamplesPerStance: number;

  // Phase 7 — feature / multi-trial
  readonly symmetryWarnPct: number;
  readonly symmetryAbnormalPct: number;
  /** 다회 trial 변동계수 경고 임계 (%) */
  readonly cvWarnPct: number;
  /** 결과 확정 권장 최소 VALID trial 수 */
  readonly minValidTrials: number;
}

export interface PawPressureFeatures {
  readonly peakPressure: number;
  readonly meanPressure: number;
  readonly contactArea: number;
  readonly pressureIntegral: number;
}

export interface PawTemporalFeatures {
  readonly stanceTimeMs: number;
  readonly swingTimeMs: number;
  readonly strideTimeMs: number;
  readonly dutyFactor: number;
}

export interface GaitMotionFeatures {
  readonly stepLength: number;
  readonly strideLength: number;
  readonly cadenceHz: number;
  readonly velocity: number;
}

export interface ClassifiedPaw {
  readonly label: PawLabelOrUnknown;
  readonly confidence: number;
  readonly trackId: number;
  readonly pressure: PawPressureFeatures;
  readonly temporal: PawTemporalFeatures;
}

export interface SymmetryReport {
  readonly symmetryIndex: number;
  readonly leftMetric: number;
  readonly rightMetric: number;
  readonly warning: boolean;
  readonly abnormalSuspect: boolean;
}

/* ───────────────────────── Phase 4 — walking direction ───────────────────────── */

export type WalkingDirection = "left_to_right" | "right_to_left" | "unknown";

export interface DirectionResult {
  readonly direction: WalkingDirection;
  /** 0..1 — 각 발 진행벡터의 일관성(coherence) */
  readonly confidence: number;
  readonly vector: Vector2 | null;
  readonly perpendicular: Vector2 | null;
}

/* ───────────────────────── Phase 2 — per-footfall (한걸음) ───────────────────────── */

/**
 * 단일 footfall = 한 발이 판을 밟고(foot strike) 떼는(toe off) 동안의 stance phase.
 * 분석의 원자 단위.
 */
export interface StepRecord {
  readonly contactId: number;
  readonly trackId: number;
  readonly label: PawLabelOrUnknown;
  readonly startFrame: number;
  readonly endFrame: number;
  readonly durationSec: number;
  /** stance 중 순간 압력합 최대 (Peak Vertical Force proxy) */
  readonly peakPressure: number;
  /** Σ(pressure · dt) — 시간가중 vertical impulse */
  readonly pressureImpulse: number;
  readonly meanPressure: number;
  readonly maxArea: number;
  readonly meanArea: number;
  readonly bbox: BBox;
  /** stance 동안 CoP 궤적 길이 (paw_path_length, grid 단위) */
  readonly copPathLength: number;
  /** 접촉 검출 신뢰도 0..1 */
  readonly confidence: number;
}

/* ───────────────────────── Phase 6 — valid-trial ───────────────────────── */

/**
 * 유효성 3단계 (Live 리포트 경로와 통일):
 *   VALID   — 4발 검출·방향 확립·이상 없음. 정상 리포트 생성.
 *   PARTIAL — 분석은 가능하나 불완전(1~2발 누락·샘플링/속도/접지수 부족).
 *             참고용 리포트 생성, 임상 비교 수치는 비활성/경고.
 *   INVALID — 분석 불가(검출 발<2·진행 방향 미확립·접지 겹침). 리포트 차단.
 */
export type TrialValidity = "VALID" | "PARTIAL" | "INVALID";

export interface ValidTrialResult {
  readonly validity: TrialValidity;
  /** PARTIAL/INVALID 사유 (VALID면 빈 배열) */
  readonly reasons: readonly string[];
  readonly detectedPaws: readonly PawLabel[];
  readonly missingPaws: readonly PawLabel[];
  readonly recommendation: string | null;
}

/* ───────────────────────── Phase 7 — per-paw trial features ───────────────────────── */

export interface PawTrialFeatures {
  readonly label: PawLabel;
  /** footfall 당 평균 접지 시간 (초) */
  readonly contactTimeSec: number;
  /** 총 stance 시간 (초) */
  readonly stanceTimeSec: number;
  readonly peakPressure: number;
  readonly pressureImpulse: number;
  readonly contactArea: number;
  /** TPI — stance 전체 압력 적분(시간가중) */
  readonly totalPressureIndex: number;
  readonly pawPathLength: number;
  readonly stepCount: number;
  /** 연속 foot strike 간격(초) */
  readonly stepTimingSec: readonly number[];
}

/* ───────────────────────── multi-trial 집계 ───────────────────────── */

export interface MetricStat {
  readonly mean: number;
  readonly sd: number;
  /** 변동계수 (%) */
  readonly cv: number;
  readonly n: number;
}

export interface PawTrialSummary {
  readonly label: PawLabel;
  readonly peakPressure: MetricStat;
  readonly pressureImpulse: MetricStat;
  readonly contactTimeSec: MetricStat;
  readonly contactArea: MetricStat;
}

export interface MultiTrialSummary {
  readonly trialCount: number;
  readonly validTrialCount: number;
  readonly paws: readonly PawTrialSummary[];
  /** 어떤 지표든 CV가 임계 초과면 true */
  readonly highVariability: boolean;
  readonly recommendation: string | null;
}

/* ───────────────────────── 종합 스크리닝 (한걸음에 다 파악) ───────────────────────── */

/**
 * 단일 세션에서 강아지 보행을 한눈에 파악하기 위한 종합 결과.
 * 리포트 정책: INVALID 시 임상 수치 미생성. PARTIAL 시 features 는 생성(참고용)하되
 * symmetry/motion 은 4발 모두 검출된 경우에만 채운다.
 */
export interface GaitScreening {
  readonly frameCount: number;
  readonly durationSec: number;
  readonly fps: number;
  /** 중복 프레임 제거 후 실효 샘플링율(Hz) — 내용 변화 Δt 중앙값 기반 */
  readonly effectiveHz: number;
  /** 중앙값 stance 를 해상하는 고유 샘플 수 */
  readonly samplesPerStance: number;
  /** 샘플링 부족 시 경고 문구. 충분하면 null */
  readonly samplingNote: string | null;
  readonly direction: DirectionResult;
  readonly paws: readonly ClassifiedPaw[];
  readonly steps: readonly StepRecord[];
  readonly validTrial: ValidTrialResult;
  /** VALID/PARTIAL(검출 발)에서 채워짐. INVALID면 빈 배열 */
  readonly features: readonly PawTrialFeatures[];
  /** 4발 모두 검출(VALID, 또는 PARTIAL+4발)에서만 채워짐. 그 외 null */
  readonly symmetry: { readonly fore: SymmetryReport; readonly hind: SymmetryReport } | null;
  readonly motion: GaitMotionFeatures | null;
  /** 사람이 읽는 정책 준수 요약 */
  readonly summary: string;
  /** Phase 0 — 전처리 품질 메타 (baseline·hot pixel·noise floor) */
  readonly preprocessing: PreprocessMeta;
  /** §1.5 — speckle/residual denoise diagnostics */
  readonly denoise: DenoiseMeta | null;
}

export interface FrameResult {
  readonly frameIndex: number;
  readonly timestampMs: number;
  readonly blobs: readonly PawBlob[];
  readonly tracks: readonly PawTrack[];
  readonly bodyDirection: Vector2 | null;
  readonly bodyPerpendicular: Vector2 | null;
  readonly classified: readonly ClassifiedPaw[];
  readonly readyForClassification: boolean;
}

export interface SessionResult {
  readonly frameCount: number;
  readonly durationMs: number;
  readonly fps: number;
  readonly bodyDirection: Vector2 | null;
  readonly classified: readonly ClassifiedPaw[];
  readonly symmetry: {
    readonly fore: SymmetryReport;
    readonly hind: SymmetryReport;
  };
  readonly motion: GaitMotionFeatures | null;
  readonly frames: readonly FrameResult[];
  /** 진행 방향 (이산 + confidence) */
  readonly direction: DirectionResult;
  /** 한걸음에 전체 보행을 파악하는 종합 스크리닝 */
  readonly screening: GaitScreening;
  /** GaitEngine.analyzeSession 호환 */
  readonly legacy: LegacyGaitResult | null;
  /** Phase 0 — 전처리 품질 메타 */
  readonly preprocessing: PreprocessMeta;
  /** §1.5 — denoise diagnostics (null when disabled) */
  readonly denoise: DenoiseMeta | null;
}

export interface LegacyGaitFoot {
  avgLoad: number;
  maxLoad: number;
  peakP: number;
  avgArea: number;
  loadPct: number;
  loadSeries: Float32Array;
  stancePhases: { start: number; end: number; duration_ms: number }[];
}

export interface LegacyGaitResult {
  nFrames: number;
  fps: number;
  duration_ms: number;
  feet: Record<PawLabel, LegacyGaitFoot>;
  loadDist: { forePct: number; hindPct: number; leftPct: number; rightPct: number };
  loadPct: Record<PawLabel, number>;
  symmetry: { fore: number; hind: number; left: number; diagonal: number };
  peakForce: Record<PawLabel, number>;
  contactArea: Record<PawLabel, number>;
  cadence: number | null;
  events: SessionContactEvent[];
  engine: string;
  classificationReady: boolean;
}

export interface SessionContactEvent {
  pawType: PawLabel;
  startFrame: number;
  endFrame: number;
  duration_s: number;
  peakForce: number;
  impulse: number;
  avgArea: number;
}
