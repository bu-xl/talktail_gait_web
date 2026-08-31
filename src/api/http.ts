/**
 * 서버 호출 공통 래퍼.
 *
 * 두 가지를 한 곳에서 보장한다:
 *
 * 1. **세션 쿠키를 싣는다.** 운영은 nginx 가 웹과 API 를 같은 호스트로 묶어 동일
 *    출처지만, 개발은 `localhost:5173 → :3000` 이라 교차 출처다. 교차 출처에서는
 *    `credentials: "include"` 가 없으면 브라우저가 쿠키를 아예 안 보낸다.
 * 2. **401 을 한 곳에서 잡는다.** 세션이 끊겼는데 화면이 조용히 빈 목록만 보여 주면
 *    사용자는 "데이터가 없다" 로 읽는다. 여기서 로그인 화면을 다시 띄운다.
 *
 * 호출 지점마다 옵션을 손으로 붙이는 방식은 새로 만든 호출에서 반드시 빠진다.
 * 그래서 `src/api/` 의 모든 fetch 가 이 함수를 지난다.
 */

type Listener = () => void;
const expiredListeners = new Set<Listener>();

/** 세션이 끊겼을 때 알림을 받는다. 로그인 게이트가 구독한다. */
export function onAuthExpired(fn: Listener): () => void {
  expiredListeners.add(fn);
  return () => {
    expiredListeners.delete(fn);
  };
}

let notifying = false;

function notifyExpired(): void {
  // 화면 하나가 여러 요청을 동시에 던지면 401 도 여러 번 온다. 한 번만 알린다.
  if (notifying) return;
  notifying = true;
  try {
    for (const fn of expiredListeners) {
      try {
        fn();
      } catch {
        /* 구독자 하나가 죽어도 나머지는 알려야 한다 */
      }
    }
  } finally {
    // 다음 401 은 다시 알린다 — 로그인 후 또 끊길 수 있다.
    setTimeout(() => {
      notifying = false;
    }, 1000);
  }
}

/** 쿠키를 실은 fetch. 401 이면 로그인 게이트를 깨운다. */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(input, { ...init, credentials: "include" });
  if (res.status === 401) notifyExpired();
  return res;
}
