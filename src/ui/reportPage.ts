/**
 * Full-page report browser (dates → sessions → detail).
 * Mirrors front_app Results* screens; uses back `/api/results/*` → ai-server.
 */

import {
  getResultDetail,
  listResultDates,
  listResultSessions,
  pickReportLocale,
  type DerivedPreview,
  type ReportRow,
  type ResultDate,
  type ResultDetail,
  type ResultSession,
} from "../api/resultsApi.js";
import { onLangChange, t } from "../i18n/index.js";
import { LOCALES, type Lang, type LocaleKey } from "../i18n/locales.js";

type Step = "dates" | "sessions" | "detail";
type ReportLang = "ko" | "en";

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
  private readonly videoEl: HTMLVideoElement;
  private readonly videoPlaceholder: HTMLElement;
  private readonly langKoBtn: HTMLButtonElement;
  private readonly langEnBtn: HTMLButtonElement;
  private readonly viewMediaBtn: HTMLButtonElement;
  private readonly langHintEl: HTMLElement;
  private readonly reviewOverlay: HTMLElement;
  private readonly reviewCloseBtn: HTMLButtonElement;
  private readonly reviewTitleEl: HTMLElement;
  private readonly reviewSubEl: HTMLElement;

  private apiBase = "";
  private step: Step = "dates";
  private selectedDate: ResultDate | null = null;
  private selectedSession: ResultSession | null = null;
  private caveatsOpen = false;
  private lastPreview: DerivedPreview | null = null;
  private lastDetail: ResultDetail | null = null;
  private lastCyclogramUrl: string | null = null;
  private reportLang: ReportLang = "ko";
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
    this.videoEl = root.querySelector("#rpCyclogramVideo") as HTMLVideoElement;
    this.videoPlaceholder = this.videoPanel.querySelector(".camera-placeholder") as HTMLElement;
    this.langKoBtn = root.querySelector("#rpLangKo") as HTMLButtonElement;
    this.langEnBtn = root.querySelector("#rpLangEn") as HTMLButtonElement;
    this.viewMediaBtn = root.querySelector("#rpViewMedia") as HTMLButtonElement;
    this.langHintEl = root.querySelector("#rpLangHint") as HTMLElement;
    this.reviewOverlay = document.getElementById("rpReviewOverlay") as HTMLElement;
    this.reviewCloseBtn = document.getElementById("rpReviewClose") as HTMLButtonElement;
    this.reviewTitleEl = document.getElementById("rpReviewTitle") as HTMLElement;
    this.reviewSubEl = document.getElementById("rpReviewSub") as HTMLElement;

    this.backBtn.addEventListener("click", () => void this.goBack());
    this.refreshBtn.addEventListener("click", () => void this.refresh());
    this.langKoBtn.addEventListener("click", () => this.setReportLang("ko"));
    this.langEnBtn.addEventListener("click", () => this.setReportLang("en"));
    this.viewMediaBtn.addEventListener("click", () => this.openReview());
    this.reviewCloseBtn.addEventListener("click", () => this.closeReview());
    this.reviewOverlay.addEventListener("click", (e) => {
      if (e.target === this.reviewOverlay) this.closeReview();
    });
    this.bindReviewControls();

    onLangChange(() => {
      if (!this.visible) return;
      this.updateChrome();
      this.syncActionLabels();
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
    this.closeReview();
    if (this.step === "detail") this.clearCyclogramVideo();
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
      this.closeReview();
      this.clearCyclogramVideo();
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
    this.syncActionLabels();
  }

  private syncActionLabels(): void {
    this.langKoBtn.textContent = t("report_lang_ko");
    this.langEnBtn.textContent = t("report_lang_en");
    this.viewMediaBtn.textContent = t("report_view_media");
    this.reviewTitleEl.textContent = t("report_review_title");
    this.reviewSubEl.textContent = t("report_review_sub");
    this.reviewCloseBtn.textContent = t("report_review_close");
    this.langKoBtn.classList.toggle("active", this.reportLang === "ko");
    this.langEnBtn.classList.toggle("active", this.reportLang === "en");
  }

  private setReportLang(lang: ReportLang): void {
    this.reportLang = lang;
    this.syncActionLabels();
    if (this.step === "detail") this.renderReport(this.lastPreview);
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
      const size = s.width && s.height ? `${s.width}×${s.height}` : "";
      const dog = s.dog?.name || "";
      const meta = [dog, orient, size].filter(Boolean).join(" · ");
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
    this.reportLang = "ko";
    this.lastDetail = null;
    this.lastPreview = null;
    this.listEl.classList.add("hidden");
    this.emptyEl.classList.add("hidden");
    this.detailEl.classList.remove("hidden");
    this.detailLoading.classList.remove("hidden");
    this.detailBody.innerHTML = "";
    this.updateChrome();

    try {
      const detail = await getResultDetail(this.apiBase, date.date, session.stem);
      this.lastDetail = detail;
      this.lastPreview = detail.report.derived.preview ?? null;
      this.updateChrome();
      const cyclogramUrl =
        detail.report.cyclogram?.available && detail.report.cyclogram.url
          ? detail.report.cyclogram.url
          : null;
      this.setCyclogramVideo(cyclogramUrl);
      this.renderReport(this.lastPreview);
    } catch (err) {
      this.clearCyclogramVideo();
      this.detailBody.innerHTML = "";
      const p = document.createElement("p");
      p.className = "rm-empty";
      p.textContent = err instanceof Error ? err.message : String(err);
      this.detailBody.appendChild(p);
    } finally {
      this.detailLoading.classList.add("hidden");
    }
  }

  /** Main-page style load: plain muted/loop video src, no transform player. */
  private setCyclogramVideo(url: string | null): void {
    if (!url) {
      this.clearCyclogramVideo(t("report_video_empty"));
      return;
    }

    let same = this.videoEl.getAttribute("src") === url;
    if (!same && this.lastCyclogramUrl) {
      same = urlsLooselyEqual(this.lastCyclogramUrl, url);
    }
    if (!same) {
      const current = this.videoEl.currentSrc || this.videoEl.src || "";
      if (current) same = urlsLooselyEqual(current, url);
    }

    this.videoPlaceholder.textContent = t("video_placeholder");
    this.videoPanel.classList.add("has-media");

    if (same) {
      if (this.videoEl.paused) void this.videoEl.play().catch(() => undefined);
      return;
    }

    this.videoEl.pause();
    this.videoEl.src = url;
    this.videoEl.load();
    this.lastCyclogramUrl = url;
    void this.videoEl.play().catch(() => undefined);
  }

  private clearCyclogramVideo(message?: string): void {
    this.videoEl.pause();
    this.videoEl.removeAttribute("src");
    this.videoEl.load();
    this.lastCyclogramUrl = null;
    this.videoPanel.classList.remove("has-media");
    this.videoPlaceholder.textContent = message || t("video_placeholder");
  }

  private hasEnglishLocale(preview: DerivedPreview | null): boolean {
    const en = preview?.locales?.en;
    return Boolean(en && ((en.report?.length ?? 0) > 0 || en.advisory || (en.caveats?.length ?? 0) > 0));
  }

  private renderReport(preview: DerivedPreview | null): void {
    this.detailBody.innerHTML = "";
    this.syncActionLabels();

    const hasEn = this.hasEnglishLocale(preview);
    this.langEnBtn.disabled = !hasEn;
    if (this.reportLang === "en" && !hasEn) {
      this.reportLang = "ko";
      this.syncActionLabels();
    }
    if (!hasEn) {
      this.langHintEl.textContent = t("report_lang_en_unavailable");
      this.langHintEl.classList.remove("hidden");
    } else {
      this.langHintEl.classList.add("hidden");
    }

    const lang = this.reportLang;
    const bundle = pickReportLocale(preview, lang);
    const rows = bundle.report || [];

    const sectionLabel = document.createElement("div");
    sectionLabel.className = "rm-section-label";
    sectionLabel.textContent = rt(lang, "report_section_label");
    this.detailBody.appendChild(sectionLabel);

    if (!preview || rows.length === 0) {
      const p = document.createElement("p");
      p.className = "rm-empty";
      p.textContent = rt(lang, "report_empty");
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
      <div class="rm-kicker">${escapeHtml(rt(lang, "report_kicker"))}</div>
      <div class="rm-title">${escapeHtml(rt(lang, "report_title"))}</div>
      <p class="rm-lead">${escapeHtml(rt(lang, "report_lead"))}</p>
    `;
    this.detailBody.appendChild(hero);

    const chips = document.createElement("div");
    chips.className = "rm-chips";
    chips.appendChild(chip(rt(lang, "report_trusted"), String(trusted), "ok"));
    chips.appendChild(chip(rt(lang, "report_caution"), String(cautioned), "warn"));
    chips.appendChild(
      chip(rt(lang, "report_detect_rate"), detectPct != null ? `${detectPct}%` : "—", "neutral"),
    );
    this.detailBody.appendChild(chips);

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
      this.detailBody.appendChild(meta);
    }

    if (bundle.advisory) {
      const box = document.createElement("div");
      box.className = "rm-advisory";
      box.innerHTML = `<b>${escapeHtml(rt(lang, "report_advisory"))}</b><p>${escapeHtml(bundle.advisory)}</p>`;
      this.detailBody.appendChild(box);
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
      this.detailBody.appendChild(sec);
    }

    if ((bundle.caveats?.length ?? 0) > 0) {
      const block = document.createElement("div");
      block.className = "rm-caveats";
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "rm-link";
      toggle.textContent = this.caveatsOpen
        ? rt(lang, "report_caveats_hide")
        : rt(lang, "report_caveats_show");
      toggle.addEventListener("click", () => {
        this.caveatsOpen = !this.caveatsOpen;
        this.renderReport(preview);
      });
      block.appendChild(toggle);
      if (this.caveatsOpen) {
        for (const c of bundle.caveats!) {
          const li = document.createElement("p");
          li.className = "rm-caveat-line";
          li.textContent = `· ${c}`;
          block.appendChild(li);
        }
      }
      this.detailBody.appendChild(block);
    }
  }

  private bindReviewControls(): void {
    this.reviewOverlay.querySelectorAll<HTMLElement>(".ws-media-controls").forEach((bar) => {
      const id = bar.getAttribute("data-video");
      if (!id) return;
      const video = document.getElementById(id) as HTMLVideoElement | null;
      if (!video) return;
      const playBtn = bar.querySelector(".ws-play") as HTMLButtonElement | null;
      const speed = bar.querySelector(".ws-speed") as HTMLSelectElement | null;
      playBtn?.addEventListener("click", () => {
        if (video.paused) void video.play().catch(() => undefined);
        else video.pause();
        syncReviewBar(video);
      });
      speed?.addEventListener("change", () => {
        video.playbackRate = Number(speed.value) || 1;
      });
      video.addEventListener("play", () => syncReviewBar(video));
      video.addEventListener("pause", () => syncReviewBar(video));
    });
  }

  private openReview(): void {
    const detail = this.lastDetail;
    if (!detail) return;

    setReviewEmptyHints();
    // 압력패드: mp4면 video, 그 외(gif 등)면 img.
    const pressureUrl =
      detail.report.pressure?.available && detail.report.pressure.url
        ? detail.report.pressure.url
        : null;
    if (pressureUrl && /\.(mp4|webm|ogg)(\?|#|$)/i.test(pressureUrl)) {
      setReviewMedia("rpBody1", document.getElementById("rpPressureGif") as HTMLImageElement, null);
      setReviewMedia(
        "rpBody1",
        document.getElementById("rpPressureVideo") as HTMLVideoElement,
        pressureUrl,
      );
    } else {
      setReviewMedia(
        "rpBody1",
        document.getElementById("rpPressureVideo") as HTMLVideoElement,
        null,
      );
      setReviewMedia(
        "rpBody1",
        document.getElementById("rpPressureGif") as HTMLImageElement,
        pressureUrl,
      );
    }
    setReviewMedia(
      "rpBody21",
      document.getElementById("rpOriginVideo") as HTMLVideoElement,
      detail.original?.available && detail.original.url
        ? detail.original.url
        : detail.backOriginal?.available
          ? detail.backOriginal.url
          : null,
    );
    setReviewMedia(
      "rpBody22",
      document.getElementById("rpAnalysisVideo") as HTMLVideoElement,
      detail.video?.available !== false ? detail.video.url : null,
    );
    setReviewMedia(
      "rpBody31",
      document.getElementById("rpAngleVideo") as HTMLVideoElement,
      detail.report.angle_pawy?.available ? detail.report.angle_pawy.url : null,
    );
    setReviewMedia(
      "rpBody32",
      document.getElementById("rpStrideImg") as HTMLImageElement,
      detail.report.stride?.available ? detail.report.stride.url : null,
    );

    this.reviewOverlay.classList.add("open");
    this.reviewOverlay.setAttribute("aria-hidden", "false");
  }

  private closeReview(): void {
    if (!this.reviewOverlay.classList.contains("open")) return;
    this.reviewOverlay.classList.remove("open");
    this.reviewOverlay.setAttribute("aria-hidden", "true");
    for (const id of ["rpOriginVideo", "rpAnalysisVideo", "rpAngleVideo", "rpPressureVideo"]) {
      const v = document.getElementById(id) as HTMLVideoElement | null;
      if (!v) continue;
      v.pause();
      v.removeAttribute("src");
      v.load();
    }
    const img = document.getElementById("rpStrideImg") as HTMLImageElement | null;
    img?.removeAttribute("src");
    const gif = document.getElementById("rpPressureGif") as HTMLImageElement | null;
    gif?.removeAttribute("src");
    for (const id of ["rpBody1", "rpBody21", "rpBody22", "rpBody31", "rpBody32"]) {
      const body = document.getElementById(id);
      body?.classList.remove("has-media");
      body?.classList.add("is-empty");
    }
  }
}

function rt(lang: Lang, key: LocaleKey, vars?: Record<string, string | number | null | undefined>): string {
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
  const ordered = FAMILY_KEYS.map((meta) => ({
    id: meta.id,
    title: rt(lang, meta.titleKey),
    blurb: rt(lang, meta.blurbKey),
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

function displayLabel(label: string, lang: ReportLang): string {
  if (lang === "en") return label;
  if (label.startsWith("앞발")) return `${rt("ko", "report_front")} · ${label.slice(2).trim()}`;
  if (label.startsWith("뒷발")) return `${rt("ko", "report_rear")} · ${label.slice(2).trim()}`;
  return label;
}

function orientationLabel(o: string): string {
  if (o === "portrait") return t("orient_portrait");
  if (o === "landscape") return t("orient_landscape");
  if (o === "square") return t("orient_square");
  return t("orient_unknown");
}

function urlsLooselyEqual(a: string, b: string): boolean {
  try {
    const ua = new URL(a, typeof location !== "undefined" ? location.href : undefined);
    const ub = new URL(b, typeof location !== "undefined" ? location.href : undefined);
    return ua.href === ub.href || ua.pathname + ua.search === ub.pathname + ub.search;
  } catch {
    return a === b || a.endsWith(b) || b.endsWith(a);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setReviewEmptyHints(): void {
  const map: Record<string, LocaleKey> = {
    rpBody1: "report_review_pressure_empty",
    rpBody21: "report_review_origin_empty",
    rpBody22: "report_review_analysis_empty",
    rpBody31: "report_review_angle_empty",
    rpBody32: "report_review_stride_empty",
  };
  for (const [id, key] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (el) el.setAttribute("data-empty", t(key));
  }
}

function syncReviewBar(video: HTMLVideoElement): void {
  const bar = document.querySelector(`.ws-media-controls[data-video="${video.id}"]`);
  if (!bar) return;
  const playBtn = bar.querySelector(".ws-play") as HTMLButtonElement | null;
  const speed = bar.querySelector(".ws-speed") as HTMLSelectElement | null;
  if (playBtn) {
    playBtn.disabled = !video.getAttribute("src");
    const playing = !video.paused && !video.ended;
    playBtn.textContent = playing ? "⏸" : "▶";
  }
  if (speed) {
    speed.disabled = !video.getAttribute("src");
    if (video.getAttribute("src")) video.playbackRate = Number(speed.value) || 1;
  }
}

function setReviewMedia(
  bodyId: string,
  media: HTMLImageElement | HTMLVideoElement,
  url: string | null,
): void {
  const body = document.getElementById(bodyId);
  if (!body) return;
  if (!url) {
    if (media instanceof HTMLVideoElement) {
      media.pause();
      media.removeAttribute("src");
      media.load();
      syncReviewBar(media);
    } else {
      media.removeAttribute("src");
    }
    body.classList.remove("has-media");
    body.classList.add("is-empty");
    return;
  }

  if (media instanceof HTMLImageElement) {
    media.src = url;
    body.classList.add("has-media");
    body.classList.remove("is-empty");
    return;
  }

  media.pause();
  media.src = url;
  media.load();
  body.classList.add("has-media");
  body.classList.remove("is-empty");
  syncReviewBar(media);
  void media.play().then(() => syncReviewBar(media)).catch(() => syncReviewBar(media));
}
