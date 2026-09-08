/**
 * 서버 디스크의 원본(영상 + 압력 CSV) 목록. DB 가 아니라 back 폴더를 읽는다.
 *
 * ## 폴더가 곧 촬영이다 (2026-09 재설계)
 *
 * 예전에는 CSV 와 영상이 다른 폴더에 흩어져 있어 화면이 파일명을 파싱해 도장으로 되묶었다
 * (`sessionNaming.groupSessions`). 지금은 `uploads/<userId>/<dogId>/<도장>/` 폴더 하나가
 * 촬영 하나라, 서버가 `tasks[]` 로 묶어서 준다 — 화면은 묶을 일이 없다.
 *
 * 키는 전부 **`<dogId>/<도장>[/<파일명>]`** 형태다. 이 문자열이 곧 서버의 폴더 경로라
 * 화면이 경로를 조립하지 않는다.
 */

import { joinApiUrl } from "../config/apiUrl.js";
import { apiFetch } from "./http.js";

export type StoredFile = {
  /** 디스크 파일명 — `260819-144204-37-main.mp4`. 개 이름은 들어 있지 않다. */
  name: string;
  /** `<dogId>/<도장>/<파일명>`. 삭제·zip 요청이 그대로 보내는 값. */
  key: string;
  size: number;
  mtime: string;
  url: string;
  /** 이 파일이 있는 계정 폴더. 전 계정 목록(`userId="*"`)에서 주인을 가른다. */
  userId?: string;
  dogId: number;
  stamp: string;
  /** 받을 때 붙는 이름 — 서버가 `dogs` 를 조회해 재조립한 값(§3-9). */
  downloadName: string;
};

export type StoredCsvFile = StoredFile;
export type StoredVideoFile = StoredFile & { role: "main" | "sub" | string };

/** 촬영 한 건 = 폴더 하나. 서버가 묶어서 준다. */
export type StoredTask = {
  /** `<dogId>/<도장>`. zip·삭제가 이 값을 그대로 보낸다. */
  key: string;
  dogId: number;
  stamp: string;
  dog: { name: string | null; weightKg: number | null };
  /** `260819-144204-37`. */
  taskName: string;
  files: number;
  bytes: number;
  userId?: string;
};

export type StoredFilesList = {
  source: string;
  csv: StoredCsvFile[];
  videos: StoredVideoFile[];
  tasks: StoredTask[];
};

/**
 * @param userId 마스터만 의미가 있다. `"*"` 면 전 계정을 한 목록으로 받는다.
 *               생략하면 조회 스코프(헤더의 계정 선택)를 따른다.
 */
export async function listStoredFiles(
  apiBaseUrl: string,
  userId?: string,
): Promise<StoredFilesList> {
  const path = userId ? `/api/files?userId=${encodeURIComponent(userId)}` : "/api/files";
  const res = await apiFetch(joinApiUrl(apiBaseUrl, path));
  if (!res.ok) throw new Error(`files HTTP ${res.status}`);
  const json = (await res.json()) as StoredFilesList;
  return {
    source: json.source || "fs",
    csv: Array.isArray(json.csv) ? json.csv : [],
    videos: Array.isArray(json.videos) ? json.videos : [],
    tasks: Array.isArray(json.tasks) ? json.tasks : [],
  };
}

/**
 * 이번 촬영을 버린다(소프트 삭제) — 파일은 남고 회차 행에 표시만 붙는다.
 *
 * 예전에는 도장 문자열 목록(`discarded-stamps.json`)에 적었다. 계정 구분이 없어 같은 초에
 * 찍은 남의 회차가 같이 표시됐고 DB 백업에도 안 들어갔다. 지금은
 * `gait_sessions.discarded_at` 컬럼이고, 회차를 통삭제하면 표시도 함께 사라진다(§3-17-1).
 */
export async function discardSession(
  apiBaseUrl: string,
  sessionId: string,
): Promise<{ stamp: string }> {
  const res = await apiFetch(
    joinApiUrl(apiBaseUrl, `/api/sessions/${encodeURIComponent(sessionId)}/discard`),
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`discard HTTP ${res.status}`);
  return (await res.json()) as { stamp: string };
}

/** 버림 표시 해제 — 검증 화면의 되살리기. */
export async function restoreSession(apiBaseUrl: string, sessionId: string): Promise<void> {
  const res = await apiFetch(
    joinApiUrl(apiBaseUrl, `/api/sessions/${encodeURIComponent(sessionId)}/restore`),
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`restore HTTP ${res.status}`);
}

/** 목록의 상대 경로를 절대 URL 로. `download=1` 이면 첨부 저장. */
export function storedFileUrl(apiBaseUrl: string, rel: string, download = true): string {
  const url = joinApiUrl(apiBaseUrl, rel);
  if (!download) return url;
  return `${url}${url.includes("?") ? "&" : "?"}download=1`;
}

/**
 * `task` 는 촬영 한 건을 통째로 묶는다 — zip 안이 **dogId 폴더**로 갈리고 그 안에
 * CSV 와 영상이 사람이 읽는 이름으로 들어간다. `csv`/`video` 는 파일 단위 묶음이다.
 */
export type ZipKind = "csv" | "video" | "task";

const ZIP_KINDS: readonly ZipKind[] = ["csv", "video", "task"];

/** 이름에 파일명으로 못 쓰는 문자가 있는 개체 — 화면이 모달로 알린다(§3-9-A). */
export type ZipNameWarning = {
  dogId: number;
  name: string;
  reason: "forbidden" | "too_long" | "empty" | string;
};

export type ZipTicket = {
  token: string;
  kind: ZipKind;
  /** 실제로 zip 에 담기는 파일 수 (사라진 파일은 빠진다). */
  count: number;
  totalSize: number;
  filename: string;
  /** `/api/files/zip/<token>` — `zipDownloadUrl()` 로 절대 URL 을 만든다. */
  url: string;
  /** 서버에서 찾지 못한 항목 수. */
  missingCount: number;
  nameWarnings: ZipNameWarning[];
};

/**
 * 여러 파일을 한 번에 받기 위한 다운로드 토큰을 발급받는다.
 *
 * 파일명을 URL 에 싣지 않으려고 POST 로 목록을 보내고, 실제 내려받기는
 * `zipDownloadUrl()` 을 브라우저에 맡긴다 — 수 GB 를 Blob 으로 들고 있지 않기 위해서다.
 *
 * @param files 파일은 `<dogId>/<도장>/<파일명>`, 태스크는 `<dogId>/<도장>`.
 *              어떤 파일이 그 촬영의 것인지는 서버가 폴더를 읽어 정한다.
 */
export async function createZipTicket(
  apiBaseUrl: string,
  kind: ZipKind,
  files: string[],
): Promise<ZipTicket> {
  const res = await apiFetch(joinApiUrl(apiBaseUrl, "/api/files/zip-ticket"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, files }),
  });
  const json = (await res.json().catch(() => null)) as
    | (Partial<ZipTicket> & { error?: string })
    | null;
  if (!res.ok || !json || typeof json.url !== "string") {
    const detail = json && typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return {
    token: String(json.token || ""),
    kind: ZIP_KINDS.includes(json.kind as ZipKind) ? (json.kind as ZipKind) : kind,
    count: Number(json.count) || 0,
    totalSize: Number(json.totalSize) || 0,
    filename: String(json.filename || "files.zip"),
    url: json.url,
    missingCount: Number(json.missingCount) || 0,
    nameWarnings: Array.isArray(json.nameWarnings) ? json.nameWarnings : [],
  };
}

/** 발급받은 티켓의 zip 다운로드 절대 URL. */
export function zipDownloadUrl(apiBaseUrl: string, ticketUrl: string): string {
  return joinApiUrl(apiBaseUrl, ticketUrl);
}

/** CSV 로우데이터의 시간 범위 — 첫 행과 마지막 행의 `time` 열에서 뽑는다. */
export type CsvSpan = {
  /** 첫 샘플 시각(초). 보통 0 근처다. */
  startSec: number;
  /** 마지막 샘플 시각(초). */
  endSec: number;
  /** `endSec - startSec`. 실제로 몇 초간 쌓였는지. */
  seconds: number;
  /** frame_id 로 센 행 수. */
  frames: number;
  /** frames / seconds. 매트가 초당 몇 장을 남겼는지 — 빠지면 여기서 티가 난다. */
  fps: number;
};

/**
 * CSV 의 앞뒤 조각만 Range 로 받아 시간 범위를 계산한다.
 *
 * 전체를 받으면 안 되는 이유: 파일 하나가 중앙값 2MB, 최대 14MB 인데 여기서 필요한
 * 건 첫 행과 마지막 행 두 줄뿐이다. 세션을 눌러볼 때마다 수 MB 를 받으면 현장
 * 노트북에서 확인이 느려진다.
 *
 * 앞 조각을 32KB 나 받는 이유는 헤더가 40×40=1600 열이라 그것만 12KB 이기 때문이다.
 * 서버가 Range 를 무시하고 200 으로 전체를 주더라도 파싱은 그대로 성립한다(느릴 뿐).
 */
/** CSV 가 LF 로 오든 CRLF 로 오든 같은 줄로 자른다. */
const NEWLINE = /\r?\n/;

export async function fetchCsvSpan(apiBaseUrl: string, rel: string): Promise<CsvSpan | null> {
  const url = joinApiUrl(apiBaseUrl, rel);
  const grab = async (range: string): Promise<string> => {
    const res = await apiFetch(url, { headers: { Range: range } });
    if (!res.ok) throw new Error(`csv HTTP ${res.status}`);
    return res.text();
  };
  const [head, tail] = await Promise.all([grab("bytes=0-32767"), grab("bytes=-16384")]);

  const headLines = head.split(NEWLINE);
  const cols = (headLines[0] || "").trim().split(",");
  const timeIdx = cols.indexOf("time");
  const frameIdx = cols.indexOf("frame_id");
  if (timeIdx < 0) return null;

  const first = pickRow(headLines.slice(1), timeIdx, frameIdx);
  // 잘려 시작하는 첫 줄은 버린다. 그 뒤부터가 온전한 행이다.
  const last = pickRow(tail.split(NEWLINE).slice(1), timeIdx, frameIdx, true);
  if (!first || !last) return null;

  const seconds = Math.max(0, last.time - first.time);
  const frames =
    first.frame != null && last.frame != null && last.frame >= first.frame
      ? last.frame - first.frame + 1
      : 0;
  return {
    startSec: first.time,
    endSec: last.time,
    seconds,
    frames,
    fps: seconds > 0 && frames > 0 ? frames / seconds : 0,
  };
}

/** 온전한 데이터 행 하나에서 time·frame_id 를 꺼낸다. `fromEnd` 면 뒤에서부터 찾는다. */
function pickRow(
  lines: string[],
  timeIdx: number,
  frameIdx: number,
  fromEnd = false,
): { time: number; frame: number | null } | null {
  const order = fromEnd ? [...lines].reverse() : lines;
  for (const line of order) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(",");
    if (parts.length <= timeIdx) continue;
    const time = Number(parts[timeIdx]);
    if (!Number.isFinite(time)) continue;
    const frame = frameIdx >= 0 ? Number(parts[frameIdx]) : NaN;
    return { time, frame: Number.isFinite(frame) ? frame : null };
  }
  return null;
}

/** `POST /api/files/delete` 의 결과. */
export type DeleteResult = {
  /** 실제로 지운 항목의 키. */
  deleted: string[];
  /** 요청했지만 이미 없던 항목 — 오류가 아니다. */
  missing: string[];
  failed: { name: string; error: string }[];
};

/**
 * 원본 파일(또는 촬영 폴더)을 서버에서 지운다. **되돌릴 수 없다.**
 *
 * 지우는 것은 back 디스크의 원본뿐이다. ai-server 의 분석 산출물과 MySQL 행은 그대로 남는다
 * — 셋을 한꺼번에 지우는 것은 태스크 목록의 **회차 통삭제**(`deleteTasks`)다.
 *
 * @param files `<dogId>/<도장>/<파일명>`(파일 하나) 또는 `<dogId>/<도장>`(폴더 통째로).
 */
export async function deleteStoredFiles(
  apiBaseUrl: string,
  files: string[],
  userId?: string,
): Promise<DeleteResult> {
  // 쓰기 요청에는 조회 스코프가 붙지 않는다(`http.ts`). 남의 계정을 지우려면 여기서 명시한다.
  const path = userId
    ? `/api/files/delete?userId=${encodeURIComponent(userId)}`
    : "/api/files/delete";
  const res = await apiFetch(joinApiUrl(apiBaseUrl, path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ files }),
  });
  const json = (await res.json().catch(() => null)) as
    | (Partial<DeleteResult> & { error?: string })
    | null;
  if (!res.ok || !json) {
    const detail = json && typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return {
    deleted: Array.isArray(json.deleted) ? json.deleted : [],
    missing: Array.isArray(json.missing) ? json.missing : [],
    failed: Array.isArray(json.failed) ? json.failed : [],
  };
}
