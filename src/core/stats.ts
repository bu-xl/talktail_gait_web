/**
 * Frame statistics over a thresholded pressure matrix (NaN == below visible_min,
 * already excluded). Areas use the physical cell area (10.125 cm^2).
 */

import { CELL_AREA_CM2 } from "./constants.js";
import type { AppConfig, FrameStats, Matrix } from "./types.js";

export function computeStats(pressure: Matrix, config: AppConfig): FrameStats {
  const { medium_min_mmhg, high_min_mmhg } = config.pressure_thresholds;
  let active = 0;
  let medium = 0;
  let high = 0;
  let sum = 0;
  let max = 0;

  for (let i = 0; i < pressure.length; i++) {
    const p = pressure[i];
    if (Number.isNaN(p)) continue; // below visible threshold -> excluded
    active += 1;
    sum += p;
    if (p > max) max = p;
    if (p >= high_min_mmhg) high += 1;
    else if (p >= medium_min_mmhg) medium += 1;
  }

  return {
    activeCellCount: active,
    maxPressure: active ? max : 0,
    avgPressure: active ? sum / active : 0,
    contactAreaCm2: active * CELL_AREA_CM2,
    mediumAreaCm2: medium * CELL_AREA_CM2, // medium_min <= p < high_min
    highAreaCm2: high * CELL_AREA_CM2, // p >= high_min
  };
}

/** Simple FPS meter from frame timestamps (exponential moving average). */
export class FpsMeter {
  private last = 0;
  private fps = 0;
  tick(now: number): number {
    if (this.last > 0) {
      const dt = now - this.last;
      if (dt > 0) {
        const inst = 1000 / dt;
        this.fps = this.fps === 0 ? inst : 0.9 * this.fps + 0.1 * inst;
      }
    }
    this.last = now;
    return this.fps;
  }
  get value(): number {
    return this.fps;
  }
}

/**
 * Sliding-window rate meter: counts events (e.g. serial frame arrivals) over a
 * trailing window and reports them as a rate in Hz. Unlike the EMA FpsMeter this
 * is exact over the window and tolerant of jitter, so it gives a stable readout
 * of the true mat input rate (~40 Hz) independent of how often we repaint.
 *
 * Usage: call {@link tick} once per frame as it ARRIVES (not when it is drawn).
 */
export class RateMeter {
  /** Ring of recent event timestamps (ms), oldest-first after pruning. */
  private readonly times: number[] = [];

  constructor(private readonly windowMs = 1000) {}

  /** Record one event at time `now` (ms) and return the current rate in Hz. */
  tick(now: number): number {
    this.times.push(now);
    this.prune(now);
    return this.hz(now);
  }

  /** Current rate in Hz without recording a new event (e.g. for idle decay). */
  hz(now: number): number {
    this.prune(now);
    const n = this.times.length;
    if (n < 2) return 0;
    const span = now - this.times[0];
    if (span <= 0) return 0;
    // (n-1) intervals over the elapsed span -> events per second.
    return ((n - 1) * 1000) / span;
  }

  reset(): void {
    this.times.length = 0;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    let drop = 0;
    while (drop < this.times.length && this.times[drop] < cutoff) drop++;
    if (drop > 0) this.times.splice(0, drop);
  }
}

/**
 * Convenience accessor matching the call site referenced in the app: returns the
 * measured serial input rate (Hz) from a {@link RateMeter}, rounded for display.
 */
export function getSerialDisplayHz(meter: RateMeter, now: number): number {
  return Math.round(meter.hz(now));
}
