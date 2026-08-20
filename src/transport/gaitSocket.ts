/**
 * 웹(매트 뷰어) ↔ back WebSocket 클라이언트.
 * 녹화 동기화 + 분석 결과만 담당 (라이브 영상 전송 없음).
 */

import { joinApiUrl } from "../config/apiUrl.js";

export type SyncPeers = {
  web: boolean;
  mobile: boolean;
  /** 연결된 카메라 폰 수 (Main + Sub). 구버전 서버는 없음. */
  mobileCount?: number;
  /** Main 카메라 접속 여부 (분석 대상). */
  main?: boolean;
  /** Sub 카메라 수. */
  subCount?: number;
};

export type CaptureSettingsPayload = {
  presetId: string;
  videoQuality: string;
  fps: number;
  width: number;
  height: number;
  bitrate: number;
};

export type SyncMessage =
  | { type: "joined"; role: string; roomId: string; peers: SyncPeers; serverNow: number }
  | { type: "peer_update"; roomId: string; peers: SyncPeers }
  | {
      type: "sync_start";
      roomId: string;
      sessionId: string;
      serverNow: number;
      recordAt: number;
      syncLeadMs: number;
      captureSettings?: CaptureSettingsPayload | null;
    }
  | { type: "record_stop"; roomId: string; sessionId: string | null; from: string; serverNow: number }
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
  | { type: "upload_started"; jobId: string; sessionId: string | null; roomId: string }
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
  roomId: string;
  role?: SyncRole;
}

export class GaitSyncSocket {
  private ws: WebSocket | null = null;
  private handler: Handler = () => {};
  private connectionHandler: ConnectionHandler = () => {};
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private readonly wsUrl: string;
  private readonly roomId: string;
  readonly role: SyncRole;
  peers: SyncPeers = { web: false, mobile: false };
  connected = false;

  constructor(opts: GaitSyncOptions) {
    this.wsUrl = opts.wsUrl;
    this.roomId = opts.roomId;
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
    this.send({ type: "join", role: this.role, roomId: this.roomId });
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
  } | null, captureSettings?: CaptureSettingsPayload | null): void {
    if (this.isViewer) return;
    this.send({
      type: "record_request",
      dog: dog && (dog.name || dog.weightKg != null)
        ? { dogName: dog.name ?? null, dogWeightKg: dog.weightKg ?? null }
        : null,
      ...(captureSettings ? { captureSettings } : {}),
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

  private open(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    console.log("[gait-sync] connecting", this.wsUrl);
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      console.log("[gait-sync] open");
      this.connectionHandler(true);
      this.join();
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as SyncMessage;
        if (msg.type === "joined" || msg.type === "peer_update") {
          this.peers = msg.peers;
        }
        this.handler(msg);
      } catch (err) {
        console.warn("[gait-sync] bad message", err);
      }
    };

    ws.onerror = () => console.warn("[gait-sync] error");
    ws.onclose = () => {
      this.connected = false;
      this.ws = null;
      console.log("[gait-sync] closed");
      this.connectionHandler(false);
      if (!this.closedByUser) {
        this.reconnectTimer = setTimeout(() => this.open(), 1500);
      }
    };
  }
}

export function waitUntilRecordAt(recordAt: number): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => {
      const remain = recordAt - Date.now();
      if (remain <= 0) {
        resolve();
        return;
      }
      setTimeout(tick, Math.min(remain, 50));
    };
    tick();
  });
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
