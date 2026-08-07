/**
 * Recording → paw-track overlay model.
 *
 * Runs the gait engine ONCE over a whole recording (the authoritative pass: the
 * full walk decides each paw's L/R + F/H label), then back-applies those final
 * labels to every frame. The result drives all three annotated exports — GIF,
 * peak PNG and the paw-track CSV — so they are mutually consistent and consistent
 * with the live overlay (same engine, same delta normalisation as analysis).
 */

import {
  PawGaitEngine,
  buildPawSummaryOverlay,
  buildSessionOverlayFrames,
  type PawOverlayFrame,
  type WalkingDirection,
} from "../gait/index.js";
import { buildEngineConfig, framesToEngineInput } from "./gaitAnalysis.js";
import { maxProjection } from "./projection.js";
import type { RecordedFrame } from "./recorder.js";
import type { AppConfig, Matrix } from "./types.js";

export interface RecordingPawTrack {
  /** Per-frame overlay (index-aligned with displayFields). */
  readonly overlayFrames: PawOverlayFrame[];
  /** One item per labelled paw, for the peak-footprint PNG. */
  readonly summaryFrame: PawOverlayFrame;
  /** Per-cell peak display pressure across the recording. */
  readonly peakField: Matrix;
  /** Display pressure fields (passed through; index-aligned with overlayFrames). */
  readonly displayFields: readonly Matrix[];
  /** Seconds from recording start, per frame. */
  readonly timestampsSec: number[];
  readonly fps: number;
  readonly frameCount: number;
  readonly direction: WalkingDirection;
  readonly directionConfidence: number;
}

/**
 * @param frames        recorded raw frames (un-oriented)
 * @param baseline      oriented per-cell baseline
 * @param config        app config
 * @param weightKg      dog weight (sensitivity profile)
 * @param displayFields display pressure fields, index-aligned with `frames`
 *                      (from the SAME pipeline the live view uses)
 */
export function buildRecordingPawTrack(
  frames: readonly RecordedFrame[],
  baseline: Matrix,
  config: AppConfig,
  weightKg: number,
  displayFields: readonly Matrix[],
): RecordingPawTrack {
  const { flat, timestamps } = framesToEngineInput(frames, baseline, config);
  const span = timestamps.length > 1 ? timestamps[timestamps.length - 1]! - timestamps[0]! : 0;
  const fps = span > 0 && flat.length > 1 ? ((flat.length - 1) / span) * 1000 : 38;

  const engine = new PawGaitEngine({
    ...buildEngineConfig(config.gait, weightKg, fps),
    // Keep the FULL per-frame history so every frame can be annotated even on
    // long recordings (the engine default trims to 512 frames).
    maxTrackHistoryFrames: Math.max(512, flat.length + 2),
  });
  const session = engine.processFlatSession(flat, timestamps, fps);
  const tracks = engine.getTracks();

  const po = config.paw_overlay;
  const overlayFrames = buildSessionOverlayFrames(tracks, flat.length, {
    includeUnknown: po.show_unknown,
    quality: {
      requireContact: po.require_contact,
      minArea: po.min_contact_area,
      minPeak: po.min_contact_peak_frac * config.gait.normalize_target_peak,
      minTrackFrames: po.min_track_frames,
      minContactFrames: Math.max(1, Math.round(po.min_contact_sec * fps)),
    },
  });
  const summaryFrame = buildPawSummaryOverlay(tracks);
  const peakField =
    displayFields.length > 0 ? maxProjection(displayFields) : new Float64Array(0);

  return {
    overlayFrames,
    summaryFrame,
    peakField,
    displayFields,
    timestampsSec: timestamps.map((t) => t / 1000),
    fps,
    frameCount: flat.length,
    direction: session.direction.direction,
    directionConfidence: session.direction.confidence,
  };
}
