/**
 * Body-frame footfall labeling — public API (replaces frame-local F/H assignment).
 *
 * Design principles (see footfall/ module):
 *   - Labels are assigned ONCE per footfall event and frozen.
 *   - F/H uses body-frame coordinates, never "most forward visible paw this frame".
 *   - Bug A (RF ahead of LF) and Bug B (hind-only phase) are structurally prevented.
 */
import type { FrameResult, PawGaitConfig, PawLabel, PawTrack, Vector2 } from "./types.js";
import {
  applyFootfallLabelingToTracks,
  labelSessionFootfallsWithTracks,
} from "./footfall/session.js";
import type { FootfallLabelingResult } from "./footfall/types.js";

export type { FootfallEvent, FootfallLabelingResult } from "./footfall/types.js";
export { labelSessionFootfalls, trackLabelAtFrame } from "./footfall/session.js";

/**
 * Session labeling from frame results + tracks.
 * Returns trackId → limb for compatibility with legacy callers.
 */
export function labelTracksFromFootfallSequence(
  tracks: readonly PawTrack[],
  _bodyDirection: Vector2 | null,
  _bodyPerpendicular: Vector2 | null,
  cfg: PawGaitConfig,
  frames: readonly FrameResult[],
  timestampsMs: readonly number[],
  hz: number,
): Map<number, PawLabel> {
  if (frames.length < 2 || tracks.length === 0) return new Map();

  const result = labelSessionFootfallsWithTracks(frames, timestampsMs, hz, tracks, cfg);
  if (result.footfalls.length < 1) return new Map();

  const trackLabels = applyFootfallLabelingToTracks(tracks, result, cfg);
  if (trackLabels.size < 1 && result.footfalls.length < 2) return trackLabels;
  if (trackLabels.size < 2 && result.footfalls.length >= 2) return new Map();
  return trackLabels;
}

/** @deprecated use applyFootfallLabelingToTracks via labelTracksFromFootfallSequence */
export function applyFootfallLabels(
  tracks: readonly PawTrack[],
  labels: Map<number, PawLabel>,
  coherence: number,
  cfg: PawGaitConfig,
): void {
  for (const track of tracks) {
    const label = labels.get(track.trackId);
    if (!label) continue;
    track.label = label;
    track.labelConfidence = Math.min(0.98, 0.55 + coherence * 0.25);
    if (track.labelConfidence >= cfg.labelLockConfidence) {
      track.lockedLabel = label;
    }
  }
}
