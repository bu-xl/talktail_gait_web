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
    [csv("260820-150920-제니-9.8kg.csv")],
    [
      vid("260820-150920-sub3-제니-9.8kg.mp4", "sub"),
      vid("260820-150920-main-제니-9.8kg.mp4", "main"),
      vid("260820-150920-sub1-제니-9.8kg.mp4", "sub"),
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
    [csv("260820-150920-제니-9.8kg.csv"), csv("260820-151530-제니-9.8kg.csv")],
    [vid("260820-150920-main-제니-9.8kg.mp4", "main")],
  );
  assert.deepEqual(
    sessions.map((s) => s.stamp),
    ["260820-151530", "260820-150920"],
  );
});

test("CSV 만 있거나 영상만 있는 촬영도 목록에 남는다", () => {
  const sessions = groupSessions([csv("260820-140000.csv")], [
    vid("260820-130000-main.mp4", "main"),
  ]);
  assert.equal(sessions.length, 2);
  const onlyCsv = sessions.find((s) => s.stamp === "260820-140000");
  assert.ok(onlyCsv?.csv);
  assert.equal(onlyCsv?.videos.length, 0);
  assert.equal(onlyCsv?.dog, "", "신원을 모르면 도장만 남는다");
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

test("충돌 회피 접미사가 붙어도 같은 촬영으로 묶인다", () => {
  const sessions = groupSessions(
    [csv("260817-165803-danbi-2.csv")],
    [vid("260817-165803-main-danbi.mp4", "main")],
  );
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.ok(s.csv);
  assert.equal(s.videos.length, 1);
  assert.equal(s.dog, "danbi", "`-2` 는 개 이름의 일부가 아니다");
});

test("도장이 없는 파일은 묶이지 않고 '분류 안 됨' 으로 남는다", () => {
  const loose = ungroupedFiles(
    [csv("메모.csv"), csv("260820-150920-제니-9.8kg.csv")],
    [vid("옛날영상.mp4", "main")],
  );
  assert.deepEqual(
    loose.map((row) => row.name),
    ["메모.csv", "옛날영상.mp4"],
  );
});

test("태스크명은 zip 폴더명이자 서버가 받는 키다", () => {
  const [withDog] = groupSessions([csv("260820-150920-제니-9.8kg.csv")], []);
  const [noDog] = groupSessions([], [vid("260820-150920-main.mp4", "main")]);
  assert.equal(taskName(withDog), "260820-150920-제니-9.8kg");
  assert.equal(taskName(noDog), "260820-150920");
});
