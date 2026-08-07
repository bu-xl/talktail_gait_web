import type { PawLabel, PawTrack } from "../types.js";
import {
  FF_ENTRY_FRONT_PRIOR_COUNT,
  FF_PROVISIONAL_CONFIDENCE_MAX,
} from "./constants.js";
import { colRowToCm, lateralCm, longitudinalCm } from "./geometry.js";
import type { FootfallEvent, TravelModel } from "./types.js";

const WALK_CYCLE: readonly PawLabel[] = ["LH", "LF", "RH", "RF"];

export interface ProvisionalLabel {
  label: PawLabel;
  confidence: number;
  provisional: boolean;
}

/** L/R from lateral (col) — immediate, highest reliability at cold start. */
export function isLeftLateral(lateralCmVal: number, lateralCenter: number): boolean {
  return lateralCmVal <= lateralCenter;
}

function limbFromSides(isLeft: boolean, isFront: boolean): PawLabel {
  if (isFront) return isLeft ? "LF" : "RF";
  return isLeft ? "LH" : "RH";
}

/**
 * §9.2 — Provisional label from entry order + fixed TOP→BOTTOM direction.
 * Never returns Unknown; confidence < FF_PROVISIONAL_CONFIDENCE_MAX until confirmed.
 */
export function provisionalLabelForEntry(
  posCm: { x: number; y: number },
  entryIndex: number,
  lateralCenter: number,
  bodyCenterY: number | null,
): ProvisionalLabel {
  const isLeft = isLeftLateral(posCm.x, lateralCenter);

  let isFront: boolean;
  if (bodyCenterY != null && entryIndex >= 2) {
    isFront = posCm.y <= bodyCenterY;
  } else {
    isFront = entryIndex < FF_ENTRY_FRONT_PRIOR_COUNT;
  }

  const walkLab = WALK_CYCLE[entryIndex % WALK_CYCLE.length]!;
  const walkLeft = walkLab === "LH" || walkLab === "LF";
  const walkFront = walkLab === "LF" || walkLab === "RF";

  if (entryIndex < 4) {
    const blendFront = isFront || walkFront;
    const blendLeft = isLeft || walkLeft;
    return {
      label: limbFromSides(blendLeft, blendFront),
      confidence: 0.38 + entryIndex * 0.04,
      provisional: true,
    };
  }

  return {
    label: limbFromSides(isLeft, isFront),
    confidence: FF_PROVISIONAL_CONFIDENCE_MAX - 0.05,
    provisional: true,
  };
}

/** Seed provisional labels on footfalls before global pass (§9). */
export function seedProvisionalFootfallLabels(
  footfalls: FootfallEvent[],
  travel: TravelModel,
): void {
  if (!footfalls.length) return;
  const sorted = [...footfalls].sort((a, b) => a.frameTd - b.frameTd || a.tTouchdown - b.tTouchdown);
  const lateralCenter = travel.lateralCenter;

  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i]!;
    const bodyCenterY =
      i >= 2 ? sorted.slice(0, i).reduce((s, x) => s + x.posCm.y, 0) / i : null;
    const prov = provisionalLabelForEntry(f.posCm, i, lateralCenter, bodyCenterY);
    f.limb = prov.label;
    f.confidence = prov.confidence;
    f.flags.provisional = prov.provisional;
  }
}

/** Live cold-start: assign provisional labels to active contacts (never Unknown). */
export function applyProvisionalLiveLabels(
  tracks: readonly PawTrack[],
  frameIndex: number,
): void {
  const active = tracks.filter((t) => t.active && t.contact && t.lastBlob);
  if (!active.length) return;

  const lateralCenter = robustLateralCenter(active);
  const entries = active
    .map((t) => ({
      track: t,
      start: t.pendingContactStart ?? t.lastFrameIndex,
      pos: colRowToCm(t.lastBlob!.copX, t.lastBlob!.copY),
    }))
    .sort((a, b) => a.start - b.start || a.pos.y - b.pos.y);

  const globalOffset = countCompletedContacts(tracks);

  for (let i = 0; i < entries.length; i++) {
    const { track, pos } = entries[i]!;
    if (track.lockedLabel) {
      track.label = track.lockedLabel;
      continue;
    }
    const frozen = frozenContactLabel(track, frameIndex);
    if (frozen) {
      track.label = frozen;
      track.labelConfidence = Math.max(track.labelConfidence, 0.65);
      continue;
    }

    const entryIndex = globalOffset + i;
    const bodyCenterY =
      entries.length >= 2
        ? entries.slice(0, i).reduce((s, e) => s + e.pos.y, 0) / Math.max(i, 1)
        : null;
    const prov = provisionalLabelForEntry(pos, entryIndex, lateralCenter, bodyCenterY);
    track.label = prov.label;
    track.labelConfidence = prov.confidence;
    track.flagsProvisional = prov.provisional;
  }
}

function robustLateralCenter(active: readonly PawTrack[]): number {
  const xs = active.map((t) => lateralCm(t.lastBlob!.copX));
  xs.sort((a, b) => a - b);
  const m = xs.length >> 1;
  return xs.length % 2 ? xs[m]! : (xs[m - 1]! + xs[m]!) / 2;
}

function countCompletedContacts(tracks: readonly PawTrack[]): number {
  let n = 0;
  for (const t of tracks) n += t.contactEvents.length;
  return n;
}

function frozenContactLabel(track: PawTrack, frameIndex: number): PawLabel | null {
  for (let ei = 0; ei < track.contactEvents.length; ei++) {
    const ev = track.contactEvents[ei]!;
    if (frameIndex >= ev.startFrame && frameIndex <= ev.endFrame) {
      return track.contactEventLabels[ei] ?? null;
    }
  }
  return null;
}

/** Promote confirmed labels — clear provisional flag. */
export function confirmFootfallLabels(footfalls: FootfallEvent[], minConfidence: number): number {
  let corrections = 0;
  for (const f of footfalls) {
    if (f.flags.provisional && f.confidence >= minConfidence) {
      f.flags.provisional = false;
    }
    if (f.flags.provisional && f.confidence >= 0.7) corrections++;
  }
  return corrections;
}
