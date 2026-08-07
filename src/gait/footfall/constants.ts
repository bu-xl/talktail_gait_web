/**
 * Footfall labeling tunables — proportional coefficients only.
 * Absolute cm thresholds are derived from ScaleEstimate (§8).
 */

/** Dog enters from mat TOP (row 0) and progresses toward BOTTOM (+row). */
export const ENTRY_EDGE_TOP = true;

/** Fixed travel sign: +1 = increasing row cm (top → bottom). Do not wait to estimate. */
export const TRAVEL_SIGN_FIXED: 1 | -1 = 1;

/** Regression slope below this (row cm/s) triggers direction_conflict flag. */
export const FF_DIRECTION_CONFLICT_SLOPE = 0.02;

export const FF_K_R_LINK = 0.6;
export const FF_K_TOE_GROUP = 1.0;
export const FF_K_MIN_STANCE_FRAMES = 3;
export const FF_MAX_GAP_FRAMES = 2;
export const FF_MIN_CELLS = 3;
export const FF_NOISE_FLOOR = 150;
export const FF_MIN_PEAK_FORCE = 150;
export const FF_FH_RESOLUTION_PITCH_CM = 4.2;
export const FF_NARROW_STANCE_CELLS = 2;
export const FF_TRAVERSE_R2_MIN = 0.15;
export const FF_SEP_RATIO_TIME_WEIGHT = 0.75;
export const FF_DUPLICATE_LIMB_PENALTY = 10;
export const FF_DEFAULT_PAW_DIAM_CM = 3.5;
export const FF_DEFAULT_STANCE_WIDTH_CM = 8.0;
export const FF_DEFAULT_BODY_LEN_CM = 12.0;

/** Confidence below this → provisional label (UI may show "LF?"). */
export const FF_PROVISIONAL_CONFIDENCE_MAX = 0.62;

/** First N footfalls get weak front-prior when entering from TOP. */
export const FF_ENTRY_FRONT_PRIOR_COUNT = 2;
