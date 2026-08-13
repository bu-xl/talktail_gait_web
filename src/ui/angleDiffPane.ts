/**
 * Pane 3-2: joint angle min/max (angle_diff JSON from ai-server result_angle_diff).
 * Carousel: one chain level per slide; each slide shows front + rear sections
 * with left / right. Auto-advances every 4s (toggleable).
 *
 * 라벨은 모두 i18n 을 거친다. 언어를 바꾸면 마지막 리포트로 통째로 다시 그린다 —
 * 슬라이드 제목·좌우 라벨이 DOM 에 텍스트로 박혀 있어 `applyDocumentI18n` 이
 * 닿지 못하기 때문이다.
 */

import { onLangChange, t } from "../i18n/index.js";
import type { LocaleKey } from "../i18n/locales.js";

export type AngleDiffJoint = {
  limb: string;
  joint_ko: string;
  joint?: string;
  kind?: string;
  min_deg: number;
  max_deg: number;
  mean_deg?: number;
  p5_deg?: number;
  p95_deg?: number;
  range_p5p95_deg?: number;
  conf_p50?: number;
};

export type AngleDiffReport = {
  schema_version?: string;
  primary_metric?: string;
  note?: string;
  joints: Record<string, AngleDiffJoint>;
};

const AUTO_MS = 4000;

/** Four slides: front / rear homologous joints with section titles. */
const SLIDES: ReadonlyArray<{
  frontKey: string;
  rearKey: string;
  frontTitleKey: LocaleKey;
  rearTitleKey: LocaleKey;
}> = [
  { frontKey: "shoulder", rearKey: "hip", frontTitleKey: "ad_shoulder", rearTitleKey: "ad_hip" },
  { frontKey: "elbow", rearKey: "knee", frontTitleKey: "ad_elbow", rearTitleKey: "ad_knee" },
  { frontKey: "carpus", rearKey: "tarsus", frontTitleKey: "ad_carpus", rearTitleKey: "ad_tarsus" },
  // JSON uses front_paw / rear_paw (kind=segment_ground), not "paw"
  { frontKey: "front_paw", rearKey: "rear_paw", frontTitleKey: "ad_front_paw", rearTitleKey: "ad_rear_paw" },
];

function fmtDeg(n: number | undefined | null): string {
  if (n == null || Number.isNaN(n)) return "–";
  return `${n.toFixed(0)}°`;
}

function bodyOf(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

function ensureRoot(): HTMLElement {
  const body = bodyOf("wsBody32");
  let root = document.getElementById("wsAngleDiff");
  if (!root) {
    root = document.createElement("div");
    root.id = "wsAngleDiff";
    root.className = "ad-root";
    root.setAttribute("hidden", "");
    body.appendChild(root);
  }
  return root;
}

function hideLegacyImage(): void {
  const img = document.getElementById("wsShadowImg") as HTMLImageElement | null;
  if (!img) return;
  img.removeAttribute("src");
  img.setAttribute("hidden", "");
}

let autoTimer: number | null = null;
/** 언어 전환 시 다시 그리기 위해 마지막 리포트를 들고 있는다. */
let lastReport: AngleDiffReport | null = null;
let langHookInstalled = false;

function stopAutoplay(): void {
  if (autoTimer != null) {
    window.clearInterval(autoTimer);
    autoTimer = null;
  }
}

export function clearAngleDiffPane(): void {
  stopAutoplay();
  lastReport = null;
  const body = bodyOf("wsBody32");
  const root = document.getElementById("wsAngleDiff");
  if (root) {
    root.innerHTML = "";
    root.setAttribute("hidden", "");
  }
  body.classList.remove("has-media", "has-angle-diff");
  body.classList.add("is-empty");
}

function findJoint(
  byKey: Map<string, AngleDiffJoint>,
  limb: string,
  joint: string,
): AngleDiffJoint | undefined {
  return byKey.get(`${limb}.${joint}`);
}

function buildSideCard(
  sideLabel: string,
  limbClass: string,
  j: AngleDiffJoint | undefined,
): HTMLElement {
  const card = document.createElement("div");
  card.className = `ad-limb ad-limb--${limbClass}`;

  const label = document.createElement("div");
  label.className = "ad-limb-id";
  label.textContent = sideLabel;
  card.appendChild(label);

  if (!j) {
    const empty = document.createElement("div");
    empty.className = "ad-limb-empty";
    empty.textContent = "–";
    card.appendChild(empty);
    return card;
  }

  const nums = document.createElement("div");
  nums.className = "ad-limb-nums";
  nums.innerHTML = `<span class="ad-min">${fmtDeg(j.min_deg)}</span><span class="ad-sep">–</span><span class="ad-max">${fmtDeg(j.max_deg)}</span>`;
  card.appendChild(nums);

  return card;
}

function buildSection(
  title: string,
  left: AngleDiffJoint | undefined,
  right: AngleDiffJoint | undefined,
  side: "front" | "rear",
): HTMLElement {
  const section = document.createElement("div");
  section.className = `ad-section ad-section--${side}`;

  const h = document.createElement("div");
  h.className = "ad-section-title";
  h.textContent = title;
  section.appendChild(h);

  const row = document.createElement("div");
  row.className = "ad-side-row";
  row.appendChild(buildSideCard(t("ad_left"), `${side}_left`, left));
  row.appendChild(buildSideCard(t("ad_right"), `${side}_right`, right));
  section.appendChild(row);

  return section;
}

export function renderAngleDiff(report: AngleDiffReport): void {
  stopAutoplay();
  lastReport = report;
  if (!langHookInstalled) {
    langHookInstalled = true;
    onLangChange(() => {
      if (lastReport) renderAngleDiff(lastReport);
    });
  }
  hideLegacyImage();
  const body = bodyOf("wsBody32");
  const root = ensureRoot();
  root.removeAttribute("hidden");
  root.innerHTML = "";

  const byKey = new Map<string, AngleDiffJoint>();
  for (const j of Object.values(report.joints ?? {})) {
    if (!j?.limb || !j.joint) continue;
    byKey.set(`${j.limb}.${j.joint}`, j);
  }

  const viewport = document.createElement("div");
  viewport.className = "ad-viewport";

  const track = document.createElement("div");
  track.className = "ad-track";

  for (const slide of SLIDES) {
    const page = document.createElement("div");
    page.className = "ad-page";
    page.setAttribute("data-slide", t(slide.frontTitleKey));

    page.appendChild(
      buildSection(
        t(slide.frontTitleKey),
        findJoint(byKey, "front_left", slide.frontKey),
        findJoint(byKey, "front_right", slide.frontKey),
        "front",
      ),
    );
    page.appendChild(
      buildSection(
        t(slide.rearTitleKey),
        findJoint(byKey, "rear_left", slide.rearKey),
        findJoint(byKey, "rear_right", slide.rearKey),
        "rear",
      ),
    );

    track.appendChild(page);
  }

  viewport.appendChild(track);
  root.appendChild(viewport);

  const nav = document.createElement("div");
  nav.className = "ad-nav";

  const navCenter = document.createElement("div");
  navCenter.className = "ad-nav-center";

  const prev = document.createElement("button");
  prev.type = "button";
  prev.className = "ad-nav-btn";
  prev.setAttribute("aria-label", t("ad_prev"));
  prev.textContent = "‹";

  const next = document.createElement("button");
  next.type = "button";
  next.className = "ad-nav-btn";
  next.setAttribute("aria-label", t("ad_next"));
  next.textContent = "›";

  const dots = document.createElement("div");
  dots.className = "ad-dots";
  const dotBtns: HTMLButtonElement[] = [];
  for (let i = 0; i < SLIDES.length; i++) {
    const d = document.createElement("button");
    d.type = "button";
    d.className = "ad-dot";
    d.setAttribute("aria-label", t(SLIDES[i].frontTitleKey));
    dots.appendChild(d);
    dotBtns.push(d);
  }

  navCenter.append(prev, dots, next);

  const autoBtn = document.createElement("button");
  autoBtn.type = "button";
  autoBtn.className = "ad-autoplay is-playing";
  autoBtn.setAttribute("aria-label", t("ad_autoplay_stop"));
  autoBtn.title = t("ad_autoplay_stop");
  autoBtn.textContent = "⏸";

  // Spacer keeps center controls visually centered while autoplay sits on the right.
  const spacer = document.createElement("div");
  spacer.className = "ad-nav-spacer";
  spacer.setAttribute("aria-hidden", "true");

  nav.append(spacer, navCenter, autoBtn);
  root.appendChild(nav);

  let index = 0;
  /** User toggle: auto-advance on/off. */
  let autoplayOn = true;
  /** Temporary pause while dragging. */
  let dragging = false;

  const syncAutoBtn = (): void => {
    autoBtn.classList.toggle("is-playing", autoplayOn);
    const label = autoplayOn ? t("ad_autoplay_stop") : t("ad_autoplay_start");
    autoBtn.textContent = autoplayOn ? "⏸" : "▶";
    autoBtn.setAttribute("aria-label", label);
    autoBtn.title = label;
  };

  const setIndex = (i: number): void => {
    index = ((i % SLIDES.length) + SLIDES.length) % SLIDES.length;
    track.style.transform = `translateX(-${index * 100}%)`;
    dotBtns.forEach((d, di) => d.classList.toggle("is-active", di === index));
  };

  const restartAutoplay = (): void => {
    stopAutoplay();
    if (!autoplayOn || dragging) return;
    autoTimer = window.setInterval(() => {
      setIndex(index + 1);
    }, AUTO_MS);
  };

  const go = (i: number): void => {
    setIndex(i);
    restartAutoplay();
  };

  autoBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    autoplayOn = !autoplayOn;
    syncAutoBtn();
    if (autoplayOn) restartAutoplay();
    else stopAutoplay();
  });

  prev.addEventListener("click", () => go(index - 1));
  next.addEventListener("click", () => go(index + 1));
  dotBtns.forEach((d, di) => d.addEventListener("click", () => go(di)));

  let dragX = 0;
  let startX = 0;
  viewport.addEventListener(
    "pointerdown",
    (ev) => {
      dragging = true;
      stopAutoplay();
      startX = ev.clientX;
      dragX = 0;
      viewport.setPointerCapture(ev.pointerId);
      track.classList.add("is-dragging");
    },
    { passive: true },
  );
  viewport.addEventListener(
    "pointermove",
    (ev) => {
      if (!dragging) return;
      dragX = ev.clientX - startX;
      const w = viewport.clientWidth || 1;
      const pct = (dragX / w) * 100;
      track.style.transform = `translateX(calc(-${index * 100}% + ${pct}%))`;
    },
    { passive: true },
  );
  const endDrag = (): void => {
    if (!dragging) return;
    dragging = false;
    track.classList.remove("is-dragging");
    const w = viewport.clientWidth || 1;
    if (Math.abs(dragX) > w * 0.18) setIndex(index + (dragX < 0 ? 1 : -1));
    else setIndex(index);
    restartAutoplay();
  };
  viewport.addEventListener("pointerup", endDrag);
  viewport.addEventListener("pointercancel", endDrag);

  syncAutoBtn();
  setIndex(0);
  restartAutoplay();

  body.classList.add("has-media", "has-angle-diff");
  body.classList.remove("is-empty");
}

export async function loadAngleDiffFromUrl(url: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`angle_diff fetch ${res.status}: ${url}`);
  const data = (await res.json()) as AngleDiffReport;
  if (!data?.joints || typeof data.joints !== "object") {
    throw new Error("angle_diff JSON missing joints");
  }
  renderAngleDiff(data);
}

/** Load angle_diff JSON into 3-2. Pass null/empty to clear the pane. */
export async function loadAngleDiffPane(url?: string | null): Promise<void> {
  const target = url?.trim();
  if (!target) {
    clearAngleDiffPane();
    return;
  }
  await loadAngleDiffFromUrl(target);
}
