/** Shared types for the pressure-mat pipeline. */

/** A 40x40 grid stored row-major as Float64. Use helpers in matrix.ts to index. */
export type Matrix = Float64Array;

/** Orientation transforms applied to the raw matrix before calibration. */
export interface OrientationConfig {
  /** rotated[col][R-1-row] = raw[row][col] — maps stored to display orientation. */
  rotate90: boolean;
  flipHorizontal: boolean;
  flipVertical: boolean;
}

export type PressureFormula = "piecewise_linear" | "linear_scale" | "relative";

export interface PressureThresholds {
  visible_min_mmhg: number; // below this -> not shown / excluded from stats
  medium_min_mmhg: number;
  high_min_mmhg: number;
}

/**
 * Gait-analysis tuning. The ported paw-gait-engine defaults to a denser 72x80
 * grid tuned for ~200-count loaded cells; this block adapts it to the 40x40 mat
 * (larger cells -> a paw covers fewer cells) and normalises the inverted-raw
 * delta onto the engine's expected magnitude.
 */
export interface GaitConfig {
  rows: number;
  cols: number;
  /** Minimum connected-cell area to accept a blob as a paw (40x40 cells). */
  min_paw_area: number;
  /** Max cell distance to match the same paw frame-to-frame. */
  max_track_distance: number;
  /** Morphological closing kernel (3 or 5) to merge fragmented paw blobs. */
  morphology_kernel: number;
  /** Contact cycles required before the engine commits paw labels. */
  min_cycles_before_classify: number;
  /** Adaptive normalisation: map the Nth percentile delta onto this peak. */
  normalize_target_peak: number;
  normalize_percentile: number;
  /** Fixed delta->engine scale; when set (>0) it overrides adaptive scaling. */
  pressure_scale: number | null;
  /** Default dog weight (kg) used to seed the sensitivity profile. */
  default_weight_kg: number;
}

/**
 * Paw-label overlay (LF/RF/LH/RH boxes) shown live and burned into the exported
 * GIF / peak PNG. The labelling itself comes from the gait engine; this block
 * only controls the visualisation + the live adaptive-scale behaviour.
 */
export interface PawOverlayConfig {
  /** Master switch for the LIVE overlay (exports always annotate). */
  enabled: boolean;
  /** Also draw grey boxes for real contacts without a confident L/R-F/H label.
   *  false = only show fully classified LF/RF/LH/RH paws (cleanest). */
  show_unknown: boolean;
  /** Annotated GIF output width (height derived as width × MAT_ASPECT). */
  gif_width: number;
  gif_height: number;
  /** Cap GIF frame count (strided) to bound file size. */
  gif_max_frames: number;
  /** Annotated peak-footprint PNG size. */
  png_width: number;
  png_height: number;
  /** Live running-peak decay per frame (adaptive delta->engine scale). */
  live_scale_decay: number;
  /** Live: ignore frames whose running peak delta is below this (empty mat). */
  live_min_peak: number;
  /** Live: peak must fall below live_min_peak × this to treat the mat as unloaded. */
  live_unload_peak_ratio: number;
  /** Live: total delta sum must fall below load threshold × this to unload. */
  live_unload_sum_ratio: number;
  /** Live: minimum track persistence before drawing a box (often stricter than export). */
  live_min_track_frames: number;
  /** Live: hide grey unknown boxes until walk direction is established. */
  live_require_tracking_for_unknown: boolean;

  // --- Contact-quality gates: only annotate REAL, sustained paw contacts ----
  /** Only draw a paw while it is actually in contact (engine hysteresis). */
  require_contact: boolean;
  /** Minimum contact area (grid cells) to annotate — drops 1-2 cell specks. */
  min_contact_area: number;
  /** Minimum contact peak as a fraction of `gait.normalize_target_peak`
   *  (engine magnitude) — drops faint touches. */
  min_contact_peak_frac: number;
  /** Live: a track must persist this many frames before it is drawn. */
  min_track_frames: number;
  /** Minimum stance duration (s) for a contact to count as a real footfall. */
  min_contact_sec: number;
}

export interface AppConfig {
  /** "piecewise_linear" (production) | "linear_scale" (test) | "relative" (uncalibrated). */
  formula: PressureFormula;
  /** delta ranges for piecewise linear, e.g. [[0,300],[300,800],...]. */
  x_ranges: Array<[number, number]>;
  /** [a, b] per range: pressureMmHg = a*delta + b. */
  coefficients: Array<[number, number]>;
  /** test-mode scale: pressureMmHg = delta * scale. */
  scale: number;
  pressure_range: [number, number];
  colorbar_range: [number, number];
  pressure_thresholds: PressureThresholds;
  orientation: OrientationConfig;
  baseline: {
    /** seconds of unloaded frames to collect for the per-cell median baseline. */
    collect_seconds: number;
    /** raw value assumed when uncalibrated (no baseline yet). */
    fallback_raw: number;
  };
  noise: {
    /** raw-count dead-band subtracted from delta (kills baseline jitter). */
    deadband_raw: number;
    /** apply a 3x3 spatial median to the RAW frame (removes single-pixel spikes). */
    spatial_median: boolean;
    /** drop visible cells with fewer than this many visible 8-neighbours. */
    min_active_neighbors: number;
  };
  smoothing: {
    ema_alpha: number; // default 0.45
    ema_alpha_rising: number; // up to 0.6 when current > previous
    fade_out_ms: number; // 300
  };
  render: {
    // Offscreen CPU resolution. The blur runs on the 40x40 grid, so this only
    // controls gradient smoothness before the GPU upscales to screen; 200x400 is
    // plenty (1:2). Larger = smoother but more putImageData/compositing cost.
    upsample_width: number;
    upsample_height: number;
    // Pressure-ADAPTIVE blur radius (cells). Low pressures blur by sigma_min,
    // high pressures by sigma_max, scaled over [visible_min .. colorbar high].
    // Set sigma_max = 0 to disable blur entirely (sharp). sigma_min == sigma_max
    // gives a uniform (pressure-independent) blur.
    gaussian_sigma_min: number;
    gaussian_sigma_max: number;
    // "nearest" = crisp per-sensor blocks (most accurate localisation);
    // "bilinear" = smooth gradients between cells.
    interpolation: "nearest" | "bilinear";
    target_fps: number; // paint cap (processing always runs at full input Hz)
    show_grid: boolean; // debug only
  };
  /** Gait-analysis tuning (engine geometry, normalisation, weight default). */
  gait: GaitConfig;
  /** Paw-label overlay (live + exports). */
  paw_overlay: PawOverlayConfig;
  /** Camera sync + AI results API (talktail_gait back). */
  sync: SyncConfig;
}

/** Web ↔ mobile sync hub + stored results API. */
export interface SyncConfig {
  enabled: boolean;
  /** HTTP base for `/api/results/*` and job polling. Empty → env / dev proxy. */
  apiBaseUrl: string;
  /** WebSocket hub URL. Empty → derived from apiBaseUrl + `/ws`. */
  wsUrl: string;
  roomId: string;
}

/** Whether the pressure scale is physically calibrated or relative. */
export type CalibrationState = "calibrated" | "uncalibrated";

/** Result of converting one raw matrix to pressure. NaN == below threshold. */
export interface PressureFrame {
  /** mmHg (or relative units) per cell, row-major; NaN where below visible_min. */
  pressure: Matrix;
  state: CalibrationState;
  /** unit label for the UI: "mmHg" when calibrated, "rel" otherwise. */
  unit: string;
}

export interface FrameStats {
  activeCellCount: number;
  maxPressure: number;
  avgPressure: number;
  contactAreaCm2: number;
  mediumAreaCm2: number;
  highAreaCm2: number;
}
