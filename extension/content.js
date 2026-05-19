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
let errorTimer = null;
let activeSubtitle = null;
let subtitleQueue = [];
let renderLoopId = null;
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
  startRenderLoop();
}

function unmount() {
  stopRenderLoop();
  activeSubtitle = null;
  subtitleQueue = [];
  if (errorTimer) { clearTimeout(errorTimer); errorTimer = null; }
  untrackVideo();
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

function startRenderLoop() {
  if (renderLoopId) return;
  renderLoopId = requestAnimationFrame(renderLoop);
}

function stopRenderLoop() {
  if (renderLoopId) {
    cancelAnimationFrame(renderLoopId);
    renderLoopId = null;
  }
}

function renderLoop() {
  updateSubtitles();
  renderLoopId = requestAnimationFrame(renderLoop);
}

function updateSubtitles() {
  if (!overlayEl || !textEl) return;

  const now = Date.now();
  const offsetMs = subtitleOffsetMs();
  const minVisibleMs = MIN_SUBTITLE_DURATION_MS;

  // 1. Process Queue: promote pending to active if it's time to show.
  // We consume all items in the queue that have already passed their showAt time,
  // leaving only the most recent one as activeSubtitle.
  while (subtitleQueue.length > 0) {
    const next = subtitleQueue[0];
    const showAt = next.segmentStartTs + offsetMs;
    if (now >= showAt) {
      activeSubtitle = subtitleQueue.shift();
    } else {
      break;
    }
  }

  // 2. Decide if active should be visible
  if (activeSubtitle) {
    const showAt = activeSubtitle.segmentStartTs + offsetMs;
    let hideAt = activeSubtitle.segmentEndTs + offsetMs;
    // Fallback: ensure minimum duration
    hideAt = Math.max(hideAt, showAt + minVisibleMs);

    if (now >= showAt && now < hideAt) {
      // Within visible window
      let t = (activeSubtitle.text || '').trim();
      if (t.length > MAX_VISIBLE_CHARS) t = '…' + t.slice(-MAX_VISIBLE_CHARS);

      if (textEl.textContent !== t) {
        textEl.textContent = t;
      }
      if (!overlayEl.classList.contains('kami-visible')) {
        overlayEl.classList.add('kami-visible');
        positionOverlayOverVideo();
      }
    } else {
      // Outside visible window (either expired or pushed into future by offset)
      if (overlayEl.classList.contains('kami-visible')) {
        overlayEl.classList.remove('kami-visible');
        textEl.textContent = '';
      }

      if (now >= hideAt) {
        activeSubtitle = null;
      }
    }
  } else {
    // No active subtitle
    if (overlayEl.classList.contains('kami-visible')) {
      overlayEl.classList.remove('kami-visible');
      textEl.textContent = '';
    }
  }
}

function setTranscriptText(msg) {
  const text = (msg.text || '').trim();
  if (msg.sync) currentSyncMetrics = msg.sync;

  if (!text) return;

  const receivedAtMs = Number(msg.receivedAtMs) || Date.now();

  // Use segment timestamps if available, otherwise derive from receivedAtMs
  let segmentStartTs = msg.segmentStartTs ? msg.segmentStartTs * 1000 : receivedAtMs;
  let segmentEndTs = msg.segmentEndTs ? msg.segmentEndTs * 1000 : segmentStartTs + subtitleDurationMs();

  const item = {
    text,
    segmentStartTs,
    segmentEndTs,
    receivedAtMs
  };

  // If this is an update to the current active subtitle or the latest queued one, replace it.
  // We use a 200ms threshold to identify "same" segments from potentially slightly varied timestamps.
  let replaced = false;
  if (activeSubtitle && Math.abs(activeSubtitle.segmentStartTs - segmentStartTs) < 200) {
    activeSubtitle = item;
    replaced = true;
  } else if (subtitleQueue.length > 0) {
    const last = subtitleQueue[subtitleQueue.length - 1];
    if (Math.abs(last.segmentStartTs - segmentStartTs) < 200) {
      subtitleQueue[subtitleQueue.length - 1] = item;
      replaced = true;
    }
  }

  if (!replaced) {
    subtitleQueue.push(item);
    // Sort to ensure timeline order even if backend sends chunks slightly out of order
    subtitleQueue.sort((a, b) => a.segmentStartTs - b.segmentStartTs);
  }

  // Keep queue small
  if (subtitleQueue.length > 5) subtitleQueue.shift();
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
      setTranscriptText(msg);
      break;
    case 'overlay:error':   showError(msg.message); break;
  }
});

// If the page loads while capture is already active, restore the overlay.
chrome.storage.local.get(['isCapturing', 'activeTabId', 'settings'], (s) => {
  if (s && s.isCapturing) mount(s.settings || {});
});
