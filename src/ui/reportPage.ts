/**
 * Full-page report browser (dates → sessions → detail).
 * Mirrors front_app Results* screens; uses back `/api/results/*` → ai-server.
 */

import {
  getResultDetail,
  listResultDates,
  listResultSessions,
  type DerivedPreview,
  type ReportRow,
  type ResultDate,
  type ResultDetail,
  type ResultSession,
} from "../api/resultsApi.js";
import { onLangChange, t } from "../i18n/index.js";
import type { LocaleKey } from "../i18n/locales.js";
import { VideoPlayerController } from "./videoPlayerController.js";

type Step = "dates" | "sessions" | "detail";

const FAMILY_KEYS: { id: string; titleKey: LocaleKey; blurbKey: LocaleKey }[] = [
  { id: "paw_height", titleKey: "report_family_paw_height", blurbKey: "report_family_paw_height_blurb" },
  { id: "paw_excursion", titleKey: "report_family_paw_excursion", blurbKey: "report_family_paw_excursion_blurb" },
  { id: "knee_rom", titleKey: "report_family_knee_rom", blurbKey: "report_family_knee_rom_blurb" },
  { id: "knee_cv", titleKey: "report_family_knee_cv", blurbKey: "report_family_knee_cv_blurb" },
  { id: "stance", titleKey: "report_family_stance", blurbKey: "report_family_stance_blurb" },
  { id: "step_length", titleKey: "report_family_step_length", blurbKey: "report_family_step_length_blurb" },
];

export class ReportPage {
  private readonly root: HTMLElement;
  private readonly crumbsEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly subEl: HTMLElement;
  private readonly backBtn: HTMLButtonElement;
  private readonly refreshBtn: HTMLButtonElement;
  private readonly listEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private readonly loadingEl: HTMLElement;
  private readonly detailEl: HTMLElement;
  private readonly detailBody: HTMLElement;
  private readonly detailLoading: HTMLElement;
  private readonly videoPanel: HTMLElement;
  private readonly player: VideoPlayerController;

  private apiBase = "";
  private step: Step = "dates";
  private selectedDate: ResultDate | null = null;
  private selectedSession: ResultSession | null = null;
  private caveatsOpen = false;
  private lastPreview: DerivedPreview | null = null;
  private lastDetail: ResultDetail | null = null;
  private visible = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.crumbsEl = root.querySelector("#rpCrumbs") as HTMLElement;
    this.titleEl = root.querySelector("#rpTitle") as HTMLElement;
    this.subEl = root.querySelector("#rpSub") as HTMLElement;
    this.backBtn = root.querySelector("#rpBack") as HTMLButtonElement;
    this.refreshBtn = root.querySelector("#rpRefresh") as HTMLButtonElement;
    this.listEl = root.querySelector("#rpList") as HTMLElement;
    this.emptyEl = root.querySelector("#rpEmpty") as HTMLElement;
    this.loadingEl = root.querySelector("#rpLoading") as HTMLElement;
    this.detailEl = root.querySelector("#rpDetail") as HTMLElement;
    this.detailBody = root.querySelector("#rpDetailBody") as HTMLElement;
    this.detailLoading = root.querySelector("#rpDetailLoading") as HTMLElement;
    this.videoPanel = root.querySelector("#rpDetailVideo") as HTMLElement;
    this.player = new VideoPlayerController(this.videoPanel);

    this.backBtn.addEventListener("click", () => void this.goBack());
    this.refreshBtn.addEventListener("click", () => void this.refresh());

    onLangChange(() => {
      if (!this.visible) return;
      this.updateChrome();
      if (this.step === "detail" && this.lastDetail) {
        this.renderReport(this.lastPreview);
      } else {
        void this.refresh();
      }
    });
  }

  setApiBase(url: string): void {
    this.apiBase = url.replace(/\/$/, "");
  }

  show(): void {
    this.visible = true;
    this.root.hidden = false;
    void this.refresh();
  }

  hide(): void {
    this.visible = false;
    this.root.hidden = true;
    if (this.step === "detail") {
      this.player.stopVideo();
      this.player.showIdle();
    }
  }

  async refresh(): Promise<void> {
    if (!this.apiBase) {
      this.showEmpty(t("results_no_api"));
      return;
    }
    this.setLoading(true);
    try {
      if (this.step === "dates") await this.loadDates();
      else if (this.step === "sessions" && this.selectedDate) await this.loadSessions(this.selectedDate);
      else if (this.step === "detail" && this.selectedDate && this.selectedSession) {
        await this.openDetail(this.selectedDate, this.selectedSession);
      }
    } catch (err) {
      this.showEmpty(err instanceof Error ? err.message : String(err));
    } finally {
      this.setLoading(false);
    }
  }

  private async goBack(): Promise<void> {
    if (this.step === "detail") {
      this.player.stopVideo();
      this.player.showIdle();
      this.detailEl.classList.add("hidden");
      this.listEl.classList.remove("hidden");
      this.lastDetail = null;
      this.lastPreview = null;
      if (this.selectedDate) {
        this.step = "sessions";
        await this.loadSessions(this.selectedDate);
      }
      return;
    }
    if (this.step === "sessions") {
      this.step = "dates";
      this.selectedDate = null;
      this.selectedSession = null;
      await this.loadDates();
    }
  }

  private setLoading(on: boolean): void {
    this.loadingEl.classList.toggle("hidden", !on);
    this.refreshBtn.disabled = on;
    this.backBtn.disabled = on && this.step === "dates";
  }

  private showEmpty(msg?: string): void {
    this.listEl.innerHTML = "";
    this.emptyEl.textContent = msg || t("results_empty");
    this.emptyEl.classList.remove("hidden");
    this.detailEl.classList.add("hidden");
    this.listEl.classList.remove("hidden");
  }

  private updateChrome(): void {
    const onDates = this.step === "dates";
    this.backBtn.classList.toggle("hidden", onDates);
    this.backBtn.textContent = t("btn_results_back");
    this.refreshBtn.textContent = t("btn_results_refresh");

    if (this.step === "dates") {
      this.titleEl.textContent = t("report_page_title");
      this.subEl.textContent = t("results_dates_hint");
      this.crumbsEl.textContent = t("results_list");
    } else if (this.step === "sessions" && this.selectedDate) {
      this.titleEl.textContent = this.selectedDate.displayDate;
      this.subEl.textContent = t("report_sessions_hint");
      this.crumbsEl.textContent = `${t("results_list")} › ${this.selectedDate.displayDate}`;
    } else if (this.step === "detail" && this.selectedDate && this.selectedSession) {
      const d = this.lastDetail;
      const orient = d?.session.orientation || this.selectedSession.orientation;
      const orientLabel = orient ? orientationLabel(orient) : "";
      this.titleEl.textContent = this.selectedSession.displayTime;
      this.subEl.textContent = orientLabel
        ? `${this.selectedDate.displayDate} · ${orientLabel}`
        : this.selectedDate.displayDate;
      this.crumbsEl.textContent = `${t("results_list")} › ${this.selectedDate.displayDate} › ${this.selectedSession.displayTime}`;
    }
  }

  private async loadDates(): Promise<void> {
    this.step = "dates";
    this.selectedSession = null;
    this.detailEl.classList.add("hidden");
    this.listEl.classList.remove("hidden");
    this.updateChrome();

    const dates = await listResultDates(this.apiBase);
    this.emptyEl.classList.toggle("hidden", dates.length > 0);
    if (dates.length === 0) this.emptyEl.textContent = t("results_empty");
    this.listEl.innerHTML = "";
    this.listEl.className = "rp-grid";

    for (const d of dates) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rp-card";
      btn.innerHTML = `<span class="rp-card-title">${escapeHtml(d.displayDate)}</span><span class="rp-card-meta">${escapeHtml(d.date)}</span>`;
      btn.addEventListener("click", () => {
        this.selectedDate = d;
        void this.loadSessions(d);
      });
      this.listEl.appendChild(btn);
    }
  }

  private async loadSessions(date: ResultDate): Promise<void> {
    this.step = "sessions";
    this.selectedDate = date;
    this.selectedSession = null;
    this.detailEl.classList.add("hidden");
    this.listEl.classList.remove("hidden");
    this.updateChrome();

    const data = await listResultSessions(this.apiBase, date.date);
    this.emptyEl.classList.toggle("hidden", data.sessions.length > 0);
    if (data.sessions.length === 0) this.emptyEl.textContent = t("results_empty");
    this.listEl.innerHTML = "";
    this.listEl.className = "rp-grid";

    for (const s of data.sessions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rp-card";
      const orient = s.orientation ? orientationLabel(s.orientation) : "";
      const size =
        s.width && s.height ? `${s.width}×${s.height}` : "";
      const meta = [orient, size].filter(Boolean).join(" · ");
      btn.innerHTML = `<span class="rp-card-title">${escapeHtml(s.displayTime)}</span><span class="rp-card-meta">${escapeHtml(meta || s.stem)}</span>`;
      btn.addEventListener("click", () => void this.openDetail(date, s));
      this.listEl.appendChild(btn);
    }
  }

  private async openDetail(date: ResultDate, session: ResultSession): Promise<void> {
    this.step = "detail";
    this.selectedDate = date;
    this.selectedSession = session;
    this.caveatsOpen = false;
    this.lastDetail = null;
    this.lastPreview = null;
    this.listEl.classList.add("hidden");
    this.emptyEl.classList.add("hidden");
    this.detailEl.classList.remove("hidden");
    this.detailLoading.classList.remove("hidden");
    this.detailBody.innerHTML = "";
    this.player.showIdle();
    this.updateChrome();

    try {
      const detail = await getResultDetail(this.apiBase, date.date, session.stem);
      this.lastDetail = detail;
      this.lastPreview = detail.report.derived.preview ?? null;
      this.updateChrome();
      if (detail.video.url) {
        this.player.loadVideo(detail.video.url, {
          autoplay: true,
          loop: true,
          orientation: detail.session.orientation || session.orientation,
        });
      } else {
        this.player.showIdle(t("report_video_empty"));
      }
      this.renderReport(this.lastPreview);
    } catch (err) {
      this.detailBody.innerHTML = "";
      const p = document.createElement("p");
      p.className = "rm-empty";
      p.textContent = err instanceof Error ? err.message : String(err);
      this.detailBody.appendChild(p);
    } finally {
      this.detailLoading.classList.add("hidden");
    }
  }

  private renderReport(preview: DerivedPreview | null): void {
    this.detailBody.innerHTML = "";
    const rows = preview?.report || [];

    const sectionLabel = document.createElement("div");
    sectionLabel.className = "rm-section-label";
    sectionLabel.textContent = t("report_section_label");
    this.detailBody.appendChild(sectionLabel);

    if (!preview || rows.length === 0) {
      const p = document.createElement("p");
      p.className = "rm-empty";
      p.textContent = t("report_empty");
      this.detailBody.appendChild(p);
      return;
    }

    const trusted = rows.filter((r) => !r.caution && r.value != null).length;
    const cautioned = rows.filter((r) => r.caution).length;
    const detectPct =
      preview.quality?.detect_rate != null ? Math.round(preview.quality.detect_rate * 100) : null;

    const hero = document.createElement("div");
    hero.className = "rm-hero";
    hero.innerHTML = `
      <div class="rm-kicker">${escapeHtml(t("report_kicker"))}</div>
      <div class="rm-title">${escapeHtml(t("report_title"))}</div>
      <p class="rm-lead">${escapeHtml(t("report_lead"))}</p>
    `;
    this.detailBody.appendChild(hero);

    const chips = document.createElement("div");
    chips.className = "rm-chips";
    chips.appendChild(chip(t("report_trusted"), String(trusted), "ok"));
    chips.appendChild(chip(t("report_caution"), String(cautioned), "warn"));
    chips.appendChild(
      chip(t("report_detect_rate"), detectPct != null ? `${detectPct}%` : "—", "neutral"),
    );
    this.detailBody.appendChild(chips);

    if (preview.frames != null || preview.fps != null || preview.width != null) {
      const meta = document.createElement("p");
      meta.className = "rm-meta";
      meta.textContent = [
        preview.frames != null ? t("report_frames", { n: preview.frames }) : null,
        preview.fps != null ? `${preview.fps} fps` : null,
        preview.width && preview.height ? `${preview.width}×${preview.height}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      this.detailBody.appendChild(meta);
    }

    if (preview.advisory) {
      const box = document.createElement("div");
      box.className = "rm-advisory";
      box.innerHTML = `<b>${escapeHtml(t("report_advisory"))}</b><p>${escapeHtml(preview.advisory)}</p>`;
      this.detailBody.appendChild(box);
    }

    for (const group of groupByFamily(rows)) {
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
      for (const row of group.rows) sec.appendChild(metricCard(row));
      this.detailBody.appendChild(sec);
    }

    if ((preview.caveats?.length ?? 0) > 0) {
      const block = document.createElement("div");
      block.className = "rm-caveats";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "rm-link";
      toggle.textContent = this.caveatsOpen ? t("report_caveats_hide") : t("report_caveats_show");
      toggle.addEventListener("click", () => {
        this.caveatsOpen = !this.caveatsOpen;
        this.renderReport(preview);
      });
      block.appendChild(toggle);
      if (this.caveatsOpen) {
        for (const c of preview.caveats!) {
          const li = document.createElement("p");
          li.className = "rm-caveat-line";
          li.textContent = `· ${c}`;
          block.appendChild(li);
        }
      }
      this.detailBody.appendChild(block);
    }
  }
}

function chip(label: string, value: string, tone: "ok" | "warn" | "neutral"): HTMLElement {
  const el = document.createElement("div");
  el.className = `rm-chip ${tone}`;
  el.innerHTML = `<b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span>`;
  return el;
}

function metricCard(row: ReportRow): HTMLElement {
  const caution = Boolean(row.caution);
  const card = document.createElement("div");
  card.className = `rm-metric${caution ? " caution" : ""}`;
  const higher =
    row.higher === "left"
      ? t("report_higher_left")
      : row.higher === "right"
        ? t("report_higher_right")
        : t("report_higher_none");
  card.innerHTML = `
    <div class="rm-metric-top">
      <div>
        <div class="rm-metric-label">${escapeHtml(shortLabel(row.label))}</div>
        <div class="rm-metric-sub${row.higher ? "" : " muted"}">${escapeHtml(higher)}</div>
      </div>
      <div class="rm-metric-value-wrap">
        <div class="rm-metric-value${caution ? " caution" : ""}">${escapeHtml(row.text)}</div>
        ${caution ? `<span class="rm-ref">${escapeHtml(t("report_ref_badge"))}</span>` : ""}
      </div>
    </div>
    ${caution && row.why ? `<p class="rm-why">${escapeHtml(row.why)}</p>` : ""}
  `;
  return card;
}

function groupByFamily(rows: ReportRow[]) {
  const byFamily = new Map<string, ReportRow[]>();
  for (const row of rows) {
    const family = familyFromKey(row.key);
    const list = byFamily.get(family) || [];
    list.push(row);
    byFamily.set(family, list);
  }
  const ordered = FAMILY_KEYS.map((meta) => ({
    id: meta.id,
    title: t(meta.titleKey),
    blurb: t(meta.blurbKey),
    rows: sortPairRows(byFamily.get(meta.id) || []),
  })).filter((g) => g.rows.length > 0);

  for (const [id, list] of byFamily) {
    if (FAMILY_KEYS.some((m) => m.id === id)) continue;
    ordered.push({ id, title: id, blurb: "", rows: sortPairRows(list) });
  }
  return ordered;
}

function familyFromKey(key?: string): string {
  if (!key) return "other";
  if (key.startsWith("front_")) return key.slice("front_".length);
  if (key.startsWith("rear_")) return key.slice("rear_".length);
  return key;
}

function sortPairRows(rows: ReportRow[]): ReportRow[] {
  return [...rows].sort((a, b) => pairRank(a.key) - pairRank(b.key));
}

function pairRank(key?: string): number {
  if (!key) return 9;
  if (key.startsWith("front_")) return 0;
  if (key.startsWith("rear_")) return 1;
  return 2;
}

function shortLabel(label: string): string {
  if (label.startsWith("앞발")) return `${t("report_front")} · ${label.slice(2).trim()}`;
  if (label.startsWith("뒷발")) return `${t("report_rear")} · ${label.slice(2).trim()}`;
  return label;
}

function orientationLabel(o: string): string {
  if (o === "portrait") return t("orient_portrait");
  if (o === "landscape") return t("orient_landscape");
  if (o === "square") return t("orient_square");
  return t("orient_unknown");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
