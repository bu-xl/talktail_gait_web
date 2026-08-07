/**
 * Temporal smoothing (EMA) with rising-edge boost and data-loss fade-out.
 *
 *   smoothed = alpha * current + (1 - alpha) * previous
 *
 * alpha defaults to 0.45 and is raised (up to ema_alpha_rising, e.g. 0.6) when
 * the current value exceeds the previous one, so sharp pressure peaks are not
 * lagged. On data loss the field fades to zero within fade_out_ms.
 *
 * NaN cells (below the visible threshold) are treated as 0 for blending, and the
 * blended result is re-thresholded to NaN below visible_min so smoothing never
 * reintroduces sub-threshold bleed.
 */

import type { Matrix } from "./types.js";

export class TemporalSmoother {
  private prev: Matrix | null = null;

  constructor(
    private readonly emaAlpha: number,
    private readonly emaAlphaRising: number,
    private readonly fadeOutMs: number,
    private readonly visibleMin: number,
  ) {}

  reset(): void {
    this.prev = null;
  }

  /** Blend a new (already thresholded) pressure frame with the previous one. */
  step(current: Matrix): Matrix {
    const n = current.length;
    const out = new Float64Array(n);
    const prev = this.prev;
    for (let i = 0; i < n; i++) {
      const cur = Number.isNaN(current[i]) ? 0 : current[i];
      const pv = prev && !Number.isNaN(prev[i]) ? prev[i] : 0;
      const alpha = cur > pv ? this.emaAlphaRising : this.emaAlpha;
      const blended = alpha * cur + (1 - alpha) * pv;
      out[i] = blended >= this.visibleMin ? blended : Number.NaN;
    }
    this.prev = out;
    return out;
  }

  /**
   * Advance a fade-out when no new frame arrived for `dtMs`. Each call decays the
   * last field toward zero; cells drop below threshold (NaN) as they fade.
   */
  fade(dtMs: number): Matrix {
    const prev = this.prev;
    const n = prev ? prev.length : 0;
    const out = new Float64Array(n);
    if (!prev) return out;
    const decay = Math.max(0, 1 - dtMs / this.fadeOutMs);
    for (let i = 0; i < n; i++) {
      const v = Number.isNaN(prev[i]) ? 0 : prev[i] * decay;
      out[i] = v >= this.visibleMin ? v : Number.NaN;
    }
    this.prev = out;
    return out;
  }
}
