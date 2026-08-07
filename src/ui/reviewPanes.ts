/**
 * Review-layout panes (1 / 2-1 / 2-2 / 3-1 / 3-2).
 * Media stays black until an explicit load; AI paths for 3-* TBD with ai-server.
 */

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
    playBtn.title = playing ? "정지" : "재생";
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

  if (media.paused) {
    void media.play().then(() => syncVideoBar(media, true)).catch((error: unknown) => {
      if (
        typeof DOMException !== "undefined" &&
        error instanceof DOMException &&
        error.name === "AbortError"
      ) {
        syncVideoBar(media, true);
        return;
      }
      syncVideoBar(media, true);
    });
  }
}

export function clearReviewPanes(): void {
  setPaneMedia("wsBody1", bodyOf("wsPressureGif") as HTMLImageElement, null);
  setPaneMedia("wsBody21", bodyOf("wsOriginVideo") as HTMLVideoElement, null);
  setPaneMedia("wsBody22", bodyOf("wsAnalysisVideo") as HTMLVideoElement, null);
  setPaneMedia("wsBody31", bodyOf("wsMaxMinVideo") as HTMLVideoElement, null);
  setPaneMedia("wsBody32", bodyOf("wsShadowImg") as HTMLImageElement, null);
}

export function setPressureGif(url: string | null): void {
  setPaneMedia("wsBody1", bodyOf("wsPressureGif") as HTMLImageElement, url);
}

export function setOriginVideo(url: string | null): void {
  setPaneMedia("wsBody21", bodyOf("wsOriginVideo") as HTMLVideoElement, url);
}

export function setAnalysisVideo(url: string | null): void {
  setPaneMedia("wsBody22", bodyOf("wsAnalysisVideo") as HTMLVideoElement, url);
}

/** 3-1 / 3-2 — wire when ai-server export paths are known (incl. report later). */
export function setMaxMinVideo(url: string | null): void {
  setPaneMedia("wsBody31", bodyOf("wsMaxMinVideo") as HTMLVideoElement, url);
}

export function setShadowImage(url: string | null): void {
  setPaneMedia("wsBody32", bodyOf("wsShadowImg") as HTMLImageElement, url);
}
