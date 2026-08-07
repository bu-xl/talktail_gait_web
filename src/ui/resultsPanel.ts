/**
 * Saved recordings list (sidebar) + dark report modal (video + asymmetry report).
 * Matches the TalkTail mobile results detail screen.
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

type Step = "dates" | "sessions";

const FAMILY_KEYS: { id: string; titleKey: LocaleKey; blurbKey: LocaleKey }[] = [
  { id: "paw_height", titleKey: "report_family_paw_height", blurbKey: "report_family_paw_height_blurb" },
  { id: "paw_excursion", titleKey: "report_family_paw_excursion", blurbKey: "report_family_paw_excursion_blurb" },
  { id: "knee_rom", titleKey: "report_family_knee_rom", blurbKey: "report_family_knee_rom_blurb" },
  { id: "knee_cv", titleKey: "report_family_knee_cv", blurbKey: "report_family_knee_cv_blurb" },
  { id: "stance", titleKey: "report_family_stance", blurbKey: "report_family_stance_blurb" },
  { id: "step_length", titleKey: "report_family_step_length", blurbKey: "report_family_step_length_blurb" },
];

export class ResultsPanel {
  private readonly listEl: HTMLUListElement;
  private readonly breadcrumbEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private readonly loadingEl: HTMLElement;
  private readonly backBtn: HTMLButtonElement;
  private readonly refreshBtn: HTMLButtonElement;

  private readonly modal: HTMLElement;
  private readonly modalBody: HTMLElement;
  private readonly modalTitle: HTMLElement;
  private readonly modalSub: HTMLElement;
  private readonly modalCrumbs: HTMLElement;
  private readonly modalReport: HTMLElement;
  private readonly modalLoading: HTMLElement;
  private readonly modalVideoPanel: HTMLElement;
  private readonly modalCloseBtn: HTMLButtonElement;
  private readonly modalBackBtn: HTMLButtonElement;

  private readonly modalPlayer: VideoPlayerController;

  private apiBase = "";
  private step: Step = "dates";
  private selectedDate: ResultDate | null = null;
  private caveatsOpen = false;
  private lastDetail: ResultDetail | null = null;
  private lastPreview: DerivedPreview | null = null;

  constructor(root: HTMLElement) {
    this.listEl = root.querySelector("#resultsList") as HTMLUListElement;
    this.breadcrumbEl = root.querySelector("#resultsBreadcrumb") as HTMLElement;
    this.emptyEl = root.querySelector("#resultsEmpty") as HTMLElement;
    this.loadingEl = root.querySelector("#resultsLoading") as HTMLElement;
    this.backBtn = root.querySelector("#btnResultsBack") as HTMLButtonElement;
    this.refreshBtn = root.querySelector("#btnResultsRefresh") as HTMLButtonElement;

    this.modal = document.getElementById("reportModal") as HTMLElement;
    this.modalBody = this.modal.querySelector("#reportModalScroll") as HTMLElement;
    this.modalTitle = this.modal.querySelector("#reportModalTitle") as HTMLElement;
    this.modalSub = this.modal.querySelector("#reportModalSub") as HTMLElement;
    this.modalCrumbs = this.modal.querySelector("#reportModalCrumbs") as HTMLElement;
    this.modalReport = this.modal.querySelector("#reportModalBody") as HTMLElement;
    this.modalLoading = this.modal.querySelector("#reportModalLoading") as HTMLElement;
    this.modalVideoPanel = this.modal.querySelector("#reportModalVideo") as HTMLElement;
    this.modalCloseBtn = this.modal.querySelector("#reportModalClose") as HTMLButtonElement;
    this.modalBackBtn = this.modal.querySelector("#reportModalBack") as HTMLButtonElement;

    this.modalPlayer = new VideoPlayerController(this.modalVideoPanel);

    this.backBtn.addEventListener("click", () => void this.goBack());
    this.refreshBtn.addEventListener("click", () => void this.refresh());
    this.modalCloseBtn.addEventListener("click", () => this.closeModal());
    this.modalBackBtn.addEventListener("click", () => this.closeModal());
    this.modal.addEventListener("click", (ev) => {
      if (ev.target === this.modal) this.closeModal();
    });
    window.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && this.modal.classList.contains("open")) this.closeModal();
    });

    onLangChange(() => {
      this.renderList();
      if (this.modal.classList.contains("open") && this.lastDetail) {
        this.fillModalHeader(this.lastDetail);
        this.renderReport(this.lastPreview);
      }
    });
  }

  setApiBase(url: string): void {
    this.apiBase = url.replace(/\/$/, "");
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
    } catch (err) {
      this.showEmpty(err instanceof Error ? err.message : String(err));
    } finally {
      this.setLoading(false);
    }
  }

  private async goBack(): Promise<void> {
    if (this.step === "sessions") {
      this.step = "dates";
      this.selectedDate = null;
      await this.loadDates();
    }
  }

  private setLoading(on: boolean): void {
    this.loadingEl.classList.toggle("hidden", !on);
    this.refreshBtn.disabled = on;
    this.backBtn.disabled = on;
  }

  private showEmpty(msg?: string): void {
    this.listEl.innerHTML = "";
    this.emptyEl.textContent = msg || t("results_empty");
    this.emptyEl.classList.remove("hidden");
  }

  private renderList(): void {
    if (this.step === "dates") void this.loadDates();
    else if (this.step === "sessions" && this.selectedDate) void this.loadSessions(this.selectedDate);
  }

  private async loadDates(): Promise<void> {
    this.step = "dates";
    this.backBtn.classList.add("hidden");
    this.breadcrumbEl.textContent = t("results_dates_hint");
    const dates = await listResultDates(this.apiBase);
    this.emptyEl.classList.toggle("hidden", dates.length > 0);
    if (dates.length === 0) this.emptyEl.textContent = t("results_empty");
    this.listEl.innerHTML = "";
    for (const d of dates) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "results-item";
      btn.textContent = d.displayDate;
      btn.addEventListener("click", () => {
        this.selectedDate = d;
        void this.loadSessions(d);
      });
      li.appendChild(btn);
      this.listEl.appendChild(li);
    }
  }

  private async loadSessions(date: ResultDate): Promise<void> {
    this.step = "sessions";
    this.backBtn.classList.remove("hidden");
    this.breadcrumbEl.textContent = date.displayDate;
    const data = await listResultSessions(this.apiBase, date.date);
    this.emptyEl.classList.toggle("hidden", data.sessions.length > 0);
    if (data.sessions.length === 0) this.emptyEl.textContent = t("results_empty");
    this.listEl.innerHTML = "";
    for (const s of data.sessions) {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "results-item";
      const orient = s.orientation ? ` · ${orientationLabel(s.orientation)}` : "";
      btn.textContent = `${s.displayTime}${orient}`;
      btn.addEventListener("click", () => void this.openSessionModal(date, s));
      li.appendChild(btn);
      this.listEl.appendChild(li);
    }
  }

  private async openSessionModal(date: ResultDate, session: ResultSession): Promise<void> {
    this.caveatsOpen = false;
    this.lastDetail = null;
    this.lastPreview = null;
    this.modal.classList.add("open");
    document.body.classList.add("modal-open");
    this.modalLoading.classList.remove("hidden");
    this.modalReport.innerHTML = "";
    this.modalPlayer.showIdle();
    this.fillModalHeader({
      date: date.date,
      displayDate: date.displayDate,
      session,
      video: { filename: "", url: null },
      report: {
        keypoints: { filename: "", url: null },
        derived: { filename: "", url: null },
      },
    });

    try {
      const detail = await getResultDetail(this.apiBase, date.date, session.stem);
      this.lastDetail = detail;
      this.lastPreview = detail.report.derived.preview ?? null;
      this.fillModalHeader(detail);
      if (detail.video.url) {
        this.modalPlayer.loadVideo(detail.video.url, {
          autoplay: true,
          loop: true,
          orientation: detail.session.orientation || session.orientation,
        });
      } else {
        this.modalPlayer.showIdle();
      }
      this.renderReport(this.lastPreview);
    } catch (err) {
      this.modalReport.innerHTML = "";
      const p = document.createElement("p");
      p.className = "rm-empty";
      p.textContent = err instanceof Error ? err.message : String(err);
      this.modalReport.appendChild(p);
    } finally {
      this.modalLoading.classList.add("hidden");
    }
  }

  private closeModal(): void {
    this.modal.classList.remove("open");
    document.body.classList.remove("modal-open");
    this.modalPlayer.stopVideo();
    this.modalPlayer.showIdle();
  }

  private fillModalHeader(detail: ResultDetail): void {
    const session = detail.session;
    const orient = session.orientation ? orientationLabel(session.orientation) : "";
    this.modalTitle.textContent = session.displayTime;
    this.modalSub.textContent = orient
      ? `${detail.displayDate} · ${orient}`
      : detail.displayDate;
    this.modalCrumbs.textContent = `${t("results_list")} › ${detail.displayDate} › ${session.displayTime}`;
  }

  private renderReport(preview: DerivedPreview | null): void {
    this.modalReport.innerHTML = "";
    const rows = preview?.report || [];

    const sectionLabel = document.createElement("div");
    sectionLabel.className = "rm-section-label";
    sectionLabel.textContent = t("report_section_label");
    this.modalReport.appendChild(sectionLabel);

    if (!preview || rows.length === 0) {
      const p = document.createElement("p");
      p.className = "rm-empty";
      p.textContent = t("report_empty");
      this.modalReport.appendChild(p);
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
    this.modalReport.appendChild(hero);

    const chips = document.createElement("div");
    chips.className = "rm-chips";
    chips.appendChild(chip(t("report_trusted"), String(trusted), "ok"));
    chips.appendChild(chip(t("report_caution"), String(cautioned), "warn"));
    chips.appendChild(
      chip(t("report_detect_rate"), detectPct != null ? `${detectPct}%` : "—", "neutral"),
    );
    this.modalReport.appendChild(chips);

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
      this.modalReport.appendChild(meta);
    }

    if (preview.advisory) {
      const box = document.createElement("div");
      box.className = "rm-advisory";
      box.innerHTML = `<b>${escapeHtml(t("report_advisory"))}</b><p>${escapeHtml(preview.advisory)}</p>`;
      this.modalReport.appendChild(box);
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
      this.modalReport.appendChild(sec);
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
        this.modalBody.scrollTop = this.modalBody.scrollHeight;
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
      this.modalReport.appendChild(block);
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
