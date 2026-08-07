/**
 * Backend results API (talktail_gait back → ai-server proxy).
 */

export type ResultDate = {
  date: string;
  displayDate: string;
};

export type ResultSession = {
  stem: string;
  startedAt: string;
  displayTime: string;
  width?: number;
  height?: number;
  orientation?: "portrait" | "landscape" | "square" | "unknown";
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

export type DerivedPreview = {
  schema_version?: number;
  advisory?: string | null;
  report?: ReportRow[];
  caveats?: string[];
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

export type ResultDetail = {
  source?: string;
  date: string;
  displayDate: string;
  session: ResultSession;
  video: {
    filename: string;
    url: string | null;
    available?: boolean;
  };
  report: {
    keypoints: {
      filename: string;
      url: string | null;
      available?: boolean;
    };
    derived: {
      filename: string;
      url: string | null;
      available?: boolean;
      preview?: DerivedPreview | null;
    };
  };
};

function base(apiBaseUrl: string): string {
  return apiBaseUrl.replace(/\/$/, "");
}

function absolutize(apiBaseUrl: string, url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  const b = base(apiBaseUrl);
  return url.startsWith("/") ? `${b}${url}` : `${b}/${url}`;
}

export async function listResultDates(apiBaseUrl: string): Promise<ResultDate[]> {
  const res = await fetch(`${base(apiBaseUrl)}/api/results/dates`);
  if (!res.ok) throw new Error(`dates HTTP ${res.status}`);
  const json = (await res.json()) as { dates: ResultDate[] };
  return json.dates || [];
}

export async function listResultSessions(
  apiBaseUrl: string,
  date: string,
): Promise<{ date: string; displayDate: string; sessions: ResultSession[] }> {
  const res = await fetch(`${base(apiBaseUrl)}/api/results/${encodeURIComponent(date)}/sessions`);
  if (!res.ok) throw new Error(`sessions HTTP ${res.status}`);
  return (await res.json()) as { date: string; displayDate: string; sessions: ResultSession[] };
}

export async function getResultDetail(
  apiBaseUrl: string,
  date: string,
  stem: string,
): Promise<ResultDetail> {
  const res = await fetch(
    `${base(apiBaseUrl)}/api/results/${encodeURIComponent(date)}/sessions/${encodeURIComponent(stem)}`,
  );
  if (!res.ok) throw new Error(`detail HTTP ${res.status}`);
  const detail = (await res.json()) as ResultDetail;
  detail.video = {
    ...detail.video,
    url: absolutize(apiBaseUrl, detail.video?.url),
  };
  detail.report = {
    keypoints: {
      ...detail.report.keypoints,
      url: absolutize(apiBaseUrl, detail.report?.keypoints?.url),
    },
    derived: {
      ...detail.report.derived,
      url: absolutize(apiBaseUrl, detail.report?.derived?.url),
    },
  };
  return detail;
}
