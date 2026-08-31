/**
 * 웹(매트 뷰어) ↔ back WebSocket 클라이언트.
 * 녹화 동기화 + 분석 결과만 담당 (라이브 영상 전송 없음).
 */

import { joinApiUrl } from "../config/apiUrl.js";
import { clockSync } from "./clockSync.js";

export type SyncPeers = {
  web: boolean;
  mobile: boolean;
  /** 연결된 카메라 폰 수 (Main + Sub). 구버전 서버는 없음. */
  mobileCount?: number;
  /** Main 카메라 접속 여부 (분석 대상). */
  main?: boolean;
  /** Sub 카메라 수. */
  subCount?: number;
  /**
   * 지금 쓰이고 있는 자리 번호(sub1, sub2 …). 폰이 스스로 들고 오는 값이라
   * `subCount` 보다 적을 수 있다 — 그 차이가 곧 "번호를 안 고른 카메라" 수다.
   */
  subIndexes?: number[];
};

/** 카메라 목록에 보이는 상태. 이 셋이 전부다. */
export type CamState = "idle" | "recording" | "uploading";

export type CaptureSettingsPayload = {
  presetId: string;
  videoQuality: string;
  fps: number;
  width: number;
  height: number;
  bitrate: number;
};

export type SyncMessage =
  | { type: "joined"; role: string; userId: string; peers: SyncPeers; serverNow: number }
  /**
   * 세션이 없거나 만료됐다. 서버는 이 메시지를 보낸 뒤 곧바로 끊는다.
   * 조용히 재연결만 반복하면 현장에서 "버튼이 안 먹는다" 로만 보인다.
   */
  | { type: "auth_required"; message?: string }
  | { type: "peer_update"; userId: string; peers: SyncPeers }
  | {
      type: "sync_start";
      /** @deprecated 서버가 토큰에서 정한다. 자리만 남겨 뒀다. */
  userId?: string;
      sessionId: string;
      serverNow: number;
      recordAt: number;
      syncLeadMs: number;
      /** 촬영 하드 상한(ms) — 서버가 clamp 한 값. 매트 녹화도 이 상한을 따른다. */
      maxDurationMs?: number;
      captureSettings?: CaptureSettingsPayload | null;
    }
  | { type: "record_stop"; userId: string; sessionId: string | null; from: string; serverNow: number; retry?: boolean }
  | { type: "retake"; userId: string; sessionId: string | null; serverNow: number }
  /**
   * 폰이 **실제로** 녹화를 시작했다. `sync_start` 는 지시일 뿐이고 폰마다 카메라를 올리는
   * 시간이 달라, 이 신호가 있어야 "몇 대 중 몇 대가 찍고 있나" 를 웹에서 알 수 있다.
   * Sub 것도 온다(`upload_started` 와 다른 점).
   */
  | {
      type: "record_started";
      userId: string;
      sessionId: string | null;
      deviceId: string | null;
      captureRole: "main" | "sub";
      subIndex: number | null;
      serverNow: number;
    }
  | {
      type: "record_stopped";
      userId: string;
      sessionId: string | null;
      deviceId: string | null;
      captureRole: "main" | "sub";
      subIndex: number | null;
      serverNow: number;
    }
  /**
   * 폰이 스스로 말하는 표시 상태. 카메라 목록은 이것만 보고 그린다 — 사건을 모아
   * 상태를 추측하지 않으므로 업로드가 끝나 대기로 돌아온 것도 그대로 보인다.
   */
  | {
      type: "cam_state";
      userId: string;
      state: CamState;
      deviceId: string | null;
      captureRole: "main" | "sub";
      subIndex: number | null;
      serverNow: number;
    }
  | {
      type: "capture_settings";
      presetId: string;
      videoQuality: string;
      fps: number;
      width: number;
      height: number;
      bitrate: number;
      serverNow: number;
    }
  | { type: "preview_frame"; mime: string; data: string; ts: number }
  | { type: "upload_started"; jobId: string; sessionId: string | null; userId: string }
  | {
      type: "analyze_done";
      jobId: string;
      resultUrl: string;
      resultFilename?: string | null;
      originalUrl?: string | null;
      artifacts?: Record<string, { kind?: string; filename?: string; url?: string | null; available?: boolean }> | null;
      date?: string | null;
      time?: string | null;
      stem?: string | null;
      sessionPath?: string | null;
      sessionId: string | null;
      serverNow: number;
    }
  | { type: "analyze_failed"; jobId?: string; error: string; sessionId?: string | null }
  | { type: "analyze_cancelled"; jobId: string; sessionId: string | null; serverNow: number }
  | ({ type: "analysis_queue" } & AnalysisQueueSnapshot)
  | { type: "error"; message: string }
  | { type: "pong"; serverTs: number; clientTs: number | null }
  | { type: "replaced"; reason: string };

/** 서버 전역 분석 대기열 스냅샷 — 상태가 바뀔 때마다 브로드캐스트된다. */
export type AnalysisQueueSnapshot = {
  running: {
    jobId: string;
    label: string;
    sessionId?: string | null;
    startedAt: number;
    elapsedMs?: number;
    expectedEndAt: number;
  } | null;
  queued: Array<{
    jobId: string;
    label: string;
    sessionId?: string | null;
    position: number;
    enqueuedAt?: number;
    expectedStartAt?: number;
    expectedEndAt: number;
  }>;
  queuedCount: number;
  avgDurationMs: number;
  serverNow: number;
};

type Handler = (msg: SyncMessage) => void;
type ConnectionHandler = (connected: boolean) => void;

/**
 * `web` 은 제어판이다 — 촬영 시작·종료 권한이 있다.
 * `viewer` 는 완료된 분석만 지켜보는 화면이다. 허브가 viewer 의 제어 메시지를
 * 거부하므로, 열람용 노트북이 실수로 측정 중인 노트북의 세션을 건드릴 수 없다.
 * 클라이언트가 안 보내기를 믿는 게 아니라 서버가 막는다.
 */
export type SyncRole = "web" | "viewer";

export interface GaitSyncOptions {
  wsUrl: string;
  role?: SyncRole;
}

/** 끊겨 있는 동안 쌓아 둘 제어판 사건 기록의 최대 개수. */
const MAX_PENDING_LOGS = 200;

export class GaitSyncSocket {
  private ws: WebSocket | null = null;
  private handler: Handler = () => {};
  private connectionHandler: ConnectionHandler = () => {};
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private readonly wsUrl: string;
  /** 서버가 `joined` 로 알려 주는 실제 방(=계정). 진단용이다. */
  private userId = "";
  readonly role: SyncRole;
  peers: SyncPeers = { web: false, mobile: false };
  connected = false;
  /** 끊겨 있는 동안 쌓아 두는 사건 기록. `log()` / `flushLogs()` 참고. */
  private pendingLogs: Array<Record<string, unknown>> = [];
  /** 마지막으로 끊긴 시각 — 재연결 때 공백 길이를 서버에 알린다. */
  private disconnectedAt = 0;

  constructor(opts: GaitSyncOptions) {
    this.wsUrl = opts.wsUrl;

    this.role = opts.role ?? "web";
  }

  get isViewer(): boolean {
    return this.role === "viewer";
  }

  onMessage(handler: Handler): void {
    this.handler = handler;
  }

  onConnectionChange(handler: ConnectionHandler): void {
    this.connectionHandler = handler;
  }

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.connected = false;
    this.connectionHandler(false);
  }

  send(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  join(): void {
    // ★ 방 이름을 보내지 않는다. 서버가 **세션 쿠키**에서 계정을 확정해 방을 정한다 —
    //   클라가 보낸 값을 서버가 믿으면 남의 방에 그냥 들어갈 수 있다.
    //   (앱은 쿠키가 없어 join 에 token 을 싣는다. 웹은 핸드셰이크 쿠키로 충분하다.)
    this.send({ type: "join", role: this.role });
  }

  /**
   * 제어판의 사건을 **서버 로그로** 보낸다.
   *
   * 이 화면의 `console.log` 는 브라우저/Electron 안에만 남아, 현장에서 문제가 나도
   * 나중에 볼 수 없다. 확인 가능한 것은 배포된 back 의 pm2 로그뿐이라, 웹이 무엇을
   * 눌렀고 어떤 신호에 어떻게 반응했는지를 서버로 밀어 넣어야 촬영 한 회차의 앞뒤가
   * 이어진다. 폰의 `capture_log` 와 같은 통로를 쓰고 서버가 `[web]` 로 구분해 찍는다.
   *
   * 끊겨 있으면 쌓아 뒀다가 재연결 직후 몰아 보낸다 — 사고가 나는 순간이 대개 그
   * 끊긴 순간이라, 그때 로그를 버리면 정작 필요한 것만 사라진다.
   */
  log(label: string, detail?: Record<string, unknown> | null): void {
    const entry = { type: "capture_log", label, detail: detail ?? null, clientTs: Date.now() };
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.send(entry);
      return;
    }
    this.pendingLogs.push(entry);
    if (this.pendingLogs.length > MAX_PENDING_LOGS) {
      this.pendingLogs.splice(0, this.pendingLogs.length - MAX_PENDING_LOGS);
    }
  }

  private flushLogs(): void {
    if (!this.pendingLogs.length) return;
    const queued = this.pendingLogs;
    this.pendingLogs = [];
    this.send({ type: "capture_log", label: "log_flush_begin", detail: { count: queued.length }, clientTs: Date.now() });
    for (const entry of queued) this.send({ ...entry, buffered: true });
  }

  /**
   * Ask every camera to start.
   *
   * The dog goes with the request because the phones upload the video but never
   * learn whose walk it is; the hub stores this on the capture session and the
   * backend uses it to name the file.
   */
  /** viewer 에서 호출되면 조용히 무시한다. 서버도 거부하지만 두 번 막는다. */
  requestRecord(dog?: {
    name?: string | null;
    weightKg?: number | null;
  } | null, captureSettings?: CaptureSettingsPayload | null, maxDurationMs?: number | null): void {
    if (this.isViewer) return;
    this.send({
      type: "record_request",
      dog: dog && (dog.name || dog.weightKg != null)
        ? { dogName: dog.name ?? null, dogWeightKg: dog.weightKg ?? null }
        : null,
      ...(captureSettings ? { captureSettings } : {}),
      // 촬영 하드 상한. 서버가 10~180초로 clamp 한 뒤 sync_start 로 폰에 내려보낸다.
      ...(maxDurationMs != null ? { maxDurationMs } : {}),
    });
  }

  sendCaptureSettings(captureSettings: CaptureSettingsPayload): void {
    if (this.isViewer) return;
    this.send({ type: "capture_settings", ...captureSettings });
  }

  stopRecord(sessionId?: string | null): void {
    if (this.isViewer) return;
    this.send({ type: "record_stop", sessionId: sessionId ?? null });
  }

  /**
   * 재촬영 — 방금 찍은 것을 버린다고 폰에 알린다.
   *
   * HTTP 취소(`DELETE /api/analyze/:jobId`)는 업로드가 끝나 jobId 가 생긴 뒤에만 쓸 수
   * 있다. 그런데 재촬영을 누르는 시점은 대개 업로드 중이고, 그동안 폰은 버릴 영상을
   * 끝까지 올리느라 다음 촬영을 못 받는다. 이 신호가 그 대기를 없앤다.
   */
  requestRetake(sessionId?: string | null): void {
    if (this.isViewer) return;
    this.send({ type: "retake", sessionId: sessionId ?? null });
  }

  private open(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    console.log("[gait-sync] connecting", this.wsUrl);
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      const downMs = this.disconnectedAt ? Date.now() - this.disconnectedAt : 0;
      this.connected = true;
      console.log("[gait-sync] open");
      this.connectionHandler(true);
      this.join();
      // join 이 먼저 나가야 서버가 이 소켓을 web 으로 인식한다. 그 뒤에 밀린 로그를 흘린다.
      if (downMs > 0) this.log("ws_reconnected", { downMs });
      this.disconnectedAt = 0;
      this.flushLogs();
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as SyncMessage;
        if (msg.type === "joined" || msg.type === "peer_update") {
          this.peers = msg.peers;
        }
        // 서버가 쿠키에서 확정한 방(=계정). 클라가 정하지 않는다.
        if (msg.type === "joined") this.userId = msg.userId;
        if (msg.type === "auth_required") {
          // 재연결을 멈춘다 — 세션이 죽은 채 무한 재시도하면 로그만 더럽힌다.
          // 화면은 http 쪽 401 이 이미 로그인 게이트를 띄우므로 여기서는 멈추기만 한다.
          this.closedByUser = true;
          console.warn("[gait-sync] auth required — 로그인이 필요합니다");
        }
        this.handler(msg);
      } catch (err) {
        console.warn("[gait-sync] bad message", err);
      }
    };

    ws.onerror = () => console.warn("[gait-sync] error");
    ws.onclose = (ev) => {
      this.connected = false;
      this.ws = null;
      this.disconnectedAt = Date.now();
      console.log("[gait-sync] closed", ev?.code);
      // 끊긴 사실을 버퍼에 남긴다 — 재연결 뒤 서버가 이 공백을 알 수 있다.
      if (!this.closedByUser) this.log("ws_closed", { code: ev?.code ?? null, reason: ev?.reason || null });
      this.connectionHandler(false);
      if (!this.closedByUser) {
        this.reconnectTimer = setTimeout(() => this.open(), 1500);
      }
    };
  }
}

export function waitUntilRecordAt(recordAt: number, maxWaitMs = 3000): Promise<void> {
  let remain: number;
  try {
    // performance.now() 축으로 환산 — 이 PC 의 벽시계가 서버와 얼마나 어긋났든 무관하다.
    remain = Number(clockSync.toDeviceNs(BigInt(Math.round(recordAt)) * 1_000_000n)) / 1e6 - performance.now();
  } catch {
    remain = recordAt - Date.now();
  }
  const waitMs = Math.min(Math.max(0, remain), maxWaitMs);
  if (waitMs <= 0) return Promise.resolve();
  return new Promise((resolve) => window.setTimeout(resolve, waitMs));
}

export function absolutizeResultUrl(apiBaseUrl: string, resultUrl: string): string {
  if (resultUrl.startsWith("http://") || resultUrl.startsWith("https://")) return resultUrl;
  return joinApiUrl(apiBaseUrl, resultUrl);
}

type JobPoll = {
  id: string;
  /** processing | completed | failed | cancelled | stored */
  status: string;
  awaitingConfirm?: boolean;
  resultUrl: string | null;
  originalUrl?: string | null;
  artifacts?: Record<string, { kind?: string; filename?: string; url?: string | null; available?: boolean }> | null;
  date?: string | null;
  time?: string | null;
  stem?: string | null;
  sessionPath?: string | null;
  error: string | null;
};

/** HTTP fallback when WebSocket analyze_done is missed. */
export async function pollJobUntilDone(
  apiBaseUrl: string,
  jobId: string,
  intervalMs = 1500,
  timeoutMs = 10 * 60 * 1000,
): Promise<JobPoll> {
  const started = Date.now();
  for (;;) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("job poll timeout");
    }
    const res = await fetch(joinApiUrl(apiBaseUrl, `/api/jobs/${encodeURIComponent(jobId)}`));
    if (!res.ok) throw new Error(`job poll HTTP ${res.status}`);
    const job = (await res.json()) as JobPoll;
    // cancelled/stored 등 어떤 종결 상태든 그대로 돌려준다(취소된 잡을 영원히 기다리지 않게).
    if (job.status !== "processing") return job;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * 웹 확인 모달 "분석" — 저장된 Main 영상을 분석 큐에 세운다.
 * @returns queuePosition 0 = 바로 시작, 1+ = 앞에 그만큼 대기.
 */
export async function confirmAnalyzeJob(
  apiBaseUrl: string,
  jobId: string,
): Promise<{ jobId?: string; status?: string; queuePosition?: number }> {
  const res = await fetch(joinApiUrl(apiBaseUrl, `/api/analyze/${encodeURIComponent(jobId)}/confirm`), {
    method: "POST",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`분석 시작 실패 (${res.status}): ${text.slice(0, 200)}`);
  }
  try {
    return (await res.json()) as { jobId?: string; status?: string; queuePosition?: number };
  } catch {
    return {};
  }
}

/** 웹 확인 모달 "취소(재촬영)" — AI 미전송. 서버가 `analyze_cancelled` 를 방에 뿌려 앱이 촬영 대기로 돌아간다. */
export async function cancelAnalyzeJob(apiBaseUrl: string, jobId: string): Promise<void> {
  const res = await fetch(joinApiUrl(apiBaseUrl, `/api/analyze/${encodeURIComponent(jobId)}`), {
    method: "DELETE",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`취소 실패 (${res.status}): ${text.slice(0, 200)}`);
  }
}
