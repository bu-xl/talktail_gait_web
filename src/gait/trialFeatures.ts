import type {
  GaitScreening,
  MetricStat,
  MultiTrialSummary,
  PawGaitConfig,
  PawLabel,
  PawTrialFeatures,
  PawTrialSummary,
  StepRecord,
} from "./types.js";
import { frameDtSec, stepsByLabel } from "./stepRecords.js";

const PAW_LABELS: readonly PawLabel[] = ["LF", "RF", "LH", "RH"];

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

function sum(values: readonly number[]): number {
  let s = 0;
  for (const v of values) s += v;
  return s;
}

/** population mean/SD/CV */
export function metricStat(values: readonly number[]): MetricStat {
  const n = values.length;
  if (n === 0) return { mean: 0, sd: 0, cv: 0, n: 0 };
  const m = mean(values);
  let varSum = 0;
  for (const v of values) varSum += (v - m) * (v - m);
  const sd = Math.sqrt(varSum / n);
  const cv = m > 1e-9 ? (sd / m) * 100 : 0;
  return { mean: m, sd, cv, n };
}

function featuresForLabel(
  label: PawLabel,
  steps: readonly StepRecord[],
  dt: number,
): PawTrialFeatures {
  const durations = steps.map((s) => s.durationSec);
  const peaks = steps.map((s) => s.peakPressure);
  const impulses = steps.map((s) => s.pressureImpulse);
  const areas = steps.map((s) => s.meanArea);
  const paths = steps.map((s) => s.copPathLength);

  const starts = steps.map((s) => s.startFrame).sort((a, b) => a - b);
  const stepTimingSec: number[] = [];
  for (let i = 1; i < starts.length; i++) {
    stepTimingSec.push((starts[i]! - starts[i - 1]!) * dt);
  }

  return {
    label,
    contactTimeSec: mean(durations),
    stanceTimeSec: sum(durations),
    peakPressure: mean(peaks),
    pressureImpulse: mean(impulses),
    contactArea: mean(areas),
    totalPressureIndex: sum(impulses),
    pawPathLength: mean(paths),
    stepCount: steps.length,
    stepTimingSec,
  };
}

/**
 * Phase 7 — Feature Extraction. VALID Trial 에서만 호출한다.
 * 라벨이 확정된 발에 대해서만 발별 feature 를 계산한다.
 */
export function extractTrialFeatures(
  steps: readonly StepRecord[],
  hz: number,
  timestampsMs: readonly number[],
): PawTrialFeatures[] {
  const dt = frameDtSec(timestampsMs, hz);
  const byLabel = stepsByLabel(steps);
  const out: PawTrialFeatures[] = [];
  for (const label of PAW_LABELS) {
    const arr = byLabel.get(label);
    if (arr && arr.length > 0) out.push(featuresForLabel(label, arr, dt));
  }
  return out;
}

function pawSummary(label: PawLabel, trials: readonly PawTrialFeatures[]): PawTrialSummary {
  return {
    label,
    peakPressure: metricStat(trials.map((t) => t.peakPressure)),
    pressureImpulse: metricStat(trials.map((t) => t.pressureImpulse)),
    contactTimeSec: metricStat(trials.map((t) => t.contactTimeSec)),
    contactArea: metricStat(trials.map((t) => t.contactArea)),
  };
}

/**
 * 다회 trial 집계 — VALID trial 들의 발별 feature 를 모아 평균/표준편차/CV 산출.
 * 1회 측정으로 확정하지 않으며, VALID 가 부족하거나 CV 가 높으면 재측정을 권장한다.
 */
export function summarizeTrials(
  screenings: readonly GaitScreening[],
  cfg: PawGaitConfig,
): MultiTrialSummary {
  const valid = screenings.filter((s) => s.validTrial.validity === "VALID");

  const perLabel = new Map<PawLabel, PawTrialFeatures[]>();
  for (const s of valid) {
    for (const f of s.features) {
      const arr = perLabel.get(f.label);
      if (arr) arr.push(f);
      else perLabel.set(f.label, [f]);
    }
  }

  const paws: PawTrialSummary[] = [];
  let highVariability = false;
  for (const label of PAW_LABELS) {
    const arr = perLabel.get(label);
    if (!arr || arr.length === 0) continue;
    const summary = pawSummary(label, arr);
    paws.push(summary);
    const cvs = [
      summary.peakPressure.cv,
      summary.pressureImpulse.cv,
      summary.contactTimeSec.cv,
      summary.contactArea.cv,
    ];
    if (cvs.some((cv) => cv > cfg.cvWarnPct)) highVariability = true;
  }

  let recommendation: string | null = null;
  if (valid.length < cfg.minValidTrials) {
    recommendation = `VALID trial ${valid.length}/${cfg.minValidTrials} — 추가 측정 권장`;
  } else if (highVariability) {
    recommendation = "변동계수(CV) 높음 — 재측정 권장";
  }

  return {
    trialCount: screenings.length,
    validTrialCount: valid.length,
    paws,
    highVariability,
    recommendation,
  };
}
