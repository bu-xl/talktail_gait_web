/**
 * Session file naming.
 *
 * Every artifact of one measurement carries the dog it belongs to, so a file
 * pulled off disk months later still identifies its subject:
 *
 *     대박이-5.2kg-main-260819-144204.mp4
 *     대박이-5.2kg-sub1-260819-144204.mp4
 *     대박이-5.2kg-260819-144204.csv
 *
 * The `role-stamp` tail is unchanged from the previous `main-260819-144204`
 * scheme. That matters: the backend recognises its own files by matching that
 * tail, so keeping it intact lets old and new names coexist. Anything that
 * parses these names must anchor on the tail, never on the start of the string.
 */

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
  return prefix ? `${prefix}-${role}-${stamp}` : `${role}-${stamp}`;
}

/**
 * Pressure CSV filename.
 *
 * There is only ever one mat, so the CSV carries no capture role.
 */
export function pressureCsvName(opts: {
  dog: DogIdentity;
  stamp?: string;
  when?: Date;
}): string {
  const stamp = opts.stamp ?? stampFrom(opts.when);
  const prefix = dogPrefix(opts.dog);
  return prefix ? `${prefix}-${stamp}.csv` : `pressure-${stamp}.csv`;
}

export interface ParsedCaptureName {
  role: CaptureRole;
  /** 1-based sub-camera number, or null for the main camera. */
  subIndex: number | null;
  stamp: string;
  /** The dog prefix as stored, or an empty string on a legacy name. */
  dog: string;
}

/**
 * Pull the role and stamp back out of a filename.
 *
 * Anchored on the tail so it reads both the legacy `main-260819-144204.mp4` and
 * the current `대박이-5.2kg-main-260819-144204.mp4`.
 */
export function parseCaptureName(filename: string): ParsedCaptureName | null {
  const match = /(?:^|-)(main|sub(\d+))-(\d{6}-\d{6})(?:-\d+)?(?:\.[^.]+)?$/.exec(filename);
  if (!match) return null;
  const [, roleToken, subDigits, stamp] = match;
  // match.index points at the separator before the role, so everything before
  // it is the dog prefix (empty for a legacy name).
  const dog = match.index > 0 ? filename.slice(0, match.index) : "";
  return {
    role: roleToken.startsWith("sub") ? "sub" : "main",
    subIndex: subDigits ? Number(subDigits) : null,
    stamp,
    dog,
  };
}
