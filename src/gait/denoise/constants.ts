/** σ multiplier for per-cell adaptive threshold (Stage A/B). */
export const DN_K_SIGMA = 4.5;

/** Minimum per-cell threshold (engine delta units). */
export const DN_THRESHOLD_FLOOR = 5;

/** Fraction of samples treated as unloaded per cell during calibration. */
export const DN_LOW_PERCENTILE = 0.4;

/** Liftoff / residual: force below this × recent peak → residual (Stage E). */
export const DN_RELEASE_FRAC = 0.3;

/** Weak-candidate must persist this many frames (Stage D). */
export const DN_PERSIST_FRAMES = 3;

/** Gap-bridging for weak-candidate persistence. */
export const DN_MAX_GAP_FRAMES = 2;

/** Strong blob min cells before scale calibration is available. */
export const DN_MIN_CELLS_DEFAULT = 2;

/** Weak (1-cell) candidate minimum size. */
export const DN_WEAK_MIN_CELLS = 1;

/** Frames to accumulate per-cell noise before calibration locks. */
export const DN_CALIBRATION_MIN_FRAMES = 12;

/** Cells with σ above this × median σ are flagged noisy. */
export const DN_NOISY_SIGMA_RATIO = 3.0;

/** Spatial key quantisation for weak-candidate tracker (cells). */
export const DN_PERSIST_CELL_RADIUS = 1;

/** Peak decay per frame when cell is off (residual tracker). */
export const DN_PEAK_DECAY = 0.92;

/** Neighbor rise threshold for residual guard (fraction of cell value). */
export const DN_NEIGHBOR_RISE_RATIO = 1.15;
