import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_RECORD_SEC,
  MIN_RECORD_SEC,
  clampRecordSec,
} from "../src/settings/persist.js";

// 상한은 "종료 신호를 못 받았을 때 폰이 스스로 멈추는" 안전장치다. 화면에서 고른 값이
// 그대로 서버로 가고 서버가 다시 clamp 하므로, 두 쪽 규칙이 같아야 값이 튀지 않는다.
test("촬영 상한은 10초 단위로 10~180초 안에 들어온다", () => {
  assert.equal(clampRecordSec(30), 30);
  assert.equal(clampRecordSec(45), 50);
  assert.equal(clampRecordSec(1), MIN_RECORD_SEC);
  assert.equal(clampRecordSec(9999), MAX_RECORD_SEC);
  assert.equal(clampRecordSec("abc"), 30, "이상한 값은 기본값 30초");
  assert.equal(clampRecordSec(0), 30);
});
