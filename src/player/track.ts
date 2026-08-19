/**
 * Timestamped track store for the result player.
 *
 * The mat is NOT evenly sampled: the period drifts across roughly 22.2..25.6 ms
 * (39..45 Hz). Any `index = round((t - t0) * rate)` shortcut accumulates hundreds
 * of milliseconds of drift by the end of a session, so every lookup here goes
 * through the stored timestamp array. There is deliberately no uniform-resample
 * path and no "assume 43 Hz" constant anywhere in this file.
 *
 * Storage is columnar TypedArrays (BigInt64Array timestamps + one flat
 * Float32Array of values). Unpacking samples into an object array would make the
 * GC drop frames during playback.
 */

/**
 * `nearest` snaps to the closest stored sample; `interp` blends the two
 * neighbours linearly.
 *
 * Pick per data kind:
 *   - mat heatmap, joint angles -> `interp`. `nearest` visibly flickers because
 *     the mat period and the 30 fps video period are not integer multiples, so
 *     the same sample gets shown twice or skipped.
 *   - pose keypoints -> `nearest`. They were produced from the video frame
 *     itself, so blending two of them invents positions the detector never
 *     reported.
 *   - contact/footfall times -> neither; use threshold-crossing interpolation on
 *     the raw samples instead of a resampled value.
 */
export type TrackMode = "nearest" | "interp";

export interface Track<T> {
  readonly name: string;
  /** Track clock -> master clock: `tMaster = tTrack + offsetNs`. */
  readonly offsetNs: bigint;
  readonly irregular: boolean;
  at(tServerNs: bigint, mode: TrackMode): T | null;
  window(tServerNs: bigint, spanNs: bigint): T[];
  /** True where there is no data, as opposed to data that reads zero. */
  gapAt(tServerNs: bigint): boolean;
}

export interface PeriodStats {
  /** Sample-to-sample interval percentiles, ns. */
  p50: number;
  p95: number;
  min: number;
  max: number;
  /** Median rate in Hz, derived from p50. 0 when the track has < 2 samples. */
  medianHz: number;
}

export interface GapSpan {
  startNs: bigint;
  endNs: bigint;
}

export interface IndexRange {
  start: number;
  end: number;
}

export interface SampleTrackOptions {
  name: string;
  /** One entry per sample, ascending, in the track's own clock. */
  timestampsNs: BigInt64Array;
  /** `stride * count` values, grouped per sample. */
  values: Float32Array;
  /** Values per sample (1600 for the 40x40 mat, 2 or 3 per keypoint, ...). */
  stride: number;
  /** Track clock -> master clock offset. */
  offsetNs?: bigint;
  irregular?: boolean;
  /**
   * Interval above which a pair of neighbours counts as missing data.
   * Defaults to 2x the measured p95 interval.
   */
  gapThresholdNs?: bigint;
}

/**
 * Columnar, irregularly-sampled track with an O(1) sequential lookup.
 *
 * IMPORTANT: `at()` returns a buffer that is reused on the next `at()` call for
 * the same track. Read it immediately, or copy it if you need to keep it. This
 * is what keeps per-frame lookups allocation-free.
 */
export class SampleTrack implements Track<Float32Array> {
  readonly name: string;
  readonly offsetNs: bigint;
  readonly irregular: boolean;
  readonly stride: number;
  readonly count: number;
  readonly timestampsNs: BigInt64Array;
  readonly values: Float32Array;

  /**
   * Number-space mirror of `timestampsNs` used by the search hot path.
   *
   * The BigInt64Array above stays the authoritative store, but bigint compares
   * cost roughly an order of magnitude more than double compares, and the search
   * budget is 10k lookups in under 5 ms. A session would need to run for ~104
   * days before nanoseconds stopped being exactly representable as a double, so
   * the mirror is lossless in practice.
   */
  private readonly tsNum: Float64Array;

  private readonly gapThreshold: number;
  private readonly scratch: Float32Array;

  /** Galloping-search hints: one for point lookups, one for window queries. */
  private cursor = 0;
  private windowCursor = 0;

  private periodStatsCache: PeriodStats | null = null;
  private rateHzCache: Float32Array | null = null;
  private valueRangeCache: { min: number; max: number } | null = null;
  private gapsCache: GapSpan[] | null = null;

  constructor(options: SampleTrackOptions) {
    const { timestampsNs, values, stride } = options;
    if (stride <= 0) throw new Error(`${options.name}: stride must be >= 1`);
    if (values.length !== timestampsNs.length * stride) {
      throw new Error(
        `${options.name}: values length ${values.length} != ${timestampsNs.length} samples x stride ${stride}`,
      );
    }

    this.name = options.name;
    this.offsetNs = options.offsetNs ?? 0n;
    this.irregular = options.irregular ?? true;
    this.stride = stride;
    this.count = timestampsNs.length;
    this.timestampsNs = timestampsNs;
    this.values = values;
    this.scratch = new Float32Array(stride);

    this.tsNum = new Float64Array(this.count);
    for (let i = 0; i < this.count; i++) this.tsNum[i] = Number(timestampsNs[i]);
    assertAscending(this.tsNum, this.name);

    this.gapThreshold =
      options.gapThresholdNs !== undefined
        ? Number(options.gapThresholdNs)
        : defaultGapThreshold(this.periodStats());
  }

  get startNs(): bigint {
    return this.count > 0 ? this.timestampsNs[0] + this.offsetNs : 0n;
  }

  get endNs(): bigint {
    return this.count > 0 ? this.timestampsNs[this.count - 1] + this.offsetNs : 0n;
  }

  /** Interval above which neighbours are treated as missing data, ns. */
  get gapThresholdNs(): number {
    return this.gapThreshold;
  }

  at(tServerNs: bigint, mode: TrackMode = "nearest"): Float32Array | null {
    return this.atNs(Number(tServerNs - this.offsetNs), mode);
  }

  /** `at()` in the track's own clock, as a plain number. Skips bigint math. */
  atNs(tTrackNs: number, mode: TrackMode = "nearest"): Float32Array | null {
    const n = this.count;
    if (n === 0) return null;
    const ts = this.tsNum;
    if (tTrackNs < ts[0] || tTrackNs > ts[n - 1]) return null;

    const i = this.locate(tTrackNs);
    if (i < 0) return null;

    const stride = this.stride;
    const out = this.scratch;

    if (ts[i] === tTrackNs || i >= n - 1) {
      out.set(this.values.subarray(i * stride, (i + 1) * stride));
      return out;
    }
    // Never synthesise a value across missing data.
    if (this.isGapBetween(i)) return null;

    if (mode === "nearest") {
      const j = tTrackNs - ts[i] <= ts[i + 1] - tTrackNs ? i : i + 1;
      out.set(this.values.subarray(j * stride, (j + 1) * stride));
      return out;
    }

    const span = ts[i + 1] - ts[i];
    const w = span > 0 ? (tTrackNs - ts[i]) / span : 0;
    const a = i * stride;
    const b = a + stride;
    const values = this.values;
    for (let k = 0; k < stride; k++) {
      const lo = values[a + k];
      out[k] = lo + (values[b + k] - lo) * w;
    }
    return out;
  }

  /**
   * True when `t` falls in a missing-data span, or outside the track entirely.
   *
   * Renderers use this to grey the frame out. Pressure zero and "no data" must
   * never look the same.
   */
  gapAt(tServerNs: bigint): boolean {
    return this.gapAtNs(Number(tServerNs - this.offsetNs));
  }

  gapAtNs(tTrackNs: number): boolean {
    const n = this.count;
    if (n === 0) return true;
    const ts = this.tsNum;
    if (tTrackNs < ts[0] || tTrackNs > ts[n - 1]) return true;

    const i = this.locate(tTrackNs);
    if (i < 0) return true;
    if (ts[i] === tTrackNs) return false;
    return this.isGapBetween(i);
  }

  /**
   * Samples covering `spanNs` centred on `tServerNs`, oldest first.
   *
   * Allocates one copy per sample. The per-frame chart path should use
   * `windowRange()` and read `values` directly instead.
   */
  window(tServerNs: bigint, spanNs: bigint): Float32Array[] {
    const range = this.windowRange(tServerNs, spanNs);
    if (!range) return [];
    const out: Float32Array[] = [];
    for (let i = range.start; i <= range.end; i++) {
      out.push(this.values.slice(i * this.stride, (i + 1) * this.stride));
    }
    return out;
  }

  /** Allocation-free `window()`: inclusive index range, or null when empty. */
  windowRange(tServerNs: bigint, spanNs: bigint): IndexRange | null {
    const centre = Number(tServerNs - this.offsetNs);
    const half = Number(spanNs) / 2;
    return this.windowRangeNs(centre - half, centre + half);
  }

  /** Inclusive index range covering [loNs, hiNs] in the track's own clock. */
  windowRangeNs(loNs: number, hiNs: number): IndexRange | null {
    const n = this.count;
    if (n === 0) return null;
    const ts = this.tsNum;
    if (hiNs < ts[0] || loNs > ts[n - 1]) return null;

    let start = this.locateFrom(loNs, this.windowCursor);
    if (start < 0) start = 0;
    else if (ts[start] < loNs) start += 1;
    if (start > n - 1) return null;

    let end = this.locateFrom(hiNs, start);
    if (end < 0) return null;
    if (end > n - 1) end = n - 1;
    this.windowCursor = end;

    if (start > end) return null;
    return { start, end };
  }

  /**
   * Index of the sample closest to `tTrackNs`, or -1 outside the track.
   *
   * Used by the timing overlay to show how far the displayed sample sits from
   * the master clock. That distance must stay inside half a sample period.
   */
  nearestIndexNs(tTrackNs: number): number {
    const n = this.count;
    if (n === 0) return -1;
    const ts = this.tsNum;
    if (tTrackNs <= ts[0]) return 0;
    if (tTrackNs >= ts[n - 1]) return n - 1;
    const i = this.locate(tTrackNs);
    if (i < 0) return 0;
    if (i >= n - 1) return n - 1;
    return tTrackNs - ts[i] <= ts[i + 1] - tTrackNs ? i : i + 1;
  }

  /** Value at `index * stride + channel`, without copying. */
  valueAt(index: number, channel = 0): number {
    return this.values[index * this.stride + channel];
  }

  /** Master-clock timestamp of a sample. */
  timeAt(index: number): bigint {
    return this.timestampsNs[index] + this.offsetNs;
  }

  /** Interval percentiles over the whole track. Computed once. */
  periodStats(): PeriodStats {
    if (this.periodStatsCache) return this.periodStatsCache;
    const n = this.count;
    if (n < 2) {
      this.periodStatsCache = { p50: 0, p95: 0, min: 0, max: 0, medianHz: 0 };
      return this.periodStatsCache;
    }
    const deltas = new Float64Array(n - 1);
    for (let i = 1; i < n; i++) deltas[i - 1] = this.tsNum[i] - this.tsNum[i - 1];
    const sorted = Float64Array.from(deltas).sort();
    const p50 = percentile(sorted, 0.5);
    this.periodStatsCache = {
      p50,
      p95: percentile(sorted, 0.95),
      min: sorted[0],
      max: sorted[sorted.length - 1],
      medianHz: p50 > 0 ? 1e9 / p50 : 0,
    };
    return this.periodStatsCache;
  }

  /**
   * Instantaneous rate (Hz) per sample, from the interval that precedes it.
   * Index 0 repeats index 1 so the array lines up with the sample array.
   */
  rateHz(): Float32Array {
    if (this.rateHzCache) return this.rateHzCache;
    const n = this.count;
    const out = new Float32Array(n);
    for (let i = 1; i < n; i++) {
      const d = this.tsNum[i] - this.tsNum[i - 1];
      out[i] = d > 0 ? 1e9 / d : 0;
    }
    if (n > 1) out[0] = out[1];
    this.rateHzCache = out;
    return out;
  }

  /**
   * Min/max across every stored value, ignoring NaN.
   *
   * The heatmap normalisation is anchored to this once per session. Recomputing
   * per frame makes the colours pulse as the dog steps on and off the mat.
   */
  valueRange(): { min: number; max: number } {
    if (this.valueRangeCache) return this.valueRangeCache;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    const v = this.values;
    for (let i = 0; i < v.length; i++) {
      const x = v[i];
      if (Number.isNaN(x)) continue;
      if (x < min) min = x;
      if (x > max) max = x;
    }
    if (min > max) {
      min = 0;
      max = 0;
    }
    this.valueRangeCache = { min, max };
    return this.valueRangeCache;
  }

  /** Missing-data spans in master-clock time, for the timeline's grey bands. */
  gaps(): GapSpan[] {
    if (this.gapsCache) return this.gapsCache;
    const out: GapSpan[] = [];
    for (let i = 0; i < this.count - 1; i++) {
      if (this.isGapBetween(i)) {
        out.push({ startNs: this.timeAt(i), endNs: this.timeAt(i + 1) });
      }
    }
    this.gapsCache = out;
    return out;
  }

  /** Fraction of the session duration with no data. */
  missingRatio(): number {
    if (this.count < 2) return 0;
    const total = this.tsNum[this.count - 1] - this.tsNum[0];
    if (total <= 0) return 0;
    let missing = 0;
    for (const gap of this.gaps()) missing += Number(gap.endNs - gap.startNs);
    return missing / total;
  }

  private isGapBetween(i: number): boolean {
    if (i < 0 || i >= this.count - 1) return false;
    return this.tsNum[i + 1] - this.tsNum[i] > this.gapThreshold;
  }

  private locate(t: number): number {
    const i = this.locateFrom(t, this.cursor);
    if (i >= 0) this.cursor = i;
    return i;
  }

  /**
   * Largest index with `ts[index] <= t`, or -1 when `t` precedes the track.
   *
   * Galloping search seeded from `hint`: sequential playback hits the first
   * bracket test and returns in O(1); a scrub jump costs O(log distance).
   */
  private locateFrom(t: number, hint: number): number {
    const ts = this.tsNum;
    const n = ts.length;
    if (n === 0) return -1;
    if (t < ts[0]) return -1;
    if (t >= ts[n - 1]) return n - 1;

    let i = hint;
    if (i < 0) i = 0;
    else if (i > n - 2) i = n - 2;
    if (ts[i] <= t && t < ts[i + 1]) return i;

    let lo: number;
    let hi: number;
    if (t < ts[i]) {
      let step = 1;
      hi = i;
      lo = i - step;
      while (lo > 0 && ts[lo] > t) {
        step <<= 1;
        hi = lo;
        lo = i - step;
      }
      if (lo < 0) lo = 0;
    } else {
      let step = 1;
      lo = i;
      hi = i + step;
      while (hi < n - 1 && ts[hi] <= t) {
        step <<= 1;
        lo = hi;
        hi = i + step;
      }
      if (hi > n - 1) hi = n - 1;
    }

    while (hi - lo > 1) {
      const mid = (lo + hi) >>> 1;
      if (ts[mid] <= t) lo = mid;
      else hi = mid;
    }
    return lo;
  }
}

/**
 * A track that failed to load.
 *
 * Every accessor answers "no data", so one broken artifact degrades to a greyed
 * panel instead of taking the whole player down.
 */
export class EmptyTrack implements Track<Float32Array> {
  readonly offsetNs = 0n;
  readonly irregular = true;

  constructor(
    readonly name: string,
    readonly reason: string,
  ) {}

  at(): null {
    return null;
  }

  window(): Float32Array[] {
    return [];
  }

  gapAt(): boolean {
    return true;
  }
}

/** 2 x p95, per the missing-data rule. Falls back to +inf for short tracks. */
function defaultGapThreshold(stats: PeriodStats): number {
  return stats.p95 > 0 ? stats.p95 * 2 : Number.POSITIVE_INFINITY;
}

function percentile(sorted: Float64Array, q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const idx = Math.min(n - 1, Math.max(0, Math.round((n - 1) * q)));
  return sorted[idx];
}

function assertAscending(ts: Float64Array, name: string): void {
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] < ts[i - 1]) {
      throw new Error(`${name}: timestamps must be ascending (broken at index ${i})`);
    }
  }
}
