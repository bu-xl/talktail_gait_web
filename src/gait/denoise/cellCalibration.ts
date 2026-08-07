import {
  DN_CALIBRATION_MIN_FRAMES,
  DN_K_SIGMA,
  DN_LOW_PERCENTILE,
  DN_NOISY_SIGMA_RATIO,
  DN_THRESHOLD_FLOOR,
} from "./constants.js";
import type { CellCalibrationMaps } from "./types.js";

/**
 * Stage A — per-cell baseline / noise model from unloaded samples.
 * Uses lower-quantile samples per cell (not global 4095 assumption).
 */
export class CellNoiseCalibrator {
  private readonly n: number;
  private readonly rows: number;
  private readonly cols: number;
  private readonly samples: number[][];
  private readonly sampleCount: Uint16Array;
  private framesFed = 0;
  private finalized = false;

  readonly thrCell: Float32Array;
  readonly sigmaCell: Float32Array;
  readonly noisyCellMap: Uint8Array;

  constructor(rows: number, cols: number) {
    this.rows = rows;
    this.cols = cols;
    this.n = rows * cols;
    this.thrCell = new Float32Array(this.n);
    this.sigmaCell = new Float32Array(this.n);
    this.noisyCellMap = new Uint8Array(this.n);
    this.samples = Array.from({ length: this.n }, () => []);
    this.sampleCount = new Uint16Array(this.n);
    this.thrCell.fill(DN_THRESHOLD_FLOOR);
    this.sigmaCell.fill(1);
  }

  reset(): void {
    for (const arr of this.samples) arr.length = 0;
    this.sampleCount.fill(0);
    this.framesFed = 0;
    this.finalized = false;
    this.thrCell.fill(DN_THRESHOLD_FLOOR);
    this.sigmaCell.fill(1);
    this.noisyCellMap.fill(0);
  }

  /**
   * Feed one frame of pressure (post-baseline-subtraction).
   * Samples below `idleThreshold` are treated as unloaded for that cell.
   */
  feed(pressure: Float32Array, idleThreshold: number): void {
    if (this.finalized) return;
    const cap = 64;
    for (let i = 0; i < this.n; i++) {
      const v = pressure[i]!;
      if (v > idleThreshold) continue;
      const cnt = this.sampleCount[i]!;
      if (cnt >= cap) continue;
      this.samples[i]!.push(v);
      this.sampleCount[i] = cnt + 1;
    }
    this.framesFed++;
    if (this.framesFed >= DN_CALIBRATION_MIN_FRAMES) this.finalize();
  }

  finalize(): CellCalibrationMaps {
    const sigmas: number[] = [];
    for (let i = 0; i < this.n; i++) {
      const arr = this.samples[i]!;
      if (arr.length < 3) {
        this.sigmaCell[i] = 1;
        this.thrCell[i] = DN_THRESHOLD_FLOOR;
        continue;
      }
      const sorted = [...arr].sort((a, b) => a - b);
      const cut = Math.max(1, Math.floor(sorted.length * DN_LOW_PERCENTILE));
      const low = sorted.slice(0, cut);
      const mean = low.reduce((a, b) => a + b, 0) / low.length;
      let varSum = 0;
      for (const v of low) varSum += (v - mean) ** 2;
      const sigma = Math.sqrt(varSum / Math.max(low.length - 1, 1)) || 1;
      this.sigmaCell[i] = sigma;
      this.thrCell[i] = Math.max(DN_THRESHOLD_FLOOR, DN_K_SIGMA * sigma);
      sigmas.push(sigma);
    }

    const medSigma =
      sigmas.length > 0
        ? sigmas.sort((a, b) => a - b)[Math.floor(sigmas.length / 2)]!
        : 1;
    let noisy = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.sigmaCell[i]! > medSigma * DN_NOISY_SIGMA_RATIO) {
        this.noisyCellMap[i] = 1;
        noisy++;
      }
    }

    this.finalized = true;
    return this.getMaps();
  }

  getMaps(): CellCalibrationMaps {
    return {
      thrCell: this.thrCell,
      sigmaCell: this.sigmaCell,
      noisyCellMap: this.noisyCellMap,
      calibrated: this.finalized,
      calibrationFrames: this.framesFed,
      noisyCellCount: [...this.noisyCellMap].reduce((a, b) => a + b, 0),
    };
  }
}
