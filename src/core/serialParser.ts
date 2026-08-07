/**
 * Stream-safe frame parser for the 40x40 pressure mat.
 *
 * Robustness rules (do NOT assume one chunk == one frame):
 *   - incoming chunks are appended to an internal rxBuffer;
 *   - the header [5A 01 95 6C 00 02] is located inside the buffer;
 *   - any garbage *before* the header is discarded (resync), but a partial
 *     header at the very end is preserved;
 *   - a frame is only emitted once >= 3206 bytes are available from the header;
 *   - multiple frames contained in one buffer are all emitted;
 *   - bytes that may begin the next frame are retained for the next chunk.
 *
 * The payload (3200 bytes) is read as 1600 little-endian uint16 values and
 * reshaped row-major into a 40x40 raw matrix.
 */

import {
  FRAME_HEADER,
  FRAME_SIZE,
  GRID_COLS,
  GRID_ROWS,
  HEADER_SIZE,
  PAYLOAD_SIZE,
  RAW_MAX,
  SENSOR_COUNT,
} from "./constants.js";
import type { Matrix } from "./types.js";

const HEADER = Uint8Array.from(FRAME_HEADER);

/** Find the first index of HEADER in buf at/after `from`, else -1. */
function indexOfHeader(buf: Uint8Array, from = 0): number {
  const last = buf.length - HEADER.length;
  for (let i = from; i <= last; i++) {
    let match = true;
    for (let j = 0; j < HEADER.length; j++) {
      if (buf[i + j] !== HEADER[j]) {
        match = false;
        break;
      }
    }
    if (match) return i;
  }
  return -1;
}

/** Length of the longest suffix of `buf` that is a strict prefix of HEADER. */
function partialHeaderSuffix(buf: Uint8Array): number {
  const maxLen = Math.min(HEADER.length - 1, buf.length);
  for (let len = maxLen; len > 0; len--) {
    let match = true;
    for (let j = 0; j < len; j++) {
      if (buf[buf.length - len + j] !== HEADER[j]) {
        match = false;
        break;
      }
    }
    if (match) return len;
  }
  return 0;
}

export interface ParserStats {
  framesEmitted: number;
  bytesDiscarded: number; // garbage bytes dropped during resync
}

/**
 * Incremental, allocation-conscious frame parser. Feed it raw serial chunks via
 * {@link appendChunk}; it returns any complete raw 40x40 matrices it could
 * extract.
 */
export class SerialFrameParser {
  private rx: Uint8Array = new Uint8Array(0);
  readonly stats: ParserStats = { framesEmitted: 0, bytesDiscarded: 0 };

  /** Number of bytes currently buffered (for tests / diagnostics). */
  get buffered(): number {
    return this.rx.length;
  }

  reset(): void {
    this.rx = new Uint8Array(0);
    this.stats.framesEmitted = 0;
    this.stats.bytesDiscarded = 0;
  }

  /** Append a chunk and return all complete raw matrices now available. */
  appendChunk(chunk: Uint8Array): Matrix[] {
    this.rx = concat(this.rx, chunk);
    return this.extractFrames();
  }

  /** Drain all complete frames currently in the buffer. */
  extractFrames(): Matrix[] {
    const out: Matrix[] = [];
    const buf = this.rx;
    // Walk with a single cursor and compact the buffer ONCE at the end, instead
    // of reallocating the RX buffer on every header/frame boundary. This keeps
    // per-frame work allocation-free when several frames arrive in one chunk.
    let pos = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const headerIdx = indexOfHeader(buf, pos);

      if (headerIdx === -1) {
        // No header in the remaining bytes. Keep only a possible partial header
        // at the tail so a header split across chunk boundaries is not lost.
        const tailLen = buf.length - pos;
        const keep = partialHeaderSuffix(buf.subarray(pos));
        if (tailLen > keep) this.stats.bytesDiscarded += tailLen - keep;
        pos = buf.length - keep;
        break;
      }

      if (headerIdx > pos) {
        // Garbage before the header -> discard it (resync).
        this.stats.bytesDiscarded += headerIdx - pos;
        pos = headerIdx;
      }

      if (buf.length - pos < FRAME_SIZE) break; // wait for more bytes

      out.push(parseFrameToRawMatrix(buf.subarray(pos, pos + FRAME_SIZE)));
      this.stats.framesEmitted += 1;
      pos += FRAME_SIZE;
    }

    // Retain only the unconsumed tail (single slice instead of N slices).
    this.rx = pos === 0 ? buf : buf.slice(pos);
    return out;
  }
}

/** Concatenate two Uint8Arrays. */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b.slice();
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Parse a single 3206-byte frame (header + payload) into a 40x40 raw matrix.
 * Throws if the frame size or sensor count is wrong (validation requirement).
 */
export function parseFrameToRawMatrix(frame: Uint8Array): Matrix {
  if (frame.length < FRAME_SIZE) {
    throw new Error(`Frame too short: ${frame.length} < ${FRAME_SIZE}`);
  }
  const payload = frame.subarray(HEADER_SIZE, HEADER_SIZE + PAYLOAD_SIZE);
  const values = parsePayloadToValues(payload);
  if (values.length !== SENSOR_COUNT) {
    throw new Error(`Expected ${SENSOR_COUNT} values, got ${values.length}`);
  }
  // Row-major: values[row*COLS + col].
  return values;
}

/** Read 3200 payload bytes as 1600 little-endian uint16 values. */
export function parsePayloadToValues(payload: Uint8Array): Matrix {
  const n = payload.length >> 1; // 2 bytes per value
  const out = new Float64Array(n);
  // DataView guarantees little-endian regardless of host endianness.
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  for (let i = 0; i < n; i++) {
    out[i] = view.getUint16(i * 2, /* littleEndian */ true);
  }
  return out;
}

/** Validate a raw matrix: 1600 values, 40x40, mostly within 0..4095. */
export function validateRawMatrix(m: Matrix): { ok: boolean; reason?: string } {
  if (m.length !== SENSOR_COUNT) return { ok: false, reason: `length ${m.length} != ${SENSOR_COUNT}` };
  if (GRID_ROWS * GRID_COLS !== SENSOR_COUNT) return { ok: false, reason: "grid mismatch" };
  let inRange = 0;
  for (let i = 0; i < m.length; i++) {
    if (m[i] >= 0 && m[i] <= RAW_MAX) inRange++;
  }
  const frac = inRange / m.length;
  return frac >= 0.95
    ? { ok: true }
    : { ok: false, reason: `only ${(frac * 100).toFixed(1)}% of values in 0..${RAW_MAX}` };
}
