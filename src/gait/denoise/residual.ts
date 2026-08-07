import { DN_NEIGHBOR_RISE_RATIO, DN_PEAK_DECAY, DN_RELEASE_FRAC } from "./constants.js";

/**
 * Stage E — hysteresis tail suppression.
 * Liftoff when force drops below release_frac × recent peak (not full zero).
 */
export class ResidualSuppressor {
  private readonly peak: Float32Array;
  private readonly prev: Float32Array;
  private readonly n: number;
  private readonly rows: number;
  private readonly cols: number;

  constructor(rows: number, cols: number) {
    this.rows = rows;
    this.cols = cols;
    this.n = rows * cols;
    this.peak = new Float32Array(this.n);
    this.prev = new Float32Array(this.n);
  }

  reset(): void {
    this.peak.fill(0);
    this.prev.fill(0);
  }

  apply(
    pressure: Float32Array,
    passMask: Uint8Array,
    out: Float32Array,
    removed: Uint8Array,
  ): boolean {
    let flagResidual = false;
    const { rows, cols, n } = this;

    for (let i = 0; i < n; i++) {
      const v = pressure[i]!;
      if (!passMask[i] || v <= 0) {
        this.peak[i] = this.peak[i]! * DN_PEAK_DECAY;
        this.prev[i] = 0;
        out[i] = 0;
        continue;
      }

      const pk = Math.max(this.peak[i]!, v);
      this.peak[i] = pk;
      const rel = DN_RELEASE_FRAC * pk;
      const r = (i / cols) | 0;
      const c = i % cols;
      const neighborRising = this.neighborRising(pressure, passMask, rows, cols, r, c, v);

      if (pk > rel * 1.2 && v < rel && v <= this.prev[i]! && !neighborRising) {
        out[i] = 0;
        removed[i] = 1;
        flagResidual = true;
        this.prev[i] = v;
        continue;
      }

      out[i] = v;
      removed[i] = 0;
      this.prev[i] = v;
    }
    return flagResidual;
  }

  private neighborRising(
    pressure: Float32Array,
    passMask: Uint8Array,
    rows: number,
    cols: number,
    r: number,
    c: number,
    v: number,
  ): boolean {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const ni = nr * cols + nc;
        if (!passMask[ni]) continue;
        if (pressure[ni]! > v * DN_NEIGHBOR_RISE_RATIO) return true;
      }
    }
    return false;
  }
}
