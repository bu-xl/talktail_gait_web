/**
 * Gait analysis adapter — feeds a recorded session into the ported
 * paw-gait-engine and returns a compact, panel/report-ready summary.
 *
 * Why an adapter (and not just calling the engine directly):
 *
 *  1. POLARITY. This mat is INVERTED (unloaded raw ~= 4095, higher load = lower
 *     raw). The engine expects positive-going pressure (unloaded ~= 0). So we
 *     convert every recorded raw frame to a baseline-subtracted delta
 *         delta = max(0, baseline - raw)
 *     which gives the engine exactly the polarity it wants. The engine then runs
 *     its OWN baseline/hot-pixel preprocessing on top (idempotent on a ~0 floor).
 *
 *  2. MAGNITUDE. The engine's contact/segmentation thresholds were tuned for a
 *     mat whose loaded cells read ~200 counts. Our delta can reach thousands, and
 *     the real per-cell magnitude is hardware specific. Rather than hand-guess a
 *     fixed scale, we ADAPTIVELY normalise: take a high percentile of the
 *     session's positive deltas and scale it onto a known target peak, so the
 *     engine's magnitude-based thresholds stay meaningful regardless of the
 *     sensor's absolute range. A fixed `pressure_scale` override is supported.
 *
 *  3. GEOMETRY. The engine defaults to a 72x80 grid; this mat is 40x40 with much
 *     larger cells (1.825 x 4.2 cm), so a paw covers far fewer cells. The spatial
 *     gates (min paw area, track distance) are overridden from the gait config.
 *
 * Live view and analysis stay consistent because both start from the SAME
 * recorded raw frames and the SAME calibration baseline.
 */

import {
  PawGaitEngine,
  computeClinicalMetrics,
  configForWeightKg,
  WEIGHT_REF_KG,
} from "../gait/index.js";
import type {
  ClinicalMetrics,
  GaitScreening,
  PawGaitConfig,
  PawLabel,
  SessionResult,
} from "../gait/index.js";
import { COL_PITCH_CM, GRID_COLS, GRID_ROWS, ROW_PITCH_CM } from "./constants.js";
import { applyOrientation } from "./matrix.js";
import type { RecordedFrame } from "./recorder.js";
import type { AppConfig, GaitConfig, Matrix } from "./types.js";

const PAW_ORDER: readonly PawLabel[] = ["LF", "RF", "LH", "RH"];

export interface GaitPawRow {
  label: PawLabel;
  detected: boolean;
  loadPct: number;
  peakPressure: number;
  pressureImpulse: number;
  contactArea: number;
  contactTimeSec: number;
  totalPressureIndex: number;
  pawPathLength: number;
  stepCount: number;
}

export interface GaitSymmetrySide {
  symmetryIndex: number;
  leftMetric: number;
  rightMetric: number;
  warning: boolean;
  abnormalSuspect: boolean;
}

export interface GaitSummary {
  ok: boolean;
  validity: "VALID" | "PARTIAL" | "INVALID";
  reasons: string[];
  recommendation: string | null;
  detectedPaws: PawLabel[];
  missingPaws: PawLabel[];

  direction: "left_to_right" | "right_to_left" | "unknown";
  directionConfidence: number;

  frameCount: number;
  durationSec: number;
  fps: number;
  effectiveHz: number;
  samplesPerStance: number;
  samplingNote: string | null;

  cadenceHz: number | null;
  velocity: number | null;
  stepLength: number | null;
  strideLength: number | null;

  loadPct: Record<PawLabel, number>;
  loadDist: { forePct: number; hindPct: number; leftPct: number; rightPct: number };
  symmetry: { fore: GaitSymmetrySide; hind: GaitSymmetrySide } | null;
  paws: GaitPawRow[];

  weightKg: number;
  normalization: { scale: number; targetPeak: number; percentile: number; deltaPeak: number };
  preprocessing: GaitScreening["preprocessing"];
  /** Absolute-unit clinical metrics (speed, lengths, COP, double support, flags). */
  clinical: ClinicalMetrics;
  summaryText: string;
  /** ISO timestamp the analysis was produced. */
  analyzedAt: string;
}

export class GaitAnalysisError extends Error {}

/** Build the engine config for this mat + dog weight + gait tuning block. */
export function buildEngineConfig(
  gait: GaitConfig,
  weightKg: number,
  sampleHz: number,
): Partial<PawGaitConfig> {
  return {
    ...configForWeightKg(weightKg),
    rows: gait.rows,
    cols: gait.cols,
    sampleHz,
    // 40x40 geometry overrides (engine defaults assume a denser 72x80 grid).
    minPawArea: gait.min_paw_area,
    maxTrackDistance: gait.max_track_distance,
    morphologyKernelSize: gait.morphology_kernel,
    minCyclesBeforeClassify: gait.min_cycles_before_classify,
  };
}

/**
 * Convert recorded raw frames to engine-ready, normalised delta frames.
 *
 * Returns the flat delta frames (mutated in place to the engine scale), the
 * timestamps, and the normalisation metadata used.
 */
export function framesToEngineInput(
  frames: readonly RecordedFrame[],
  baseline: Matrix,
  config: AppConfig,
): {
  flat: Float32Array[];
  timestamps: number[];
  normalization: GaitSummary["normalization"];
} {
  const gait = config.gait;
  const cells = GRID_ROWS * GRID_COLS;
  const flat: Float32Array[] = [];
  const timestamps: number[] = [];
  const positives: number[] = [];

  for (const f of frames) {
    // Orient identically to the live view so engine "left/right" matches screen.
    const oriented = applyOrientation(f.raw, config.orientation, GRID_ROWS, GRID_COLS).matrix;
    const delta = new Float32Array(cells);
    for (let i = 0; i < cells; i++) {
      const d = baseline[i] - oriented[i];
      if (d > 0) {
        delta[i] = d;
        if (d > 1) positives.push(d);
      }
    }
    flat.push(delta);
    timestamps.push(f.t);
  }

  // Adaptive scale: map a high percentile of positive delta onto targetPeak so
  // the engine's magnitude thresholds (tuned around ~200) stay meaningful.
  const targetPeak = gait.normalize_target_peak;
  const pct = gait.normalize_percentile;
  let deltaPeak = 0;
  if (positives.length > 0) {
    positives.sort((a, b) => a - b);
    const idx = Math.min(
      positives.length - 1,
      Math.max(0, Math.round((pct / 100) * (positives.length - 1))),
    );
    deltaPeak = positives[idx];
  }

  let scale: number;
  if (gait.pressure_scale != null && gait.pressure_scale > 0) {
    scale = gait.pressure_scale; // explicit override
  } else if (deltaPeak > 1e-6) {
    scale = targetPeak / deltaPeak; // adaptive
  } else {
    scale = 1; // no signal — leave as-is (engine will report INVALID)
  }

  if (scale !== 1) {
    for (const frame of flat) {
      for (let i = 0; i < frame.length; i++) frame[i] *= scale;
    }
  }

  return {
    flat,
    timestamps,
    normalization: { scale, targetPeak, percentile: pct, deltaPeak },
  };
}

/** Run the full engine on a recorded session and produce a panel-ready summary. */
export function analyzeRecordedSession(
  frames: readonly RecordedFrame[],
  baseline: Matrix,
  config: AppConfig,
  weightKg: number,
): GaitSummary {
  if (frames.length < 2) {
    throw new GaitAnalysisError(
      "분석할 프레임이 부족합니다. 먼저 Record 로 보행을 녹화하세요.",
    );
  }

  const w = Number.isFinite(weightKg) && weightKg > 0 ? weightKg : WEIGHT_REF_KG;
  const { flat, timestamps, normalization } = framesToEngineInput(frames, baseline, config);

  // Estimate fps from the recorded timestamps (ms).
  const span = timestamps[timestamps.length - 1] - timestamps[0];
  const fps = span > 0 ? ((flat.length - 1) / span) * 1000 : config.gait.rows > 0 ? 38 : 38;

  const engine = new PawGaitEngine(buildEngineConfig(config.gait, w, fps));
  const session: SessionResult = engine.processFlatSession(flat, timestamps, fps);
  return summarize(session, w, normalization, engine.getCoPSamples(), engine.config);
}

function emptyLoad(): Record<PawLabel, number> {
  return { LF: 0, RF: 0, LH: 0, RH: 0 };
}

function summarize(
  session: SessionResult,
  weightKg: number,
  normalization: GaitSummary["normalization"],
  cop: ReadonlyArray<{ frame: number; col: number; row: number; weight: number }>,
  cfg: PawGaitConfig,
): GaitSummary {
  const s = session.screening;
  const legacy = session.legacy;
  const vt = s.validTrial;
  const loadDist = legacy?.loadDist ?? { forePct: 0, hindPct: 0, leftPct: 0, rightPct: 0 };

  const clinical = computeClinicalMetrics({
    steps: s.steps,
    features: s.features,
    loadDist,
    cop,
    durationSec: s.durationSec,
    fps: s.fps,
    colPitchCm: COL_PITCH_CM,
    rowPitchCm: ROW_PITCH_CM,
    symmetryWarnPct: cfg.symmetryWarnPct,
    symmetryAbnormalPct: cfg.symmetryAbnormalPct,
  });

  const loadPct = emptyLoad();
  if (legacy) {
    for (const p of PAW_ORDER) loadPct[p] = legacy.loadPct[p] ?? 0;
  }

  const featByLabel = new Map(s.features.map((f) => [f.label, f]));
  const detected = new Set(vt.detectedPaws);
  const paws: GaitPawRow[] = PAW_ORDER.map((label) => {
    const f = featByLabel.get(label);
    return {
      label,
      detected: detected.has(label),
      loadPct: loadPct[label],
      peakPressure: f?.peakPressure ?? 0,
      pressureImpulse: f?.pressureImpulse ?? 0,
      contactArea: f?.contactArea ?? 0,
      contactTimeSec: f?.contactTimeSec ?? 0,
      totalPressureIndex: f?.totalPressureIndex ?? 0,
      pawPathLength: f?.pawPathLength ?? 0,
      stepCount: f?.stepCount ?? 0,
    };
  });

  return {
    ok: vt.validity !== "INVALID",
    validity: vt.validity,
    reasons: [...vt.reasons],
    recommendation: vt.recommendation,
    detectedPaws: [...vt.detectedPaws],
    missingPaws: [...vt.missingPaws],

    direction: s.direction.direction,
    directionConfidence: s.direction.confidence,

    frameCount: s.frameCount,
    durationSec: s.durationSec,
    fps: s.fps,
    effectiveHz: s.effectiveHz,
    samplesPerStance: s.samplesPerStance,
    samplingNote: s.samplingNote,

    cadenceHz: s.motion?.cadenceHz ?? null,
    velocity: s.motion?.velocity ?? null,
    stepLength: s.motion?.stepLength ?? null,
    strideLength: s.motion?.strideLength ?? null,

    loadPct,
    loadDist,
    symmetry: s.symmetry
      ? {
          fore: { ...s.symmetry.fore },
          hind: { ...s.symmetry.hind },
        }
      : null,
    paws,

    weightKg,
    normalization,
    preprocessing: s.preprocessing,
    clinical,
    summaryText: s.summary,
    analyzedAt: new Date().toISOString(),
  };
}
