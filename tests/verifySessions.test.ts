import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchCsvSpan } from "../src/api/storedFilesApi.js";
import { groupSessions, taskName, ungroupedFiles } from "../src/core/sessionNaming.js";

const csv = (name: string) => ({ name, size: 100, mtime: "2026-08-20T06:09:29.914Z", url: `/api/files/csv/${name}` });
const vid = (name: string, role: "main" | "sub") => ({
  name,
  size: 100,
  mtime: "2026-08-20T06:09:39.318Z",
  role,
  url: `/api/uploads/${role}/${name}`,
});

test("한 촬영의 CSV 와 영상이 도장 하나로 묶인다", () => {
  const sessions = groupSessions(
    [csv("제니-9.8kg-260820-150920.csv")],
    [
      vid("제니-9.8kg-sub3-260820-150920.mp4", "sub"),
      vid("제니-9.8kg-main-260820-150920.mp4", "main"),
      vid("제니-9.8kg-sub1-260820-150920.mp4", "sub"),
    ],
  );
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.equal(s.stamp, "260820-150920");
  assert.equal(s.dog, "제니-9.8kg");
  assert.ok(s.csv);
  // main 이 먼저, 그다음 sub 번호순 — 업로드 도착 순서와 무관해야 한다.
  assert.deepEqual(
    s.videos.map((v) => v.name.split("-")[2]),
    ["main", "sub1", "sub3"],
  );
  assert.equal(s.when?.getFullYear(), 2026);
  assert.equal(s.when?.getHours(), 15);
});

test("도장이 다르면 다른 촬영이고, 최신이 앞에 온다", () => {
  const sessions = groupSessions(
    [csv("제니-9.8kg-260820-150920.csv"), csv("제니-9.8kg-260820-151530.csv")],
    [vid("제니-9.8kg-main-260820-150920.mp4", "main")],
  );
  assert.deepEqual(
    sessions.map((s) => s.stamp),
    ["260820-151530", "260820-150920"],
  );
});

test("CSV 만 있거나 영상만 있는 촬영도 목록에 남는다", () => {
  const sessions = groupSessions([csv("pressure-260820-140000.csv")], [
    vid("main-260820-130000.mp4", "main"),
  ]);
  assert.equal(sessions.length, 2);
  const onlyCsv = sessions.find((s) => s.stamp === "260820-140000");
  assert.ok(onlyCsv?.csv);
  assert.equal(onlyCsv?.videos.length, 0);
  assert.equal(onlyCsv?.dog, "", "pressure- 접두사는 개 이름이 아니다");
  const onlyVideo = sessions.find((s) => s.stamp === "260820-130000");
  assert.equal(onlyVideo?.csv, null);
  assert.equal(onlyVideo?.videos.length, 1);
});

test("fetchCsvSpan 은 앞뒤 조각만 받아 길이를 계산한다", async () => {
  // 실제 파일 모양: 헤더 1줄 + `frame_id,time,p_…` 행. 뒤 조각은 행 중간에서 잘려 시작한다.
  const head = ["frame_id,time,p_0_0,p_0_1", "0,0.054,4092,4095", "1,0.076,4083,4095"].join("\n");
  const tail = ["5,4090", "343,7.953,4090,4095", "344,7.976,4089,4095"].join("\n");

  const ranges: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const range = String((init?.headers as Record<string, string>)?.Range || "");
    ranges.push(range);
    return { ok: true, text: async () => (range.startsWith("bytes=0-") ? head : tail) };
  }) as typeof fetch;
  try {
    const span = await fetchCsvSpan("", "/api/files/csv/x.csv");
    assert.ok(span);
    assert.equal(span.startSec, 0.054);
    assert.equal(span.endSec, 7.976);
    assert.equal(Number(span.seconds.toFixed(3)), 7.922);
    assert.equal(span.frames, 345);
    assert.equal(Math.round(span.fps), 44);
    // 헤더가 12KB 라 앞 조각은 그보다 커야 첫 데이터 행이 잡힌다.
    assert.deepEqual(ranges, ["bytes=0-32767", "bytes=-16384"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("개명 이전 CSV 이름도 같은 도장으로 읽는다", () => {
  // 서버 CSV 의 대부분이 아직 이 이름이다. 못 읽으면 화면에서 통째로 사라진다.
  const sessions = groupSessions(
    [csv("pressure-20260817-165803-danbi-7e35bfeb.csv"), csv("pressure-20260818-131402-dog-0b806187.csv")],
    [vid("danbi-main-260817-165803.mp4", "main")],
  );
  const joined = sessions.find((s) => s.stamp === "260817-165803");
  assert.ok(joined?.csv, "네 자리 연도를 두 자리로 맞춰 영상과 묶여야 한다");
  assert.equal(joined?.videos.length, 1);
  assert.equal(joined?.dog, "danbi");
  const placeholder = sessions.find((s) => s.stamp === "260818-131402");
  assert.equal(placeholder?.dog, "", "`dog` 는 이름이 아니라 자리표시자다");
});

test("도장이 없는 파일은 묶이지 않고 '분류 안 됨' 으로 남는다", () => {
  const loose = ungroupedFiles(
    [csv("메모.csv"), csv("제니-9.8kg-260820-150920.csv")],
    [vid("옛날영상.mp4", "main")],
  );
  assert.deepEqual(
    loose.map((row) => row.name),
    ["메모.csv", "옛날영상.mp4"],
  );
});

test("태스크명은 zip 폴더명이자 서버가 받는 키다", () => {
  const [withDog] = groupSessions([csv("제니-9.8kg-260820-150920.csv")], []);
  const [noDog] = groupSessions([], [vid("main-260820-150920.mp4", "main")]);
  assert.equal(taskName(withDog), "제니-9.8kg-260820-150920");
  assert.equal(taskName(noDog), "260820-150920");
});
