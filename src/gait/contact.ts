import type { ContactEvent, PawGaitConfig, PawTrack } from "./types.js";

function trackPeakPressure(track: PawTrack): number {
  let peak = 0;
  for (const p of track.pressureHistory) {
    if (p > peak) peak = p;
  }
  if (track.lastBlob && track.lastBlob.pressureSum > peak) {
    peak = track.lastBlob.pressureSum;
  }
  return peak;
}

function thresholdsForTrack(
  track: PawTrack,
  cfg: PawGaitConfig,
): { contact: number; release: number } {
  const peak = trackPeakPressure(track);
  const floor = cfg.contactThreshold;
  const ratioBased = peak * cfg.contactThresholdRatio;

  // 소형견(3~4kg): track peak 가 절대 하한 근처면 ratio-primary (고정 55~80 방지)
  let contact: number;
  if (peak > 0 && peak < floor * 1.5) {
    contact = Math.max(6, ratioBased, peak * 0.05, floor * 0.26);
  } else {
    contact = Math.max(floor, ratioBased);
  }

  const release = Math.max(
    4,
    Math.min(contact * 0.62, floor * 0.36),
    peak * cfg.releaseThresholdRatio,
    contact * 0.48,
  );
  return { contact, release };
}

/** Step 4 — adaptive contact + hysteresis (IC / toe-off) */
export function updateContactState(
  tracks: readonly PawTrack[],
  frameIndex: number,
  cfg: PawGaitConfig,
): void {
  for (const track of tracks) {
    if (!track.active || !track.lastBlob) continue;
    // 이번 프레임에 매칭된 blob이 없으면(발이 떨어짐) 순간 압력을 0으로 본다.
    // 그렇지 않으면 stale한 lastBlob.pressureSum 때문에 toe-off(release)가
    // 영원히 트리거되지 않아 한 번의 접지가 세션 끝까지 이어진다.
    const pressure = track.missFrames > 0 ? 0 : track.lastBlob.pressureSum;
    const { contact, release } = thresholdsForTrack(track, cfg);
    const wasContact = track.contact;
    const nowContact = wasContact ? pressure >= release : pressure > contact;
    track.contact = nowContact;

    if (!wasContact && nowContact) {
      track.pendingContactStart = frameIndex;
    } else if (wasContact && !nowContact) {
      const start = track.pendingContactStart ?? frameIndex;
      const ev: ContactEvent = { startFrame: start, endFrame: frameIndex };
      track.contactEvents.push(ev);
      track.contactEventLabels.push(null);
      track.pendingContactStart = null;
    } else if (nowContact && track.pendingContactStart === null) {
      track.pendingContactStart = frameIndex;
    }
  }
}

export function countCompletedContacts(tracks: readonly PawTrack[]): number {
  let n = 0;
  for (const t of tracks) n += t.contactEvents.length;
  return n;
}

/** IC + 진행 중 stance 포함 — 분류 준비 판단용 */
export function countContactCycles(tracks: readonly PawTrack[]): number {
  let n = 0;
  for (const t of tracks) {
    n += t.contactEvents.length;
    if (t.pendingContactStart !== null) n += 1;
  }
  return n;
}

export function closeOpenContacts(tracks: readonly PawTrack[], endFrame: number): void {
  for (const t of tracks) {
    if (t.pendingContactStart !== null && t.contact) {
      t.contactEvents.push({
        startFrame: t.pendingContactStart,
        endFrame,
      });
      t.contactEventLabels.push(null);
      t.pendingContactStart = null;
      t.contact = false;
    }
  }
}
