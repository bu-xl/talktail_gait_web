import type {
  LegacyGaitFoot,
  LegacyGaitResult,
  PawLabel,
  PawTrack,
  SessionContactEvent,
} from "./types.js";
import { frameToMs } from "./config.js";

const PAW_LABELS: readonly PawLabel[] = ["LF", "RF", "LH", "RH"];

function resolveLabel(track: PawTrack): PawLabel | null {
  const label = track.lockedLabel ?? track.label;
  if (label === "Unknown") return null;
  return label;
}

function symPct(a: number, b: number): number {
  if (a + b <= 0) return 100;
  return (1 - Math.abs(a - b) / (a + b)) * 100;
}

function peakInRange(track: PawTrack, start: number, end: number): number {
  let peak = 0;
  for (let i = 0; i < track.frameIndices.length; i++) {
    const fi = track.frameIndices[i]!;
    if (fi < start || fi > end) continue;
    const p = track.pressureHistory[i] ?? 0;
    if (p > peak) peak = p;
  }
  return peak;
}

function impulseInRange(
  track: PawTrack,
  start: number,
  end: number,
  fps: number,
): number {
  const dtSec = fps > 0 ? 1 / fps : 1 / 38;
  let sum = 0;
  for (let i = 0; i < track.frameIndices.length; i++) {
    const fi = track.frameIndices[i]!;
    if (fi < start || fi > end) continue;
    sum += (track.pressureHistory[i] ?? 0) * dtSec;
  }
  return sum;
}

function avgAreaInRange(track: PawTrack, start: number, end: number): number {
  let sum = 0;
  let n = 0;
  for (const b of track.history) {
    const fi = track.lastFrameIndex;
    if (fi < start || fi > end) continue;
    sum += b.area;
    n++;
  }
  if (n > 0) return sum / n;
  let areaSum = 0;
  let areaN = 0;
  for (const b of track.history) {
    areaSum += b.area;
    areaN++;
  }
  return areaN > 0 ? areaSum / areaN : 0;
}

export function buildFootLoadSeries(
  tracks: readonly PawTrack[],
  frameCount: number,
): Record<PawLabel, Float32Array> {
  const out: Record<PawLabel, Float32Array> = {
    LF: new Float32Array(frameCount),
    RF: new Float32Array(frameCount),
    LH: new Float32Array(frameCount),
    RH: new Float32Array(frameCount),
  };

  for (const track of tracks) {
    const label = resolveLabel(track);
    if (!label) continue;
    for (let i = 0; i < track.frameIndices.length; i++) {
      const fi = track.frameIndices[i]!;
      if (fi < 0 || fi >= frameCount) continue;
      const series = out[label];
      series[fi] = (series[fi] ?? 0) + (track.pressureHistory[i] ?? 0);
    }
  }
  return out;
}

export function buildSessionEvents(
  tracks: readonly PawTrack[],
  fps: number,
): SessionContactEvent[] {
  const events: SessionContactEvent[] = [];
  for (const track of tracks) {
    const label = resolveLabel(track);
    if (!label) continue;
    for (const e of track.contactEvents) {
      const duration_s = fps > 0 ? (e.endFrame - e.startFrame) / fps : 0;
      events.push({
        pawType: label,
        startFrame: e.startFrame,
        endFrame: e.endFrame,
        duration_s,
        peakForce: peakInRange(track, e.startFrame, e.endFrame),
        impulse: impulseInRange(track, e.startFrame, e.endFrame, fps),
        avgArea: avgAreaInRange(track, e.startFrame, e.endFrame),
      });
    }
  }
  events.sort((a, b) => a.startFrame - b.startFrame);
  return events;
}

export function buildLegacyGaitResult(
  tracks: readonly PawTrack[],
  frameCount: number,
  fps: number,
  durationMs: number,
  timestampsMs: readonly number[],
): LegacyGaitResult {
  const loadSeries = buildFootLoadSeries(tracks, frameCount);
  const events = buildSessionEvents(tracks, fps);

  const impulse: Record<PawLabel, number> = { LF: 0, RF: 0, LH: 0, RH: 0 };
  const peakForce: Record<PawLabel, number> = { LF: 0, RF: 0, LH: 0, RH: 0 };
  const contactArea: Record<PawLabel, number> = { LF: 0, RF: 0, LH: 0, RH: 0 };

  for (const label of PAW_LABELS) {
    const ls = loadSeries[label];
    let peak = 0;
    let sum = 0;
    for (let i = 0; i < ls.length; i++) {
      sum += ls[i]!;
      if (ls[i]! > peak) peak = ls[i]!;
    }
    impulse[label] = sum;
    peakForce[label] = peak;
  }

  for (const track of tracks) {
    const label = resolveLabel(track);
    if (!label) continue;
    let areaSum = 0;
    for (const b of track.history) areaSum += b.area;
    if (track.history.length > 0) {
      contactArea[label] = Math.max(contactArea[label], areaSum / track.history.length);
    }
  }

  const totalImpulse = PAW_LABELS.reduce((s, p) => s + impulse[p], 0);
  const loadPct: Record<PawLabel, number> = { LF: 0, RF: 0, LH: 0, RH: 0 };
  for (const p of PAW_LABELS) {
    loadPct[p] = totalImpulse > 0 ? (impulse[p] / totalImpulse) * 100 : 0;
  }

  const loadDist = {
    forePct: loadPct.LF + loadPct.RF,
    hindPct: loadPct.LH + loadPct.RH,
    leftPct: loadPct.LF + loadPct.LH,
    rightPct: loadPct.RF + loadPct.RH,
  };

  const symmetry = {
    fore: symPct(loadPct.LF, loadPct.RF),
    hind: symPct(loadPct.LH, loadPct.RH),
    left: symPct(loadPct.LF + loadPct.LH, loadPct.RF + loadPct.RH),
    diagonal: symPct(loadPct.LF + loadPct.RH, loadPct.RF + loadPct.LH),
  };

  const feet: Record<PawLabel, LegacyGaitFoot> = {} as Record<PawLabel, LegacyGaitFoot>;
  for (const id of PAW_LABELS) {
    const ls = loadSeries[id];
    let sum = 0;
    let maxL = 0;
    for (let i = 0; i < ls.length; i++) {
      sum += ls[i]!;
      if (ls[i]! > maxL) maxL = ls[i]!;
    }
    const stancePhases = events
      .filter((e) => e.pawType === id)
      .map((e) => ({
        start: e.startFrame,
        end: e.endFrame,
        duration_ms:
          timestampsMs[e.endFrame] != null && timestampsMs[e.startFrame] != null
            ? timestampsMs[e.endFrame]! - timestampsMs[e.startFrame]!
            : frameToMs(e.endFrame - e.startFrame, fps),
      }));

    feet[id] = {
      avgLoad: ls.length > 0 ? sum / ls.length : 0,
      maxLoad: maxL,
      peakP: peakForce[id],
      avgArea: contactArea[id],
      loadPct: loadPct[id],
      loadSeries: ls,
      stancePhases,
    };
  }

  let cadence: number | null = null;
  if (durationMs > 0 && events.length >= 2) {
    cadence = (events.length / (durationMs / 1000)) * 60;
  }

  const classifiedCount = tracks.filter((t) => resolveLabel(t) !== null).length;

  return {
    nFrames: frameCount,
    fps,
    duration_ms: durationMs,
    feet,
    loadDist,
    loadPct,
    symmetry,
    peakForce,
    contactArea,
    cadence,
    events,
    engine: "paw-gait-v2",
    classificationReady: classifiedCount >= 2,
  };
}

export function legacyToViewerResult(
  legacy: LegacyGaitResult,
  timestampsMs: readonly number[],
): Record<string, unknown> {
  const globalR = new Float32Array(legacy.nFrames);
  const globalC = new Float32Array(legacy.nFrames);

  return {
    nFrames: legacy.nFrames,
    fps: legacy.fps,
    duration_ms: legacy.duration_ms,
    feet: legacy.feet,
    loadDist: legacy.loadDist,
    loadPct: legacy.loadPct,
    symmetry: legacy.symmetry,
    peakForce: legacy.peakForce,
    contactArea: legacy.contactArea,
    cadence: legacy.cadence,
    events: legacy.events,
    globalCoP: { r: globalR, c: globalC, rangeR: 0, rangeC: 0 },
    engine: legacy.engine,
    classificationReady: legacy.classificationReady,
    pattern: { type: "normal", confidence: legacy.classificationReady ? 0.85 : 0.4 },
    score: legacy.classificationReady
      ? { total: 75, grade: "B", label: "양호" }
      : { total: 50, grade: "C", label: "분류 미완" },
    issues: [],
    normalRef: null,
    metrics: {
      impulse: legacy.loadPct,
      peakForce: legacy.peakForce,
      contactArea: legacy.contactArea,
      cadence: legacy.cadence,
    },
    lameness: {
      fore: { peakForce: { SI: 100 - legacy.symmetry.fore } },
      hind: { peakForce: { SI: 100 - legacy.symmetry.hind } },
    },
    _timestamps: timestampsMs,
  };
}
