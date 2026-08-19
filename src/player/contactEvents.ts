/**
 * Foot-strike and lift-off times from the mat's load signal.
 *
 * The timestamp of a contact is NOT the timestamp of the first sample above the
 * threshold. The mat samples every ~24 ms, so snapping to a sample quantises
 * every event by up to a full period, which is the same order as the difference
 * between a sound and a lame limb. The crossing time is interpolated between the
 * two samples that bracket it, giving sub-sample resolution.
 *
 * Hysteresis keeps a signal hovering at the threshold from emitting a burst of
 * events: the load must rise past `enter` to start a contact and fall below
 * `exit` to end it.
 */

import type { SampleTrack } from "./track.js";

export type ContactEventKind = "strike" | "lift";

export interface ContactEvent {
  kind: ContactEventKind;
  /** Interpolated crossing time on the master clock. */
  tNs: bigint;
  /** Bracketing sample indices, for tracing an event back to raw data. */
  betweenIndices: [number, number];
}

export interface ContactSpan {
  startNs: bigint;
  endNs: bigint;
  /** True when the span runs to the end of the recording without lifting. */
  openEnded: boolean;
}

export interface ContactOptions {
  /** Load above this starts a contact. */
  enter: number;
  /** Load below this ends it. Must be <= `enter`. */
  exit?: number;
  /** Value channel within the sample. */
  channel?: number;
  /** Ignore contacts shorter than this. Filters single-sample noise spikes. */
  minDurationNs?: number;
}

/**
 * Threshold crossings over a track, in time order.
 *
 * Missing data ends any open contact rather than bridging it: a dropout is not
 * evidence that the paw stayed down.
 */
export function findContactEvents(track: SampleTrack, opts: ContactOptions): ContactEvent[] {
  const enter = opts.enter;
  const exit = opts.exit ?? enter;
  if (exit > enter) throw new Error(`contact exit ${exit} must not exceed enter ${enter}`);
  const channel = opts.channel ?? 0;

  const events: ContactEvent[] = [];
  let inContact = false;

  for (let i = 1; i < track.count; i++) {
    const prevT = Number(track.timeAt(i - 1));
    const currT = Number(track.timeAt(i));
    const prev = track.valueAt(i - 1, channel);
    const curr = track.valueAt(i, channel);

    // A hole in the data closes an open contact at the last known-good sample.
    if (currT - prevT > track.gapThresholdNs) {
      if (inContact) {
        events.push({ kind: "lift", tNs: track.timeAt(i - 1), betweenIndices: [i - 1, i - 1] });
        inContact = false;
      }
      continue;
    }
    if (!Number.isFinite(prev) || !Number.isFinite(curr)) continue;

    if (!inContact && prev < enter && curr >= enter) {
      events.push({
        kind: "strike",
        tNs: crossingTime(prevT, currT, prev, curr, enter),
        betweenIndices: [i - 1, i],
      });
      inContact = true;
    } else if (inContact && prev > exit && curr <= exit) {
      events.push({
        kind: "lift",
        tNs: crossingTime(prevT, currT, prev, curr, exit),
        betweenIndices: [i - 1, i],
      });
      inContact = false;
    }
  }

  return events;
}

/** Contacts as spans, which is what the timeline draws. */
export function findContactSpans(track: SampleTrack, opts: ContactOptions): ContactSpan[] {
  const events = findContactEvents(track, opts);
  const minDuration = BigInt(Math.round(opts.minDurationNs ?? 0));
  const spans: ContactSpan[] = [];

  let openStart: bigint | null = null;
  for (const event of events) {
    if (event.kind === "strike") openStart = event.tNs;
    else if (openStart !== null) {
      if (event.tNs - openStart >= minDuration) {
        spans.push({ startNs: openStart, endNs: event.tNs, openEnded: false });
      }
      openStart = null;
    }
  }
  if (openStart !== null && track.count > 0) {
    spans.push({ startNs: openStart, endNs: track.endNs, openEnded: true });
  }
  return spans;
}

/**
 * Time at which a straight line between two samples crosses `threshold`.
 * This is the sub-sample resolution the mat's own rate cannot give.
 */
function crossingTime(
  t0: number,
  t1: number,
  v0: number,
  v1: number,
  threshold: number,
): bigint {
  const span = v1 - v0;
  if (span === 0) return BigInt(Math.round(t0));
  const w = Math.min(1, Math.max(0, (threshold - v0) / span));
  return BigInt(Math.round(t0 + (t1 - t0) * w));
}

/**
 * Contact threshold from the session itself, as a fraction of peak load.
 *
 * An absolute count would depend on the dog's weight and the mat's calibration
 * state, so it cannot be a constant.
 */
export function suggestThreshold(track: SampleTrack, fraction = 0.12): ContactOptions {
  const { max } = track.valueRange();
  const enter = max * fraction;
  return {
    enter,
    // 25% below the entry level: enough to reject dithering at the threshold
    // without swallowing a genuinely brief lift.
    exit: enter * 0.75,
    channel: 0,
  };
}
