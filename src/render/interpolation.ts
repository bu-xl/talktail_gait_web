/**
 * NaN-aware bilinear upsampling + separable Gaussian blur.
 *
 * Sub-threshold cells are NaN. To keep their edges crisp-but-soft (alpha only,
 * no colour bleed) we upsample a value buffer (NaN -> 0) together with a coverage
 * mask (1 where visible, else 0), blur BOTH, then normalise value by coverage.
 * Coverage becomes the alpha channel, so the visible region softens at its
 * border without resurrecting sub-threshold pressure.
 */

/**
 * Bilinear-upsample a row-major (srcRows x srcCols) buffer to (dstH x dstW).
 * If `out` is supplied it is reused (no allocation) — the hot render path passes
 * preallocated scratch buffers so painting allocates nothing per frame.
 */
export function bilinearUpsample(
  src: Float64Array,
  srcRows: number,
  srcCols: number,
  dstW: number,
  dstH: number,
  out: Float64Array = new Float64Array(dstW * dstH),
): Float64Array {
  const sx = srcCols > 1 ? (srcCols - 1) / (dstW - 1) : 0;
  const sy = srcRows > 1 ? (srcRows - 1) / (dstH - 1) : 0;
  for (let y = 0; y < dstH; y++) {
    const fy = y * sy;
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, srcRows - 1);
    const ty = fy - y0;
    for (let x = 0; x < dstW; x++) {
      const fx = x * sx;
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, srcCols - 1);
      const tx = fx - x0;
      const v00 = src[y0 * srcCols + x0];
      const v01 = src[y0 * srcCols + x1];
      const v10 = src[y1 * srcCols + x0];
      const v11 = src[y1 * srcCols + x1];
      const top = v00 + (v01 - v00) * tx;
      const bot = v10 + (v11 - v10) * tx;
      out[y * dstW + x] = top + (bot - top) * ty;
    }
  }
  return out;
}

/**
 * Nearest-neighbour upsample (no interpolation) — renders each sensor cell as a
 * solid block so pressure is shown exactly where it is measured, with no spatial
 * bleed. Use for precise localisation; the result looks pixelated by design.
 */
export function nearestUpsample(
  src: Float64Array,
  srcRows: number,
  srcCols: number,
  dstW: number,
  dstH: number,
  out: Float64Array = new Float64Array(dstW * dstH),
): Float64Array {
  for (let y = 0; y < dstH; y++) {
    const syi = Math.min(srcRows - 1, Math.floor((y * srcRows) / dstH));
    for (let x = 0; x < dstW; x++) {
      const sxi = Math.min(srcCols - 1, Math.floor((x * srcCols) / dstW));
      out[y * dstW + x] = src[syi * srcCols + sxi];
    }
  }
  return out;
}

/** 1-D Gaussian kernel (normalised), radius = ceil(3*sigma). */
function gaussianKernel(sigma: number): Float64Array {
  if (sigma <= 0) return Float64Array.of(1);
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const size = radius * 2 + 1;
  const k = new Float64Array(size);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < size; i++) k[i] /= sum;
  return k;
}

/** Separable Gaussian blur with independent x/y sigmas (edge-clamped). */
export function gaussianBlurSeparable(
  src: Float64Array,
  w: number,
  h: number,
  sigmaX: number,
  sigmaY: number,
): Float64Array {
  const kx = gaussianKernel(sigmaX);
  const ky = gaussianKernel(sigmaY);
  const rx = (kx.length - 1) >> 1;
  const ry = (ky.length - 1) >> 1;

  const tmp = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -rx; i <= rx; i++) {
        const xx = Math.min(w - 1, Math.max(0, x + i));
        acc += src[y * w + xx] * kx[i + rx];
      }
      tmp[y * w + x] = acc;
    }
  }
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let i = -ry; i <= ry; i++) {
        const yy = Math.min(h - 1, Math.max(0, y + i));
        acc += tmp[yy * w + x] * ky[i + ry];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

export interface UpsampledField {
  value: Float64Array; // normalised pressure per dst pixel (0 where no coverage)
  coverage: Float64Array; // 0..1 alpha mask
  width: number;
  height: number;
}

/**
 * Reusable scratch buffers for {@link buildSmoothField}, sized once for a fixed
 * grid + destination. Reusing them keeps the per-frame paint allocation-free
 * (otherwise ~6 MB of Float64Array is allocated and GC'd every single frame).
 */
export class SmoothFieldScratch {
  readonly value: Float64Array;
  readonly mask: Float64Array;
  readonly blurValue: Float64Array;
  readonly blurMask: Float64Array;
  readonly upValue: Float64Array;
  readonly coverage: Float64Array;
  readonly outValue: Float64Array;

  constructor(rows: number, cols: number, dstW: number, dstH: number) {
    this.value = new Float64Array(rows * cols);
    this.mask = new Float64Array(rows * cols);
    this.blurValue = new Float64Array(rows * cols);
    this.blurMask = new Float64Array(rows * cols);
    this.upValue = new Float64Array(dstW * dstH);
    this.coverage = new Float64Array(dstW * dstH);
    this.outValue = new Float64Array(dstW * dstH);
  }
}

/** Options controlling the pressure-adaptive blur in {@link buildSmoothField}. */
export interface BlurOptions {
  /** Blur radius (cells) applied to the LOWEST pressures. */
  sigmaMin: number;
  /** Blur radius (cells) applied to the HIGHEST pressures. */
  sigmaMax: number;
  /** Pressure mapped to sigmaMin (typically visible_min). */
  normLo: number;
  /** Pressure mapped to sigmaMax (typically colorbar high). */
  normHi: number;
  /** Crisp per-sensor blocks instead of smooth gradients. */
  nearest?: boolean;
  scratch?: SmoothFieldScratch;
}

/**
 * Pressure-ADAPTIVE Gaussian "scatter" blur on the native grid.
 *
 * Each active sensor cell splats a normalised Gaussian whose sigma grows with
 * that cell's pressure (sigma = lerp(sigmaMin, sigmaMax, t), t from normLo..normHi).
 * So a hard press blooms into a wide soft halo while a light touch stays tight —
 * the spread varies with pressure instead of being uniform. value & mask are
 * accumulated together; dividing value by mask later recovers the pressure, and
 * mask doubles as the soft alpha coverage.
 */
function adaptiveScatterBlur(
  value: Float64Array,
  mask: Float64Array,
  cols: number,
  rows: number,
  o: BlurOptions,
  outValue: Float64Array,
  outMask: Float64Array,
): void {
  outValue.fill(0);
  outMask.fill(0);
  const span = o.normHi - o.normLo || 1;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c;
      if (mask[idx] <= 0) continue;
      const p = value[idx];
      const t = Math.max(0, Math.min(1, (p - o.normLo) / span));
      const sigma = o.sigmaMin + (o.sigmaMax - o.sigmaMin) * t;
      if (sigma <= 0) {
        outValue[idx] += p;
        outMask[idx] += 1;
        continue;
      }
      const rad = Math.max(1, Math.ceil(sigma * 3));
      const inv2s2 = 1 / (2 * sigma * sigma);
      // Normalise the kernel so every source contributes equal total mass.
      let wsum = 0;
      for (let dy = -rad; dy <= rad; dy++) {
        const ry = r + dy;
        if (ry < 0 || ry >= rows) continue;
        for (let dx = -rad; dx <= rad; dx++) {
          const cx = c + dx;
          if (cx < 0 || cx >= cols) continue;
          wsum += Math.exp(-(dx * dx + dy * dy) * inv2s2);
        }
      }
      if (wsum <= 0) wsum = 1;
      for (let dy = -rad; dy <= rad; dy++) {
        const ry = r + dy;
        if (ry < 0 || ry >= rows) continue;
        for (let dx = -rad; dx <= rad; dx++) {
          const cx = c + dx;
          if (cx < 0 || cx >= cols) continue;
          const w = Math.exp(-(dx * dx + dy * dy) * inv2s2) / wsum;
          const j = ry * cols + cx;
          outValue[j] += p * w;
          outMask[j] += w;
        }
      }
    }
  }
}

/**
 * Upsample + blur a thresholded pressure matrix into a smooth field.
 * `pressure` is row-major (rows x cols); NaN means below threshold.
 *
 * Performance: the Gaussian blur is applied on the NATIVE low-res grid
 * (rows x cols, e.g. 40x40) and the field is upsampled ONCE afterwards. Blurring
 * in upsampled space instead would scale sigma by dstW/cols (~9 px), giving a
 * ~55-tap kernel over ~260k pixels twice per frame — tens of millions of ops
 * that collapsed the paint rate to single-digit fps. Blur-then-upsample is
 * visually equivalent for these smooth fields but ~25-30x cheaper, since
 * bilinear upsampling is itself a smoothing (linear) operator and commutes with
 * the blur to first order.
 */
export function buildSmoothField(
  pressure: Float64Array,
  rows: number,
  cols: number,
  dstW: number,
  dstH: number,
  options: BlurOptions,
): UpsampledField {
  const scratch = options.scratch;
  const value = scratch?.value ?? new Float64Array(rows * cols);
  const mask = scratch?.mask ?? new Float64Array(rows * cols);
  for (let i = 0; i < pressure.length; i++) {
    const p = pressure[i];
    if (Number.isNaN(p)) {
      value[i] = 0;
      mask[i] = 0;
    } else {
      value[i] = p;
      mask[i] = 1;
    }
  }

  // Pressure-adaptive blur on the small grid. With sigmaMax <= 0 the blur is off
  // (sharp); otherwise each cell spreads by an amount that grows with its
  // pressure, so the softness varies with how hard the sensor is pressed.
  let gridValue = value;
  let gridMask = mask;
  if (options.sigmaMax > 0) {
    const bv = scratch?.blurValue ?? new Float64Array(rows * cols);
    const bm = scratch?.blurMask ?? new Float64Array(rows * cols);
    adaptiveScatterBlur(value, mask, cols, rows, options, bv, bm);
    gridValue = bv;
    gridMask = bm;
  }

  // Nearest = crisp per-sensor blocks (no spatial bleed); bilinear = soft gradients.
  const up = options.nearest ? nearestUpsample : bilinearUpsample;
  const upValue = up(gridValue, rows, cols, dstW, dstH, scratch?.upValue);
  const coverage = up(gridMask, rows, cols, dstW, dstH, scratch?.coverage);

  const outValue = scratch?.outValue ?? new Float64Array(dstW * dstH);
  for (let i = 0; i < outValue.length; i++) {
    outValue[i] = coverage[i] > 1e-4 ? upValue[i] / coverage[i] : 0;
  }
  return { value: outValue, coverage, width: dstW, height: dstH };
}
