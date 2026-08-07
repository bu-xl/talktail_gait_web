import type { PawTrack } from "../types.js";
import { FF_K_MIN_STANCE_FRAMES } from "./constants.js";
import {
  COL_PITCH_CM,
  ROW_PITCH_CM,
  bboxAreaCm2,
  colRowToCm,
  distCm,
} from "./geometry.js";
import { estimateScale, mergeToeFragments } from "./scale.js";
import type { FootfallEvent, FrameBlob, ScaleEstimate } from "./types.js";
import type { FrameResult } from "../types.js";

interface ActiveFootfall {
  id: number;
  blobs: FrameBlob[];
  lastFrame: number;
  wx: number;
  wy: number;
  wSum: number;
  peak: number;
  force: number;
  area: number;
  edge: boolean;
}

function contactCentroidCm(
  track: PawTrack,
  start: number,
  end: number,
): { x: number; y: number } | null {
  let wx = 0;
  let wy = 0;
  let wSum = 0;
  for (let i = 0; i < track.frameIndices.length; i++) {
    const fi = track.frameIndices[i]!;
    if (fi < start || fi > end) continue;
    const p = track.pressureHistory[i] ?? 0;
    const cp = track.centroidHistory[i];
    if (!cp || p <= 0) continue;
    wx += cp.col * p;
    wy += cp.row * p;
    wSum += p;
  }
  if (wSum <= 0) return null;
  return colRowToCm(wx / wSum, wy / wSum);
}

/** Build footfall events from engine tracks (preferred — uses full stance history). */
export function extractFootfallsFromTracks(
  tracks: readonly PawTrack[],
  timestampsMs: readonly number[],
  hz: number,
  scale: ScaleEstimate,
): FootfallEvent[] {
  const out: FootfallEvent[] = [];
  let id = 0;
  for (const track of tracks) {
    for (let ei = 0; ei < track.contactEvents.length; ei++) {
      const ev = track.contactEvents[ei]!;
      const nFrames = ev.endFrame - ev.startFrame + 1;
      if (nFrames < FF_K_MIN_STANCE_FRAMES) continue;

      const pos = contactCentroidCm(track, ev.startFrame, ev.endFrame);
      if (!pos) continue;

      let peak = 0;
      let force = 0;
      let area = 0;
      let edge = false;
      for (let i = 0; i < track.frameIndices.length; i++) {
        const fi = track.frameIndices[i]!;
        if (fi < ev.startFrame || fi > ev.endFrame) continue;
        const p = track.pressureHistory[i] ?? 0;
        const b = track.history[i];
        if (p > peak) peak = p;
        force += p;
        if (b) {
          area = Math.max(area, bboxAreaCm2(b.bbox));
          if (
            b.bbox.minRow <= 0 ||
            b.bbox.maxRow >= 39 ||
            b.bbox.minCol <= 0 ||
            b.bbox.maxCol >= 39
          ) {
            edge = true;
          }
        }
      }
      if (peak < scale.minPeakForce) continue;

      const t0 = timestampsMs[ev.startFrame];
      const t1 = timestampsMs[ev.endFrame];
      const td =
        Number.isFinite(t0) && t0 != null ? t0 / 1000 : ev.startFrame / Math.max(hz, 1);
      const tl =
        Number.isFinite(t1) && t1 != null ? t1 / 1000 : ev.endFrame / Math.max(hz, 1);
      const dt = Math.max(1 / Math.max(hz, 1), tl - td);

      out.push({
        id: id++,
        limb: "LF",
        frameTd: ev.startFrame,
        frameLo: ev.endFrame,
        tTouchdown: td,
        tLiftoff: tl,
        posCm: pos,
        rLong: 0,
        rLat: 0,
        peakForce: peak,
        meanForce: force / Math.max(nFrames, 1),
        pti: force * dt,
        contactAreaCm2: area,
        nFrames,
        confidence: 0,
        flags: {
          edgeClip: edge,
          merged: false,
          correctedByGlobal: false,
          nonTraverse: false,
          belowFhResolution: scale.belowFhResolution,
          narrowStance: scale.narrowStance,
          directionConflict: false,
          provisional: false,
          weak: false,
        },
        memberBlobIds: [track.trackId * 1000 + ei],
      });
    }
  }
  out.sort((a, b) => a.frameTd - b.frameTd || a.id - b.id);
  return out;
}

function frameBlobsFromResult(
  fr: FrameResult,
  timeSec: number,
  noiseFloor: number,
  nextId: { v: number },
): FrameBlob[] {
  const out: FrameBlob[] = [];
  for (const blob of fr.blobs) {
    if (blob.peakPressure < noiseFloor) continue;
    if (blob.area < 3) continue;
    const c = colRowToCm(blob.copX, blob.copY);
    out.push({
      frameIdx: fr.frameIndex,
      timeSec,
      cxCm: c.x,
      cyCm: c.y,
      peakForce: blob.peakPressure,
      totalForce: blob.pressureSum,
      areaCm2: bboxAreaCm2(blob.bbox),
      bbox: blob.bbox,
      edgeClip:
        blob.bbox.minRow <= 0 ||
        blob.bbox.maxRow >= 39 ||
        blob.bbox.minCol <= 0 ||
        blob.bbox.maxCol >= 39,
      blobId: nextId.v++,
    });
  }
  return out;
}

export function extractFrameBlobs(
  frames: readonly FrameResult[],
  timestampsMs: readonly number[],
  hz: number,
  noiseFloor = 150,
): FrameBlob[] {
  const nextId = { v: 0 };
  const all: FrameBlob[] = [];
  for (const fr of frames) {
    const tMs = timestampsMs[fr.frameIndex];
    const timeSec =
      Number.isFinite(tMs) && tMs != null
        ? tMs / 1000
        : fr.frameIndex / Math.max(hz, 1);
    all.push(...frameBlobsFromResult(fr, timeSec, noiseFloor, nextId));
  }
  return all;
}

function closeFootfall(act: ActiveFootfall, scale: ScaleEstimate): FootfallEvent | null {
  const n = act.blobs.length;
  const nFrames = act.lastFrame - act.blobs[0]!.frameIdx + 1;
  if (n < 1 || act.peak < scale.minPeakForce) return null;

  const pos = act.wSum > 0 ? { x: act.wx / act.wSum, y: act.wy / act.wSum } : { x: 0, y: 0 };
  const t0 = act.blobs[0]!.timeSec;
  const t1 = act.blobs[act.blobs.length - 1]!.timeSec;
  const dt = Math.max(1 / 40, t1 - t0 || 1 / 40);

  return {
    id: act.id,
    limb: "LF",
    frameTd: act.blobs[0]!.frameIdx,
    frameLo: act.lastFrame,
    tTouchdown: t0,
    tLiftoff: t1,
    posCm: pos,
    rLong: 0,
    rLat: 0,
    peakForce: act.peak,
    meanForce: act.force / n,
    pti: act.force * dt,
    contactAreaCm2: act.area,
    nFrames,
    confidence: 0,
    flags: {
      edgeClip: act.edge,
      merged: n > 1,
      correctedByGlobal: false,
      nonTraverse: false,
      belowFhResolution: scale.belowFhResolution,
      narrowStance: scale.narrowStance,
      directionConflict: false,
      provisional: false,
      weak: false,
    },
    memberBlobIds: act.blobs.map((b) => b.blobId),
  };
}

export function extractFootfallEvents(
  frameBlobs: readonly FrameBlob[],
  scale: ScaleEstimate,
  minStanceFrames = FF_K_MIN_STANCE_FRAMES,
  maxGapFrames = 2,
): FootfallEvent[] {
  const byFrame = new Map<number, FrameBlob[]>();
  for (const b of frameBlobs) {
    const arr = byFrame.get(b.frameIdx) ?? [];
    arr.push(b);
    byFrame.set(b.frameIdx, arr);
  }

  const mergedFrames: FrameBlob[] = [];
  for (const [fi, blobs] of [...byFrame.entries()].sort((a, b) => a[0] - b[0])) {
    const grouped = mergeToeFragments(blobs, scale.toeGroupRadiusCm);
    for (const g of grouped) {
      if (g.areaCm2 < scale.minContactAreaCm2 * 0.25 && g.peakForce < scale.minPeakForce) continue;
      mergedFrames.push({ ...g, frameIdx: fi });
    }
  }

  const active: ActiveFootfall[] = [];
  const closed: FootfallEvent[] = [];
  let nextFfId = 0;

  const frameIndices = [...new Set(mergedFrames.map((b) => b.frameIdx))].sort((a, b) => a - b);
  const blobsByFrame = new Map<number, FrameBlob[]>();
  for (const b of mergedFrames) {
    const arr = blobsByFrame.get(b.frameIdx) ?? [];
    arr.push(b);
    blobsByFrame.set(b.frameIdx, arr);
  }

  for (const fi of frameIndices) {
    const blobs = blobsByFrame.get(fi) ?? [];
    const matched = new Set<number>();

    for (const blob of blobs) {
      let bestIdx = -1;
      let bestD = Infinity;
      for (let ai = 0; ai < active.length; ai++) {
        if (matched.has(ai)) continue;
        const act = active[ai]!;
        if (fi - act.lastFrame > maxGapFrames) continue;
        const c = act.wSum > 0 ? { x: act.wx / act.wSum, y: act.wy / act.wSum } : { x: 0, y: 0 };
        const d = distCm(c.x, c.y, blob.cxCm, blob.cyCm);
        if (d < scale.rLinkCm && d < bestD) {
          bestD = d;
          bestIdx = ai;
        }
      }
      if (bestIdx >= 0) {
        matched.add(bestIdx);
        const act = active[bestIdx]!;
        act.blobs.push(blob);
        act.lastFrame = fi;
        const w = blob.totalForce;
        act.wx += blob.cxCm * w;
        act.wy += blob.cyCm * w;
        act.wSum += w;
        act.peak = Math.max(act.peak, blob.peakForce);
        act.force += blob.totalForce;
        act.area = Math.max(act.area, blob.areaCm2);
        act.edge = act.edge || blob.edgeClip;
      } else {
        active.push({
          id: nextFfId++,
          blobs: [blob],
          lastFrame: fi,
          wx: blob.cxCm * blob.totalForce,
          wy: blob.cyCm * blob.totalForce,
          wSum: blob.totalForce,
          peak: blob.peakForce,
          force: blob.totalForce,
          area: blob.areaCm2,
          edge: blob.edgeClip,
        });
      }
    }

    const still: ActiveFootfall[] = [];
    for (const act of active) {
      if (fi - act.lastFrame > maxGapFrames) {
        const ev = closeFootfall(act, scale);
        if (ev && ev.nFrames >= minStanceFrames) closed.push(ev);
      } else {
        still.push(act);
      }
    }
    active.length = 0;
    active.push(...still);
  }

  for (const act of active) {
    const ev = closeFootfall(act, scale);
    if (ev && ev.nFrames >= minStanceFrames) closed.push(ev);
  }

  closed.sort((a, b) => a.frameTd - b.frameTd || a.id - b.id);
  return closed;
}

export function buildFootfallsFromSession(
  frames: readonly FrameResult[],
  tracks: readonly PawTrack[],
  timestampsMs: readonly number[],
  hz: number,
): { footfalls: FootfallEvent[]; scale: ScaleEstimate; frameBlobs: FrameBlob[] } {
  const frameBlobs = extractFrameBlobs(frames, timestampsMs, hz);
  const scale = estimateScale(frameBlobs.length > 0 ? frameBlobs : footfallBlobsFromTracks(tracks));
  const fromTracks = extractFootfallsFromTracks(tracks, timestampsMs, hz, scale);
  const footfalls =
    fromTracks.length >= 2
      ? fromTracks
      : extractFootfallEvents(frameBlobs, scale);
  return { footfalls, scale, frameBlobs };
}

function footfallBlobsFromTracks(tracks: readonly PawTrack[]): FrameBlob[] {
  const out: FrameBlob[] = [];
  let id = 0;
  for (const t of tracks) {
    for (const b of t.history) {
      const c = colRowToCm(b.copX, b.copY);
      out.push({
        frameIdx: 0,
        timeSec: 0,
        cxCm: c.x,
        cyCm: c.y,
        peakForce: b.peakPressure,
        totalForce: b.pressureSum,
        areaCm2: bboxAreaCm2(b.bbox),
        bbox: b.bbox,
        edgeClip: false,
        blobId: id++,
      });
    }
  }
  return out;
}

/** @deprecated use buildFootfallsFromSession */
export function buildFootfallsFromFrames(
  frames: readonly FrameResult[],
  timestampsMs: readonly number[],
  hz: number,
): { footfalls: FootfallEvent[]; scale: ScaleEstimate; frameBlobs: FrameBlob[] } {
  return buildFootfallsFromSession(frames, [], timestampsMs, hz);
}
