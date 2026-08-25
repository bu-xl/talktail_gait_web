/**
 * Session file naming.
 *
 * Field order is `stamp - role - dogName - weight - kind`:
 *
 *     260819-144204-main-대박이-5.2kg.mp4
 *     260819-144204-sub1-대박이-5.2kg.mp4
 *     260819-144204-대박이-5.2kg.csv
 *
 * The stamp leads so that sorting a folder by name keeps one capture's files
 * together, with `main` before `sub1` before `sub2` inside it. Everything that
 * parses these names therefore anchors on the START of the string. The old
 * tail-anchored scheme (`대박이-5.2kg-main-260819-144204.mp4`) is not read at
 * all — that data was dropped rather than migrated.
 *
 * The backend's copy of these rules lives in `back/src/naming.js`. A change to
 * one has to land in the same release as the other.
 */

import type { StoredCsvFile, StoredVideoFile } from "../api/storedFilesApi.js";

export type CaptureRole = "main" | "sub";

export interface DogIdentity {
  name: string | null | undefined;
  weightKg: number | null | undefined;
}

/**
 * Characters a filename cannot carry across Windows, macOS and Linux, plus the
 * hyphen. The hyphen is the field separator here, so removing it from the dog's
 * name is what keeps `parseCaptureName` unambiguous. Korean and other
 * non-ASCII letters pass through untouched.
 */
const FORBIDDEN = /["*/:<>?\\|-]/g;
const CONTROL = /[\u0000-\u001f\u007f]/g;
const MAX_NAME_CHARS = 40;

/**
 * Make a dog's name safe to put in a filename.
 *
 * Returns an empty string when nothing usable survives, which is the signal to
 * fall back to the legacy name without a dog prefix.
 */
export function sanitizeDogName(raw: string | null | undefined): string {
  if (!raw) return "";
  const cleaned = raw
    .replace(CONTROL, "")
    .replace(/\s+/g, "_")
    .replace(FORBIDDEN, "")
    // A leading dot hides the file on unix; a trailing dot breaks on Windows.
    .replace(/^[._]+/, "")
    .replace(/[._]+$/, "");
  return cleaned.slice(0, MAX_NAME_CHARS);
}

/**
 * Weight as it appears in a filename: `5.2kg`, `5kg`, `12.75kg`.
 * Trailing zeros are dropped so a scale reading of 5.0 does not become "5.0kg".
 */
export function formatWeightTag(weightKg: number | null | undefined): string {
  if (weightKg == null || !Number.isFinite(weightKg) || weightKg <= 0) return "";
  const rounded = Math.round(weightKg * 100) / 100;
  return `${String(rounded)}kg`;
}

/** `YYMMDD-HHMMSS` in local time, matching the backend's `stampFrom`. */
export function stampFrom(when: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  const yy = p(when.getFullYear() % 100);
  return (
    `${yy}${p(when.getMonth() + 1)}${p(when.getDate())}` +
    `-${p(when.getHours())}${p(when.getMinutes())}${p(when.getSeconds())}`
  );
}

/**
 * `대박이-5.2kg`, or an empty string when the dog is unidentified.
 * Kept separate so the backend and the CSV exporter build the same prefix.
 */
export function dogPrefix(dog: DogIdentity): string {
  const name = sanitizeDogName(dog.name);
  if (!name) return "";
  const weight = formatWeightTag(dog.weightKg);
  return weight ? `${name}-${weight}` : name;
}

/**
 * Video filename base (no extension).
 *
 * `subIndex` numbers the sub cameras, matching the backend's `sub1`, `sub2`.
 */
export function videoBaseName(opts: {
  dog: DogIdentity;
  role: CaptureRole;
  subIndex?: number | null;
  stamp?: string;
  when?: Date;
}): string {
  const role = opts.role === "sub" ? `sub${opts.subIndex ?? 1}` : "main";
  const stamp = opts.stamp ?? stampFrom(opts.when);
  const prefix = dogPrefix(opts.dog);
  return prefix ? `${stamp}-${role}-${prefix}` : `${stamp}-${role}`;
}

/**
 * Pressure CSV filename.
 *
 * There is only ever one mat, so the CSV carries no capture role. The `.csv`
 * extension already says what kind of file this is, so there is no prefix —
 * which makes the name exactly `taskName + ".csv"` whether or not the dog is
 * known.
 */
export function pressureCsvName(opts: {
  dog: DogIdentity;
  stamp?: string;
  when?: Date;
}): string {
  const stamp = opts.stamp ?? stampFrom(opts.when);
  const prefix = dogPrefix(opts.dog);
  return prefix ? `${stamp}-${prefix}.csv` : `${stamp}.csv`;
}

export interface ParsedCaptureName {
  role: CaptureRole;
  /** 1-based sub-camera number, or null for the main camera. */
  subIndex: number | null;
  stamp: string;
  /** The dog part as stored, or an empty string when the dog was unknown. */
  dog: string;
}

/**
 * Pull the role and stamp back out of a filename.
 *
 * Anchored on the start of the string, where the stamp now lives. The trailing
 * `-2` the backend appends on a name collision is not part of the dog.
 */
export function parseCaptureName(filename: string): ParsedCaptureName | null {
  const match =
    /^(\d{6}-\d{6})-(main|sub(\d+))(?:-(.*?))??(?:-\d+)?(?:\.[^.]+)?$/.exec(filename);
  if (!match) return null;
  const [, stamp, roleToken, subDigits, dog] = match;
  return {
    role: roleToken.startsWith("sub") ? "sub" : "main",
    subIndex: subDigits ? Number(subDigits) : null,
    stamp,
    dog: dog ?? "",
  };
}

/* ─────────────── 촬영 한 번(=태스크) 단위 묶기 ─────────────── */

/**
 * 파일 목록을 도장으로 되묶는다.
 *
 * "데이터 검증"과 "파일 다운"이 같은 묶기를 쓴다. 규칙이 두 군데로 갈라지면
 * 한쪽 화면에서만 촬영이 사라지는 식으로 어긋나므로 여기 한 곳에 둔다.
 */

/** 촬영 한 번 = 도장 하나. */
export interface CaptureSession {
  stamp: string;
  /** 도장을 로컬 시각으로 되읽은 값. 형식이 깨지면 null. */
  when: Date | null;
  /** `제니-9.8kg` 같은 파일명 앞머리. 없으면 빈 문자열. */
  dog: string;
  csv: StoredCsvFile | null;
  /** main 먼저, 그다음 sub1·sub2… 순. */
  videos: StoredVideoFile[];
}

/** `260820-150920` → Date. 도장은 촬영 노트북의 로컬 시각으로 찍힌다. */
export function parseStamp(stamp: string): Date | null {
  const m = /^(\d{2})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(stamp);
  if (!m) return null;
  const [, yy, mo, dd, hh, mi, ss] = m;
  const d = new Date(
    2000 + Number(yy),
    Number(mo) - 1,
    Number(dd),
    Number(hh),
    Number(mi),
    Number(ss),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/** CSV 파일명의 도장. `260820-150920-제니-9.8kg.csv` → `260820-150920`. */
export function csvStamp(name: string): string | null {
  const m = /^(\d{6}-\d{6})(?:-.*)?\.csv$/i.exec(name);
  return m ? m[1] : null;
}

/** 도장 뒤의 개 이름 부분. `260820-150920-제니-9.8kg.csv` → `제니-9.8kg`. */
export function csvDog(name: string, stamp: string): string {
  // 충돌 회피본(`…-2.csv`)의 꼬리는 개 이름이 아니다 — `parseCaptureName` 과 같은 규칙.
  return name
    .slice(stamp.length, name.length - ".csv".length)
    .replace(/-\d+$/, "")
    .replace(/^-/, "");
}

/** main → sub1 → sub2 … 순서. 못 읽으면 맨 뒤. */
export function roleOrder(name: string): number {
  const parsed = parseCaptureName(name);
  if (!parsed) return 999;
  return parsed.role === "main" ? 0 : (parsed.subIndex ?? 1);
}

/** 파일 목록을 도장으로 되묶는다. 최신 촬영이 앞. */
export function groupSessions(
  csv: StoredCsvFile[],
  videos: StoredVideoFile[],
): CaptureSession[] {
  const byStamp = new Map<string, CaptureSession>();
  const ensure = (stamp: string): CaptureSession => {
    let s = byStamp.get(stamp);
    if (!s) {
      s = { stamp, when: parseStamp(stamp), dog: "", csv: null, videos: [] };
      byStamp.set(stamp, s);
    }
    return s;
  };

  for (const row of csv) {
    const stamp = csvStamp(row.name);
    if (!stamp) continue;
    const s = ensure(stamp);
    s.csv = row;
    if (!s.dog) s.dog = csvDog(row.name, stamp);
  }
  for (const row of videos) {
    const parsed = parseCaptureName(row.name);
    if (!parsed) continue;
    const s = ensure(parsed.stamp);
    s.videos.push(row);
    if (!s.dog && parsed.dog) s.dog = parsed.dog;
  }

  for (const s of byStamp.values()) {
    s.videos.sort((a, b) => roleOrder(a.name) - roleOrder(b.name) || a.name.localeCompare(b.name));
  }
  // 도장은 `YYMMDD-HHMMSS` 라 문자열 내림차순이 곧 최신순이다.
  return [...byStamp.values()].sort((a, b) => b.stamp.localeCompare(a.stamp));
}

/**
 * 도장이 없어 어느 촬영인지 알 수 없는 파일들.
 *
 * `groupSessions` 가 조용히 버리는 것과 같은 파일이다. 파일 다운 화면은 이것을
 * "분류 안 됨" 으로 따로 보여줘야 한다 — 안 보이면 없는 파일이 되어 버린다.
 */
export function ungroupedFiles(
  csv: StoredCsvFile[],
  videos: StoredVideoFile[],
): (StoredCsvFile | StoredVideoFile)[] {
  return [
    ...csv.filter((row) => !csvStamp(row.name)),
    ...videos.filter((row) => !parseCaptureName(row.name)),
  ];
}

/** zip 폴더명이자 태스크의 표시 이름. 개 이름이 없으면 도장만. */
export function taskName(session: CaptureSession): string {
  return session.dog ? `${session.stamp}-${session.dog}` : session.stamp;
}
