/**
 * 압력판 CSV 저장 API (talktail_gait back → back/pressure_data).
 *
 * 녹화 종료 시 canine_gait 호환 CSV + 강아지 메타데이터를 백엔드로 업로드하고,
 * 저장된 기록 목록을 조회한다. CSV 원본은 `csvUrl` 로 열람/다운로드한다.
 */

import { joinApiUrl } from "../config/apiUrl.js";

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
  rows: number | null;
  cols: number | null;
  startedAt: string | null;
};

export type PressureRecord = {
  id: string;
  createdAt: string;
  dog: PressureDog;
  recording: PressureRecording;
  csv: { filename: string; size: number; path?: string | null };
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
};

/** 녹화 CSV + 메타데이터를 업로드한다. 저장된 레코드를 반환. */
export async function uploadPressureCsv(
  apiBaseUrl: string,
  input: UploadPressureInput,
): Promise<PressureRecord> {
  const form = new FormData();
  const blob = new Blob([input.csv], { type: "text/csv;charset=utf-8" });
  form.append("csv", blob, "pressure.csv");

  const { name, breed, weightKg, heightCm } = input.dog;
  if (name) form.append("dogName", name);
  if (breed) form.append("dogBreed", breed);
  if (weightKg != null && Number.isFinite(weightKg)) form.append("dogWeightKg", String(weightKg));
  if (heightCm != null && Number.isFinite(heightCm)) form.append("dogHeightCm", String(heightCm));

  const rec = input.recording || {};
  for (const key of ["frames", "durationSec", "fps", "rows", "cols"] as const) {
    const v = rec[key];
    if (v != null && Number.isFinite(v)) form.append(key, String(v));
  }
  if (rec.startedAt) form.append("startedAt", rec.startedAt);
  if (input.sessionId) form.append("sessionId", input.sessionId);

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
