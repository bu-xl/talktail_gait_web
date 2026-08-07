import { DEFAULT_CONFIG, msToFrames } from "./config.js";
import { Preprocessor } from "./noiseFilter.js";
import { PressureDenoiser } from "./denoise/index.js";
import { segmentPaws } from "./segmentation.js";
import { normalizeMorphologyKernelSize } from "./morphology.js";
import { PawTracker } from "./tracking.js";
import { updateContactState, countContactCycles, closeOpenContacts } from "./contact.js";
import {
  estimateBodyAxes,
  estimateProgressionAxes,
  resolveSessionWalkAxes,
  toWalkingDirection,
  type CoPSample,
} from "./bodyDirection.js";
import { applyLiveLabels, finalizeSessionLabels } from "./sessionClassification.js";
import {
  buildLegacyGaitResult,
  legacyToViewerResult,
} from "./legacyGaitReport.js";
import {
  buildSymmetryReport,
  extractMotionFeatures,
  extractPressureFeatures,
  extractTemporalFeatures,
} from "./gaitFeatures.js";
import { buildScreening } from "./screening.js";
import { summarizeTrials as summarizeTrialsImpl } from "./trialFeatures.js";
import type {
  ClassifiedPaw,
  DirectionResult,
  GaitMotionFeatures,
  GaitScreening,
  MultiTrialSummary,
  FrameResult,
  PawGaitConfig,
  PawLabel,
  PawTrack,
  PressureFrame,
  SessionResult,
} from "./types.js";

const PAW_LABELS: readonly PawLabel[] = ["LF", "RF", "LH", "RH"];

function mergeConfig(partial?: Partial<PawGaitConfig>): PawGaitConfig {
  if (!partial) return DEFAULT_CONFIG;
  return { ...DEFAULT_CONFIG, ...partial };
}

function flatToGrid(
  flat: ArrayLike<number>,
  rows: number,
  cols: number,
): PressureFrame {
  const frame: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: number[] = [];
    for (let c = 0; c < cols; c++) {
      row.push(Number(flat[r * cols + c] ?? 0));
    }
    frame.push(row);
  }
  return frame;
}

/**
 * Canine paw tracking & classification — pressure-only, direction-aware.
 */
export class PawGaitEngine {
  readonly config: PawGaitConfig;
  private readonly buffer: Float32Array;
  private readonly denoisedBuffer: Float32Array;
  private readonly removedMask: Uint8Array;
  private readonly preproc: Preprocessor;
  private readonly denoiser: PressureDenoiser;
  private readonly tracker = new PawTracker();
  private frameIndex = 0;
  private readonly frameResults: FrameResult[] = [];
  private readonly timestampsMs: number[] = [];
  private runtimeHz: number;
  private lastBodyDirection: { x: number; y: number } | null = null;
  private lastBodyPerpendicular: { x: number; y: number } | null = null;
  private lastCoherence = 0;
  /** 프레임별 전역 CoP — 진행 방향 회귀용 */
  private readonly copSamples: CoPSample[] = [];

  constructor(config?: Partial<PawGaitConfig>) {
    this.config = mergeConfig(config);
    this.runtimeHz = this.config.sampleHz;
    this.buffer = new Float32Array(this.config.rows * this.config.cols);
    this.denoisedBuffer = new Float32Array(this.config.rows * this.config.cols);
    this.removedMask = new Uint8Array(this.config.rows * this.config.cols);
    this.preproc = new Preprocessor(this.config);
    this.denoiser = new PressureDenoiser(this.config);
  }

  reset(): void {
    this.tracker.reset();
    this.preproc.reset();
    this.denoiser.reset();
    this.frameIndex = 0;
    this.frameResults.length = 0;
    this.timestampsMs.length = 0;
    this.runtimeHz = this.config.sampleHz;
    this.lastBodyDirection = null;
    this.lastBodyPerpendicular = null;
    this.lastCoherence = 0;
    this.copSamples.length = 0;
  }

  /** Process one frame (real-time) */
  processFrame(frame: PressureFrame, timestampMs?: number): FrameResult {
    const cfg = this.config;
    const idx = this.frameIndex++;
    const ts = timestampMs ?? (idx / this.runtimeHz) * 1000;
    this.timestampsMs.push(ts);

    // Phase 1 — baseline / hot-pixel 보정 (raw preserved; output to buffer)
    this.preproc.process(frame, this.buffer);

    // §1.5 — cell-adaptive denoise → pressure_denoised (non-destructive)
    const segInput = this.denoisedBuffer;
    if (cfg.denoiseEnabled) {
      this.denoiser.process(this.buffer, idx, segInput, this.removedMask);
    } else {
      segInput.set(this.buffer);
      this.removedMask.fill(0);
    }

    const blobs = segmentPaws(segInput, cfg.rows, cfg.cols, cfg.minPawArea, {
      morphology: {
        enabled: cfg.morphologyEnabled,
        kernelSize: normalizeMorphologyKernelSize(cfg.morphologyKernelSize),
      },
    });

    // 전역 CoP 표본 (진행 방향 회귀용) — 접촉 blob 의 압력가중 중심
    if (blobs.length > 0) {
      let w = 0;
      let cx = 0;
      let cy = 0;
      for (const b of blobs) {
        w += b.pressureSum;
        cx += b.copX * b.pressureSum;
        cy += b.copY * b.pressureSum;
      }
      if (w > 0) {
        this.copSamples.push({ frame: idx, col: cx / w, row: cy / w, weight: w });
      }
    }

    const timeoutFrames = msToFrames(cfg.trackTimeoutMs, this.runtimeHz);
    const tracks = this.tracker.update(
      blobs,
      idx,
      cfg.maxTrackDistance,
      timeoutFrames,
      cfg.maxTrackHistoryFrames,
    );
    updateContactState(tracks, idx, cfg);

    const trackAxes = estimateBodyAxes(tracks, cfg.bodyDirectionWindowFrames);
    const progAxes = estimateProgressionAxes(this.copSamples);
    const axes = resolveSessionWalkAxes(progAxes, trackAxes);
    const { bodyDirection, bodyPerpendicular, coherence } = axes;
    if (bodyDirection) this.lastBodyDirection = bodyDirection;
    if (bodyPerpendicular) this.lastBodyPerpendicular = bodyPerpendicular;
    if (coherence > this.lastCoherence) {
      this.lastCoherence = coherence;
    }

    const dir = this.lastBodyDirection;
    const perp = this.lastBodyPerpendicular;
    const cycles = countContactCycles(tracks);
    const ready = cycles >= cfg.minCyclesBeforeClassify && dir !== null && perp !== null;

    if (ready && dir && perp) {
      applyLiveLabels(tracks, dir, perp, cfg, idx);
    } else {
      applyLiveLabels(tracks, dir ?? { x: 0, y: 1 }, perp ?? { x: 1, y: 0 }, cfg, idx);
    }

    const classified = this.buildClassifiedPaws(tracks, idx);
    const result: FrameResult = {
      frameIndex: idx,
      timestampMs: ts,
      blobs,
      tracks: tracks.slice(),
      bodyDirection: dir,
      bodyPerpendicular: perp,
      classified,
      readyForClassification: ready,
    };
    this.frameResults.push(result);
    return result;
  }

  /** Flat buffer (Uint8Array / Float32Array) single frame */
  processFlatFrame(flat: ArrayLike<number>, timestampMs?: number): FrameResult {
    return this.processFrame(flatToGrid(flat, this.config.rows, this.config.cols), timestampMs);
  }

  /** Batch session */
  processSession(frames: readonly PressureFrame[]): SessionResult {
    this.reset();
    for (const f of frames) {
      this.processFrame(f);
    }
    return this.finalizeSession();
  }

  /** Flat frames batch — GaitEngine.analyzeSession 호환 입력 */
  processFlatSession(
    flatFrames: readonly ArrayLike<number>[],
    timestamps?: readonly number[],
    fpsOverride?: number,
  ): SessionResult {
    this.reset();
    if (fpsOverride && fpsOverride > 0) {
      this.runtimeHz = fpsOverride;
    } else if (timestamps && timestamps.length > 1) {
      const t0 = timestamps[0] ?? 0;
      const t1 = timestamps[timestamps.length - 1] ?? t0;
      const dur = t1 - t0;
      if (dur > 0 && flatFrames.length > 1) {
        this.runtimeHz = (flatFrames.length - 1) / (dur / 1000);
      }
    }
    for (let i = 0; i < flatFrames.length; i++) {
      const ts = timestamps?.[i];
      this.processFlatFrame(flatFrames[i]!, Number.isFinite(ts) ? ts : undefined);
    }
    return this.finalizeSession();
  }

  finalizeSession(): SessionResult {
    const cfg = this.config;
    const frameCount = this.frameIndex;
    const durationMs =
      frameCount > 1 && this.timestampsMs.length >= 2
        ? this.timestampsMs[this.timestampsMs.length - 1]! - this.timestampsMs[0]!
        : frameCount > 0
          ? (frameCount / this.runtimeHz) * 1000
          : 0;
    const fps =
      durationMs > 0 && frameCount > 1
        ? (frameCount - 1) / (durationMs / 1000)
        : this.runtimeHz;

    const tracks = this.tracker.getTracks();
    const lastFrame = frameCount > 0 ? frameCount - 1 : 0;
    closeOpenContacts(tracks, lastFrame);

    // 진행 방향: 제품 고정 Sensor X 0→오른쪽. CoP col 증가 일관성으로 신뢰도만 산출.
    const trackAxes = estimateBodyAxes(tracks, cfg.bodyDirectionWindowFrames);
    const prog = estimateProgressionAxes(this.copSamples);
    const {
      bodyDirection: authDir,
      bodyPerpendicular: authPerp,
      coherence: authCoh,
    } = resolveSessionWalkAxes(prog, trackAxes);

    const cycles = countContactCycles(tracks);
    if (cycles >= cfg.minCyclesBeforeClassify && authDir && authPerp) {
      finalizeSessionLabels(
        tracks,
        authDir,
        authPerp,
        cfg,
        this.frameResults,
        this.timestampsMs,
        fps,
      );
    }

    const classified = this.buildClassifiedPaws(tracks, lastFrame);
    const legacy = buildLegacyGaitResult(
      tracks,
      frameCount,
      fps,
      durationMs,
      this.timestampsMs,
    );

    const lfImp = legacy.loadPct.LF;
    const rfImp = legacy.loadPct.RF;
    const lhImp = legacy.loadPct.LH;
    const rhImp = legacy.loadPct.RH;

    const motion: GaitMotionFeatures | null = extractMotionFeatures(tracks, durationMs, fps);
    const direction: DirectionResult = toWalkingDirection(
      { bodyDirection: authDir, bodyPerpendicular: authPerp, coherence: authCoh },
      cfg.directionMinConfidence,
    );
    // Phase 0 — 전처리 품질 메타 (baseline·hot pixel·noise floor). 리포트 메타가 소비.
    const preprocessing = this.preproc.getMeta();
    const denoise = this.config.denoiseEnabled ? this.denoiser.getMeta() : null;
    const screening: GaitScreening = buildScreening(
      tracks,
      direction,
      classified,
      motion,
      frameCount,
      durationMs / 1000,
      fps,
      this.runtimeHz,
      this.timestampsMs,
      cfg,
      preprocessing,
      denoise,
    );

    return {
      frameCount,
      durationMs,
      fps,
      bodyDirection: authDir,
      classified,
      symmetry: {
        fore: buildSymmetryReport(lfImp, rfImp, cfg.symmetryWarnPct, cfg.symmetryAbnormalPct),
        hind: buildSymmetryReport(lhImp, rhImp, cfg.symmetryWarnPct, cfg.symmetryAbnormalPct),
      },
      motion,
      frames: this.frameResults.slice(),
      direction,
      screening,
      legacy,
      preprocessing,
      denoise,
    };
  }

  /**
   * 모든 트랙(활성+종료)을 반환 — 최종 라벨(lockedLabel ?? label)과 전체 history를
   * 가진다. 오버레이/추적 CSV 가 프레임별 blob 을 재구성하는 데 사용한다.
   * `processSession`/`finalizeSession` 이후에 호출하면 세션 확정 라벨이 적용돼 있다.
   */
  getTracks(): readonly PawTrack[] {
    return this.tracker.getTracks();
  }

  /** 프레임별 전역 압력중심(CoP) 표본 — COP 궤적/안정성 임상 지표용. */
  getCoPSamples(): ReadonlyArray<{ frame: number; col: number; row: number; weight: number }> {
    return this.copSamples;
  }

  /** GaitEngine.analyzeSession() 호환 객체 (브라우저 리포트용) */
  analyzeSessionCompat(
    flatFrames: readonly ArrayLike<number>[],
    timestamps?: readonly number[],
    fpsOverride?: number,
  ): Record<string, unknown> {
    const session = this.processFlatSession(flatFrames, timestamps, fpsOverride);
    const legacy = session.legacy;
    if (!legacy) {
      throw new Error("보행 분석 결과를 생성하지 못했습니다.");
    }
    const viewer = legacyToViewerResult(legacy, this.timestampsMs);
    // Phase 0 — 전처리 품질 메타를 viewer 결과에 가산(기존 키 비파괴). Live 리포트가 소비.
    viewer.preprocessing = session.preprocessing;
    return viewer;
  }

  /**
   * 한걸음에 강아지 보행 전체를 파악하는 종합 분석.
   * Preprocessing → Contact → Tracking → Direction → Labeling → ValidTrial → Feature
   * 전 과정을 한 번에 수행하고 종합 스크리닝 객체를 반환한다.
   */
  analyzeWalk(frames: readonly PressureFrame[]): GaitScreening {
    return this.processSession(frames).screening;
  }

  /** flat 버퍼 입력용 종합 분석 (GaitEngine 호환 입력) */
  analyzeWalkFlat(
    flatFrames: readonly ArrayLike<number>[],
    timestamps?: readonly number[],
    fpsOverride?: number,
  ): GaitScreening {
    return this.processFlatSession(flatFrames, timestamps, fpsOverride).screening;
  }

  /**
   * 다회 측정 집계 — 1회로 확정하지 않고 VALID trial 들의 평균/표준편차/CV 를 낸다.
   * CV 가 높거나 VALID 가 부족하면 재측정을 권장한다.
   */
  summarizeTrials(screenings: readonly GaitScreening[]): MultiTrialSummary {
    return summarizeTrialsImpl(screenings, this.config);
  }

  private buildClassifiedPaws(
    tracks: readonly PawTrack[],
    frameIndex: number,
  ): ClassifiedPaw[] {
    const out: ClassifiedPaw[] = [];
    for (const t of tracks) {
      if (!t.active) continue;
      const label = t.lockedLabel ?? t.label;
      out.push({
        label,
        confidence: t.labelConfidence,
        trackId: t.trackId,
        pressure: extractPressureFeatures(t),
        temporal: extractTemporalFeatures(t, frameIndex, this.runtimeHz, this.timestampsMs),
      });
    }
    return out;
  }
}

export { PAW_LABELS, flatToGrid };
