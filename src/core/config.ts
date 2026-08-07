/** Config defaults + safe loader/merger. */

import type { AppConfig } from "./types.js";

export const DEFAULT_CONFIG: AppConfig = {
  formula: "relative",
  x_ranges: [
    [0, 300],
    [300, 800],
    [800, 1600],
    [1600, 4095],
  ],
  coefficients: [
    [0, 0],
    [0, 0],
    [0, 0],
    [0, 0],
  ],
  scale: 0.05,
  pressure_range: [0, 80],
  colorbar_range: [10, 80],
  pressure_thresholds: { visible_min_mmhg: 10, medium_min_mmhg: 30, high_min_mmhg: 50 },
  orientation: { rotate90: false, flipHorizontal: false, flipVertical: false },
  baseline: { collect_seconds: 2, fallback_raw: 4095 },
  // Tuned to keep WEAK contacts visible while still dropping lone speckle:
  //  - spatial_median OFF: a 3x3 median erases any contact smaller than ~5 cells,
  //    which wipes out light/small touches. Enable only for severe spike noise.
  //  - min_active_neighbors 1: removes only fully-isolated single cells (true
  //    single-pixel speckle); a 2-cell weak touch (1 neighbour each) survives.
  //  - deadband 20: light jitter suppression without pushing weak touches under
  //    the visible threshold.
  noise: { deadband_raw: 20, spatial_median: false, min_active_neighbors: 1 },
  smoothing: { ema_alpha: 0.45, ema_alpha_rising: 0.6, fade_out_ms: 300 },
  render: {
    // Portrait 1 : 2.3014 (73 × 168 cm). Height = width × MAT_ASPECT; main.ts
    // re-derives it from the width at boot so the ratio can't drift.
    upsample_width: 260,
    upsample_height: 598,
    gaussian_sigma_min: 0.4, // light touch -> tight
    gaussian_sigma_max: 1.6, // hard press -> wider, softer halo
    interpolation: "bilinear",
    target_fps: 60,
    show_grid: false,
  },
  gait: {
    rows: 40,
    cols: 40,
    // 40x40 cells are large (1.825 x 4.2 cm): a small-dog paw covers only a few
    // cells, so the engine's 72x80 defaults (14-20) would reject every paw.
    min_paw_area: 2,
    max_track_distance: 7,
    morphology_kernel: 3,
    min_cycles_before_classify: 2,
    // Map the 98th-percentile delta onto ~200 counts (the engine's native
    // loaded-cell magnitude), so contact thresholds stay meaningful on any mat.
    normalize_target_peak: 200,
    normalize_percentile: 98,
    pressure_scale: null,
    default_weight_kg: 3.5,
  },
  paw_overlay: {
    enabled: true,
    // Cold-start: real-but-unlabelled contacts show as grey "?" (noise is still
    // dropped by the quality gates below), then snap to LF/RF/LH/RH once known.
    show_unknown: true,
    gif_width: 240,
    gif_height: 552, // = round(240 × 2.3014); re-derived from width in code
    gif_max_frames: 160,
    png_width: 360,
    png_height: 828, // = round(360 × 2.3014); re-derived from width in code
    live_scale_decay: 0.985,
    live_min_peak: 120,
    live_unload_peak_ratio: 0.22,
    live_unload_sum_ratio: 0.35,
    live_min_track_frames: 5,
    live_require_tracking_for_unknown: true,
    // Contact-quality gates (balanced): real, sustained paw contacts only.
    require_contact: true,
    min_contact_area: 3,
    min_contact_peak_frac: 0.3,
    min_track_frames: 3,
    min_contact_sec: 0.08,
  },
  sync: {
    enabled: true,
    apiBaseUrl: "http://210.91.154.131:20443/deployment2/41e3dafa47605ab5",
    wsUrl: "",
    roomId: "gait-default",
  },
};

/** Deep-merge a partial config (e.g. parsed config.json) over the defaults. */
export function loadConfig(partial: Partial<AppConfig> | unknown): AppConfig {
  const p = (partial ?? {}) as Partial<AppConfig>;
  return {
    ...DEFAULT_CONFIG,
    ...p,
    pressure_thresholds: {
      ...DEFAULT_CONFIG.pressure_thresholds,
      ...(p.pressure_thresholds ?? {}),
    },
    orientation: { ...DEFAULT_CONFIG.orientation, ...(p.orientation ?? {}) },
    baseline: { ...DEFAULT_CONFIG.baseline, ...(p.baseline ?? {}) },
    noise: { ...DEFAULT_CONFIG.noise, ...(p.noise ?? {}) },
    smoothing: { ...DEFAULT_CONFIG.smoothing, ...(p.smoothing ?? {}) },
    render: { ...DEFAULT_CONFIG.render, ...(p.render ?? {}) },
    gait: { ...DEFAULT_CONFIG.gait, ...(p.gait ?? {}) },
    paw_overlay: { ...DEFAULT_CONFIG.paw_overlay, ...(p.paw_overlay ?? {}) },
    sync: { ...DEFAULT_CONFIG.sync, ...(p.sync ?? {}) },
  };
}
