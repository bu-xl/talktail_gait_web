/**
 * Structured JSON export of a gait analysis — a single machine-readable record
 * (also the seed format for future ML datasets). Pure: takes a GaitSummary,
 * returns pretty-printed JSON text.
 */

import type { GaitSummary } from "../core/gaitAnalysis.js";

const r = (x: number | null | undefined, d = 2): number | null =>
  x == null || !Number.isFinite(x) ? null : Number(x.toFixed(d));

export function gaitSummaryToJson(s: GaitSummary): string {
  const c = s.clinical;
  const doc = {
    schema: "gait-analysis/v1",
    analyzedAt: s.analyzedAt,
    weightKg: s.weightKg,
    validity: s.validity,
    ok: s.ok,
    reasons: s.reasons,
    recommendation: s.recommendation,
    detectedPaws: s.detectedPaws,
    missingPaws: s.missingPaws,
    direction: { value: s.direction, confidence: r(s.directionConfidence) },
    capture: {
      frameCount: s.frameCount,
      durationSec: r(s.durationSec),
      fps: r(s.fps, 1),
      effectiveHz: r(s.effectiveHz, 1),
      samplesPerStance: s.samplesPerStance,
      samplingNote: s.samplingNote,
    },
    motionAbsolute: {
      speedMs: r(c.speedMs),
      speedKmh: r(c.speedKmh),
      strideLengthCm: r(c.strideLengthCm, 1),
      stepLengthCm: r(c.stepLengthCm, 1),
      stepWidthCm: r(c.stepWidthCm, 1),
      cadenceStepsMin: r(c.cadenceStepsMin, 0),
    },
    temporal: {
      cadenceHz: r(s.cadenceHz),
      doubleSupportSec: r(c.doubleSupportSec),
      doubleSupportPct: r(c.doubleSupportPct, 1),
    },
    cop: c.cop
      ? { pathLengthCm: r(c.cop.pathLengthCm, 1), areaCm2: r(c.cop.areaCm2, 1), meanVelCmS: r(c.cop.meanVelCmS, 1) }
      : null,
    load: {
      perPawPct: s.loadPct,
      distribution: s.loadDist,
    },
    symmetryIndexPct: c.symmetry,
    pawSequence: { order: c.pawSequence, regular: c.sequenceRegular },
    perPaw: s.paws.map((p) => ({
      label: p.label,
      detected: p.detected,
      loadPct: r(p.loadPct, 1),
      peakPressure: r(p.peakPressure, 1),
      pressureImpulse: r(p.pressureImpulse, 1),
      contactAreaCm2: r(p.contactArea, 2),
      contactTimeSec: r(p.contactTimeSec, 3),
      stepCount: p.stepCount,
    })),
    screeningFlags: c.flags,
    units: { ...c.units, note: "lengths in cm; speed m/s & km/h; SI in %" },
    disclaimer:
      "Screening signals only — not a diagnosis. Fore/Hind labels and small-mat metrics are estimates.",
  };
  return JSON.stringify(doc, null, 2);
}
