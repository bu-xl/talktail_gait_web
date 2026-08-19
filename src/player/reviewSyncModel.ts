/**
 * Time mapping for the five review panes.
 *
 * The panes are pre-rendered mp4s, not data tracks, so they cannot share a
 * single clock the way the result player's canvases do. What they can do is
 * follow one master video. This module holds the arithmetic for that, separated
 * from the DOM so the mapping and the drift policy can be tested directly.
 *
 * Two kinds of pane exist:
 *
 *  - `shared`: rendered from the same clip as the master (skeleton overlay,
 *    angle overlay). Same t0, same frame grid, so the mapping is the identity
 *    and alignment is exact.
 *
 *  - `proportional`: a different recording of the same walk. The pressure mp4 is
 *    the case that matters: `heatmap_video.py` writes it at a ROUNDED constant
 *    fps derived from the CSV's own `time` column, discarding both the irregular
 *    sample spacing and `times[0]`. There is therefore no shared origin to line
 *    up against, and no sync marker in this pipeline to recover one. Mapping by
 *    duration fraction assumes the two recordings cover the same walk, which is
 *    an assumption the UI has to state rather than hide.
 */

export type PaneMapping = "shared" | "proportional";

export interface PaneTiming {
  masterTime: number;
  masterDuration: number;
  followerDuration: number;
  mapping: PaneMapping;
  /** Manual nudge in seconds, for aligning a proportional pane by eye. */
  offsetSec?: number;
}

/** Where a follower should be for the master's current position. */
export function followerTarget(t: PaneTiming): number {
  const offset = t.offsetSec ?? 0;
  if (t.followerDuration <= 0) return 0;

  const raw =
    t.mapping === "shared"
      ? t.masterTime + offset
      : t.masterDuration > 0
        ? (t.masterTime / t.masterDuration) * t.followerDuration + offset
        : offset;

  return Math.min(t.followerDuration, Math.max(0, raw));
}

/**
 * Playback rate that keeps a follower aligned without repeated seeking.
 *
 * A proportional pane covering a different span has to run at a scaled rate;
 * leaving it at 1x and correcting by seeking makes it stutter once per
 * correction instead of playing smoothly.
 */
export function followerRate(
  masterRate: number,
  masterDuration: number,
  followerDuration: number,
  mapping: PaneMapping,
): number {
  if (mapping === "shared") return masterRate;
  if (masterDuration <= 0 || followerDuration <= 0) return masterRate;
  return masterRate * (followerDuration / masterDuration);
}

/**
 * Whether a follower is far enough off to be worth seeking.
 *
 * Correcting every frame would seek constantly and stutter; never correcting
 * lets rounding error accumulate. The tolerance is the visible threshold: about
 * one frame.
 */
export function shouldCorrect(driftSec: number, toleranceSec: number): boolean {
  return Math.abs(driftSec) > toleranceSec;
}

/** Drift tolerance for a pane, floored so a high-fps pane is not corrected constantly. */
export function toleranceFor(fps: number): number {
  const frame = fps > 0 ? 1 / fps : 1 / 30;
  return Math.max(frame, 0.033);
}

export interface DriftReading {
  key: string;
  driftSec: number;
  corrected: boolean;
}

/** Worst absolute drift across the panes, for the sync-quality readout. */
export function worstDrift(readings: readonly DriftReading[]): number {
  let worst = 0;
  for (const r of readings) {
    const d = Math.abs(r.driftSec);
    if (d > worst) worst = d;
  }
  return worst;
}

/**
 * Whether two panes can be trusted to line up frame for frame.
 *
 * Durations further apart than a frame mean they are not the same clip, so the
 * identity mapping would be wrong even though both are "the same session".
 */
export function durationsMatch(a: number, b: number, toleranceSec = 0.05): boolean {
  if (a <= 0 || b <= 0) return false;
  return Math.abs(a - b) <= toleranceSec;
}
