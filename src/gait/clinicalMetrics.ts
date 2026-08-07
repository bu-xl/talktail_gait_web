/**
 * Clinical gait metrics — absolute-unit, research/clinic-oriented measures derived
 * from the engine's footfall records + COP trajectory. Pure and dependency-free of
 * the app core: physical cell pitch (cm) is passed in, so this stays inside the
 * `gait` layer.
 *
 * Travel axis is the product-fixed walk direction (+column); lateral is the row
 * axis. All distances convert grid cells → cm with the (non-square) cell pitch.
 *
 * IMPORTANT (honest limits): on a small 40×40 mat there are few steps per limb, so
 * absolute speed/length and especially the abnormal-gait flags are SCREENING
 * signals, not diagnoses. Flags must never be presented as clinical conclusions.
 */

import type { PawLabel, PawTrialFeatures, StepRecord } from "./types.js";
import { symmetryIndex } from "./gaitFeatures.js";

export interface CoPSample {
  readonly frame: number;
  readonly col: number;
  readonly row: number;
  readonly weight: number;
}

export interface CopStability {
  /** total CoP path length over the trial (cm) */
  readonly pathLengthCm: number;
  /** 95% confidence ellipse area of the CoP cloud (cm²) */
  readonly areaCm2: number;
  /** mean CoP speed (cm/s) */
  readonly meanVelCmS: number;
}

export interface SymmetrySet {
  /** symmetry index (%) — 0 = perfect, higher = more asymmetric */
  readonly contactTime: number | null;
  readonly peak: number | null;
  readonly impulse: number | null;
  readonly area: number | null;
  readonly stride: number | null;
}

export type FlagSeverity = "info" | "warn" | "high";
export interface GaitFlag {
  readonly type: string;
  readonly severity: FlagSeverity;
  readonly detail: string;
}

export interface ClinicalMetrics {
  speedMs: number | null;
  speedKmh: number | null;
  strideLengthCm: number | null;
  stepLengthCm: number | null;
  stepWidthCm: number | null;
  cadenceStepsMin: number | null;
  doubleSupportSec: number | null;
  doubleSupportPct: number | null;
  cop: CopStability | null;
  symmetry: { fore: SymmetrySet | null; hind: SymmetrySet | null };
  pawSequence: PawLabel[];
  sequenceRegular: boolean | null;
  flags: GaitFlag[];
  units: { colPitchCm: number; rowPitchCm: number };
}

export interface ClinicalInput {
  steps: readonly StepRecord[];
  features: readonly PawTrialFeatures[];
  loadDist: { forePct: number; hindPct: number; leftPct: number; rightPct: number };
  cop: readonly CoPSample[];
  durationSec: number;
  fps: number;
  colPitchCm: number;
  rowPitchCm: number;
  symmetryWarnPct: number;
  symmetryAbnormalPct: number;
}

const PAWS: readonly PawLabel[] = ["LF", "RF", "LH", "RH"];

const median = (xs: number[]): number => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const std = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
};
const stepCenter = (s: StepRecord): { col: number; row: number } => ({
  col: (s.bbox.minCol + s.bbox.maxCol) / 2,
  row: (s.bbox.minRow + s.bbox.maxRow) / 2,
});

/** Per-label steps, sorted by onset, label-known only. */
function stepsByLabel(steps: readonly StepRecord[]): Map<PawLabel, StepRecord[]> {
  const m = new Map<PawLabel, StepRecord[]>();
  for (const s of [...steps].sort((a, b) => a.startFrame - b.startFrame)) {
    if (s.label === "Unknown") continue;
    const arr = m.get(s.label as PawLabel);
    if (arr) arr.push(s);
    else m.set(s.label as PawLabel, [s]);
  }
  return m;
}

/** Weighted slope of col vs time (cols/sec) for the body-speed estimate. */
function copColSlope(cop: readonly CoPSample[], fps: number): number | null {
  if (cop.length < 4 || fps <= 0) return null;
  let sw = 0, st = 0, sc = 0;
  for (const s of cop) {
    const w = s.weight > 0 ? s.weight : 0;
    sw += w; st += w * (s.frame / fps); sc += w * s.col;
  }
  if (sw <= 0) return null;
  const tBar = st / sw, cBar = sc / sw;
  let stt = 0, stc = 0;
  for (const s of cop) {
    const w = s.weight > 0 ? s.weight : 0;
    const dt = s.frame / fps - tBar;
    stt += w * dt * dt; stc += w * dt * (s.col - cBar);
  }
  if (stt < 1e-9) return null;
  return stc / stt;
}

function copStability(cop: readonly CoPSample[], colPitch: number, rowPitch: number, durationSec: number): CopStability | null {
  if (cop.length < 3) return null;
  let pathLen = 0;
  for (let i = 1; i < cop.length; i++) {
    const dCol = (cop[i]!.col - cop[i - 1]!.col) * colPitch;
    const dRow = (cop[i]!.row - cop[i - 1]!.row) * rowPitch;
    pathLen += Math.hypot(dCol, dRow);
  }
  const xs = cop.map((s) => s.col * colPitch);
  const ys = cop.map((s) => s.row * rowPitch);
  const area = Math.PI * (1.96 * std(xs)) * (1.96 * std(ys));
  return {
    pathLengthCm: pathLen,
    areaCm2: area,
    meanVelCmS: durationSec > 0 ? pathLen / durationSec : 0,
  };
}

/** Frames where ≥2 / ≥1 paws are in contact (difference-array sweep). */
function doubleSupport(steps: readonly StepRecord[], fps: number): { sec: number; pct: number } | null {
  if (steps.length === 0 || fps <= 0) return null;
  let maxF = 0;
  for (const s of steps) maxF = Math.max(maxF, s.endFrame);
  const diff = new Int32Array(maxF + 2);
  for (const s of steps) {
    diff[Math.max(0, s.startFrame)] += 1;
    diff[Math.min(maxF + 1, s.endFrame + 1)] -= 1;
  }
  let cur = 0, anyF = 0, dsF = 0;
  for (let f = 0; f <= maxF; f++) {
    cur += diff[f]!;
    if (cur >= 1) anyF++;
    if (cur >= 2) dsF++;
  }
  if (anyF === 0) return null;
  return { sec: dsF / fps, pct: (dsF / anyF) * 100 };
}

function siOrNull(a: number | undefined, b: number | undefined): number | null {
  if (a == null || b == null || (a === 0 && b === 0)) return null;
  return symmetryIndex(a, b);
}

function girdleSymmetry(
  left: PawTrialFeatures | undefined,
  right: PawTrialFeatures | undefined,
  strideLeft: number | undefined,
  strideRight: number | undefined,
): SymmetrySet | null {
  if (!left || !right) return null;
  return {
    contactTime: siOrNull(left.contactTimeSec, right.contactTimeSec),
    peak: siOrNull(left.peakPressure, right.peakPressure),
    impulse: siOrNull(left.pressureImpulse, right.pressureImpulse),
    area: siOrNull(left.contactArea, right.contactArea),
    stride: siOrNull(strideLeft, strideRight),
  };
}

export function computeClinicalMetrics(input: ClinicalInput): ClinicalMetrics {
  const { steps, features, cop, durationSec, fps, colPitchCm, rowPitchCm } = input;
  const byLabel = stepsByLabel(steps);
  const featByLabel = new Map(features.map((f) => [f.label, f]));
  const flags: GaitFlag[] = [];

  // --- stride length (cm) per label: median |Δcol| between same-paw strikes ---
  const strideColByLabel = new Map<PawLabel, number>();
  for (const [label, ss] of byLabel) {
    if (ss.length < 2) continue;
    const ds: number[] = [];
    for (let i = 1; i < ss.length; i++) ds.push(Math.abs(stepCenter(ss[i]!).col - stepCenter(ss[i - 1]!).col));
    const m = median(ds);
    if (Number.isFinite(m)) strideColByLabel.set(label, m);
  }
  const strideCols = [...strideColByLabel.values()];
  const strideLengthCm = strideCols.length ? mean(strideCols) * colPitchCm : null;

  // --- step length (cm): median |Δcol| between successive footfalls (any paw) ---
  const ordered = [...steps].filter((s) => s.label !== "Unknown").sort((a, b) => a.startFrame - b.startFrame);
  let stepLengthCm: number | null = null;
  if (ordered.length >= 2) {
    const ds: number[] = [];
    for (let i = 1; i < ordered.length; i++) ds.push(Math.abs(stepCenter(ordered[i]!).col - stepCenter(ordered[i - 1]!).col));
    const m = median(ds);
    stepLengthCm = Number.isFinite(m) ? m * colPitchCm : null;
  }

  // --- step width (cm): lateral (row) gap between L/R of each girdle ---
  const rowMean = (label: PawLabel): number | null => {
    const ss = byLabel.get(label);
    if (!ss || ss.length === 0) return null;
    return mean(ss.map((s) => stepCenter(s).row));
  };
  const widths: number[] = [];
  const foreW = rowMean("LF") != null && rowMean("RF") != null ? Math.abs(rowMean("LF")! - rowMean("RF")!) : null;
  const hindW = rowMean("LH") != null && rowMean("RH") != null ? Math.abs(rowMean("LH")! - rowMean("RH")!) : null;
  if (foreW != null) widths.push(foreW);
  if (hindW != null) widths.push(hindW);
  const stepWidthCm = widths.length ? mean(widths) * rowPitchCm : null;

  // --- stride time (s) per label: median Δt between same-paw strikes ---
  const strideTimes: number[] = [];
  for (const ss of byLabel.values()) {
    if (ss.length < 2) continue;
    const dts: number[] = [];
    for (let i = 1; i < ss.length; i++) dts.push((ss[i]!.startFrame - ss[i - 1]!.startFrame) / fps);
    const m = median(dts);
    if (Number.isFinite(m) && m > 0) strideTimes.push(m);
  }
  const strideTimeSec = strideTimes.length ? median(strideTimes) : null;

  // --- speed: COP regression primary, stride/stride-time fallback ---
  let speedCmS: number | null = null;
  const slope = copColSlope(cop, fps);
  if (slope != null) speedCmS = Math.abs(slope) * colPitchCm;
  else if (strideLengthCm != null && strideTimeSec) speedCmS = strideLengthCm / strideTimeSec;
  const speedMs = speedCmS != null ? speedCmS / 100 : null;
  const speedKmh = speedMs != null ? speedMs * 3.6 : null;

  // --- cadence (footfalls/min) ---
  const cadenceStepsMin = durationSec > 0 ? (ordered.length / durationSec) * 60 : null;

  // --- double support ---
  const ds = doubleSupport(ordered, fps);

  // --- COP stability ---
  const copS = copStability(cop, colPitchCm, rowPitchCm, durationSec);

  // --- expanded symmetry per girdle ---
  const symmetry = {
    fore: girdleSymmetry(featByLabel.get("LF"), featByLabel.get("RF"), strideColByLabel.get("LF"), strideColByLabel.get("RF")),
    hind: girdleSymmetry(featByLabel.get("LH"), featByLabel.get("RH"), strideColByLabel.get("LH"), strideColByLabel.get("RH")),
  };

  // --- paw sequence (first contact order) + regularity ---
  const seqSeen = new Set<PawLabel>();
  const pawSequence: PawLabel[] = [];
  for (const s of ordered) {
    const l = s.label as PawLabel;
    if (!seqSeen.has(l)) { seqSeen.add(l); pawSequence.push(l); }
    if (pawSequence.length === 4) break;
  }
  // regular if the next full cycle repeats the same order
  let sequenceRegular: boolean | null = null;
  if (pawSequence.length === 4) {
    const labelsOnly = ordered.map((s) => s.label as PawLabel);
    if (labelsOnly.length >= 8) {
      sequenceRegular = true;
      for (let i = 0; i < 4; i++) if (labelsOnly[4 + i] !== pawSequence[i]) { sequenceRegular = false; break; }
    }
  }

  // --- screening flags (NOT diagnostic) ---
  const warn = input.symmetryWarnPct, abn = input.symmetryAbnormalPct;
  const sev = (si: number): FlagSeverity => (si >= abn ? "high" : si >= warn ? "warn" : "info");

  const nPaws = byLabel.size;
  if (nPaws < 4) flags.push({ type: "foot_miss", severity: "high", detail: `검출된 발 ${nPaws}/4 — 일부 발 미검출(재측정 권장)` });

  const lrSI = siOrNull(input.loadDist.leftPct, input.loadDist.rightPct);
  if (lrSI != null && lrSI >= warn) flags.push({ type: "lr_load_asymmetry", severity: sev(lrSI), detail: `좌우 하중 비대칭 ${lrSI.toFixed(0)}%` });

  for (const [g, set] of [["전지", symmetry.fore], ["후지", symmetry.hind]] as const) {
    if (!set) continue;
    for (const [k, name] of [["peak", "최대압력"], ["impulse", "충격량"], ["contactTime", "접촉시간"]] as const) {
      const v = set[k as keyof SymmetrySet];
      if (v != null && v >= abn) flags.push({ type: `${g}_${k}_asym`, severity: "high", detail: `${g} 좌우 ${name} 비대칭 ${v.toFixed(0)}% (파행 신호 가능)` });
    }
  }

  if (strideTimes.length >= 2) {
    const cv = (std(strideTimes) / Math.max(1e-9, mean(strideTimes))) * 100;
    if (cv >= 25) flags.push({ type: "irregular_rhythm", severity: cv >= 40 ? "high" : "warn", detail: `보폭 주기 변동 큼 (CV ${cv.toFixed(0)}%) — 불규칙 보행 신호` });
  }
  if (sequenceRegular === false) flags.push({ type: "irregular_sequence", severity: "warn", detail: "발 착지 순서가 주기마다 다름" });

  return {
    speedMs, speedKmh, strideLengthCm, stepLengthCm, stepWidthCm, cadenceStepsMin,
    doubleSupportSec: ds?.sec ?? null,
    doubleSupportPct: ds?.pct ?? null,
    cop: copS,
    symmetry,
    pawSequence,
    sequenceRegular,
    flags,
    units: { colPitchCm, rowPitchCm },
  };
}
