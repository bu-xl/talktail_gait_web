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

/**
 * 마스터가 "지금 보고 있는 계정".
 *
 * 마스터는 남의 결과를 조회할 수 있고, 그 대상은 `?userId=` 로 전달한다.
 * 호출 지점마다 인자를 늘리면 `main.ts` 의 수십 곳을 고쳐야 하므로 여기 한 벌 둔다.
 *
 * ★ 일반 계정에는 아무 영향이 없다 — 서버가 무엇을 받든 자기 계정으로 되돌린다.
 *   화면이 아니라 서버가 경계를 지킨다.
 */
const SCOPE_KEY = "gait.viewScope";

/** 계정 전환은 새로고침을 동반하므로 저장해 두지 않으면 즉시 잃는다. */
function loadScope(): string | null {
  try {
    return localStorage.getItem(SCOPE_KEY);
  } catch {
    return null; // 시크릿 모드 등 — 이번 세션에서만 유지된다
  }
}

let viewScope: string | null = loadScope();

export function setViewScope(userId: string | null): void {
  viewScope = userId && userId.trim() ? userId.trim() : null;
  try {
    if (viewScope) localStorage.setItem(SCOPE_KEY, viewScope);
    else localStorage.removeItem(SCOPE_KEY);
  } catch {
    /* 저장이 막힌 환경 — 메모리 값으로 이번 세션은 동작한다 */
  }
}

export function getViewScope(): string | null {
  return viewScope;
}

/**
 * 계정 스코프를 붙일 조회 경로. **명시 목록이다.**
 * 자동으로 전부 붙이면 로그인·계정관리처럼 붙으면 안 되는 곳까지 딸려간다.
 */
const SCOPED_PATHS = [
  "/results/",
  "/results/dates",
  "/pressure/records",
  "/files",
  "/storage",
];

function withScope(input: string): string {
  if (!viewScope) return input;
  // 절대 URL 도 상대 경로도 들어온다 — 경로 부분만 본다.
  const qIndex = input.indexOf("?");
  const pathPart = qIndex >= 0 ? input.slice(0, qIndex) : input;
  if (!SCOPED_PATHS.some((p) => pathPart.includes(p))) return input;
  if (/[?&]userId=/.test(input)) return input; // 호출측이 이미 지정했다
  return `${input}${qIndex >= 0 ? "&" : "?"}userId=${encodeURIComponent(viewScope)}`;
}

/** 쿠키를 실은 fetch. 401 이면 로그인 게이트를 깨운다. */
export async function apiFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method || "GET").toUpperCase();
  // 스코프는 **조회에만** 붙인다. 쓰기·삭제까지 남의 계정으로 향하면 사고가 된다.
  const url = method === "GET" ? withScope(input) : input;
  const res = await fetch(url, { ...init, credentials: "include" });
  if (res.status === 401) notifyExpired();
  return res;
}
