/** Per-session cell noise calibration (Stage A output). */
export interface CellCalibrationMaps {
  readonly thrCell: Float32Array;
  readonly sigmaCell: Float32Array;
  readonly noisyCellMap: Uint8Array;
  readonly calibrated: boolean;
  readonly calibrationFrames: number;
  readonly noisyCellCount: number;
}

/** Per-frame denoise provenance (Stage F). */
export interface DenoiseFrameMeta {
  readonly flagResidual: boolean;
  readonly removedCellCount: number;
  readonly strongBlobCount: number;
  readonly weakApprovedCount: number;
}

/** Session-level denoise diagnostics. */
export interface DenoiseMeta {
  readonly calibrated: boolean;
  readonly calibrationFrames: number;
  readonly noisyCellCount: number;
  readonly totalRemovedCells: number;
  readonly residualFrameCount: number;
}
