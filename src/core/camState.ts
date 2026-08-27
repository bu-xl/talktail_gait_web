/**
 * 카메라 자리(슬롯) 키와 상태 집계.
 *
 * 서버가 주는 것은 개수와 번호 집합뿐이라 기기를 낱개로 식별할 수 없다. 그래서 자리
 * 번호를 키로 쓴다 — `main`, `sub1`, `sub2`…
 *
 * 키를 만드는 쪽(수신 이벤트)과 세는 쪽(붙어 있는 자리)이 규칙이 갈리면 "촬영 중인
 * 카메라 0대" 같은 조용한 오답이 나온다. 그래서 양쪽이 이 파일 하나를 쓴다.
 */

import type { CamState, SyncPeers } from "../transport/gaitSocket.js";

/** 이벤트의 역할·번호 → 자리 키. 번호 없는 sub 는 자리를 특정할 수 없다. */
export function camKey(role: string, subIndex: number | null): string {
  return role === "main" ? "main" : `sub${subIndex ?? "?"}`;
}

/** 지금 방에 붙어 있는 자리들. 번호 미지정 sub 는 촬영을 못 하므로 빠진다. */
export function liveCamKeys(peers?: SyncPeers): string[] {
  return [
    ...(peers?.main ? ["main"] : []),
    ...(peers?.subIndexes ?? []).map((n) => camKey("sub", n)),
  ];
}

/**
 * 붙어 있는 카메라 중 해당 상태인 자리 수.
 *
 * 떠난 폰의 잔여 상태는 세지 않는다 — 방을 나간 폰이 `uploading` 인 채로 남아 있으면
 * 재촬영이 영영 되묻게 된다.
 */
export function countCamsInState(
  states: ReadonlyMap<string, CamState>,
  peers: SyncPeers | undefined,
  state: CamState,
): number {
  return liveCamKeys(peers).filter((key) => states.get(key) === state).length;
}
