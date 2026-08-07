/**
 * Hardware / protocol constants for the 40x40 USB-Serial pressure mat.
 *
 * Confirmed by reverse engineering of the original Qt6 C++ application:
 *   - frame header : 5A 01 95 6C 00 02
 *   - frame size   : 3206 bytes  (6 header + 3200 payload)
 *   - payload      : 1600 little-endian uint16 values (40 x 40 grid)
 *   - raw range    : 0..4095 (12-bit); LOWER raw == HIGHER pressure
 *   - unloaded     : ~4095
 */

/** Frame start marker. */
export const FRAME_HEADER: readonly number[] = [0x5a, 0x01, 0x95, 0x6c, 0x00, 0x02];

export const HEADER_SIZE = 6;
export const PAYLOAD_SIZE = 3200;
export const FRAME_SIZE = 3206; // HEADER_SIZE + PAYLOAD_SIZE
export const SENSOR_COUNT = 1600;
export const GRID_ROWS = 40;
export const GRID_COLS = 40;

/** 12-bit ADC ceiling. */
export const RAW_MAX = 4095;

/**
 * Physical mat geometry (cm). The cells are NON-square: a column step (width) is
 * narrow, a row step (height) is tall. Measured pitch is 1.825 cm × 4.2 cm, so
 * the 40×40 active area is portrait 73 × 168 cm = **1 : 2.3014** (never 1:1, and
 * the old 1:2 was an approximation). All rendering must use this true ratio or
 * footprints look squashed horizontally.
 */
export const COL_PITCH_CM = 1.825; // width of one column (cm)
export const ROW_PITCH_CM = 4.2; // height of one row (cm)
export const MAT_WIDTH_CM = GRID_COLS * COL_PITCH_CM; // 73.0
export const MAT_HEIGHT_CM = GRID_ROWS * ROW_PITCH_CM; // 168.0
export const CELL_WIDTH_CM = COL_PITCH_CM; // 1.825
export const CELL_HEIGHT_CM = ROW_PITCH_CM; // 4.2
export const CELL_AREA_CM2 = COL_PITCH_CM * ROW_PITCH_CM; // 7.665

/** Row:column stretch = cell height : width. Output height = width × MAT_ASPECT. */
export const MAT_ASPECT = MAT_HEIGHT_CM / MAT_WIDTH_CM; // 2.3014 (H : W)
/** Display aspect width:height (portrait). */
export const DISPLAY_ASPECT = MAT_WIDTH_CM / MAT_HEIGHT_CM; // 0.4345 (W : H)

/** Height (px) for a given width that preserves the physical aspect (square px). */
export function aspectHeight(width: number): number {
  return Math.round(width * MAT_ASPECT);
}

/** Output size (px) at a given resolution so every pixel is physically square. */
export function matPixelSize(pxPerCm: number): { width: number; height: number } {
  return {
    width: Math.round(MAT_WIDTH_CM * pxPerCm),
    height: Math.round(MAT_HEIGHT_CM * pxPerCm),
  };
}
