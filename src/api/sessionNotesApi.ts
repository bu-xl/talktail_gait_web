/**
 * 세션별 병력·메모.
 *
 * 측정 노트북과 열람 노트북이 나뉘어 있으므로 브라우저 로컬에 두면 쓸모가 없다.
 * 서버에 두어야 어느 쪽에서 적어도 양쪽에서 보이고, 나중에 라벨링 데이터로 같이
 * 꺼낼 수 있다.
 */

import { joinApiUrl } from "../config/apiUrl.js";
import { apiFetch } from "./http.js";

export interface SessionNotes {
  date: string;
  stem: string;
  /** 자유 서술. 병력, 수술 이력, 관찰 메모. */
  text: string;
  updatedAt: string | null;
}

function notesUrl(apiBaseUrl: string, date: string, stem: string): string {
  return joinApiUrl(
    apiBaseUrl,
    `/api/results/${encodeURIComponent(date)}/sessions/${encodeURIComponent(stem)}/notes`,
  );
}

/** 저장된 메모. 아직 없으면 빈 문자열. */
export async function getSessionNotes(
  apiBaseUrl: string,
  date: string,
  stem: string,
): Promise<string> {
  const res = await apiFetch(notesUrl(apiBaseUrl, date, stem));
  // 한 번도 안 적은 세션은 404 다. 빈 메모와 같은 뜻이므로 예외로 만들지 않는다.
  if (res.status === 404) return "";
  if (!res.ok) throw new Error(`notes HTTP ${res.status}`);
  const json = (await res.json()) as Partial<SessionNotes>;
  return typeof json.text === "string" ? json.text : "";
}

export async function saveSessionNotes(
  apiBaseUrl: string,
  date: string,
  stem: string,
  text: string,
): Promise<void> {
  const res = await apiFetch(notesUrl(apiBaseUrl, date, stem), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const json = (await res.json()) as { error?: string };
      if (json.error) detail = json.error;
    } catch {
      /* 본문이 JSON 이 아니면 상태 코드만 쓴다 */
    }
    throw new Error(detail);
  }
}
