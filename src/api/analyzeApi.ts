/**
 * 직접 분석 API — 이미 가지고 있는 압력 CSV + 촬영 영상을 back 으로 올린다.
 *
 * back `POST /api/analyze/manual` 이 CSV 를 `pressure_data/` 에, 영상을 `uploads/main/`
 * 에 저장한 뒤 둘을 함께 ai-server `/analyze` 로 보낸다. 촬영 세션과 산출물·DB 행이
 * 같으므로, 결과는 리포트에서 평소처럼 조회된다.
 */

import { joinApiUrl } from "../config/apiUrl.js";

export type ManualDogInfo = {
  name?: string | null;
  breed?: string | null;
  weightKg?: number | null;
  heightCm?: number | null;
};

export type ManualAnalyzeInput = {
  csv: File;
  video: File;
  dog?: ManualDogInfo;
};

export type ManualAnalyzeJob = {
  jobId: string;
  status: string;
  sessionId: string | null;
  originalUrl: string | null;
};

/** 강아지 정보 4종 중 하나라도 값이 있으면 true. */
export function hasDogInfo(dog: ManualDogInfo | null | undefined): boolean {
  if (!dog) return false;
  return Boolean(
    (dog.name && dog.name.trim()) ||
      (dog.breed && dog.breed.trim()) ||
      (dog.weightKg != null && Number.isFinite(dog.weightKg)) ||
      (dog.heightCm != null && Number.isFinite(dog.heightCm)),
  );
}

/** CSV + 영상을 업로드하고 분석 잡을 시작한다. 잡 진행은 `/api/jobs/:id` 로 폴링한다. */
export async function uploadManualAnalysis(
  apiBaseUrl: string,
  input: ManualAnalyzeInput,
): Promise<ManualAnalyzeJob> {
  const form = new FormData();
  form.append("video", input.video, input.video.name || "gait.mp4");
  form.append("csv", input.csv, input.csv.name || "pressure.csv");

  const dog = input.dog || {};
  if (dog.name && dog.name.trim()) form.append("dogName", dog.name.trim());
  if (dog.breed && dog.breed.trim()) form.append("dogBreed", dog.breed.trim());
  if (dog.weightKg != null && Number.isFinite(dog.weightKg)) {
    form.append("dogWeightKg", String(dog.weightKg));
  }
  if (dog.heightCm != null && Number.isFinite(dog.heightCm)) {
    form.append("dogHeightCm", String(dog.heightCm));
  }

  const res = await fetch(joinApiUrl(apiBaseUrl, "/api/analyze/manual"), {
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
  return (await res.json()) as ManualAnalyzeJob;
}
