/**
 * 촬영 저장 이름 규칙 (2026-09 재설계).
 *
 *     uploads/<userId>/<dogId>/<도장>/
 *         260819-144204-37-main.mp4
 *         260819-144204-37-sub1.mp4
 *         260819-144204-37.csv
 *
 * 필드 순서는 `도장 - 개체id - 역할` 이고 **개 이름·몸무게는 들어가지 않는다.**
 *
 * ## 파일명을 되읽어 묶던 코드가 사라졌다
 *
 * 예전에는 `groupSessions`/`parseCaptureName`/`csvStamp`/`csvDog` 가 파일명을 파싱해
 * 도장으로 같은 촬영을 되묶었다. 이름이 규칙에서 조금만 벗어나면 그 촬영이 목록에서
 * 조용히 빠졌고, 같은 초에 찍은 남의 파일이 한 줄로 합쳐지기도 했다.
 * 지금은 **폴더 하나가 촬영 하나**라 서버가 `readdir` 로 묶어 보낸다(`/api/files` 의 `tasks`).
 *
 * ## 사람이 읽는 이름은 내보낼 때만 만든다
 *
 * 디스크 이름에는 개 이름이 없다. 받을 때 서버가 `dogs` 를 조회해 재조립한다
 * (`downloadName`). 여기 남은 `dogPrefix`/`formatWeightTag` 는 **화면 표시와 로컬
 * 내보내기 파일명** 전용이다 — 서버 저장 이름을 만드는 데는 쓰지 않는다.
 *
 * back 쪽 정본은 `back/src/naming.js` 다. 한쪽을 고치면 같은 커밋에서 둘 다 고쳐야 한다.
 */

export type CaptureRole = "main" | "sub";

export interface DogIdentity {
  name: string | null | undefined;
  weightKg: number | null | undefined;
}

/**
 * 파일명에 못 쓰는 문자(윈도우/맥/리눅스 공통) + 구분자로 쓰는 하이픈.
 * 한글을 비롯한 비ASCII 글자는 그대로 통과한다.
 */
const FORBIDDEN = /["*/:<>?\\|-]/g;
const CONTROL = /[\u0000-\u001f\u007f]/g;
const MAX_NAME_CHARS = 40;

/** 표시·내보내기용 이름 정리. 쓸 게 남지 않으면 빈 문자열. */
export function sanitizeDogName(raw: string | null | undefined): string {
  if (!raw) return "";
  const cleaned = raw
    .replace(CONTROL, "")
    .replace(/\s+/g, "_")
    .replace(FORBIDDEN, "")
    // 앞 점은 유닉스에서 파일을 숨기고, 뒤 점은 윈도우에서 깨진다.
    .replace(/^[._]+/, "")
    .replace(/[._]+$/, "");
  return cleaned.slice(0, MAX_NAME_CHARS);
}

/**
 * 파일명에 넣을 수 있는 이름인가 — 다운로드 직전에 확인한다(§3-9-A).
 *
 * **입력 단에서 막지 않는다.** 고객이 신청서에 뭘 적을지 통제할 수 없고, 개 이름으로
 * 장난치는 사람도 없다. 대신 받기 직전에 모달로 알리고 정보 변경으로 보낸다.
 */
export function checkDogNameForFilename(
  raw: string | null | undefined,
): { ok: boolean; reason: "forbidden" | "too_long" | "empty" | null } {
  const s = String(raw ?? "");
  if (!s.trim()) return { ok: false, reason: "empty" };
  if (s.length > MAX_NAME_CHARS) return { ok: false, reason: "too_long" };
  if (sanitizeDogName(s) !== s.replace(/\s+/g, "_")) return { ok: false, reason: "forbidden" };
  return { ok: true, reason: null };
}

/**
 * 파일명에 들어가는 몸무게: `5.2kg`, `5kg`, `0.66kg`.
 * 소수 둘째자리까지 — 1kg 미만 개(660g)를 표현해야 한다.
 */
export function formatWeightTag(weightKg: number | null | undefined): string {
  if (weightKg == null || !Number.isFinite(weightKg) || weightKg <= 0) return "";
  const rounded = Math.round(weightKg * 100) / 100;
  return `${String(rounded)}kg`;
}

/** `YYMMDD-HHMMSS`(로컬 시각). back 의 `stampFrom` 과 같은 값이다. */
export function stampFrom(when: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  const yy = p(when.getFullYear() % 100);
  return (
    `${yy}${p(when.getMonth() + 1)}${p(when.getDate())}` +
    `-${p(when.getHours())}${p(when.getMinutes())}${p(when.getSeconds())}`
  );
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

/** `대박이-5.2kg` — **표시·내보내기 전용**. 서버 저장 이름에는 안 쓴다. */
export function dogPrefix(dog: DogIdentity): string {
  const name = sanitizeDogName(dog.name);
  if (!name) return "";
  const weight = formatWeightTag(dog.weightKg);
  return weight ? `${name}-${weight}` : name;
}

/* ─────────────── 서버 저장 이름 ─────────────── */

/** 태스크명 `260819-144204-37`. 회차를 가리키는 이름이자 산출물 어간이다. */
export function taskName(opts: { dogId: number; stamp?: string; when?: Date }): string {
  const stamp = opts.stamp ?? stampFrom(opts.when);
  return `${stamp}-${opts.dogId}`;
}

/** 영상 파일명(확장자 제외) — `260819-144204-37-main`. */
export function videoBaseName(opts: {
  dogId: number;
  role: CaptureRole;
  subIndex?: number | null;
  stamp?: string;
  when?: Date;
}): string {
  const role = opts.role === "sub" ? `sub${opts.subIndex ?? 1}` : "main";
  return `${taskName(opts)}-${role}`;
}

/**
 * 압력 CSV 파일명 — `260819-144204-37.csv`.
 *
 * 매트는 한 대뿐이라 역할 꼬리가 없다. 확장자가 이미 종류를 말하므로
 * **태스크명 + `.csv`** 가 그대로 파일명이다.
 */
export function pressureCsvName(opts: { dogId: number; stamp?: string; when?: Date }): string {
  return `${taskName(opts)}.csv`;
}

/**
 * **로컬 내보내기** CSV 파일명 — `대박이-5.2kg-260819-144204.csv`.
 *
 * 서버 저장 이름(`pressureCsvName`)과 다르다. 이건 브라우저가 바로 받는 파일이라
 * 사람이 읽을 수 있어야 하고, 어느 회차인지는 도장으로 남는다.
 */
export function displayCsvName(dog: DogIdentity, when: Date = new Date()): string {
  const prefix = dogPrefix(dog);
  const stamp = stampFrom(when);
  return prefix ? `${prefix}-${stamp}.csv` : `${stamp}.csv`;
}

/** 파일명에서 역할을 읽는다. main → 0, subN → N, 모르면 뒤로. */
export function roleOrder(name: string): number {
  const m = /-(main|sub(\d+))\.[A-Za-z0-9]+$/.exec(name);
  if (!m) return 999;
  return m[2] ? Number(m[2]) : 0;
}

/**
 * 저장 파일명 → 사람이 읽는 이름 (§3-9).
 *
 *     downloadName("260819-144204-37-main.mp4", {name:"대박이", weightKg:5.2})
 *       → "260819-144204-대박이-5.2kg-main.mp4"
 *
 * 서버(`back/src/naming.js`)가 같은 값을 만든다. 화면은 받기 전에 이름을 미리 보여 주는
 * 용도로만 쓴다 — 실제 파일명을 정하는 것은 서버다.
 */
export function downloadName(storedName: string, dog: DogIdentity): string {
  const m = /^(\d{6}-\d{6})-(\d+)(?:-(main|sub\d+))?(\.[A-Za-z0-9]+)$/.exec(storedName);
  if (!m) return storedName;
  const [, stamp, , role, ext] = m;
  const prefix = dogPrefix(dog);
  const head = prefix ? `${stamp}-${prefix}` : stamp;
  return role ? `${head}-${role}${ext}` : `${head}${ext}`;
}
