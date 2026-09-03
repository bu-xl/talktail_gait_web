/**
 * 다중 분석 API (back → ai-server).
 *
 * 목록의 출처가 "파일"이 아니라 **분석이 끝난 태스크**라는 점이 데이터 검증 화면과 다르다.
 * back 이 `analysis_results` 를 개(이름+몸무게) 단위로 묶어 준다.
 */

import { joinApiUrl } from "../config/apiUrl.js";
import { apiFetch } from "./http.js";

export type MultiDog = {
  /** `이름|몸무게` — 목록과 선택이 같은 문자열을 쓰게 하는 키. */
  key: string;
  name: string;
  weightKg: number | null;
  sessionCount: number;
  /** `260819-144204` */
  latestStamp: string;
  latestDate: string;
};

export type MultiSession = {
  taskName: string;
  date: string;
  displayDate: string;
  time: string;
  displayTime: string;
};

export type MultiJob = {
  id: number;
  dogName: string | null;
  dogWeightKg: number | null;
  taskNames: string[];
  status: "pending" | "done" | "failed";
  jobId: string | null;
  /** back 기준 상대 주소. 열 때 `joinApiUrl` 로 절대화한다. */
  pdfUrl: string | null;
  error: string | null;
  createdAt: string;
};

async function getJson<T>(apiBase: string, path: string): Promise<T> {
  const res = await apiFetch(joinApiUrl(apiBase, path));
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body as T;
}

export async function listMultiDogs(apiBase: string): Promise<MultiDog[]> {
  const data = await getJson<{ dogs: MultiDog[] }>(apiBase, "/api/multi-analysis/dogs");
  return data.dogs ?? [];
}

export async function listMultiSessions(
  apiBase: string,
  dog: { name: string; weightKg: number | null },
): Promise<MultiSession[]> {
  const q = new URLSearchParams({ name: dog.name });
  if (dog.weightKg != null) q.set("weightKg", String(dog.weightKg));
  const data = await getJson<{ sessions: MultiSession[] }>(
    apiBase,
    `/api/multi-analysis/sessions?${q.toString()}`,
  );
  return data.sessions ?? [];
}

export async function listMultiJobs(apiBase: string): Promise<MultiJob[]> {
  const data = await getJson<{ jobs: MultiJob[] }>(apiBase, "/api/multi-analysis/jobs");
  return data.jobs ?? [];
}

export async function requestMultiAnalysis(
  apiBase: string,
  input: { name: string; weightKg: number | null; taskNames: string[] },
): Promise<{ job: MultiJob; position: number }> {
  const res = await apiFetch(joinApiUrl(apiBase, "/api/multi-analysis/jobs"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body as { job: MultiJob; position: number };
}

/** 결과 PDF 의 절대 주소. */
export function multiPdfUrl(apiBase: string, job: MultiJob): string | null {
  return job.pdfUrl ? joinApiUrl(apiBase, job.pdfUrl) : null;
}

export type MultiShareLink = {
  /** 폰이 그대로 여는 절대 주소. back 이 요청 Host 로 만든다. */
  url: string;
  filename: string;
  expiresAt: string;
  ttlSec: number;
};

/**
 * 로그인 없이 열리는 짧은 다운로드 링크를 받는다. QR 로 찍을 대상이다.
 *
 * 기존 `pdfUrl` 을 QR 로 만들면 안 된다 — 폰에는 세션 쿠키가 없어 401 만 본다.
 */
export async function createMultiShareLink(
  apiBase: string,
  jobId: number,
): Promise<MultiShareLink> {
  const res = await apiFetch(joinApiUrl(apiBase, `/api/multi-analysis/jobs/${jobId}/share`), {
    method: "POST",
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body as MultiShareLink;
}
