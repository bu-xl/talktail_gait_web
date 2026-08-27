import assert from "node:assert/strict";
import { test } from "node:test";

import { camKey, countCamsInState, liveCamKeys } from "../src/core/camState.js";
import type { CamState, SyncPeers } from "../src/transport/gaitSocket.js";

function peers(main: boolean, subIndexes: number[], subCount = subIndexes.length): SyncPeers {
  return { main, mobile: main || subCount > 0, subCount, subIndexes } as SyncPeers;
}

test("이벤트가 만드는 키와 붙어 있는 자리의 키가 같다", () => {
  // 여기가 갈리면 "촬영 중 0대" 같은 조용한 오답이 나온다.
  assert.equal(camKey("main", null), "main");
  assert.equal(camKey("sub", 2), "sub2");
  assert.deepEqual(liveCamKeys(peers(true, [1, 2])), ["main", "sub1", "sub2"]);
});

test("번호 없는 sub 는 자리로 세지 않는다", () => {
  // subCount 3 인데 번호는 둘뿐 — 나머지 하나는 촬영을 못 한다(앱이 막는다).
  assert.deepEqual(liveCamKeys(peers(true, [1, 2], 3)), ["main", "sub1", "sub2"]);
});

test("상태별 집계는 붙어 있는 자리만 센다", () => {
  const states = new Map<string, CamState>([
    ["main", "uploading"],
    ["sub1", "recording"],
    ["sub2", "recording"],
    // 방을 떠난 폰의 잔여 상태 — 세면 재촬영이 영영 되묻게 된다.
    ["sub9", "uploading"],
  ]);
  const p = peers(true, [1, 2]);
  assert.equal(countCamsInState(states, p, "recording"), 2);
  assert.equal(countCamsInState(states, p, "uploading"), 1);
  assert.equal(countCamsInState(states, p, "idle"), 0);
});

test("연결된 카메라가 없으면 0", () => {
  const states = new Map<string, CamState>([["main", "recording"]]);
  assert.equal(countCamsInState(states, undefined, "recording"), 0);
  assert.equal(countCamsInState(states, peers(false, []), "recording"), 0);
});
