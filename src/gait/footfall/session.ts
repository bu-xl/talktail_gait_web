import type { FrameResult, PawGaitConfig, PawLabel, PawTrack } from "../types.js";
import {
  assignBodyFrameLabels,
  enforceGlobalConsistency,
  scoreLabeling,
} from "./assign.js";
import { applyBodyFrame, fitTravelModel } from "./bodyModel.js";
import { confirmFootfallLabels, seedProvisionalFootfallLabels } from "./coldStart.js";
import { FF_PROVISIONAL_CONFIDENCE_MAX } from "./constants.js";
import { buildFootfallsFromSession } from "./extract.js";
import { COL_PITCH_CM, ROW_PITCH_CM, distCm } from "./geometry.js";
import type { FootfallEvent, FootfallLabelingResult } from "./types.js";

function contactKey(trackId: number, eventIdx: number): string {
  return `${trackId}:${eventIdx}`;
}

/** Match footfalls to engine track contact events by frame overlap + position. */
export function mapFootfallsToContacts(
  footfalls: readonly FootfallEvent[],
  tracks: readonly PawTrack[],
  labels: Map<number, PawLabel>,
): Map<string, PawLabel> {
  const out = new Map<string, PawLabel>();
  for (const track of tracks) {
    for (let ei = 0; ei < track.contactEvents.length; ei++) {
      const ev = track.contactEvents[ei]!;
      const lab = matchFootfallToContact(footfalls, labels, track, ev.startFrame, ev.endFrame);
      if (lab) out.set(contactKey(track.trackId, ei), lab);
    }
  }
  return out;
}

function matchFootfallToContact(
  footfalls: readonly FootfallEvent[],
  labels: Map<number, PawLabel>,
  track: PawTrack,
  start: number,
  end: number,
): PawLabel | null {
  let best: { id: number; score: number } | null = null;
  for (const f of footfalls) {
    if (f.frameLo < start - 2 || f.frameTd > end + 2) continue;
    const overlap = Math.min(f.frameLo, end) - Math.max(f.frameTd, start);
    if (overlap < 0) continue;
    const lab = labels.get(f.id);
    if (!lab) continue;
    let trackCx = 0;
    let trackCy = 0;
    let w = 0;
    for (let i = 0; i < track.frameIndices.length; i++) {
      const fi = track.frameIndices[i]!;
      if (fi < start || fi > end) continue;
      const cp = track.centroidHistory[i];
      const p = track.pressureHistory[i] ?? 0;
      if (!cp || p <= 0) continue;
      trackCx += cp.col;
      trackCy += cp.row;
      w++;
    }
    if (w > 0) {
      trackCx /= w;
      trackCy /= w;
    }
    const d = distCm(f.posCm.x, f.posCm.y, trackCx * COL_PITCH_CM, trackCy * ROW_PITCH_CM);
    const score = overlap * 10 - d;
    if (!best || score > best.score) best = { id: f.id, score };
  }
  return best ? labels.get(best.id) ?? null : null;
}

/**
 * Full body-frame footfall labeling pipeline (Steps 1–5).
 * Labels are frozen per footfall — never recomputed per frame.
 */
export function labelSessionFootfalls(
  frames: readonly FrameResult[],
  timestampsMs: readonly number[],
  hz: number,
  cfg: PawGaitConfig,
  tracks: readonly PawTrack[] = [],
): FootfallLabelingResult {
  const { footfalls: raw, scale } = buildFootfallsFromSession(frames, tracks, timestampsMs, hz);
  const { travel, passQuality } = fitTravelModel(raw);

  // §9 — immediate provisional labels (never leave footfalls unlabeled).
  seedProvisionalFootfallLabels(raw, travel);
  applyBodyFrame(raw, travel);

  if (!passQuality.isTraverse) {
    for (const f of raw) f.flags.nonTraverse = true;
  }

  let labels = new Map(raw.map((f) => [f.id, f.limb]));

  if (raw.length >= 2) {
    labels = assignBodyFrameLabels(raw, scale, travel);
    labels = enforceGlobalConsistency(raw, labels);
    for (const f of raw) {
      const lab = labels.get(f.id);
      if (lab) {
        f.limb = lab;
        f.flags.provisional = false;
      }
    }
    confirmFootfallLabels(raw, FF_PROVISIONAL_CONFIDENCE_MAX);
  }

  scoreLabeling(raw, labels);

  const perContactLabels = new Map<string, PawLabel>();

  return {
    footfalls: raw,
    perContactLabels,
    scale,
    travel,
    passQuality,
  };
}

export function labelSessionFootfallsWithTracks(
  frames: readonly FrameResult[],
  timestampsMs: readonly number[],
  hz: number,
  tracks: readonly PawTrack[],
  cfg: PawGaitConfig,
): FootfallLabelingResult {
  const result = labelSessionFootfalls(frames, timestampsMs, hz, cfg, tracks);
  const labelMap = new Map(result.footfalls.map((f) => [f.id, f.limb]));
  result.perContactLabels = mapFootfallsToContacts(result.footfalls, tracks, labelMap);
  return result;
}

/** Apply frozen footfall labels to PawTrack (track + per-contact arrays). */
export function applyFootfallLabelingToTracks(
  tracks: readonly PawTrack[],
  result: FootfallLabelingResult,
  cfg: PawGaitConfig,
): Map<number, PawLabel> {
  const trackLabels = new Map<number, PawLabel>();
  const contactLabels =
    result.perContactLabels.size > 0
      ? result.perContactLabels
      : mapFootfallsToContacts(
          result.footfalls,
          tracks,
          new Map(result.footfalls.map((f) => [f.id, f.limb])),
        );

  for (const track of tracks) {
    track.contactEventLabels.length = track.contactEvents.length;
    const votes = new Map<PawLabel, number>();
    for (let ei = 0; ei < track.contactEvents.length; ei++) {
      const lab = contactLabels.get(contactKey(track.trackId, ei));
      track.contactEventLabels[ei] = lab ?? null;
      if (lab) votes.set(lab, (votes.get(lab) ?? 0) + 1);
    }
    let best: PawLabel | null = null;
    let bestW = -1;
    for (const [lab, w] of votes) {
      if (w > bestW) {
        bestW = w;
        best = lab;
      }
    }
    if (best) {
      track.label = best;
      const conf = Math.min(0.98, 0.5 + result.passQuality.progressionR2 * 0.4 + bestW * 0.05);
      track.labelConfidence = conf;
      track.flagsProvisional = conf < FF_PROVISIONAL_CONFIDENCE_MAX;
      if (conf >= cfg.labelLockConfidence) track.lockedLabel = best;
      trackLabels.set(track.trackId, best);
    }
  }
  return trackLabels;
}

/** Label for a track at a specific frame — frozen contact label or provisional live label. */
export function trackLabelAtFrame(track: PawTrack, frameIndex: number): PawLabel | null {
  for (let ei = 0; ei < track.contactEvents.length; ei++) {
    const ev = track.contactEvents[ei]!;
    if (frameIndex >= ev.startFrame && frameIndex <= ev.endFrame) {
      return track.contactEventLabels[ei] ?? null;
    }
  }
  if (track.pendingContactStart !== null && frameIndex >= track.pendingContactStart) {
    if (track.lockedLabel) return track.lockedLabel;
    if (track.label !== "Unknown") return track.label;
  }
  return track.lockedLabel;
}
