/**
 * The report body (hero + chips + metric families + caveats), rendered from
 * `derived.json`'s `preview.locales`.
 *
 * Lives apart from `reportPage` because three places draw the same thing: the
 * result detail's report modal, the report list page, and the print container
 * that both use to make a PDF.
 */

import { pickReportLocale, type DerivedPreview, type ReportRow } from "../api/resultsApi.js";
import { LOCALES, type Lang, type LocaleKey } from "../i18n/locales.js";

export type ReportLang = "ko" | "en";

/** Both languages, in the order they are printed. */
export const REPORT_LANGS: readonly ReportLang[] = ["ko", "en"];

const FAMILY_KEYS: { id: string; titleKey: LocaleKey; blurbKey: LocaleKey }[] = [
  { id: "paw_height", titleKey: "report_family_paw_height", blurbKey: "report_family_paw_height_blurb" },
  { id: "paw_excursion", titleKey: "report_family_paw_excursion", blurbKey: "report_family_paw_excursion_blurb" },
  { id: "knee_rom", titleKey: "report_family_knee_rom", blurbKey: "report_family_knee_rom_blurb" },
  { id: "knee_cv", titleKey: "report_family_knee_cv", blurbKey: "report_family_knee_cv_blurb" },
  { id: "stance", titleKey: "report_family_stance", blurbKey: "report_family_stance_blurb" },
  { id: "step_length", titleKey: "report_family_step_length", blurbKey: "report_family_step_length_blurb" },
];

/**
 * Report text follows the report's own language, not the app chrome's, so a
 * Korean UI can print the English report.
 */
export function rt(
  lang: Lang,
  key: LocaleKey,
  vars?: Record<string, string | number | null | undefined>,
): string {
  const table = LOCALES[lang] ?? LOCALES.en;
  let s: string = table[key] ?? LOCALES.en[key] ?? key;
  if (vars) {
    s = s.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
      const v = vars[k];
      return v !== undefined && v !== null ? String(v) : "";
    });
  }
  return s;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** True when the session actually carries an English report worth showing. */
export function hasEnglishLocale(preview: DerivedPreview | null): boolean {
  const en = preview?.locales?.en;
  return Boolean(en && ((en.report?.length ?? 0) > 0 || en.advisory || (en.caveats?.length ?? 0) > 0));
}

export interface RenderReportOptions {
  /** Open state of the caveats block. Print passes `true` — paper has no toggle. */
  caveatsOpen?: boolean;
  /** Omitted by print so the caveats toggle button is not drawn at all. */
  onToggleCaveats?: () => void;
}

/** Replaces `host`'s content with the report for `lang`. */
export function renderReportInto(
  host: HTMLElement,
  preview: DerivedPreview | null,
  lang: ReportLang,
  opts: RenderReportOptions = {},
): void {
  host.innerHTML = "";

  const bundle = pickReportLocale(preview, lang);
  const rows = bundle.report || [];

  const sectionLabel = document.createElement("div");
  sectionLabel.className = "rm-section-label";
  sectionLabel.textContent = rt(lang, "report_section_label");
  host.appendChild(sectionLabel);

  if (!preview || rows.length === 0) {
    const p = document.createElement("p");
    p.className = "rm-empty";
    p.textContent = rt(lang, "report_empty");
    host.appendChild(p);
    return;
  }

  const trusted = rows.filter((r) => !r.caution && r.value != null).length;
  const cautioned = rows.filter((r) => r.caution).length;
  const detectPct =
    preview.quality?.detect_rate != null ? Math.round(preview.quality.detect_rate * 100) : null;

  const hero = document.createElement("div");
  hero.className = "rm-hero";
  hero.innerHTML = `
      <div class="rm-kicker">${escapeHtml(rt(lang, "report_kicker"))}</div>
      <div class="rm-title">${escapeHtml(rt(lang, "report_title"))}</div>
      <p class="rm-lead">${escapeHtml(rt(lang, "report_lead"))}</p>
    `;
  host.appendChild(hero);

  const chips = document.createElement("div");
  chips.className = "rm-chips";
  chips.appendChild(chip(rt(lang, "report_trusted"), String(trusted), "ok"));
  chips.appendChild(chip(rt(lang, "report_caution"), String(cautioned), "warn"));
  chips.appendChild(
    chip(rt(lang, "report_detect_rate"), detectPct != null ? `${detectPct}%` : "—", "neutral"),
  );
  host.appendChild(chips);

  if (preview.frames != null || preview.fps != null || preview.width != null) {
    const meta = document.createElement("p");
    meta.className = "rm-meta";
    meta.textContent = [
      preview.frames != null ? rt(lang, "report_frames", { n: preview.frames }) : null,
      preview.fps != null ? `${preview.fps} fps` : null,
      preview.width && preview.height ? `${preview.width}×${preview.height}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    host.appendChild(meta);
  }

  if (bundle.advisory) {
    const box = document.createElement("div");
    box.className = "rm-advisory";
    box.innerHTML = `<b>${escapeHtml(rt(lang, "report_advisory"))}</b><p>${escapeHtml(bundle.advisory)}</p>`;
    host.appendChild(box);
  }

  for (const group of groupByFamily(rows, lang)) {
    const sec = document.createElement("section");
    sec.className = "rm-section";
    const title = document.createElement("h3");
    title.textContent = group.title;
    sec.appendChild(title);
    if (group.blurb) {
      const blurb = document.createElement("p");
      blurb.className = "rm-blurb";
      blurb.textContent = group.blurb;
      sec.appendChild(blurb);
    }
    for (const row of group.rows) sec.appendChild(metricCard(row, lang));
    host.appendChild(sec);
  }

  if ((bundle.caveats?.length ?? 0) > 0) {
    const block = document.createElement("div");
    block.className = "rm-caveats";
    const open = opts.caveatsOpen ?? false;
    if (opts.onToggleCaveats) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "rm-link";
      toggle.textContent = open ? rt(lang, "report_caveats_hide") : rt(lang, "report_caveats_show");
      toggle.addEventListener("click", opts.onToggleCaveats);
      block.appendChild(toggle);
    }
    if (open) {
      for (const c of bundle.caveats!) {
        const li = document.createElement("p");
        li.className = "rm-caveat-line";
        li.textContent = `· ${c}`;
        block.appendChild(li);
      }
    }
    host.appendChild(block);
  }
}

export interface PrintableReport {
  /** Heading above the report, e.g. `대박이-5.2kg-14:42:04`. */
  title: string;
  /** Date line under the heading. */
  subtitle?: string | null;
  preview: DerivedPreview | null;
}

const PRINT_ROOT_ID = "rpPrintRoot";

/**
 * Renders every report into one off-screen document and prints it.
 *
 * `window.print()` rather than a generated file: the renderer already lives
 * here and the server keeps no report artifact, so a PDF costs no new code on
 * either side. One call produces one document — N reports become N sections of
 * it, not N files.
 */
export function printReports(items: PrintableReport[]): void {
  if (items.length === 0) return;

  let root = document.getElementById(PRINT_ROOT_ID);
  if (!root) {
    root = document.createElement("div");
    root.id = PRINT_ROOT_ID;
    document.body.appendChild(root);
  }
  root.innerHTML = "";

  for (const item of items) {
    // Both languages, because a printed report is read without a toggle.
    const langs = REPORT_LANGS.filter((l) => l === "ko" || hasEnglishLocale(item.preview));
    for (const lang of langs) {
      const page = document.createElement("article");
      page.className = "rp-print-page";
      const head = document.createElement("header");
      head.className = "rp-print-head";
      head.innerHTML = `<h2>${escapeHtml(item.title)}</h2>${
        item.subtitle ? `<p>${escapeHtml(item.subtitle)}</p>` : ""
      }`;
      page.appendChild(head);
      const body = document.createElement("div");
      renderReportInto(body, item.preview, lang, { caveatsOpen: true });
      page.appendChild(body);
      root.appendChild(page);
    }
  }

  document.body.classList.add("rp-printing");
  const done = (): void => {
    document.body.classList.remove("rp-printing");
    if (root) root.innerHTML = "";
    window.removeEventListener("afterprint", done);
  };
  window.addEventListener("afterprint", done);
  window.print();
  // Browsers that never fire `afterprint` would otherwise strand the page in
  // print mode.
  setTimeout(() => {
    if (document.body.classList.contains("rp-printing")) done();
  }, 1000);
}

function chip(label: string, value: string, tone: "ok" | "warn" | "neutral"): HTMLElement {
  const el = document.createElement("div");
  el.className = `rm-chip ${tone}`;
  el.innerHTML = `<b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span>`;
  return el;
}

function metricCard(row: ReportRow, lang: ReportLang): HTMLElement {
  const caution = Boolean(row.caution);
  const card = document.createElement("div");
  card.className = `rm-metric${caution ? " caution" : ""}`;
  const higher =
    row.higher === "left"
      ? rt(lang, "report_higher_left")
      : row.higher === "right"
        ? rt(lang, "report_higher_right")
        : rt(lang, "report_higher_none");
  card.innerHTML = `
    <div class="rm-metric-top">
      <div>
        <div class="rm-metric-label">${escapeHtml(displayLabel(row.label, lang))}</div>
        <div class="rm-metric-sub${row.higher ? "" : " muted"}">${escapeHtml(higher)}</div>
      </div>
      <div class="rm-metric-value-wrap">
        <div class="rm-metric-value${caution ? " caution" : ""}">${escapeHtml(row.text)}</div>
        ${caution ? `<span class="rm-ref">${escapeHtml(rt(lang, "report_ref_badge"))}</span>` : ""}
      </div>
    </div>
    ${caution && row.why ? `<p class="rm-why">${escapeHtml(row.why)}</p>` : ""}
  `;
  return card;
}

function groupByFamily(rows: ReportRow[], lang: ReportLang) {
  const byFamily = new Map<string, ReportRow[]>();
  for (const row of rows) {
    const family = familyFromKey(row.key);
    const list = byFamily.get(family) || [];
    list.push(row);
    byFamily.set(family, list);
  }
  const out: { title: string; blurb: string; rows: ReportRow[] }[] = [];
  for (const fam of FAMILY_KEYS) {
    const list = byFamily.get(fam.id);
    if (!list || list.length === 0) continue;
    list.sort((a, b) => pairRank(a.key) - pairRank(b.key));
    out.push({ title: rt(lang, fam.titleKey), blurb: rt(lang, fam.blurbKey), rows: list });
    byFamily.delete(fam.id);
  }
  for (const [, list] of byFamily) out.push({ title: "", blurb: "", rows: list });
  return out;
}

function familyFromKey(key?: string): string {
  if (!key) return "other";
  const stripped = key.replace(/^(front|rear)_/, "");
  for (const fam of FAMILY_KEYS) if (stripped.startsWith(fam.id)) return fam.id;
  return "other";
}

function pairRank(key?: string): number {
  if (!key) return 9;
  if (key.startsWith("front_")) return 0;
  if (key.startsWith("rear_")) return 1;
  return 2;
}

function displayLabel(label: string, lang: ReportLang): string {
  if (lang === "en") return label;
  if (label.startsWith("앞발")) return `${rt("ko", "report_front")} · ${label.slice(2).trim()}`;
  if (label.startsWith("뒷발")) return `${rt("ko", "report_rear")} · ${label.slice(2).trim()}`;
  return label;
}
