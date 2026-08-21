/**
 * 서버 디스크의 원본 CSV·영상 목록. DB 가 아니라 back 폴더를 읽는다.
 */

import { joinApiUrl } from "../config/apiUrl.js";

export type StoredCsvFile = {
  name: string;
  size: number;
  mtime: string;
  url: string;
};

export type StoredVideoFile = StoredCsvFile & {
  role: "main" | "sub" | string;
};

export type StoredFilesList = {
  source: string;
  csv: StoredCsvFile[];
  videos: StoredVideoFile[];
};

export async function listStoredFiles(apiBaseUrl: string): Promise<StoredFilesList> {
  const res = await fetch(joinApiUrl(apiBaseUrl, "/api/files"));
  if (!res.ok) throw new Error(`files HTTP ${res.status}`);
  const json = (await res.json()) as StoredFilesList;
  return {
    source: json.source || "fs",
    csv: Array.isArray(json.csv) ? json.csv : [],
    videos: Array.isArray(json.videos) ? json.videos : [],
  };
}

/** 목록의 상대 경로를 절대 URL 로. `download=1` 이면 첨부 저장. */
export function storedFileUrl(apiBaseUrl: string, rel: string, download = true): string {
  const url = joinApiUrl(apiBaseUrl, rel);
  if (!download) return url;
  return `${url}${url.includes("?") ? "&" : "?"}download=1`;
}

export type ZipKind = "csv" | "video";

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
};

/**
 * 여러 파일을 한 번에 받기 위한 다운로드 토큰을 발급받는다.
 *
 * 파일명을 URL 에 싣지 않으려고 POST 로 목록을 보내고, 실제 내려받기는
 * `zipDownloadUrl()` 을 브라우저에 맡긴다 — 수 GB 를 Blob 으로 들고 있지 않기 위해서다.
 *
 * @param files csv 는 파일명(`a.csv`), 영상은 `role/파일명`(`main/x.mp4`).
 */
export async function createZipTicket(
  apiBaseUrl: string,
  kind: ZipKind,
  files: string[],
): Promise<ZipTicket> {
  const res = await fetch(joinApiUrl(apiBaseUrl, "/api/files/zip-ticket"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, files }),
  });
  const json = (await res.json().catch(() => null)) as (Partial<ZipTicket> & { error?: string }) | null;
  if (!res.ok || !json || typeof json.url !== "string") {
    const detail = json && typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return {
    token: String(json.token || ""),
    kind: json.kind === "video" ? "video" : "csv",
    count: Number(json.count) || 0,
    totalSize: Number(json.totalSize) || 0,
    filename: String(json.filename || "files.zip"),
    url: json.url,
    missingCount: Number(json.missingCount) || 0,
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
    const res = await fetch(url, { headers: { Range: range } });
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
  /** 실제로 지운 항목(csv 는 파일명, 영상은 `role/파일명`). */
  deleted: string[];
  /** 요청했지만 이미 없던 항목 — 오류가 아니다. */
  missing: string[];
  failed: { name: string; error: string }[];
  /** 함께 지운 압력 기록(records.json) 행 수. */
  forgottenRecords: number;
};

/**
 * 촬영 한 건의 원본 파일을 서버에서 지운다. **되돌릴 수 없다.**
 *
 * 지우는 것은 back 디스크의 원본(CSV·영상)뿐이다. ai-server 의 분석 산출물과
 * MySQL 행은 그대로 남는다 — 리포트는 그쪽을 보므로 이미 나온 분석은 살아 있다.
 *
 * @param files csv 는 파일명(`a.csv`), 영상은 `role/파일명`(`main/x.mp4`).
 */
export async function deleteStoredFiles(
  apiBaseUrl: string,
  files: { csv: string[]; videos: string[] },
): Promise<DeleteResult> {
  const res = await fetch(joinApiUrl(apiBaseUrl, "/api/files/delete"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(files),
  });
  const json = (await res.json().catch(() => null)) as (Partial<DeleteResult> & { error?: string }) | null;
  if (!res.ok || !json) {
    const detail = json && typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return {
    deleted: Array.isArray(json.deleted) ? json.deleted : [],
    missing: Array.isArray(json.missing) ? json.missing : [],
    failed: Array.isArray(json.failed) ? json.failed : [],
    forgottenRecords: Number(json.forgottenRecords) || 0,
  };
}
