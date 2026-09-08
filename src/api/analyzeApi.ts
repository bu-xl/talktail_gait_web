/**
 * 직접 분석 API — 이미 가지고 있는 압력 CSV + 촬영 영상을 back 으로 올린다.
 *
 * back `POST /api/analyze/manual` 이 **촬영 폴더**(`uploads/<userId>/<dogId>/<도장>/`)에
 * 둘을 나란히 저장한 뒤 함께 ai-server `/analyze` 로 보낸다. 촬영 세션과 산출물·DB 행이
 * 같으므로 결과는 리포트에서 평소처럼 조회된다.
 *
 * ★ **`dogId` 가 필수다.** 개체 없이는 파일을 둘 자리가 없다(§3-3).
 */

import { joinApiUrl } from "../config/apiUrl.js";
import { apiFetch } from "./http.js";

export type ManualDogInfo = {
  name?: string | null;
  breed?: string | null;
  weightKg?: number | null;
  heightCm?: number | null;
};

export type ManualAnalyzeInput = {
  csv: File;
  video: File;
  /** 촬영 대상 개체(`dogs.id`) — **필수**. 저장 폴더의 한 조각이다. */
  dogId: number;
};

export type ManualAnalyzeJob = {
  jobId: string;
  status: string;
  sessionId: string | null;
  originalUrl: string | null;
  /** 분석 큐 대기 순번. 0 = 바로 시작. */
  queuePosition?: number;
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

  // 개 정보는 **id 하나**다. 이름·몸무게는 서버가 `dogs` 에서 읽는다 — 두 곳이 같은 값을
  // 들고 있으면 언젠가 갈리고, 그 갈림이 파일명에 박히던 것이 §1-3 의 문제였다.
  form.append("dogId", String(input.dogId));

  const res = await apiFetch(joinApiUrl(apiBaseUrl, "/api/analyze/manual"), {
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

/**
 * 이미 서버에 있는 촬영을 분석한다 — 검증 화면의 "분석하기".
 *
 * `uploadManualAnalysis` 와 달리 파일을 올리지 않는다. 서버가 도장으로 디스크의
 * CSV·Main 영상을 찾아 쓰므로 브라우저가 수백 MB 를 왕복시킬 이유가 없다.
 * CSV 가 없는 촬영도 보낸다 — 영상만으로도 분석은 돈다(압력 산출물만 빠진다).
 */
export async function analyzeStoredCapture(
  apiBaseUrl: string,
  dogId: number,
  stamp: string,
): Promise<ManualAnalyzeJob & { taskName: string; hasCsv: boolean }> {
  // 개체 + 도장이 곧 촬영 폴더다(§3-22). 예전에는 도장만 보내고 서버가 계정 폴더 전체를
  // 훑어 파일명으로 짝을 맞췄다 — 이제 `readdir` 한 번이면 끝난다.
  const res = await apiFetch(joinApiUrl(apiBaseUrl, "/api/analyze/stored"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ dogId, stamp }),
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
  return (await res.json()) as ManualAnalyzeJob & { taskName: string; hasCsv: boolean };
}
