import { FRAME_HEADER, HEADER_SIZE, PAYLOAD_SIZE, SENSOR_COUNT } from "../src/core/constants.js";

/** Build a valid 3206-byte frame from 1600 raw uint16 values (little-endian). */
export function buildFrame(values: number[]): Uint8Array {
  if (values.length !== SENSOR_COUNT) throw new Error("need 1600 values");
  const frame = new Uint8Array(HEADER_SIZE + PAYLOAD_SIZE);
  frame.set(FRAME_HEADER, 0);
  const view = new DataView(frame.buffer, HEADER_SIZE, PAYLOAD_SIZE);
  for (let i = 0; i < values.length; i++) view.setUint16(i * 2, values[i] & 0xffff, true);
  return frame;
}

/** A mostly-unloaded frame (~4095) with an optional loaded blob. */
export function unloadedValues(load?: { index: number; value: number }): number[] {
  const v = new Array<number>(SENSOR_COUNT).fill(4095);
  if (load) v[load.index] = load.value;
  return v;
}

export function concat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}
