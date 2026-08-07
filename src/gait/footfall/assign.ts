import type { PawLabel } from "../types.js";
import { FF_DUPLICATE_LIMB_PENALTY, FF_SEP_RATIO_TIME_WEIGHT } from "./constants.js";
import type { FootfallEvent, ScaleEstimate, TravelModel } from "./types.js";

const WALK_CYCLE: readonly PawLabel[] = ["LH", "LF", "RH", "RF"];

function kMeans1D(values: number[], k: 2): [number, number] {
  if (values.length === 0) return [0, 0];
  const sorted = [...values].sort((a, b) => a - b);
  let c0 = sorted[0]!;
  let c1 = sorted[sorted.length - 1]!;
  for (let iter = 0; iter < 12; iter++) {
    const g0: number[] = [];
    const g1: number[] = [];
    for (const v of values) {
      if (Math.abs(v - c0) <= Math.abs(v - c1)) g0.push(v);
      else g1.push(v);
    }
    if (g0.length) c0 = g0.reduce((a, b) => a + b, 0) / g0.length;
    if (g1.length) c1 = g1.reduce((a, b) => a + b, 0) / g1.length;
  }
  return c0 <= c1 ? [c0, c1] : [c1, c0];
}

function kMeans2D(
  points: { rLong: number; rLat: number }[],
  k = 4,
): { centers: { rLong: number; rLat: number }[]; assign: number[] } {
  if (points.length === 0) return { centers: [], assign: [] };
  const centers: { rLong: number; rLat: number }[] = [];
  const n = Math.min(k, points.length);
  for (let i = 0; i < n; i++) {
    const p = points[Math.floor((i * points.length) / n)]!;
    centers.push({ rLong: p.rLong, rLat: p.rLat });
  }
  const assign = new Array(points.length).fill(0);
  for (let iter = 0; iter < 24; iter++) {
    for (let i = 0; i < points.length; i++) {
      const p = points[i]!;
      let best = 0;
      let bestD = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const cc = centers[c]!;
        const d = (p.rLong - cc.rLong) ** 2 + (p.rLat - cc.rLat) ** 2;
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      }
      assign[i] = best;
    }
    for (let c = 0; c < centers.length; c++) {
      let sx = 0;
      let sy = 0;
      let cnt = 0;
      for (let i = 0; i < points.length; i++) {
        if (assign[i] !== c) continue;
        sx += points[i]!.rLong;
        sy += points[i]!.rLat;
        cnt++;
      }
      if (cnt > 0) centers[c] = { rLong: sx / cnt, rLat: sy / cnt };
    }
  }
  return { centers, assign };
}

function quadrantLabel(rLong: number, rLat: number): PawLabel {
  const isFront = rLong >= 0;
  const isLeft = rLat <= 0;
  if (isFront && isLeft) return "LF";
  if (isFront && !isLeft) return "RF";
  if (!isFront && isLeft) return "LH";
  return "RH";
}

/** Walk-cycle label for global footfall index, constrained to lateral side. */
function walkLabelForIndex(globalIdx: number, isLeft: boolean): PawLabel {
  const template = WALK_CYCLE[globalIdx % WALK_CYCLE.length]!;
  const templateLeft = template === "LH" || template === "LF";
  if (templateLeft === isLeft) return template;
  if (isLeft) return template === "RH" ? "LH" : "LF";
  return template === "LH" ? "RH" : "RF";
}

function spatialFH(footfalls: FootfallEvent[]): Map<number, "F" | "H"> {
  const out = new Map<number, "F" | "H">();
  const [c0, c1] = kMeans1D(
    footfalls.map((f) => f.rLong),
    2,
  );
  const th = (c0 + c1) / 2;
  for (const f of footfalls) {
    out.set(f.id, f.rLong >= th ? "F" : "H");
  }
  return out;
}

function spatialClusterLabels(footfalls: FootfallEvent[]): Map<number, PawLabel> {
  const points = footfalls.map((f) => ({ rLong: f.rLong, rLat: f.rLat }));
  const { centers, assign } = kMeans2D(points, Math.min(4, footfalls.length));
  const out = new Map<number, PawLabel>();
  if (centers.length < 4) {
    const centerLabels = centers.map((c) => quadrantLabel(c.rLong, c.rLat));
    for (let i = 0; i < footfalls.length; i++) {
      const ci = assign[i] ?? 0;
      const p = points[i]!;
      out.set(footfalls[i]!.id, centerLabels[ci] ?? quadrantLabel(p.rLong, p.rLat));
    }
    return out;
  }

  const centerLimb = mapFourCentersToLimbs(centers);
  for (let i = 0; i < footfalls.length; i++) {
    const ci = assign[i] ?? 0;
    out.set(footfalls[i]!.id, centerLimb[ci] ?? quadrantLabel(points[i]!.rLong, points[i]!.rLat));
  }
  return out;
}

/** Cranial pair → LF/RF, caudal pair → LH/RH (body-frame lanes, bug B safe). */
function mapFourCentersToLimbs(centers: { rLong: number; rLat: number }[]): PawLabel[] {
  const ranked = centers.map((c, i) => ({ i, c })).sort((a, b) => b.c.rLong - a.c.rLong || a.c.rLat - b.c.rLat);
  const fore = ranked.slice(0, 2).sort((a, b) => a.c.rLat - b.c.rLat);
  const hind = ranked.slice(2, 4).sort((a, b) => a.c.rLat - b.c.rLat);
  const out: PawLabel[] = new Array(centers.length);
  out[fore[0]!.i] = "LF";
  out[fore[1]!.i] = "RF";
  out[hind[0]!.i] = "LH";
  out[hind[1]!.i] = "RH";
  return out;
}

/**
 * Step 4 — body-frame labels, frozen per footfall.
 * L/R from r_lat; F/H from 4-lane cluster or walk-sequence / entry phase.
 */
export function assignBodyFrameLabels(
  footfalls: FootfallEvent[],
  scale: ScaleEstimate,
  _travel: TravelModel,
): Map<number, PawLabel> {
  const labels = new Map<number, PawLabel>();
  if (footfalls.length === 0) return labels;

  if (isHindOnlySession(footfalls)) {
    for (const f of footfalls) {
      const lab: PawLabel = f.rLat <= 0 ? "LH" : "RH";
      labels.set(f.id, lab);
      f.limb = lab;
      f.flags.provisional = false;
      f.confidence = 0.72;
    }
    return labels;
  }

  const sorted = [...footfalls].sort((a, b) => a.tTouchdown - b.tTouchdown);
  const timeWeight = scale.belowFhResolution
    ? FF_SEP_RATIO_TIME_WEIGHT
    : Math.max(0.25, 1 - scale.sepRatio / 2.5);
  const spatialWeight = 1 - timeWeight * 0.65;

  const spatialMap = footfalls.length >= 4 ? spatialClusterLabels(footfalls) : new Map();
  const fhSpatial = spatialFH(footfalls);

  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i]!;
    const isLeft = f.rLat <= 0;
    const seqLab = walkLabelForIndex(i, isLeft);

    let lab: PawLabel;
    if (footfalls.length >= 4 && spatialMap.has(f.id)) {
      const clusterLab = spatialMap.get(f.id)!;
      const seqFh = seqLab === "LF" || seqLab === "RF" ? "F" : "H";
      const clFh = clusterLab === "LF" || clusterLab === "RF" ? "F" : "H";
      if (seqFh === clFh) lab = clusterLab;
      else lab = timeWeight >= spatialWeight ? seqLab : clusterLab;
    } else if (timeWeight >= spatialWeight) {
      lab = seqLab;
    } else {
      const fh = fhSpatial.get(f.id) ?? "F";
      lab = isLeft ? (fh === "F" ? "LF" : "LH") : fh === "F" ? "RF" : "RH";
      if (timeWeight > 0.35) {
        const seqFh = seqLab.endsWith("F") || seqLab === "LF" || seqLab === "RF" ? "F" : "H";
        const spFh = fh;
        const pick = timeWeight > 0.55 ? seqFh : spFh;
        lab = isLeft ? (pick === "F" ? "LF" : "LH") : pick === "F" ? "RF" : "RH";
      }
    }

    labels.set(f.id, lab);
    f.limb = lab;
    f.flags.provisional = false;
    const margin = Math.abs(f.rLong) + Math.abs(f.rLat);
    f.confidence = Math.max(0.25, Math.min(1, 0.4 + margin * 0.025 + (timeWeight > 0.5 ? 0.15 : 0)));
    if (scale.belowFhResolution) {
      f.flags.belowFhResolution = true;
      f.confidence *= 0.75;
    }
    if (scale.narrowStance) {
      f.flags.narrowStance = true;
      f.confidence *= 0.85;
    }
    if (f.flags.edgeClip) f.confidence *= 0.7;
  }

  return labels;
}

export function enforceGlobalConsistency(
  footfalls: FootfallEvent[],
  labels: Map<number, PawLabel>,
): Map<number, PawLabel> {
  const out = new Map(labels);
  const sorted = [...footfalls].sort((a, b) => a.frameTd - b.frameTd);

  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!;
    const la = out.get(a.id);
    if (!la) continue;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]!;
      if (b.frameTd > a.frameLo + 2) break;
      const lb = out.get(b.id);
      if (lb !== la) continue;
      const scoreA = a.peakForce * a.confidence;
      const scoreB = b.peakForce * b.confidence;
      const loser = scoreA >= scoreB ? b : a;
      const winner = scoreA >= scoreB ? a : b;
      const alt = alternateLimb(la, winner.rLat <= 0);
      out.set(loser.id, alt);
      loser.limb = alt;
      loser.flags.correctedByGlobal = true;
      loser.confidence *= 0.8;
    }
  }

  const byLimb = new Map<PawLabel, FootfallEvent[]>();
  for (const f of sorted) {
    const lab = out.get(f.id);
    if (!lab) continue;
    const arr = byLimb.get(lab) ?? [];
    arr.push(f);
    byLimb.set(lab, arr);
  }
  for (const arr of byLimb.values()) {
    let lastY = -Infinity;
    for (const f of arr) {
      if (f.posCm.y < lastY - 0.5) {
        f.flags.correctedByGlobal = true;
        f.confidence *= 0.7;
      }
      lastY = Math.max(lastY, f.posCm.y);
    }
  }

  correctHindOnlyForeMislabels(sorted, out);

  return out;
}

/**
 * Bug B — when only hind paws remain, spatial F/H must not flip them to fore.
 * If a footfall's cluster lane is hind but label is fore, and no fore partner
 * is contemporaneous, swap to the hind limb on the same lateral side.
 */
function correctHindOnlyForeMislabels(
  sorted: FootfallEvent[],
  out: Map<number, PawLabel>,
): void {
  if (sorted.length < 2) return;
  const [c0, c1] = kMeans1D(
    sorted.map((f) => f.rLong),
    2,
  );
  const th = (c0 + c1) / 2;

  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i]!;
    const lab = out.get(f.id);
    if (!lab || lab === "LH" || lab === "RH") continue;

    const peers = sorted.filter(
      (o) =>
        o.id !== f.id &&
        o.frameTd <= f.frameLo + 1 &&
        o.frameLo >= f.frameTd - 1,
    );
    if (peers.length === 0) continue;

    const window = [f, ...peers];
    const allCaudal = window.every((p) => p.rLong < th);
    if (!allCaudal) continue;

    for (const p of window) {
      const pl = out.get(p.id);
      if (pl !== "LF" && pl !== "RF") continue;
      const hindLab: PawLabel = p.rLat <= 0 ? "LH" : "RH";
      out.set(p.id, hindLab);
      p.limb = hindLab;
      p.flags.correctedByGlobal = true;
      p.confidence *= 0.85;
    }
  }
}

function alternateLimb(limb: PawLabel, isLeft: boolean): PawLabel {
  switch (limb) {
    case "LF":
      return isLeft ? "LH" : "RF";
    case "RF":
      return isLeft ? "LF" : "RH";
    case "LH":
      return isLeft ? "LF" : "RH";
    case "RH":
      return isLeft ? "LH" : "RF";
  }
}

/**
 * Bug B — session begins with hind paws only (fore missed / already passed).
 * Spatial r_long splits two hind rows into false F/H; use lateral → LH/RH only.
 */
function isHindOnlySession(footfalls: readonly FootfallEvent[]): boolean {
  if (footfalls.length < 2) return false;
  const sorted = [...footfalls].sort((a, b) => a.frameTd - b.frameTd);
  const first = sorted[0]!;
  const minY = Math.min(...footfalls.map((f) => f.posCm.y));
  const maxY = Math.max(...footfalls.map((f) => f.posCm.y));
  const rowSpread = maxY - minY;
  const noForeLane = !footfalls.some((f) => f.limb === "LF" || f.limb === "RF");
  const lateEntry = first.frameTd > 12;
  const caudalOnMat = minY > 50;
  const spreadLooksStanceNotFh = rowSpread < 35;
  return lateEntry && caudalOnMat && spreadLooksStanceNotFh && footfalls.length <= 4;
}

export function scoreLabeling(
  footfalls: FootfallEvent[],
  labels: Map<number, PawLabel>,
): number {
  let score = 0.4;
  const present = new Set(labels.values());
  score += present.size * 0.1;
  const limbCounts = new Map<PawLabel, number>();
  for (const lab of labels.values()) {
    limbCounts.set(lab, (limbCounts.get(lab) ?? 0) + 1);
  }
  for (const c of limbCounts.values()) {
    if (c > 1) score -= FF_DUPLICATE_LIMB_PENALTY * 0.01 * (c - 1);
  }
  return Math.max(0, Math.min(1, score));
}
