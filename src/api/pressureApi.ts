/**
 * 압력판 CSV 저장 API (talktail_gait back → back/pressure_data).
 *
 * 녹화 종료 시 canine_gait 호환 CSV + 강아지 메타데이터를 백엔드로 업로드하고,
 * 저장된 기록 목록을 조회한다. CSV 원본은 `csvUrl` 로 열람/다운로드한다.
 */

import { joinApiUrl } from "../config/apiUrl.js";
import { pressureCsvName } from "../core/sessionNaming.js";

export type PressureDog = {
  name: string | null;
  breed: string | null;
  weightKg: number | null;
  heightCm: number | null;
};

export type PressureRecording = {
  frames: number | null;
  durationSec: number | null;
  fps: number | null;
  startedAt: string | null;
};

export type PressureRecord = {
  id: string;
  createdAt: string;
  dog: PressureDog;
  recording: PressureRecording;
  /** `filename` 은 back 이 `path` 에서 떼어 준다 — DB 컬럼이 아니다. */
  csv: { filename: string; path?: string | null };
  /** 백엔드 상대 경로 (`/api/pressure/records/:id/csv`). */
  csvUrl: string;
};

export type UploadPressureInput = {
  csv: string;
  dog: {
    name?: string;
    breed?: string;
    weightKg?: number | null;
    heightCm?: number | null;
  };
  recording?: Partial<PressureRecording>;
  /** 동기 촬영 세션 id — back 에서 영상과 CSV 를 한 세션으로 묶는다. */
  sessionId?: string | null;
  /**
   * 시간축 — 영상 프레임과 CSV 행을 짝지으려면 필수.
   *
   * ★ 전부 **10진 문자열**이다. t_server_ns 는 약 1.75e18 로 JS Number 의
   *   안전 정수 범위(9.0e15)를 넘어, 숫자로 보내면 마이크로초 자리가 조용히 반올림된다.
   *   규격: MAT-TIMEBASE-SPEC.md
   */
  timebase?: {
    /** CSV 첫 행(`time=0`)에 해당하는 t_server_ns. 동기화 전이면 null. */
    startAtServerNs: string | null;
    clockOffsetNs: string | null;
    clockRttP50Ns: string | null;
  };
};

/** 녹화 CSV + 메타데이터를 업로드한다. 저장된 레코드를 반환. */
export async function uploadPressureCsv(
  apiBaseUrl: string,
  input: UploadPressureInput,
): Promise<PressureRecord> {
  const form = new FormData();
  const blob = new Blob([input.csv], { type: "text/csv;charset=utf-8" });
  const { name, breed, weightKg, heightCm } = input.dog;
  // The stored CSV carries the dog, so a file pulled off disk later still says
  // whose walk it is. Falls back to the legacy name when the dog is unknown.
  const rec = input.recording || {};
  form.append(
    "csv",
    blob,
    pressureCsvName({
      dog: { name, weightKg },
      when: rec.startedAt ? new Date(rec.startedAt) : undefined,
    }),
  );
  if (name) form.append("dogName", name);
  if (breed) form.append("dogBreed", breed);
  if (weightKg != null && Number.isFinite(weightKg)) form.append("dogWeightKg", String(weightKg));
  if (heightCm != null && Number.isFinite(heightCm)) form.append("dogHeightCm", String(heightCm));
  for (const key of ["frames", "durationSec", "fps"] as const) {
    const v = rec[key];
    if (v != null && Number.isFinite(v)) form.append(key, String(v));
  }
  if (rec.startedAt) form.append("startedAt", rec.startedAt);
  if (input.sessionId) form.append("sessionId", input.sessionId);

  // 백엔드는 snake_case 를 받는다(pressureStore.js). 값이 없으면 아예 보내지 않는다 —
  // 빈 문자열을 보내면 서버가 "형식이 틀렸다" 로 오해한다.
  const tb = input.timebase;
  if (tb?.startAtServerNs) form.append("start_at_server_ns", tb.startAtServerNs);
  if (tb?.clockOffsetNs) form.append("clock_offset_ns", tb.clockOffsetNs);
  if (tb?.clockRttP50Ns) form.append("clock_rtt_p50_ns", tb.clockRttP50Ns);

  const res = await fetch(joinApiUrl(apiBaseUrl, "/api/pressure/records"), {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j?.error) detail = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  const json = (await res.json()) as { record: PressureRecord };
  return json.record;
}

/** 저장된 압력 기록 목록 (백엔드에서 최신순 정렬). */
export async function listPressureRecords(apiBaseUrl: string): Promise<PressureRecord[]> {
  const res = await fetch(joinApiUrl(apiBaseUrl, "/api/pressure/records"));
  if (!res.ok) throw new Error(`records HTTP ${res.status}`);
  const json = (await res.json()) as { records: PressureRecord[] };
  return json.records || [];
}

/** CSV 열람/다운로드용 절대 URL. `download=true` 면 첨부 다운로드. */
export function pressureCsvUrl(
  apiBaseUrl: string,
  record: Pick<PressureRecord, "id" | "csvUrl">,
  download = false,
): string {
  const rel = record.csvUrl || `/api/pressure/records/${record.id}/csv`;
  const url = joinApiUrl(apiBaseUrl, rel);
  return download ? `${url}${url.includes("?") ? "&" : "?"}download=1` : url;
}
