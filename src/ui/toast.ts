/**
 * 우하단 토스트 스택 — 이벤트 알림 + 분석 대기열 상태 카드.
 *
 * 이벤트 토스트(showToast)는 몇 초 뒤 사라지는 한 줄 알림이다.
 * 대기열 카드(updateQueueToast)는 서버의 `analysis_queue` 스냅샷을 그대로 그리는
 * 고정 카드다 — 지금 분석 중인 것, 대기열에 선 것들, 각각의 예상 완료 시각을
 * 보여 주고, 남은 시간은 expectedEndAt(서버 시각) − 현재 서버 시각으로 매 초
 * 로컬에서 다시 계산한다(서버는 상태가 바뀔 때만 쏜다). 큐가 비면 카드는 사라진다.
 */

import { t } from "../i18n/index.js";

export type QueueRunning = {
  jobId: string;
  label: string;
  sessionId?: string | null;
  startedAt: number;
  elapsedMs?: number;
  expectedEndAt: number;
};

export type QueueWaiting = {
  jobId: string;
  label: string;
  sessionId?: string | null;
  position: number;
  enqueuedAt?: number;
  expectedStartAt?: number;
  expectedEndAt: number;
};

export type QueueSnapshot = {
  running: QueueRunning | null;
  queued: QueueWaiting[];
  queuedCount: number;
  avgDurationMs: number;
  serverNow: number;
};

export type ToastKind = "info" | "ok" | "warn" | "bad";

let stackEl: HTMLElement | null = null;

function ensureStack(): HTMLElement {
  if (stackEl && document.body.contains(stackEl)) return stackEl;
  const el = document.createElement("div");
  el.id = "toastStack";
  el.setAttribute("aria-live", "polite");
  document.body.appendChild(el);
  stackEl = el;
  return el;
}

const TOAST_DEFAULT_MS = 5200;

/** 몇 초 뒤 사라지는 이벤트 토스트. onClick 이 있으면 클릭할 수 있는 카드가 된다. */
export function showToast(opts: {
  kind?: ToastKind;
  title: string;
  message?: string;
  durationMs?: number;
  onClick?: () => void;
}): void {
  const stack = ensureStack();
  const el = document.createElement("div");
  el.className = `toast toast-${opts.kind ?? "info"}`;

  const body = document.createElement("div");
  body.className = "toast-body";
  const title = document.createElement("div");
  title.className = "toast-title";
  title.textContent = opts.title;
  body.appendChild(title);
  if (opts.message) {
    const msg = document.createElement("div");
    msg.className = "toast-msg";
    msg.textContent = opts.message;
    body.appendChild(msg);
  }
  el.appendChild(body);

  let removed = false;
  const remove = (): void => {
    if (removed) return;
    removed = true;
    el.classList.add("toast-out");
    window.setTimeout(() => el.remove(), 220);
  };

  if (opts.onClick) {
    el.classList.add("toast-clickable");
    el.addEventListener("click", () => {
      opts.onClick?.();
      remove();
    });
  } else {
    el.addEventListener("click", remove);
  }

  stack.appendChild(el);
  window.setTimeout(remove, opts.durationMs ?? TOAST_DEFAULT_MS);
}

// ---- 분석 대기열 고정 카드 -------------------------------------------------

let queueCard: HTMLElement | null = null;
let queueTimer: number | null = null;
let lastSnapshot: QueueSnapshot | null = null;
/** 서버 시각 → 로컬 시각 보정값(로컬 now − serverNow). */
let serverOffsetMs = 0;

function clearQueueTimer(): void {
  if (queueTimer != null) {
    window.clearInterval(queueTimer);
    queueTimer = null;
  }
}

function removeQueueCard(): void {
  clearQueueTimer();
  queueCard?.remove();
  queueCard = null;
  lastSnapshot = null;
}

function serverNowMs(): number {
  return Date.now() - serverOffsetMs;
}

function fmtRemain(ms: number): string {
  if (ms <= 1000) return t("toast_eta_soon");
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const time = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return t("toast_time_left", { time });
}

function fmtClock(serverTs: number): string {
  const local = new Date(serverTs + serverOffsetMs);
  const hh = String(local.getHours()).padStart(2, "0");
  const mm = String(local.getMinutes()).padStart(2, "0");
  const ss = String(local.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function renderQueueCard(): void {
  if (!queueCard || !lastSnapshot) return;
  const snap = lastSnapshot;
  const now = serverNowMs();

  const rows: string[] = [];
  rows.push(
    `<div class="tq-head"><span class="tq-title">${t("toast_queue_title")}</span>` +
      `<span class="tq-count">${snap.queuedCount + (snap.running ? 1 : 0)}</span></div>`,
  );

  if (snap.running) {
    const remain = fmtRemain(snap.running.expectedEndAt - now);
    rows.push(
      `<div class="tq-row tq-running"><span class="tq-dot"></span>` +
        `<span class="tq-label">${escapeHtml(snap.running.label)}</span>` +
        `<span class="tq-eta">${t("toast_running_label")} · ${remain} · ${t("toast_eta_done_at", {
          time: fmtClock(snap.running.expectedEndAt),
        })}</span></div>`,
    );
  }

  for (const item of snap.queued) {
    rows.push(
      `<div class="tq-row"><span class="tq-pos">${item.position}</span>` +
        `<span class="tq-label">${escapeHtml(item.label)}</span>` +
        `<span class="tq-eta">${t("toast_wait_position", { n: item.position })} · ${t(
          "toast_eta_done_at",
          { time: fmtClock(item.expectedEndAt) },
        )}</span></div>`,
    );
  }

  queueCard.innerHTML = rows.join("");
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * `analysis_queue` 스냅샷 반영. 큐가 완전히 비면 카드를 제거한다.
 */
export function updateQueueToast(snap: QueueSnapshot): void {
  serverOffsetMs = Date.now() - snap.serverNow;
  if (!snap.running && snap.queued.length === 0) {
    removeQueueCard();
    return;
  }
  lastSnapshot = snap;
  if (!queueCard) {
    const stack = ensureStack();
    queueCard = document.createElement("div");
    queueCard.className = "toast toast-queue";
    // 대기열 카드는 항상 스택 맨 위(고정), 이벤트 토스트는 그 아래로 쌓인다.
    stack.prepend(queueCard);
  }
  renderQueueCard();
  if (queueTimer == null) {
    queueTimer = window.setInterval(renderQueueCard, 1000);
  }
}

// ---- 상단 알림 토스트 -------------------------------------------------------

const TOP_STYLE_ID = "topToastStyle";
let topStackEl: HTMLElement | null = null;

function ensureTopStack(): HTMLElement {
  if (!document.getElementById(TOP_STYLE_ID)) {
    const style = document.createElement("style");
    style.id = TOP_STYLE_ID;
    style.textContent = `
#topToastStack{position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:1400;
  display:flex;flex-direction:column;align-items:center;gap:8px;padding:12px;
  pointer-events:none}
/* 정지 상태가 "보이는 상태"다. 애니메이션이 돌지 않는 환경(감속 모드, 백그라운드
   스로틀링)에서도 토스트는 그대로 보인다. 키프레임의 from 을 fill-mode 로 붙들면
   애니메이션이 시작되지 않았을 때 영영 투명하게 남는다. */
.top-toast{pointer-events:auto;min-width:280px;max-width:min(92vw,560px);
  padding:12px 18px;border-radius:0 0 12px 12px;
  background:var(--primary,#f0663f);color:#fff;
  box-shadow:0 10px 30px rgba(0,0,0,.18);
  font:600 15px/1.4 var(--font-ui,system-ui,sans-serif);text-align:center;
  transform:translateY(0);opacity:1;
  transition:transform .32s cubic-bezier(.16,1,.3,1),opacity .32s ease}
/* 들어오기 전(위)과 나갈 때(위로) 상태만 클래스로 준다. */
.top-toast.is-entering,.top-toast.is-out{transform:translateY(-110%);opacity:0}
/* 조건이 풀릴 때까지 남아 있는 알림. 자동으로 사라지지 않는다. */
.top-toast.is-blocking{background:var(--danger,#cf222e)}
@media (prefers-reduced-motion:reduce){
  .top-toast{transition:none}
  .top-toast.is-entering{transform:translateY(0);opacity:1}
}`;
    document.head.appendChild(style);
  }
  if (topStackEl && document.body.contains(topStackEl)) return topStackEl;
  const el = document.createElement("div");
  el.id = "topToastStack";
  el.setAttribute("aria-live", "assertive");
  document.body.appendChild(el);
  topStackEl = el;
  return el;
}

/**
 * 화면 위에서 아래로 내려오는 알림.
 *
 * 우하단 스택과 따로 두는 이유는 관객이 있기 때문이다. 보호자에게 결과를 설명하는
 * 화면에서 "분석이 완료되었습니다" 는 놓치면 안 되는 알림이라 시선이 가는 위쪽에
 * 크게 띄운다. `prefers-reduced-motion` 이면 미끄러지지 않고 그대로 나타난다.
 */
export function showTopToast(opts: { message: string; durationMs?: number }): void {
  const stack = ensureTopStack();
  const el = document.createElement("div");
  el.className = "top-toast is-entering";
  el.setAttribute("role", "status");
  el.textContent = opts.message;

  let removed = false;
  const remove = (): void => {
    if (removed) return;
    removed = true;
    el.classList.add("is-out");
    window.setTimeout(() => el.remove(), 360);
  };
  el.addEventListener("click", remove);
  stack.appendChild(el);
  // 다음 프레임에 시작 클래스를 떼면 정지 상태로 전환된다. rAF 가 늦거나 아예
  // 돌지 않아도 타이머가 같은 일을 하므로 토스트가 숨은 채로 남지 않는다.
  const settle = (): void => el.classList.remove("is-entering");
  requestAnimationFrame(() => requestAnimationFrame(settle));
  window.setTimeout(settle, 80);
  window.setTimeout(remove, opts.durationMs ?? 6000);
}

/** id 로 관리되는 상주 토스트들. 같은 id 는 덮어쓴다. */
const persistentTop = new Map<string, HTMLElement>();

/**
 * 조건이 풀릴 때까지 사라지지 않는 상단 알림.
 *
 * 시작을 막는 이유처럼 "고치기 전에는 계속 참인" 상태에 쓴다. 몇 초 뒤 사라지면
 * 사용자가 원인을 확인하기 전에 사라져 버리고, 화면 구석의 작은 문구는 측정 화면처럼
 * 볼 것이 많은 곳에서 묻힌다.
 */
export function showBlockingTopToast(id: string, message: string): void {
  const existing = persistentTop.get(id);
  if (existing && document.body.contains(existing)) {
    if (existing.textContent !== message) existing.textContent = message;
    return;
  }
  const stack = ensureTopStack();
  const el = document.createElement("div");
  el.className = "top-toast is-blocking is-entering";
  el.setAttribute("role", "alert");
  el.textContent = message;
  stack.appendChild(el);
  persistentTop.set(id, el);

  const settle = (): void => el.classList.remove("is-entering");
  requestAnimationFrame(() => requestAnimationFrame(settle));
  window.setTimeout(settle, 80);
}

/** 조건이 풀렸을 때 상주 알림을 걷는다. */
export function dismissTopToast(id: string): void {
  const el = persistentTop.get(id);
  if (!el) return;
  persistentTop.delete(id);
  el.classList.add("is-out");
  window.setTimeout(() => el.remove(), 360);
}
