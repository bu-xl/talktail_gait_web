import assert from "node:assert/strict";
import { test } from "node:test";

import { fileDay, fileTime, matchesCsv } from "../src/ui/csvPage.js";
import type { StoredCsvFile } from "../src/api/storedFilesApi.js";

function row(name: string, mtime = "2026-01-02T03:04:05.000Z"): StoredCsvFile {
  return { name, size: 1024, mtime, url: `/files/csv/${name}` };
}

/** 도장은 촬영 노트북의 로컬 시각이라, 기대값도 로컬로 만든다. */
function localDayOf(y: number, m: number, d: number): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${y}-${p(m)}-${p(d)}`;
}

const ALL = { query: "", from: "", to: "" };

test("기간은 파일명 도장의 촬영일로 자른다 (mtime 아님)", () => {
  const r = row("260819-144204-대박이-5.2kg.csv", "2026-12-31T00:00:00.000Z");
  assert.equal(fileDay(r), localDayOf(2026, 8, 19));
  assert.equal(matchesCsv(r, { ...ALL, from: "2026-08-19", to: "2026-08-19" }), true);
  assert.equal(matchesCsv(r, { ...ALL, from: "2026-08-20" }), false);
  assert.equal(matchesCsv(r, { ...ALL, to: "2026-08-18" }), false);
});

test("도장이 없으면 저장 시각으로 물러선다", () => {
  const r = row("random.csv", new Date(2026, 4, 6, 12).toISOString());
  assert.equal(fileDay(r), localDayOf(2026, 5, 6));
  assert.equal(matchesCsv(r, { ...ALL, from: "2026-05-06", to: "2026-05-06" }), true);
});

test("검색은 파일명에 걸린다 — 소문자 질의 기준", () => {
  const r = row("260819-144204-대박이-5.2kg.csv");
  assert.equal(matchesCsv(r, { ...ALL, query: "대박" }), true);
  assert.equal(matchesCsv(r, { ...ALL, query: "5.2kg" }), true);
  assert.equal(matchesCsv(r, { ...ALL, query: "초코" }), false);
});

test("정렬은 촬영 시각 내림차순 — 도장 없는 파일도 섞여 든다", () => {
  const rows = [
    row("260819-090000-a.csv"),
    row("noStamp.csv", new Date(2026, 7, 19, 12).toISOString()),
    row("260819-150000-b.csv"),
  ];
  const sorted = [...rows].sort((a, b) => fileTime(b) - fileTime(a));
  assert.deepEqual(
    sorted.map((r) => r.name),
    ["260819-150000-b.csv", "noStamp.csv", "260819-090000-a.csv"],
  );
});
