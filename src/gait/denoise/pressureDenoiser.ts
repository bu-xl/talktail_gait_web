import type { PawGaitConfig } from "../types.js";
import { CellNoiseCalibrator } from "./cellCalibration.js";
import { findComponents } from "./components.js";
import {
  DN_MIN_CELLS_DEFAULT,
  DN_PERSIST_FRAMES,
  DN_THRESHOLD_FLOOR,
  DN_WEAK_MIN_CELLS,
} from "./constants.js";
import { WeakCandidateTracker } from "./persistence.js";
import { ResidualSuppressor } from "./residual.js";
import type { DenoiseFrameMeta, DenoiseMeta } from "./types.js";

/**
 * §1.5 — Analysis-path pressure denoising (Stages A–F).
 *
 * Input: preprocessed delta pressure (Preprocessor output). Original buffer is NOT modified.
 * Output: pressure_denoised in separate buffer + removed_mask for audit.
 *
 * Three orthogonal gates (amplitude × spatial × temporal):
 *   B — per-cell adaptive threshold
 *   C — connected-component size (weak → deferred)
 *   D — temporal persistence for sub-min_cells candidates
 *   E — hysteresis residual suppression at liftoff
 */
export class PressureDenoiser {
  private readonly rows: number;
  private readonly cols: number;
  private readonly n: number;
  private readonly calibrator: CellNoiseCalibrator;
  private readonly weakTracker: WeakCandidateTracker;
  private readonly residual: ResidualSuppressor;
  private readonly candidateMask: Uint8Array;
  private readonly passMask: Uint8Array;
  private readonly globalFloor: number;

  private minCells = DN_MIN_CELLS_DEFAULT;
  private totalRemoved = 0;
  private residualFrames = 0;

  constructor(cfg: PawGaitConfig) {
    this.rows = cfg.rows;
    this.cols = cfg.cols;
    this.n = cfg.rows * cfg.cols;
    this.globalFloor = Math.max(DN_THRESHOLD_FLOOR, cfg.noiseThreshold);
    this.calibrator = new CellNoiseCalibrator(cfg.rows, cfg.cols);
    this.weakTracker = new WeakCandidateTracker();
    this.residual = new ResidualSuppressor(cfg.rows, cfg.cols);
    this.candidateMask = new Uint8Array(this.n);
    this.passMask = new Uint8Array(this.n);
  }

  reset(): void {
    this.calibrator.reset();
    this.weakTracker.reset();
    this.residual.reset();
    this.minCells = DN_MIN_CELLS_DEFAULT;
    this.totalRemoved = 0;
    this.residualFrames = 0;
  }

  /** Update min_cells from scale calibration (§8.1). */
  setMinCells(cells: number): void {
    this.minCells = Math.max(DN_WEAK_MIN_CELLS, Math.round(cells));
  }

  /**
   * Stage F — non-destructive denoise pass.
   * @param pressure — preprocessed input (unchanged)
   * @param removedMask — 1 where a cell was zeroed by denoiser
   */
  process(
    pressure: Float32Array,
    frameIdx: number,
    out: Float32Array,
    removedMask: Uint8Array,
  ): DenoiseFrameMeta {
    const { n, rows, cols } = this;
    out.fill(0);
    removedMask.fill(0);

    // Stage A — accumulate unloaded samples until calibrated
    if (!this.calibrator.getMaps().calibrated) {
      this.calibrator.feed(pressure, this.globalFloor * 2);
    }
    const maps = this.calibrator.getMaps();

    // Stage B — per-cell adaptive threshold (no global-only gate)
    this.candidateMask.fill(0);
    for (let i = 0; i < n; i++) {
      if (maps.noisyCellMap[i]) continue;
      const thr = maps.calibrated ? maps.thrCell[i]! : this.globalFloor;
      if (pressure[i]! > thr) this.candidateMask[i] = 1;
    }

    // Stage C — spatial connectivity; weak blobs deferred to Stage D
    this.passMask.fill(0);
    const components = findComponents(this.candidateMask, pressure, rows, cols);
    let strongCount = 0;
    let weakApproved = 0;

    for (const comp of components) {
      if (comp.size >= this.minCells) {
        strongCount++;
        for (const idx of comp.indices) this.passMask[idx] = 1;
        continue;
      }
      if (comp.size < DN_WEAK_MIN_CELLS) continue;

      const approved = this.weakTracker.observe(
        comp.centroidRow,
        comp.centroidCol,
        frameIdx,
        comp.peak,
      );
      if (approved) {
        weakApproved++;
        for (const idx of comp.indices) this.passMask[idx] = 1;
      }
    }
    this.weakTracker.pruneBefore(frameIdx, DN_PERSIST_FRAMES + 4);

    // Stage E — residual / hysteresis tail
    const flagResidual = this.residual.apply(pressure, this.passMask, out, removedMask);
    if (flagResidual) this.residualFrames++;

    let removedCellCount = 0;
    for (let i = 0; i < n; i++) {
      if (removedMask[i]) removedCellCount++;
      if (pressure[i]! > 0 && out[i]! === 0) removedCellCount++;
    }
    this.totalRemoved += removedCellCount;

    return {
      flagResidual,
      removedCellCount,
      strongBlobCount: strongCount,
      weakApprovedCount: weakApproved,
    };
  }

  getMeta(): DenoiseMeta {
    const maps = this.calibrator.getMaps();
    return {
      calibrated: maps.calibrated,
      calibrationFrames: maps.calibrationFrames,
      noisyCellCount: maps.noisyCellCount,
      totalRemovedCells: this.totalRemoved,
      residualFrameCount: this.residualFrames,
    };
  }

  /** Expose calibration maps for debug / export (Stage F provenance). */
  getCalibrationMaps() {
    return this.calibrator.getMaps();
  }
}
