import type { FrameResult, PawGaitConfig, PawTrack, Vector2 } from "./types.js";
import { applyProvisionalLiveLabels } from "./footfall/coldStart.js";
import { trackLabelAtFrame } from "./footfall/session.js";
import { labelTracksFromFootfallSequence } from "./footfallLabeling.js";

/**
 * Session-final labels via body-frame footfall pipeline.
 * Geometry per-frame F/H (classifyTracks) is NOT used — it caused bugs A/B.
 */
export function finalizeSessionLabels(
  tracks: readonly PawTrack[],
  _bodyDirection: Vector2,
  _bodyPerpendicular: Vector2,
  cfg: PawGaitConfig,
  frames: readonly FrameResult[],
  timestampsMs: readonly number[],
  hz: number,
): void {
  labelTracksFromFootfallSequence(
    tracks,
    null,
    null,
    cfg,
    frames,
    timestampsMs,
    hz,
  );
}

/**
 * Live labels: frozen contact-event labels, locked labels, or provisional seed.
 * Never recompute F/H from visible paws in the current frame (bugs A/B).
 */
export function applyLiveLabels(
  tracks: readonly PawTrack[],
  _bodyDirection: Vector2,
  _bodyPerpendicular: Vector2,
  cfg: PawGaitConfig,
  frameIndex: number,
): void {
  applyProvisionalLiveLabels(tracks, frameIndex);

  for (const track of tracks) {
    if (track.lockedLabel) {
      track.label = track.lockedLabel;
      track.labelConfidence = Math.max(track.labelConfidence, cfg.labelLockConfidence);
      track.flagsProvisional = false;
      continue;
    }
    const frozen = trackLabelAtFrame(track, frameIndex);
    if (frozen) {
      track.label = frozen;
      track.labelConfidence = Math.max(track.labelConfidence, cfg.minConfidence);
      continue;
    }
    if (!track.active || !track.contact) {
      if (!track.lockedLabel && track.label === "Unknown") {
        track.labelConfidence = 0;
      }
    }
  }
}
