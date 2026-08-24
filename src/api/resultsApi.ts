/**
 * Backend results API (talktail_gait back → ai-server proxy).
 */

import { joinApiUrl } from "../config/apiUrl.js";

export type ResultDate = {
  date: string;
  displayDate: string;
};

export type ResultSession = {
  stem: string;
  /** `gait_sessions.task_name` — canonical name the files on disk are built from. */
  taskName?: string;
  startedAt: string;
  displayTime: string;
  width?: number;
  height?: number;
  orientation?: "portrait" | "landscape" | "square" | "unknown";
  dog?: {
    name: string | null;
    breed: string | null;
    weightKg: number | null;
    heightCm: number | null;
  };
};

export type ReportRow = {
  key?: string;
  label: string;
  text: string;
  value?: number | null;
  unit?: string;
  caution?: boolean;
  why?: string | null;
  basis?: string;
  left?: number | null;
  right?: number | null;
  higher?: "left" | "right" | null;
};

export type ReportLocaleBundle = {
  report?: ReportRow[];
  advisory?: string | null;
  caveats?: string[];
};

export type DerivedPreview = {
  schema_version?: number;
  advisory?: string | null;
  report?: ReportRow[];
  caveats?: string[];
  /** schema v3+: bilingual bundles. Missing `en` means legacy Korean-only. */
  locales?: {
    ko?: ReportLocaleBundle;
    en?: ReportLocaleBundle;
  };
  quality?: {
    detect_rate?: number | null;
    usable_rate?: number | null;
    period_spread?: number | null;
    cycles?: Record<string, number> | null;
  };
  width?: number;
  height?: number;
  fps?: number;
  frames?: number;
  note?: string;
};

export type MediaArtifact = {
  filename?: string | null;
  url: string | null;
  available?: boolean;
};

export type ResultDetail = {
  source?: string;
  date: string;
  displayDate: string;
  session: ResultSession;
  video: MediaArtifact & { filename: string };
  original?: MediaArtifact;
  /** back/uploads 원본 (DB back_original_path). */
  backOriginal?: MediaArtifact;
  /** 연결된 압력 CSV (DB gait_sessions). */
  csv?: MediaArtifact & { path?: string | null };
  report: {
    keypoints: MediaArtifact & { filename: string };
    derived: MediaArtifact & {
      filename: string;
      preview?: DerivedPreview | null;
    };
    angle_diff?: MediaArtifact & { preview?: unknown };
    cyclogram?: MediaArtifact;
    stride?: MediaArtifact;
    angle_pawy?: MediaArtifact;
    /** 압력판 히트맵 영상 (`result_pressure/{stem}_pressure.mp4`, CSV 동봉 분석 시). */
    pressure?: MediaArtifact;
  };
};

function absolutize(apiBaseUrl: string, url: string | null | undefined): string | null {
  if (!url) return null;
  return joinApiUrl(apiBaseUrl, url);
}

export async function listResultDates(apiBaseUrl: string): Promise<ResultDate[]> {
  const res = await fetch(joinApiUrl(apiBaseUrl, "/api/results/dates"));
  if (!res.ok) throw new Error(`dates HTTP ${res.status}`);
  const json = (await res.json()) as { dates: ResultDate[] };
  return json.dates || [];
}

export async function listResultSessions(
  apiBaseUrl: string,
  date: string,
): Promise<{ date: string; displayDate: string; sessions: ResultSession[] }> {
  const res = await fetch(
    joinApiUrl(apiBaseUrl, `/api/results/${encodeURIComponent(date)}/sessions`),
  );
  if (!res.ok) throw new Error(`sessions HTTP ${res.status}`);
  return (await res.json()) as { date: string; displayDate: string; sessions: ResultSession[] };
}

export async function getResultDetail(
  apiBaseUrl: string,
  date: string,
  stem: string,
): Promise<ResultDetail> {
  const res = await fetch(
    joinApiUrl(
      apiBaseUrl,
      `/api/results/${encodeURIComponent(date)}/sessions/${encodeURIComponent(stem)}`,
    ),
  );
  if (!res.ok) throw new Error(`detail HTTP ${res.status}`);
  const detail = (await res.json()) as ResultDetail;
  detail.video = {
    ...detail.video,
    url: absolutize(apiBaseUrl, detail.video?.url),
  };
  if (detail.original) {
    detail.original = {
      ...detail.original,
      url: absolutize(apiBaseUrl, detail.original.url),
    };
  }
  if (detail.backOriginal) {
    detail.backOriginal = {
      ...detail.backOriginal,
      url: absolutize(apiBaseUrl, detail.backOriginal.url),
    };
  }
  if (detail.csv) {
    detail.csv = {
      ...detail.csv,
      url: absolutize(apiBaseUrl, detail.csv.url),
    };
  }
  const absArtifact = <T extends { url?: string | null } | null | undefined>(item: T): T => {
    if (!item || typeof item !== "object") return item;
    return { ...item, url: absolutize(apiBaseUrl, item.url) };
  };
  detail.report = {
    keypoints: absArtifact(detail.report?.keypoints) as ResultDetail["report"]["keypoints"],
    derived: absArtifact(detail.report?.derived) as ResultDetail["report"]["derived"],
    angle_diff: absArtifact(detail.report?.angle_diff),
    cyclogram: absArtifact(detail.report?.cyclogram),
    stride: absArtifact(detail.report?.stride),
    angle_pawy: absArtifact(detail.report?.angle_pawy),
    pressure: absArtifact(detail.report?.pressure),
  };
  return detail;
}

/** Pick KO/EN report body from preview (falls back to top-level Korean fields). */
export function pickReportLocale(
  preview: DerivedPreview | null | undefined,
  lang: "ko" | "en",
): ReportLocaleBundle {
  const locales = preview?.locales;
  const bundle = locales?.[lang];
  if (bundle && ((bundle.report?.length ?? 0) > 0 || bundle.advisory || (bundle.caveats?.length ?? 0) > 0)) {
    return {
      report: bundle.report || [],
      advisory: bundle.advisory ?? null,
      caveats: bundle.caveats || [],
    };
  }
  if (lang === "ko" || !locales?.en?.report?.length) {
    return {
      report: preview?.report || [],
      advisory: preview?.advisory ?? null,
      caveats: preview?.caveats || [],
    };
  }
  return {
    report: locales.en.report || [],
    advisory: locales.en.advisory ?? null,
    caveats: locales.en.caveats || [],
  };
}
