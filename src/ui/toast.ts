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
