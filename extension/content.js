// Sub Stream AI — content script
// Mounts a subtitle overlay anchored over the most likely active video element.

const OVERLAY_ID = 'kami-subs-overlay';
const MAX_VISIBLE_CHARS = 180;
const MIN_SUBTITLE_DELAY_MS = -10000;
const MAX_SUBTITLE_DELAY_MS = 10000;
const DEFAULT_SUBTITLE_DURATION_MS = 2600;
const MIN_SUBTITLE_DURATION_MS = 1200;
const MAX_SUBTITLE_DURATION_MS = 8000;

let overlayEl = null;
let textEl = null;
let hideTimer = null;
let showTimer = null;
let errorTimer = null;
let pendingSubtitle = null;
let trackedVideo = null;
let resizeObserver = null;
let scrollHandler = null;
let currentSettings = {};
let currentSyncMetrics = null;

function pickPrimaryVideo() {
  const videos = Array.from(document.querySelectorAll('video'));
  if (videos.length === 0) return null;
  // Prefer the largest visible video.
  let best = null;
  let bestArea = 0;
  for (const v of videos) {
    const r = v.getBoundingClientRect();
    const area = Math.max(0, r.width) * Math.max(0, r.height);
    if (area > bestArea) { bestArea = area; best = v; }
  }
  return best;
}

function currentOverlayHost() {
  // When something is in fullscreen, browsers paint a "top layer" above
  // everything else and only descendants of the fullscreen element are visible.
  // Re-parent the overlay there so subtitles survive fullscreen.
  return document.fullscreenElement || document.webkitFullscreenElement || document.documentElement;
}

function ensureOverlay(settings) {
  // If we hold a reference that's still in the DOM, reuse it.
  if (overlayEl && overlayEl.isConnected) {
    const host = currentOverlayHost();
    if (overlayEl.parentNode !== host) host.appendChild(overlayEl);
    return overlayEl;
  }
  // Service-worker restarts or stale content-script reloads can leave orphan
  // overlay elements in the DOM that we no longer hold a ref to. Sweep them
  // out before creating a new one — otherwise they stack.
  document.querySelectorAll('#' + OVERLAY_ID).forEach(n => n.remove());
  overlayEl = document.createElement('div');
  overlayEl.id = OVERLAY_ID;
  overlayEl.setAttribute('dir', 'rtl');
  textEl = document.createElement('span');
  textEl.className = 'kami-subs-text';
  overlayEl.appendChild(textEl);
  currentOverlayHost().appendChild(overlayEl);
  applySettings(settings || {});
  return overlayEl;
}

function relocateForFullscreen() {
  if (!overlayEl) return;
  const host = currentOverlayHost();
  if (overlayEl.parentNode !== host) host.appendChild(overlayEl);
  positionOverlayOverVideo();
}
document.addEventListener('fullscreenchange', relocateForFullscreen);
document.addEventListener('webkitfullscreenchange', relocateForFullscreen);

function applySettings(settings, sync) {
  currentSettings = { ...currentSettings, ...(settings || {}) };
  if (sync) currentSyncMetrics = sync;
  if (!overlayEl) return;
  const fontSize = settings.fontSize || 28;
  overlayEl.style.setProperty('--kami-font-size', fontSize + 'px');
  const position = settings.position || 'bottom';
  overlayEl.dataset.position = position;
  schedulePendingSubtitle();
}

function positionOverlayOverVideo() {
  if (!overlayEl) return;
  // Viewport-anchored positioning works reliably in every layout:
  // tall pages, fullscreen players, iframes, weird custom skins, etc.
  // Trying to follow the video element's bounding box ends up offscreen
  // whenever the player is taller than the viewport or scrolls oddly.
  overlayEl.style.left = '50%';
  overlayEl.style.transform = 'translateX(-50%)';
  overlayEl.style.width = 'min(86vw, 1200px)';
  if ((overlayEl.dataset.position || 'bottom') === 'top') {
    overlayEl.style.top = '6vh';
    overlayEl.style.bottom = '';
  } else if (overlayEl.dataset.position === 'middle') {
    overlayEl.style.top = '50%';
    overlayEl.style.bottom = '';
    overlayEl.style.transform = 'translate(-50%, -50%)';
  } else {
    overlayEl.style.bottom = '8vh';
    overlayEl.style.top = '';
  }
}

function trackVideo() {
  trackedVideo = pickPrimaryVideo();
  if (resizeObserver) try { resizeObserver.disconnect(); } catch (e) {}
  if (window.ResizeObserver && trackedVideo) {
    resizeObserver = new ResizeObserver(() => positionOverlayOverVideo());
    resizeObserver.observe(trackedVideo);
  }
  scrollHandler = () => positionOverlayOverVideo();
  window.addEventListener('scroll', scrollHandler, { passive: true });
  window.addEventListener('resize', scrollHandler);
  positionOverlayOverVideo();
}

function untrackVideo() {
  if (resizeObserver) { try { resizeObserver.disconnect(); } catch (e) {} resizeObserver = null; }
  if (scrollHandler) {
    window.removeEventListener('scroll', scrollHandler);
    window.removeEventListener('resize', scrollHandler);
    scrollHandler = null;
  }
  trackedVideo = null;
}

function mount(settings, sync) {
  if (sync) currentSyncMetrics = sync;
  ensureOverlay(settings);
  trackVideo();
  // Don't reveal the overlay until we actually have text — otherwise the user
  // sees an empty black padded box during the seconds before the first chunk.
}

function unmount() {
  clearPendingSubtitle();
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  if (errorTimer) { clearTimeout(errorTimer); errorTimer = null; }
  untrackVideo();
  // Belt-and-suspenders: remove every #kami-subs-overlay in the DOM, not just
  // the one we hold a ref to (defensive against orphans from previous loads).
  document.querySelectorAll('#' + OVERLAY_ID).forEach(n => n.remove());
  overlayEl = null;
  textEl = null;
}

function subtitleOffsetMs() {
  const effective = Number(currentSyncMetrics && currentSyncMetrics.effectiveOffsetS);
  if (Number.isFinite(effective)) {
    return Math.max(MIN_SUBTITLE_DELAY_MS, Math.min(MAX_SUBTITLE_DELAY_MS, effective * 1000));
  }
  const raw = Number(currentSettings.subtitleDelayMs);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(MIN_SUBTITLE_DELAY_MS, Math.min(MAX_SUBTITLE_DELAY_MS, raw));
}

function subtitleDurationMs() {
  const raw = Number(currentSettings.subtitleDurationMs);
  if (!Number.isFinite(raw)) return DEFAULT_SUBTITLE_DURATION_MS;
  return Math.max(MIN_SUBTITLE_DURATION_MS, Math.min(MAX_SUBTITLE_DURATION_MS, raw));
}

function clearPendingSubtitle() {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  pendingSubtitle = null;
}

function schedulePendingSubtitle() {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
  if (!pendingSubtitle) return;

  const offsetMs = Number.isFinite(Number(pendingSubtitle.offsetMs))
    ? Number(pendingSubtitle.offsetMs)
    : subtitleOffsetMs();
  const displayAtMs = pendingSubtitle.receivedAtMs + offsetMs;
  const waitMs = Math.max(0, displayAtMs - Date.now());
  if (waitMs <= 0) {
    const next = pendingSubtitle;
    pendingSubtitle = null;
    showSubtitleNow(next.text);
    return;
  }

  showTimer = setTimeout(() => {
    showTimer = null;
    const next = pendingSubtitle;
    pendingSubtitle = null;
    if (next) showSubtitleNow(next.text);
  }, waitMs);
}

function setText(text) {
  const t = (text || '').trim();
  if (!t) {
    clearPendingSubtitle();
    hideSubtitleNow();
    return;
  }

  pendingSubtitle = {
    text,
    receivedAtMs: Date.now(),
    offsetMs: subtitleOffsetMs()
  };
  schedulePendingSubtitle();
}

function hideSubtitleNow() {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (!overlayEl || !textEl) return;
  overlayEl.classList.remove('kami-visible');
  textEl.textContent = '';
}

function scheduleHideSubtitle() {
  if (hideTimer) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideSubtitleNow();
  }, subtitleDurationMs());
}

function showSubtitleNow(text) {
  if (!overlayEl) ensureOverlay({});
  let t = (text || '').trim();
  if (!t) {
    // Empty transcript — hide instead of showing a blank black box.
    hideSubtitleNow();
    return;
  }
  if (t.length > MAX_VISIBLE_CHARS) t = '…' + t.slice(-MAX_VISIBLE_CHARS);
  textEl.textContent = t;
  overlayEl.classList.add('kami-visible');
  positionOverlayOverVideo();
  // Keep visible until the next chunk arrives, instead of fading after 6s —
  scheduleHideSubtitle();
}

function setTranscriptText(msg) {
  const text = msg.text || '';
  const t = text.trim();
  if (!t) {
    // Backend silence/idle clears should not shorten the current subtitle.
    // Visible lifetime is controlled only by the hide timer.
    return;
  }

  const receivedAtMs = Number(msg.receivedAtMs);
  if (msg.sync) currentSyncMetrics = msg.sync;
  const effectiveOffsetMs = Number(msg.effectiveOffsetMs);
  pendingSubtitle = {
    text,
    receivedAtMs: Number.isFinite(receivedAtMs) ? receivedAtMs : Date.now(),
    offsetMs: Number.isFinite(effectiveOffsetMs) ? effectiveOffsetMs : subtitleOffsetMs()
  };
  schedulePendingSubtitle();
}

function showError(msg) {
  clearPendingSubtitle();
  if (!overlayEl) ensureOverlay({});
  textEl.textContent = '⚠ ' + msg;
  overlayEl.classList.add('kami-visible', 'kami-error');
  if (errorTimer) clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    if (overlayEl) overlayEl.classList.remove('kami-error');
    errorTimer = null;
  }, 4000);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;
  switch (msg.type) {
    case 'ping':            sendResponse({ ok: true }); return true;
    case 'overlay:mount':   mount(msg.settings, msg.sync); break;
    case 'overlay:update':  applySettings(msg.settings || {}, msg.sync); positionOverlayOverVideo(); break;
    case 'overlay:unmount': unmount(); break;
    case 'overlay:text':
      if (Number.isFinite(Number(msg.receivedAtMs))) setTranscriptText(msg);
      else {
        clearPendingSubtitle();
        showSubtitleNow(msg.text);
      }
      break;
    case 'overlay:error':   showError(msg.message); break;
  }
});

// If the page loads while capture is already active, restore the overlay.
chrome.storage.local.get(['isCapturing', 'activeTabId', 'settings'], (s) => {
  if (s && s.isCapturing) mount(s.settings || {});
});
