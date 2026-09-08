import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkDogNameForFilename,
  downloadName,
  formatWeightTag,
  parseStamp,
  pressureCsvName,
  roleOrder,
  sanitizeDogName,
  stampFrom,
  taskName,
  videoBaseName,
} from "../src/core/sessionNaming.js";

const STAMP = "260819-144204";

test("저장 이름에는 개 이름·몸무게가 들어가지 않는다", () => {
  assert.equal(taskName({ dogId: 37, stamp: STAMP }), "260819-144204-37");
  assert.equal(videoBaseName({ dogId: 37, role: "main", stamp: STAMP }), "260819-144204-37-main");
  assert.equal(
    videoBaseName({ dogId: 37, role: "sub", subIndex: 2, stamp: STAMP }),
    "260819-144204-37-sub2",
  );
  // CSV 는 역할 꼬리가 없다 — 확장자가 이미 종류를 말한다.
  assert.equal(pressureCsvName({ dogId: 37, stamp: STAMP }), "260819-144204-37.csv");
});

test("back 의 naming.js 와 같은 도장을 만든다", () => {
  const when = new Date(2026, 7, 19, 14, 42, 4);
  assert.equal(stampFrom(when), STAMP);
  const back = parseStamp(STAMP);
  assert.ok(back);
  assert.equal(back?.getTime(), when.getTime());
});

test("역할 순서 — main 이 sub 보다 앞", () => {
  assert.equal(roleOrder("260819-144204-37-main.mp4"), 0);
  assert.equal(roleOrder("260819-144204-37-sub2.mp4"), 2);
  // CSV 처럼 역할이 없는 이름은 뒤로 민다.
  assert.equal(roleOrder("260819-144204-37.csv"), 999);
});

test("다운로드 이름 재조립 — 서버가 만드는 값과 같아야 한다", () => {
  const dog = { name: "대박이", weightKg: 5.2 };
  assert.equal(
    downloadName("260819-144204-37-main.mp4", dog),
    "260819-144204-대박이-5.2kg-main.mp4",
  );
  assert.equal(downloadName("260819-144204-37.csv", dog), "260819-144204-대박이-5.2kg.csv");
  // 1kg 미만도 표현된다 — 몸무게가 개체 식별의 일부라 반올림이 정본이다(§3-2-A).
  assert.equal(formatWeightTag(0.66), "0.66kg");
  assert.equal(formatWeightTag(5.0), "5kg");
  // 규칙 밖의 이름은 **그대로 돌려준다** — 내보내기가 실패하는 것보다 낫다.
  assert.equal(downloadName("weird.mp4", dog), "weird.mp4");
});

test("파일명에 못 쓰는 이름은 다운로드 직전에 걸러 낸다 (입력은 막지 않는다)", () => {
  assert.equal(checkDogNameForFilename("대박이").ok, true);
  assert.equal(checkDogNameForFilename("대/박이").reason, "forbidden");
  assert.equal(checkDogNameForFilename("   ").reason, "empty");
  assert.equal(checkDogNameForFilename("가".repeat(41)).reason, "too_long");
  // 정리 결과가 비면 접두어 없이 도장만 남는다.
  assert.equal(sanitizeDogName("///"), "");
});
