import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parsePayloadToValues,
  SerialFrameParser,
  validateRawMatrix,
} from "../src/core/serialParser.js";
import { FRAME_SIZE, SENSOR_COUNT } from "../src/core/constants.js";
import { buildFrame, concat, unloadedValues } from "./helpers.js";

test("parses one whole frame into a 1600-value matrix", () => {
  const p = new SerialFrameParser();
  const matrices = p.appendChunk(buildFrame(unloadedValues({ index: 5, value: 1000 })));
  assert.equal(matrices.length, 1);
  assert.equal(matrices[0].length, SENSOR_COUNT);
  assert.equal(matrices[0][5], 1000);
  assert.equal(matrices[0][0], 4095);
});

test("little-endian uint16: bytes ff 0f -> 4095", () => {
  const payload = new Uint8Array([0xff, 0x0f, 0xc6, 0x0f]); // 4095, 4038
  const v = parsePayloadToValues(payload);
  assert.equal(v[0], 4095);
  assert.equal(v[1], 4038);
});

test("discards garbage before the header and resyncs", () => {
  const p = new SerialFrameParser();
  const garbage = new Uint8Array([1, 2, 3, 0x5a, 0x99]); // includes a false 0x5A
  const frame = buildFrame(unloadedValues());
  const matrices = p.appendChunk(concat(garbage, frame));
  assert.equal(matrices.length, 1);
  assert.equal(p.stats.bytesDiscarded, garbage.length);
});

test("accumulates a frame split across multiple chunks", () => {
  const p = new SerialFrameParser();
  const frame = buildFrame(unloadedValues({ index: 10, value: 2000 }));
  const a = frame.subarray(0, 1000);
  const b = frame.subarray(1000, 2500);
  const c = frame.subarray(2500);
  assert.equal(p.appendChunk(a).length, 0);
  assert.equal(p.appendChunk(b).length, 0);
  const out = p.appendChunk(c);
  assert.equal(out.length, 1);
  assert.equal(out[0][10], 2000);
});

test("emits multiple frames present in one buffer", () => {
  const p = new SerialFrameParser();
  const buf = concat(buildFrame(unloadedValues()), buildFrame(unloadedValues({ index: 0, value: 7 })));
  const out = p.appendChunk(buf);
  assert.equal(out.length, 2);
  assert.equal(out[1][0], 7);
});

test("preserves a partial header split across the chunk boundary", () => {
  const p = new SerialFrameParser();
  const frame = buildFrame(unloadedValues());
  // First chunk ends mid-header (first 3 header bytes), rest arrives next.
  const first = frame.subarray(0, 3);
  const rest = frame.subarray(3);
  assert.equal(p.appendChunk(first).length, 0);
  assert.equal(p.buffered, 3); // partial header kept, not discarded
  const out = p.appendChunk(rest);
  assert.equal(out.length, 1);
  assert.equal(p.stats.bytesDiscarded, 0);
});

test("does not drop a sub-frame chunk", () => {
  const p = new SerialFrameParser();
  const frame = buildFrame(unloadedValues());
  p.appendChunk(frame.subarray(0, FRAME_SIZE - 1));
  assert.equal(p.buffered, FRAME_SIZE - 1);
});

test("validateRawMatrix accepts unloaded ~4095 frame", () => {
  const m = Float64Array.from(unloadedValues());
  assert.equal(validateRawMatrix(m).ok, true);
});
