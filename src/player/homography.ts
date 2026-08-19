/**
 * Four-point homography, solved directly.
 *
 * This maps the mat's own grid onto video pixels so the heatmap can be overlaid
 * on the footage. Four correspondences give eight equations for the eight free
 * parameters of a projective transform (h22 is fixed at 1), so it is a plain
 * 8x8 solve. Pulling in a full computer-vision build for this would add
 * megabytes to the bundle for one matrix inverse.
 *
 * Coordinates are normalised 0..1 on both sides so a calibration survives a
 * change of resolution or panel size.
 */

export interface Point {
  x: number;
  y: number;
}

/** Row-major 3x3. */
export type Homography = Float64Array;

/**
 * Solve for H with `dst ~ H * src`.
 *
 * Returns null when the correspondences are degenerate (three points collinear,
 * or two coincident), which is what a mis-dragged calibration looks like.
 */
export function computeHomography(src: readonly Point[], dst: readonly Point[]): Homography | null {
  if (src.length < 4 || dst.length < 4) return null;

  // Each correspondence contributes two rows to A * h = b.
  const a = new Float64Array(8 * 8);
  const b = new Float64Array(8);
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    const r0 = i * 2 * 8;
    a[r0] = x; a[r0 + 1] = y; a[r0 + 2] = 1;
    a[r0 + 3] = 0; a[r0 + 4] = 0; a[r0 + 5] = 0;
    a[r0 + 6] = -x * u; a[r0 + 7] = -y * u;
    b[i * 2] = u;

    const r1 = (i * 2 + 1) * 8;
    a[r1] = 0; a[r1 + 1] = 0; a[r1 + 2] = 0;
    a[r1 + 3] = x; a[r1 + 4] = y; a[r1 + 5] = 1;
    a[r1 + 6] = -x * v; a[r1 + 7] = -y * v;
    b[i * 2 + 1] = v;
  }

  const h = solve8(a, b);
  if (!h) return null;

  const out = new Float64Array(9);
  out.set(h.subarray(0, 8));
  out[8] = 1;

  // The 8x8 system stays solvable even when no real homography exists, e.g. when
  // three of the four dragged corners end up collinear: it returns a rank-deficient
  // matrix that collapses the plane onto a line. Reject that here rather than let
  // the overlay draw a mat squashed to a streak.
  if (!isNonDegenerate(out)) return null;
  return out;
}

/** Scale-invariant check that H maps the plane onto a plane, not a line. */
function isNonDegenerate(h: Homography): boolean {
  const det =
    h[0] * (h[4] * h[8] - h[5] * h[7]) -
    h[1] * (h[3] * h[8] - h[5] * h[6]) +
    h[2] * (h[3] * h[7] - h[4] * h[6]);
  let norm = 0;
  for (let i = 0; i < 9; i++) norm += h[i] * h[i];
  const scale = Math.sqrt(norm / 3) ** 3;
  return scale > 0 && Math.abs(det) / scale > 1e-8;
}

/** Gaussian elimination with partial pivoting. Returns null if singular. */
function solve8(a: Float64Array, b: Float64Array): Float64Array | null {
  const n = 8;
  const m = Float64Array.from(a);
  const rhs = Float64Array.from(b);

  for (let col = 0; col < n; col++) {
    let pivot = col;
    let best = Math.abs(m[col * n + col]);
    for (let row = col + 1; row < n; row++) {
      const v = Math.abs(m[row * n + col]);
      if (v > best) {
        best = v;
        pivot = row;
      }
    }
    if (best < 1e-12) return null;

    if (pivot !== col) {
      for (let k = 0; k < n; k++) {
        const tmp = m[col * n + k];
        m[col * n + k] = m[pivot * n + k];
        m[pivot * n + k] = tmp;
      }
      const t = rhs[col];
      rhs[col] = rhs[pivot];
      rhs[pivot] = t;
    }

    const diag = m[col * n + col];
    for (let row = col + 1; row < n; row++) {
      const factor = m[row * n + col] / diag;
      if (factor === 0) continue;
      for (let k = col; k < n; k++) m[row * n + k] -= factor * m[col * n + k];
      rhs[row] -= factor * rhs[col];
    }
  }

  const x = new Float64Array(n);
  for (let row = n - 1; row >= 0; row--) {
    let sum = rhs[row];
    for (let k = row + 1; k < n; k++) sum -= m[row * n + k] * x[k];
    x[row] = sum / m[row * n + row];
  }
  return x;
}

/** Project a point. Returns null when it lands on the horizon (w ~ 0). */
export function applyHomography(h: Homography, x: number, y: number): Point | null {
  const w = h[6] * x + h[7] * y + h[8];
  if (Math.abs(w) < 1e-12) return null;
  return {
    x: (h[0] * x + h[1] * y + h[2]) / w,
    y: (h[3] * x + h[4] * y + h[5]) / w,
  };
}

/** Inverse transform, for turning a click on the video back into mat coordinates. */
export function invertHomography(h: Homography): Homography | null {
  const [a, b, c, d, e, f, g, i, j] = h;
  const det =
    a * (e * j - f * i) - b * (d * j - f * g) + c * (d * i - e * g);
  if (Math.abs(det) < 1e-12) return null;

  const out = new Float64Array(9);
  out[0] = (e * j - f * i) / det;
  out[1] = (c * i - b * j) / det;
  out[2] = (b * f - c * e) / det;
  out[3] = (f * g - d * j) / det;
  out[4] = (a * j - c * g) / det;
  out[5] = (c * d - a * f) / det;
  out[6] = (d * i - e * g) / det;
  out[7] = (b * g - a * i) / det;
  out[8] = (a * e - b * d) / det;
  return out;
}

/**
 * Canvas transform that maps the unit square onto the calibrated quad.
 *
 * A 2D context can only do affine transforms, so a true projective warp needs
 * either WebGL or a subdivision. Returns the matrix only when the quad is close
 * enough to affine (a parallelogram) for the error to stay sub-pixel; otherwise
 * returns null and the caller subdivides.
 */
export function affineApproximation(
  h: Homography,
  tolerancePx: number,
  scaleX: number,
  scaleY: number,
): [number, number, number, number, number, number] | null {
  const p00 = applyHomography(h, 0, 0);
  const p10 = applyHomography(h, 1, 0);
  const p01 = applyHomography(h, 0, 1);
  const p11 = applyHomography(h, 1, 1);
  if (!p00 || !p10 || !p01 || !p11) return null;

  // In a parallelogram the fourth corner is p10 + p01 - p00.
  const predictedX = p10.x + p01.x - p00.x;
  const predictedY = p10.y + p01.y - p00.y;
  const errX = Math.abs(predictedX - p11.x) * scaleX;
  const errY = Math.abs(predictedY - p11.y) * scaleY;
  if (Math.hypot(errX, errY) > tolerancePx) return null;

  return [
    (p10.x - p00.x) * scaleX,
    (p10.y - p00.y) * scaleY,
    (p01.x - p00.x) * scaleX,
    (p01.y - p00.y) * scaleY,
    p00.x * scaleX,
    p00.y * scaleY,
  ];
}

/** Calibration as stored: mat-quad corners in normalised video coordinates. */
export interface MatCalibration {
  /** Clockwise from the mat's top-left, each component 0..1. */
  corners: [Point, Point, Point, Point];
  /** Session this was captured in, so a reused calibration can be labelled. */
  sourceStem?: string;
}

export const UNIT_SQUARE: readonly Point[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

/** Homography taking mat grid coordinates (0..1) to normalised video coordinates. */
export function calibrationToHomography(cal: MatCalibration): Homography | null {
  return computeHomography(UNIT_SQUARE, cal.corners);
}
