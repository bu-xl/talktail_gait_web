import assert from "node:assert/strict";
import { test } from "node:test";

import { matchesReport, rowTitle, type Row } from "../src/ui/reportsPage.js";
import { hasEnglishLocale } from "../src/ui/reportRender.js";
import type { DerivedPreview } from "../src/api/resultsApi.js";

function row(date: string, name: string | null, weightKg?: number): Row {
  return {
    id: `${date}/stem`,
    date,
    displayDate: date.replace(/-/g, "."),
    session: {
      stem: "stem",
      displayTime: "14:42:04",
      dog: { name, breed: null, weightKg: weightKg ?? null, heightCm: null },
    } as unknown as Row["session"],
  };
}

const ALL = { query: "", from: "", to: "" };

test("검색은 반려견 이름과 날짜 모두에 걸린다", () => {
  const r = row("2026-08-19", "대박이", 5.2);
  assert.equal(matchesReport(r, { ...ALL, query: "대박" }), true);
  assert.equal(matchesReport(r, { ...ALL, query: "2026-08" }), true);
  assert.equal(matchesReport(r, { ...ALL, query: "5.2kg" }), true);
  assert.equal(matchesReport(r, { ...ALL, query: "초코" }), false);
});

test("날짜 범위는 양 끝을 포함하고, 한쪽만 비어도 동작한다", () => {
  const r = row("2026-08-19", "대박이");
  assert.equal(matchesReport(r, { ...ALL, from: "2026-08-19", to: "2026-08-19" }), true);
  assert.equal(matchesReport(r, { ...ALL, from: "2026-08-20" }), false);
  assert.equal(matchesReport(r, { ...ALL, to: "2026-08-18" }), false);
  assert.equal(matchesReport(r, { ...ALL, from: "2026-08-01" }), true);
  assert.equal(matchesReport(r, ALL), true);
});

test("이름이 없는 촬영은 시간으로 떨어진다", () => {
  assert.equal(rowTitle(row("2026-08-19", null)), "14:42:04");
  assert.equal(rowTitle(row("2026-08-19", "대박이", 5.2)), "대박이-5.2kg-14:42:04");
});

test("빈 영어 로케일은 영어 리포트로 치지 않는다 — 인쇄가 백지를 내면 안 된다", () => {
  const empty = { locales: { en: { report: [] } } } as unknown as DerivedPreview;
  const real = { locales: { en: { report: [{ key: "a", label: "a", text: "1" }] } } } as unknown as DerivedPreview;
  assert.equal(hasEnglishLocale(null), false);
  assert.equal(hasEnglishLocale(empty), false);
  assert.equal(hasEnglishLocale(real), true);
});
