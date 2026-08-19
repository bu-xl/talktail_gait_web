/**
 * 서버 클럭 오프셋 추정 — 매트를 카메라와 같은 시간축에 올린다.
 *
 * 왜 필요한가:
 *   카메라 폰들은 이미 이 방식으로 서로 2.7ms 안에 맞춰져 있다(실측). 매트만
 *   `Date.now()` 기반이라 축 밖에 있어, 압력 샘플과 영상 프레임을 짝지을 수 없다.
 *   30fps 에서 1초는 30프레임이다 — 벽시계 오차가 수백 ms 면 매칭이 성립하지 않는다.
 *
 *   rtt    = (t4 - t1) - (t3 - t2)
 *   offset = ((t2 - t1) + (t3 - t4)) / 2
 *   t_server_ns = t_device_ns + offset
 *
 * ★ `Date.now()` 를 쓰지 않는다
 *   벽시계는 NTP 보정으로 앞뒤로 점프한다. 세션 도중 한 번만 튀어도 그 순간부터
 *   기록된 모든 샘플의 시각이 틀어지고, 사후에 알아낼 방법이 없다.
 *   대신 `performance.now()` — 단조 증가하는 고해상도 시계 — 를 쓴다.
 *
 * ★ 나노초는 문자열로 다룬다
 *   t_server_ns 는 약 1.75e18 로 JS Number 안전 정수 범위(9.0e15)를 넘는다.
 *   내부 계산은 bigint, 서버와의 교환은 10진 문자열.
 */

import { joinApiUrl } from "../config/apiUrl.js";

/** 왕복 횟수. 하위 30% 를 남기면 4~5 표본이 되어 중앙값이 안정된다. */
const SAMPLE_COUNT = 16;
/** rtt 하위 몇 %를 채택할지. 큰 rtt 표본은 경로 비대칭이 커서 offset 을 오염시킨다. */
const KEEP_RATIO = 0.3;
/** 이 값을 넘으면 측정을 시작하면 안 된다. */
export const RTT_P50_LIMIT_NS = 80n * 1_000_000n;
/** 재동기화 주기. */
const RESYNC_INTERVAL_MS = 3 * 60 * 1000;
/** 이만큼 offset 이 흔들리면 알린다. */
export const DRIFT_REPORT_NS = 20n * 1_000_000n;
/** 표본 간 간격 — 연속 요청이 같은 커넥션에 몰려 rtt 가 부풀지 않게 한다. */
const SAMPLE_GAP_MS = 25;
const REQUEST_TIMEOUT_MS = 3000;

export type ClockSyncResult = {
  offsetNs: bigint;
  rttP50Ns: bigint;
  rttP95Ns: bigint;
  samplesKept: number;
  samplesTotal: number;
  /** 서버 시간축 식별자. 바뀌었으면 서버가 재시작해 축이 재앵커된 것이다. */
  epochId: string;
  /** rtt p50 이 한계 이하인가. false 면 측정을 시작하면 안 된다. */
  ok: boolean;
};

type Sample = { rtt: bigint; offset: bigint };

/** `performance.now()`(ms, 소수) → 나노초 정수. */
function deviceNowNs(): bigint {
  return BigInt(Math.round(performance.now() * 1e6));
}

function sortBig(values: bigint[]): bigint[] {
  return [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function median(sorted: bigint[]): bigint {
  const n = sorted.length;
  if (n === 0) return 0n;
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2n;
}

/** 최근접 순위 백분위 — 보간하지 않는다(표본이 16개뿐이라 실측값이어야 한다). */
function percentile(sorted: bigint[], q: number): bigint {
  if (sorted.length === 0) return 0n;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1));
  return sorted[idx];
}

async function oneRoundTrip(url: string): Promise<{ sample: Sample; epochId: string }> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    // t1 — 이 줄과 fetch 사이에 아무것도 두지 않는다.
    const t1 = deviceNowNs();
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ t1_ns: t1.toString() }),
      signal: controller.signal,
    });
    // t4 — 본문 파싱 **전에** 찍어야 파싱 시간이 rtt 에 섞이지 않는다.
    const t4 = deviceNowNs();
    if (!res.ok) throw new Error(`time/sync HTTP ${res.status}`);
    const json = (await res.json()) as {
      t1_ns: string;
      t2_ns: string;
      t3_ns: string;
      epoch_id: string;
    };
    if (json.t1_ns !== t1.toString()) throw new Error("time/sync echo mismatch");
    const t2 = BigInt(json.t2_ns);
    const t3 = BigInt(json.t3_ns);
    return {
      sample: { rtt: t4 - t1 - (t3 - t2), offset: (t2 - t1 + (t3 - t4)) / 2n },
      epochId: String(json.epoch_id ?? ""),
    };
  } finally {
    window.clearTimeout(timer);
  }
}

export class ClockSync {
  private offsetNs: bigint | null = null;
  private last: ClockSyncResult | null = null;
  private resyncTimer: number | null = null;
  private apiBase = "";

  /** 마지막 동기화 결과. 아직이면 null. */
  get result(): ClockSyncResult | null {
    return this.last;
  }

  /** 동기화 전이면 null — 이 상태에서 시각을 만들면 안 된다. */
  get offset(): bigint | null {
    return this.offsetNs;
  }

  get synced(): boolean {
    return this.offsetNs !== null;
  }

  /** 16회 왕복해 오프셋을 갱신한다. 실패한 표본은 버리고 남은 것으로 계산한다. */
  async sync(apiBaseUrl: string): Promise<ClockSyncResult> {
    this.apiBase = apiBaseUrl;
    const url = joinApiUrl(apiBaseUrl, "/api/time/sync");
    const samples: Sample[] = [];
    let epochId = "";
    let lastError: unknown = null;

    for (let i = 0; i < SAMPLE_COUNT; i++) {
      try {
        const { sample, epochId: eid } = await oneRoundTrip(url);
        // 음수 rtt 는 시계가 튀었다는 뜻 — 표본에서 제외한다.
        if (sample.rtt >= 0n) {
          samples.push(sample);
          epochId = eid;
        }
      } catch (err) {
        lastError = err;
      }
      if (i < SAMPLE_COUNT - 1) {
        await new Promise((r) => window.setTimeout(r, SAMPLE_GAP_MS));
      }
    }

    if (samples.length === 0) {
      throw new Error(`clock sync failed: no usable samples (${String(lastError)})`);
    }

    const byRtt = [...samples].sort((a, b) => (a.rtt < b.rtt ? -1 : a.rtt > b.rtt ? 1 : 0));
    const kept = byRtt.slice(0, Math.max(1, Math.ceil(byRtt.length * KEEP_RATIO)));
    const rttSorted = sortBig(byRtt.map((s) => s.rtt));
    const rttP50 = percentile(rttSorted, 0.5);
    const offsetNs = median(sortBig(kept.map((s) => s.offset)));

    // 서버가 재시작해 시간축이 재앵커됐으면 이전 오프셋은 의미가 없다.
    if (this.last?.epochId && epochId && this.last.epochId !== epochId) {
      this.offsetNs = null;
    }

    const result: ClockSyncResult = {
      offsetNs,
      rttP50Ns: rttP50,
      rttP95Ns: percentile(rttSorted, 0.95),
      samplesKept: kept.length,
      samplesTotal: samples.length,
      epochId,
      ok: rttP50 <= RTT_P50_LIMIT_NS,
    };
    this.offsetNs = offsetNs;
    this.last = result;
    return result;
  }

  /** 기기 시각 → 서버 시각. 동기화 전이면 throw — 조용히 틀린 값을 내지 않는다. */
  toServerNs(tDeviceNs: bigint): bigint {
    if (this.offsetNs === null) throw new Error("clock not synced");
    return tDeviceNs + this.offsetNs;
  }

  /** 서버 시각 → 기기 시각(= `performance.now()` 축). 예약 시각 환산에 쓴다. */
  toDeviceNs(tServerNs: bigint): bigint {
    if (this.offsetNs === null) throw new Error("clock not synced");
    return tServerNs - this.offsetNs;
  }

  /** 지금의 서버 시각(ns). */
  nowServerNs(): bigint {
    return this.toServerNs(deviceNowNs());
  }

  /**
   * `performance.now()` 값(ms) 하나를 서버 시각(ns)으로. 녹화 시작점 환산용.
   * 동기화 전이면 null.
   */
  perfMsToServerNs(perfMs: number): bigint | null {
    if (this.offsetNs === null) return null;
    return BigInt(Math.round(perfMs * 1e6)) + this.offsetNs;
  }

  /** 세션 중 3분마다 재동기화해 드리프트를 추적한다. */
  startAutoResync(handlers: {
    onDrift?: (deltaNs: bigint, result: ClockSyncResult) => void;
    onResult?: (result: ClockSyncResult) => void;
    onError?: (err: unknown) => void;
  } = {}): void {
    this.stopAutoResync();
    this.resyncTimer = window.setInterval(() => {
      const before = this.offsetNs;
      void this.sync(this.apiBase)
        .then((result) => {
          handlers.onResult?.(result);
          if (before === null) return;
          const delta = result.offsetNs - before;
          const abs = delta < 0n ? -delta : delta;
          if (abs > DRIFT_REPORT_NS) handlers.onDrift?.(delta, result);
        })
        .catch((err) => handlers.onError?.(err));
    }, RESYNC_INTERVAL_MS);
  }

  stopAutoResync(): void {
    if (this.resyncTimer !== null) window.clearInterval(this.resyncTimer);
    this.resyncTimer = null;
  }
}

/** 앱 전역 인스턴스 — 부팅 시 한 번, 세션 참가 시 한 번 `sync()` 한다. */
export const clockSync = new ClockSync();

export { deviceNowNs };
