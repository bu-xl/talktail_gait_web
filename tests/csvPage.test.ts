import assert from "node:assert/strict";
import { test } from "node:test";

import { fileDay, fileTime, matchesCsv } from "../src/ui/csvPage.js";
import type { StoredCsvFile } from "../src/api/storedFilesApi.js";

/**
 * 서버가 주는 한 줄. `stamp`·`dogId`·`downloadName` 은 **서버가 채운다** —
 * 화면이 파일명을 파싱하지 않는 것이 2026-09 재설계의 요지다.
 */
function row(
  dogId: number,
  stamp: string,
  downloadName: string,
  mtime = "2026-01-02T03:04:05.000Z",
): StoredCsvFile {
  const name = `${stamp}-${dogId}.csv`;
  return {
    name,
    key: `${dogId}/${stamp}/${name}`,
    size: 1024,
    mtime,
    url: `/api/files/csv/${dogId}/${stamp}/${name}`,
    dogId,
    stamp,
    downloadName,
  };
}

/** 도장은 촬영 노트북의 로컬 시각이라, 기대값도 로컬로 만든다. */
function localDayOf(y: number, m: number, d: number): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${y}-${p(m)}-${p(d)}`;
}

const ALL = { query: "", from: "", to: "" };

test("기간은 촬영 도장으로 자른다 (mtime 아님)", () => {
  const r = row(37, "260819-144204", "260819-144204-대박이-5.2kg.csv", "2026-12-31T00:00:00.000Z");
  assert.equal(fileDay(r), localDayOf(2026, 8, 19));
  assert.equal(matchesCsv(r, { ...ALL, from: "2026-08-19", to: "2026-08-19" }), true);
  assert.equal(matchesCsv(r, { ...ALL, from: "2026-08-20" }), false);
  assert.equal(matchesCsv(r, { ...ALL, to: "2026-08-18" }), false);
});

test("도장이 깨졌으면 저장 시각으로 물러선다", () => {
  const r = row(37, "bad-stamp", "bad.csv", new Date(2026, 4, 6, 12).toISOString());
  assert.equal(fileDay(r), localDayOf(2026, 5, 6));
  assert.equal(matchesCsv(r, { ...ALL, from: "2026-05-06", to: "2026-05-06" }), true);
});

test("검색은 **받을 때 붙는 이름**에 걸린다 — 디스크 이름에는 개가 없다", () => {
  const r = row(37, "260819-144204", "260819-144204-대박이-5.2kg.csv");
  assert.equal(matchesCsv(r, { ...ALL, query: "대박" }), true);
  assert.equal(matchesCsv(r, { ...ALL, query: "5.2kg" }), true);
  assert.equal(matchesCsv(r, { ...ALL, query: "초코" }), false);
  // 디스크 이름(`260819-144204-37.csv`)만 보면 "대박" 이 안 걸린다 — 그래서 표시 이름을 본다.
  assert.equal(r.name.includes("대박"), false);
});

test("정렬은 촬영 시각 내림차순", () => {
  const rows = [
    row(37, "260819-090000", "a.csv"),
    row(41, "260819-150000", "b.csv"),
  ];
  const sorted = [...rows].sort((a, b) => fileTime(b) - fileTime(a));
  assert.deepEqual(sorted.map((r) => r.stamp), ["260819-150000", "260819-090000"]);
});
