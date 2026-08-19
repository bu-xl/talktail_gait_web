/**
 * Review-layout panes (1 / 2-1 / 2-2 / 3-1 / 3-2).
 * Media stays black until an explicit load; 3-2 uses angle_diff JSON (see angleDiffPane).
 */

import { t } from "../i18n/index.js";
import { clearAngleDiffPane } from "./angleDiffPane";

function bodyOf(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el;
}

function syncVideoBar(video: HTMLVideoElement, enabled: boolean): void {
  const bar = document.querySelector(`.ws-media-controls[data-video="${video.id}"]`);
  if (!bar) return;
  const playBtn = bar.querySelector(".ws-play") as HTMLButtonElement | null;
  const speed = bar.querySelector(".ws-speed") as HTMLSelectElement | null;
  if (playBtn) {
    playBtn.disabled = !enabled;
    const playing = enabled && !video.paused && !video.ended;
    playBtn.textContent = playing ? "⏸" : "▶";
    playBtn.title = playing ? t("btn_pause") : t("btn_play");
  }
  if (speed) {
    speed.disabled = !enabled;
    if (enabled) video.playbackRate = Number(speed.value) || 1;
  }
}

function setPaneMedia(bodyId: string, media: HTMLImageElement | HTMLVideoElement, url: string | null): void {
  const body = bodyOf(bodyId);
  if (!url) {
    if (media instanceof HTMLVideoElement) {
      media.pause();
      media.removeAttribute("src");
      media.load();
      syncVideoBar(media, false);
    } else {
      media.removeAttribute("src");
    }
    body.classList.remove("has-media");
    body.classList.add("is-empty");
    return;
  }

  if (media instanceof HTMLImageElement) {
    if (media.getAttribute("src") === url) {
      body.classList.add("has-media");
      body.classList.remove("is-empty");
      return;
    }
    media.src = url;
    body.classList.add("has-media");
    body.classList.remove("is-empty");
    return;
  }

  // Video: never re-assign the same URL (avoids AbortError from play↔load races).
  let same = media.getAttribute("src") === url;
  if (!same) {
    const current = media.currentSrc || media.src || "";
    if (current) {
      try {
        const curPath = new URL(current, location.href);
        const nextPath = new URL(url, location.href);
        same = curPath.href === nextPath.href || curPath.pathname + curPath.search === nextPath.pathname + nextPath.search;
      } catch {
        same = current === url || current.endsWith(url) || url.endsWith(current);
      }
    }
  }
  if (same) {
    syncVideoBar(media, true);
    body.classList.add("has-media");
    body.classList.remove("is-empty");
    return;
  }

  media.pause();
  media.src = url;
  media.load();
  syncVideoBar(media, true);
  body.classList.add("has-media");
  body.classList.remove("is-empty");

  // Deliberately does NOT auto-play. Each pane starting itself is what put the
  // panes on separate clocks; ReviewSyncController starts them together.
}

function isVideoUrl(url: string): boolean {
  return /\.(mp4|webm|ogg)(\?|#|$)/i.test(url);
}

export function clearReviewPanes(): void {
  setPressureMedia(null);
  setPaneMedia("wsBody21", bodyOf("wsOriginVideo") as HTMLVideoElement, null);
  setPaneMedia("wsBody22", bodyOf("wsAnalysisVideo") as HTMLVideoElement, null);
  setPaneMedia("wsBody31", bodyOf("wsMaxMinVideo") as HTMLVideoElement, null);
  clearAngleDiffPane();
  const shadow = document.getElementById("wsShadowImg") as HTMLImageElement | null;
  if (shadow) {
    shadow.removeAttribute("src");
    shadow.setAttribute("hidden", "");
  }
}

/** Pane 1: GIF (img) or pressboard/promo MP4 (video). */
export function setPressureMedia(url: string | null): void {
  const img = bodyOf("wsPressureGif") as HTMLImageElement;
  const video = bodyOf("wsPressureVideo") as HTMLVideoElement;
  const body = bodyOf("wsBody1");

  if (!url) {
    img.removeAttribute("src");
    video.pause();
    video.removeAttribute("src");
    video.load();
    syncVideoBar(video, false);
    body.classList.remove("has-media");
    body.classList.add("is-empty");
    return;
  }

  if (isVideoUrl(url)) {
    img.removeAttribute("src");
    setPaneMedia("wsBody1", video, url);
    return;
  }

  video.pause();
  video.removeAttribute("src");
  video.load();
  syncVideoBar(video, false);
  setPaneMedia("wsBody1", img, url);
}

/** @deprecated Prefer setPressureMedia — kept for existing call sites. */
export function setPressureGif(url: string | null): void {
  setPressureMedia(url);
}

/**
 * 2-1 촬영 영상은 항상 가로(landscape)로 보이게 한다.
 * 세로로 촬영된 원본(휴대폰 등)이면 90° 회전시켜 팬을 가로로 채운다.
 * 가로 원본은 기본 CSS(object-fit: contain)를 그대로 쓴다.
 */
function applyOriginLandscape(video: HTMLVideoElement): void {
  const body = video.parentElement as HTMLElement | null;
  if (!body) return;
  const srcW = video.videoWidth;
  const srcH = video.videoHeight;
  const vw = body.clientWidth;
  const vh = body.clientHeight;
  const portrait = srcW > 0 && srcH > 0 && srcH > srcW;

  if (portrait && vw > 0 && vh > 0) {
    // 회전 전 요소 박스를 컨테이너와 가로/세로를 맞바꿔 잡으면, rotate(90deg) 후
    // 화면상 박스가 컨테이너와 일치한다. object-fit: contain 으로 프레임을 맞춘다.
    video.style.position = "absolute";
    video.style.left = "50%";
    video.style.top = "50%";
    video.style.width = `${vh}px`;
    video.style.height = `${vw}px`;
    video.style.maxWidth = "none";
    video.style.maxHeight = "none";
    video.style.objectFit = "contain";
    // 반시계 90° 회전 → 세로 원본의 위(TOP)가 화면 왼쪽으로 온다.
    video.style.transform = "translate(-50%, -50%) rotate(-90deg)";
  } else {
    // 가로거나 아직 메타데이터 미확보 → 인라인 스타일 제거(기본 CSS 사용).
    video.style.position = "";
    video.style.left = "";
    video.style.top = "";
    video.style.width = "";
    video.style.height = "";
    video.style.maxWidth = "";
    video.style.maxHeight = "";
    video.style.objectFit = "";
    video.style.transform = "";
  }
}

let originLandscapeWired = false;
function ensureOriginLandscape(): void {
  if (originLandscapeWired) return;
  const video = document.getElementById("wsOriginVideo") as HTMLVideoElement | null;
  if (!video) return;
  const reapply = (): void => applyOriginLandscape(video);
  // 새 영상 로드 시(메타데이터 확보) · 소스 제거 시 · 팬 크기 변경 시 재계산.
  video.addEventListener("loadedmetadata", reapply);
  video.addEventListener("emptied", reapply);
  const body = video.parentElement as HTMLElement | null;
  if (typeof ResizeObserver !== "undefined" && body) {
    new ResizeObserver(reapply).observe(body);
  } else if (typeof window !== "undefined") {
    window.addEventListener("resize", reapply);
  }
  originLandscapeWired = true;
}

export function setOriginVideo(url: string | null): void {
  ensureOriginLandscape();
  setPaneMedia("wsBody21", bodyOf("wsOriginVideo") as HTMLVideoElement, url);
}

export function setAnalysisVideo(url: string | null): void {
  setPaneMedia("wsBody22", bodyOf("wsAnalysisVideo") as HTMLVideoElement, url);
}

/** 3-1 / 3-2 — wire when ai-server export paths are known (incl. report later). */
export function setMaxMinVideo(url: string | null): void {
  setPaneMedia("wsBody31", bodyOf("wsMaxMinVideo") as HTMLVideoElement, url);
}

/** @deprecated 3-2 now renders angle_diff JSON via angleDiffPane. Kept for rare PNG fallback. */
export function setShadowImage(url: string | null): void {
  clearAngleDiffPane();
  const img = bodyOf("wsShadowImg") as HTMLImageElement;
  img.removeAttribute("hidden");
  setPaneMedia("wsBody32", img, url);
}
