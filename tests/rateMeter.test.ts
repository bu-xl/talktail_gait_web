import assert from "node:assert/strict";
import { test } from "node:test";

import { RateMeter, getSerialDisplayHz } from "../src/core/stats.js";

test("measures a steady 40 Hz arrival rate", () => {
  const m = new RateMeter(1000);
  let now = 0;
  let hz = 0;
  // 80 frames at 25 ms spacing == 40 Hz, well past one full window.
  for (let i = 0; i < 80; i++) {
    hz = m.tick(now);
    now += 25;
  }
  assert.ok(Math.abs(hz - 40) < 1, `expected ~40 Hz, got ${hz}`);
  assert.equal(getSerialDisplayHz(m, now - 25), 40);
});

test("measures a steady 60 Hz arrival rate", () => {
  const m = new RateMeter(1000);
  let now = 0;
  let hz = 0;
  for (let i = 0; i < 200; i++) {
    hz = m.tick(now);
    now += 1000 / 60;
  }
  assert.ok(Math.abs(hz - 60) < 1.5, `expected ~60 Hz, got ${hz}`);
});

test("reports 0 Hz before two samples and decays when input stalls", () => {
  const m = new RateMeter(1000);
  assert.equal(m.hz(0), 0); // no samples
  m.tick(0);
  assert.equal(m.hz(0), 0); // single sample -> still 0
  // Fill the window at 40 Hz.
  let now = 0;
  for (let i = 0; i < 60; i++) {
    m.tick(now);
    now += 25;
  }
  assert.ok(m.hz(now) > 35);
  // Stall: 2 s later the window is empty -> rate falls back to 0.
  assert.equal(m.hz(now + 2000), 0);
});

test("window bounds the estimate to recent events only", () => {
  const m = new RateMeter(500); // 0.5 s window
  let now = 0;
  // Old burst far outside the window must not inflate the rate.
  for (let i = 0; i < 10; i++) {
    m.tick(now);
    now += 5;
  }
  now += 5000;
  for (let i = 0; i < 25; i++) {
    m.tick(now);
    now += 20; // 50 Hz inside the window
  }
  assert.ok(Math.abs(m.hz(now - 20) - 50) < 3, `got ${m.hz(now - 20)}`);
});
