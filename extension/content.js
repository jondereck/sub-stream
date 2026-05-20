// Sub Stream AI — content script
// Mounts a subtitle overlay anchored over the most likely active video element.

const OVERLAY_ID = 'kami-subs-overlay';
const MAX_VISIBLE_CHARS = 180;
const TARGET_SUBTITLE_CARD_CHARS = 92;
const MIN_SUBTITLE_CARD_CHARS = 36;
const READABILITY_BASE_MS = 900;
const READABILITY_MS_PER_CHAR = 45;
const MIN_SUBTITLE_DELAY_MS = -10000;
const MAX_SUBTITLE_DELAY_MS = 10000;
const DEFAULT_SUBTITLE_DURATION_MS = 2600;
const MIN_SUBTITLE_DURATION_MS = 1200;
const MAX_SUBTITLE_DURATION_MS = 8000;
const DEFAULT_TRANSLATION_DISPLAY_MODE = 'translation_replace';
const DEFAULT_TRANSLATION_GRACE_MS = 200;
const TRANSLATION_DISPLAY_MODES = new Set(['translation_replace', 'translation_dual']);
const MAX_SUBTITLE_QUEUE_ITEMS = 80;
const EPOCH_SECONDS_THRESHOLD = 1000000000;
const SUBTITLE_MODE_DELAYS_MS = {
  fast: 0,
  balanced: 150,
  accurate: 350,
};

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
let relativeTimelineBaseMs = null;
let nativeSubtitleTrack = null;
let nativeSubtitleCue = null;
let nativeSubtitleText = '';

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
  const fs = fullscreenElement();
  if (fs && fs.tagName && fs.tagName.toLowerCase() === 'video') {
    return document.documentElement;
  }
  return fs || document.documentElement;
}

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function shouldUseNativeVideoSubtitle() {
  const fs = fullscreenElement();
  return !!(fs && fs.tagName && fs.tagName.toLowerCase() === 'video');
}

function effectiveSubtitlePosition() {
  // Fullscreen video controls and site overlays often cover the bottom edge.
  // Keep fullscreen captions at the top even when the normal page setting is
  // bottom.
  return fullscreenElement() ? 'top' : (currentSettings.position || 'bottom');
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
  overlayEl.setAttribute('dir', 'auto');
  textEl = document.createElement('span');
  textEl.className = 'kami-subs-text';
  textEl.setAttribute('dir', 'auto');
  overlayEl.appendChild(textEl);
  currentOverlayHost().appendChild(overlayEl);
  document.documentElement.classList.add('kami-subs-active');
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

function subtitleDirection(text) {
  return /[\u0590-\u08ff]/.test(text || '') ? 'rtl' : 'ltr';
}

function normalizeSubtitleText(text) {
  const cleaned = (text || '').trim();
  if (!cleaned) return '';
  const match = cleaned.match(/^([.!?。！？؟]+)\s*(\S.*)$/);
  if (!match) return cleaned;

  const leading = match[1];
  const rest = match[2].trim();
  const first = Array.from(rest)[0] || '';
  if (!/[\p{L}\p{N}]/u.test(first) && !`"'([`.includes(first)) return cleaned;
  if (/[.!?。！？؟]$/.test(rest)) return rest;
  return rest + leading[leading.length - 1];
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
  const position = effectiveSubtitlePosition();
  if (position === 'top') {
    overlayEl.style.top = '6vh';
    overlayEl.style.bottom = '';
  } else if (position === 'middle') {
    overlayEl.style.top = '50%';
    overlayEl.style.bottom = '';
    overlayEl.style.transform = 'translate(-50%, -50%)';
  } else {
    overlayEl.style.bottom = '8vh';
    overlayEl.style.top = '';
  }
}

function trackVideo() {
  const previousVideo = trackedVideo;
  trackedVideo = pickPrimaryVideo();
  if (previousVideo !== trackedVideo) {
    clearNativeSubtitle();
    nativeSubtitleTrack = null;
  }
  if (resizeObserver) try { resizeObserver.disconnect(); } catch (e) {}
  if (scrollHandler) {
    window.removeEventListener('scroll', scrollHandler);
    window.removeEventListener('resize', scrollHandler);
    scrollHandler = null;
  }
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
  clearNativeSubtitle();
}

function ensureNativeSubtitleTrack() {
  if (!trackedVideo || !trackedVideo.addTextTrack) return null;
  if (nativeSubtitleTrack) return nativeSubtitleTrack;
  nativeSubtitleTrack = trackedVideo.addTextTrack('captions', 'Sub Stream AI', 'en');
  nativeSubtitleTrack.mode = 'showing';
  return nativeSubtitleTrack;
}

function clearNativeSubtitle() {
  if (nativeSubtitleTrack) {
    try {
      Array.from(nativeSubtitleTrack.cues || []).forEach((cue) => nativeSubtitleTrack.removeCue(cue));
    } catch (e) {}
  }
  nativeSubtitleCue = null;
  nativeSubtitleText = '';
}

function showNativeSubtitle(text) {
  if (!shouldUseNativeVideoSubtitle() || !trackedVideo) {
    clearNativeSubtitle();
    return;
  }
  const track = ensureNativeSubtitleTrack();
  if (!track) return;

  const cleanText = (text || '').trim();
  if (!cleanText) {
    clearNativeSubtitle();
    return;
  }

  const now = Number(trackedVideo.currentTime) || 0;
  if (nativeSubtitleCue && nativeSubtitleText === cleanText && nativeSubtitleCue.endTime > now + 0.25) {
    return;
  }

  clearNativeSubtitle();
  const Cue = window.VTTCue || window.TextTrackCue;
  if (!Cue) return;
  try {
    nativeSubtitleCue = new Cue(Math.max(0, now - 0.05), now + 60, cleanText);
    if ('snapToLines' in nativeSubtitleCue) nativeSubtitleCue.snapToLines = false;
    nativeSubtitleCue.line = nativeCueLinePercent();
    if ('position' in nativeSubtitleCue) nativeSubtitleCue.position = 50;
    if ('size' in nativeSubtitleCue) nativeSubtitleCue.size = 90;
    nativeSubtitleCue.align = 'center';
    nativeSubtitleTrack.addCue(nativeSubtitleCue);
    nativeSubtitleText = cleanText;
  } catch (e) {
    nativeSubtitleCue = null;
    nativeSubtitleText = '';
  }
}

function nativeCueLinePercent() {
  const position = effectiveSubtitlePosition();
  if (position === 'middle') return 50;
  if (position === 'top') return 8;
  return 90;
}

function mount(settings, sync) {
  if (sync) currentSyncMetrics = sync;
  trackVideo();
  if (!trackedVideo) return;
  ensureOverlay(settings);
  startRenderLoop();
}

function unmount() {
  stopRenderLoop();
  activeSubtitle = null;
  subtitleQueue = [];
  relativeTimelineBaseMs = null;
  if (errorTimer) { clearTimeout(errorTimer); errorTimer = null; }
  untrackVideo();
  document.querySelectorAll('#' + OVERLAY_ID).forEach(n => n.remove());
  document.documentElement.classList.remove('kami-subs-active');
  overlayEl = null;
  textEl = null;
}

function subtitleOffsetMs() {
  const autoOffsetS = (currentSyncMetrics && Number(currentSyncMetrics.autoOffsetS)) || 0;
  const manualOffsetMs = Number(currentSettings.subtitleDelayMs) || 0;
  const effectiveMs = (autoOffsetS * 1000) + subtitleModeDelayMs() + manualOffsetMs;
  return Math.max(MIN_SUBTITLE_DELAY_MS, Math.min(MAX_SUBTITLE_DELAY_MS, effectiveMs));
}

function subtitleMode() {
  const mode = String(currentSettings.realtimeLatency || 'balanced').toLowerCase();
  if (mode === 'stable') return 'accurate';
  return Object.prototype.hasOwnProperty.call(SUBTITLE_MODE_DELAYS_MS, mode) ? mode : 'balanced';
}

function subtitleModeDelayMs() {
  return SUBTITLE_MODE_DELAYS_MS[subtitleMode()] || 0;
}

function subtitleDurationMs() {
  const raw = Number(currentSettings.subtitleDurationMs);
  if (!Number.isFinite(raw)) return DEFAULT_SUBTITLE_DURATION_MS;
  return Math.max(MIN_SUBTITLE_DURATION_MS, Math.min(MAX_SUBTITLE_DURATION_MS, raw));
}

function readableDurationMs(text) {
  const length = (text || '').trim().length;
  const estimated = READABILITY_BASE_MS + (length * READABILITY_MS_PER_CHAR);
  return Math.max(subtitleDurationMs(), Math.min(MAX_SUBTITLE_DURATION_MS, estimated));
}

function showSourceFirstEnabled(msg) {
  if (msg && typeof msg.showSourceFirst === 'boolean') return msg.showSourceFirst;
  if (typeof currentSettings.showSourceFirst === 'boolean') return currentSettings.showSourceFirst;
  return true;
}

function translationDisplayMode(msg) {
  const mode = String((msg && msg.translationDisplayMode) || currentSettings.translationDisplayMode || DEFAULT_TRANSLATION_DISPLAY_MODE).toLowerCase();
  return TRANSLATION_DISPLAY_MODES.has(mode) ? mode : DEFAULT_TRANSLATION_DISPLAY_MODE;
}

function translationGraceMs(msg) {
  const raw = Number((msg && msg.translationGraceMs) ?? currentSettings.translationGraceMs);
  if (!Number.isFinite(raw)) return DEFAULT_TRANSLATION_GRACE_MS;
  return Math.max(0, Math.min(2000, raw));
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function timelineSecondsToMs(value, receivedAtMs) {
  const seconds = numberOrNull(value);
  if (seconds === null) return null;

  // Backend currently sends wall-clock seconds. If a future backend sends
  // session-relative seconds, anchor that relative timeline to first receipt.
  if (seconds >= EPOCH_SECONDS_THRESHOLD) return seconds * 1000;
  if (relativeTimelineBaseMs === null) {
    relativeTimelineBaseMs = receivedAtMs - (seconds * 1000);
  }
  return relativeTimelineBaseMs + (seconds * 1000);
}

function hideSubtitleText() {
  if (!overlayEl || !textEl) return;
  overlayEl.classList.remove('kami-visible');
  textEl.textContent = '';
  clearNativeSubtitle();
}

function clearPendingSubtitle() {
  activeSubtitle = null;
  subtitleQueue = [];
  hideSubtitleText();
}

function subtitleStage(msg) {
  const explicit = String((msg && msg.stage) || '').toLowerCase();
  if (explicit === 'translation' || explicit === 'source') return explicit;
  const phase = String((msg && msg.phase) || '').toLowerCase();
  return phase.startsWith('translated') ? 'translation' : 'source';
}

function isTranslationItem(item) {
  return !!item && item.stage === 'translation';
}

function isSourceItem(item) {
  return !!item && item.stage !== 'translation';
}

function segmentGroupId(msg, segmentStartTs, segmentEndTs) {
  if (msg.segmentId) return `segment:${msg.segmentId}`;
  if (msg.captionId) return `caption:${msg.captionId}`;
  if (msg.chunkId != null) return `chunk:${msg.chunkId}`;
  return `time:${Math.round(segmentStartTs)}:${Math.round(segmentEndTs)}`;
}

function displayTextForMessage(msg, text) {
  const stage = subtitleStage(msg);
  const sourceText = normalizeSubtitleText(msg.sourceText || msg.raw || (stage === 'source' ? text : ''));
  const translatedText = normalizeSubtitleText(msg.translatedText || (stage === 'translation' ? text : ''));

  if (stage !== 'translation') return sourceText || normalizeSubtitleText(text);
  if (translationDisplayMode(msg) === 'translation_dual' && sourceText && translatedText && sourceText !== translatedText) {
    return `${sourceText}\n${translatedText}`;
  }
  return translatedText || sourceText || normalizeSubtitleText(text);
}

function sameSubtitle(a, b) {
  if (!a || !b) return false;
  if (a.captionId && b.captionId && a.captionId === b.captionId && a.cardIndex === b.cardIndex) return true;
  if (a.groupId && b.groupId && a.groupId === b.groupId && a.cardIndex === b.cardIndex) return true;
  const sameChunk = a.chunkId != null && b.chunkId != null && String(a.chunkId) === String(b.chunkId);
  const closeStart = Math.abs(a.segmentStartTs - b.segmentStartTs) < 250;
  return sameChunk && a.cardIndex === b.cardIndex || (!a.groupId && !b.groupId && closeStart);
}

function shouldIgnoreEmptyTranscript(msg) {
  return msg && (
    msg.chunkId != null ||
    msg.segmentStartTs != null ||
    msg.segmentEndTs != null ||
    msg.isFinal === true ||
    msg.mode
  );
}

function splitLongText(text) {
  const raw = (text || '').replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (raw.includes('\n') && raw.length <= MAX_VISIBLE_CHARS) return [raw];
  const normalized = raw.replace(/\s+/g, ' ').trim();
  if (normalized.length <= TARGET_SUBTITLE_CARD_CHARS) return [normalized];

  const words = normalized.split(' ');
  if (words.length === 1) {
    const chunks = [];
    for (let i = 0; i < normalized.length; i += TARGET_SUBTITLE_CARD_CHARS) {
      chunks.push(normalized.slice(i, i + TARGET_SUBTITLE_CARD_CHARS).trim());
    }
    return chunks.filter(Boolean);
  }

  const cards = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    const endsSentence = /[.!?。！？؟]$/.test(word);
    if (
      current &&
      (next.length > TARGET_SUBTITLE_CARD_CHARS ||
        (endsSentence && next.length >= MIN_SUBTITLE_CARD_CHARS))
    ) {
      cards.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) cards.push(current);
  return cards.length ? cards : [normalized];
}

function buildSubtitleItems(text, segmentStartTs, segmentEndTs, receivedAt, receivedAtMs, msg) {
  const cards = splitLongText(text);
  const groupId = segmentGroupId(msg, segmentStartTs, segmentEndTs);
  const stage = subtitleStage(msg);
  const readableDurations = cards.map(readableDurationMs);
  const sourceDuration = Math.max(segmentEndTs - segmentStartTs, subtitleDurationMs());
  const scheduleDuration = Math.max(sourceDuration, readableDurations.reduce((sum, value) => sum + value, 0));
  let cursor = segmentStartTs;

  return cards.map((card, index) => {
    const remainingReadable = readableDurations.slice(index).reduce((sum, value) => sum + value, 0);
    const duration = index === cards.length - 1
      ? Math.max(readableDurations[index], segmentStartTs + scheduleDuration - cursor)
      : Math.max(readableDurations[index], (scheduleDuration * readableDurations[index]) / Math.max(remainingReadable, 1));
    const item = {
      text: card,
      segmentStartTs: cursor,
      segmentEndTs: cursor + duration,
      actualShowAt: null,
      receivedAt,
      receivedAtMs,
      chunkId: msg.chunkId,
      captionId: msg.captionId,
      segmentId: msg.segmentId,
      phase: msg.phase,
      stage,
      sourceText: msg.sourceText || msg.raw || '',
      translatedText: msg.translatedText || '',
      transcriptEmittedAt: msg.transcriptEmittedAt,
      translationEmittedAt: msg.translationEmittedAt,
      transcriptToTranslationDelayMs: msg.transcriptToTranslationDelayMs,
      groupId,
      cardIndex: index,
      cardCount: cards.length,
    };
    cursor += duration;
    return item;
  });
}

function enqueueSubtitleItems(items) {
  if (!items.length) return;
  const groupId = items[0].groupId;
  const incomingIsTranslation = isTranslationItem(items[0]);
  const incomingIsSource = isSourceItem(items[0]);
  const queuedMatches = subtitleQueue.filter((item) => item.groupId === groupId);
  const matchedActive = !!(activeSubtitle && activeSubtitle.groupId === groupId);
  const matchedQueued = queuedMatches.length > 0;

  if (incomingIsTranslation) {
    console.debug('[sub-stream-ai overlay] matched segment', {
      segmentId: items[0].segmentId || groupId,
      chunkId: items[0].chunkId,
      matchedActive,
      matchedQueued,
      delayMs: items[0].transcriptToTranslationDelayMs,
    });
  }

  if (activeSubtitle && activeSubtitle.groupId === groupId) {
    if (isTranslationItem(activeSubtitle) && incomingIsSource) {
      return;
    }
    const replacement = items.find((item) => item.cardIndex === activeSubtitle.cardIndex);
    if (replacement) {
      const sourceToTranslation = isSourceItem(activeSubtitle) && isTranslationItem(replacement);
      const graceMs = translationGraceMs();
      const visibleAt = activeSubtitle.actualShowAt || Math.max(Date.now(), activeSubtitle.segmentStartTs + subtitleOffsetMs());
      const replaceAt = visibleAt + graceMs;
      if (sourceToTranslation && showSourceFirstEnabled() && Date.now() < replaceAt) {
        activeSubtitle.pendingReplacement = {
          item: replacement,
          replaceAt,
        };
      } else {
        replacement.actualShowAt = activeSubtitle.actualShowAt;
        activeSubtitle = replacement;
      }
    }
    subtitleQueue = subtitleQueue.filter((item) => item.groupId !== groupId);
    subtitleQueue.push(...items.filter((item) => item.cardIndex > activeSubtitle.cardIndex));
  } else if (incomingIsSource && queuedMatches.some(isTranslationItem)) {
    return;
  } else if (incomingIsTranslation && queuedMatches.some(isSourceItem) && showSourceFirstEnabled() && translationGraceMs() > 0) {
    subtitleQueue = subtitleQueue.filter((item) => item.groupId !== groupId);
    const sourceItems = queuedMatches.filter(isSourceItem);
    for (const sourceItem of sourceItems) {
      const replacement = items.find((item) => item.cardIndex === sourceItem.cardIndex) || items[0];
      sourceItem.pendingReplacement = {
        item: replacement,
        replaceAt: sourceItem.segmentStartTs + subtitleOffsetMs() + translationGraceMs(),
      };
      subtitleQueue.push(sourceItem);
    }
    const sourceCardIndexes = new Set(sourceItems.map((item) => item.cardIndex));
    subtitleQueue.push(...items.filter((item) => !sourceCardIndexes.has(item.cardIndex)));
  } else {
    subtitleQueue = subtitleQueue.filter((item) => item.groupId !== groupId);
    subtitleQueue.push(...items);
  }

  subtitleQueue.sort((a, b) => a.segmentStartTs - b.segmentStartTs);
  while (subtitleQueue.length > MAX_SUBTITLE_QUEUE_ITEMS) subtitleQueue.shift();
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

  // Promote one due item at a time so split subtitles remain readable instead
  // of skipping directly to the last card when a transcript arrives late.
  if (!activeSubtitle && subtitleQueue.length > 0) {
    const next = subtitleQueue[0];
    const showAt = next.segmentStartTs + offsetMs;
    if (now >= showAt) {
      activeSubtitle = subtitleQueue.shift();
      activeSubtitle.actualShowAt = null;
    }
  }

  if (activeSubtitle) {
    if (
      activeSubtitle.pendingReplacement &&
      now >= activeSubtitle.pendingReplacement.replaceAt
    ) {
      const replacement = activeSubtitle.pendingReplacement.item;
      replacement.actualShowAt = activeSubtitle.actualShowAt;
      activeSubtitle = replacement;
    }

    const showAt = activeSubtitle.segmentStartTs + offsetMs;
    let hideAt = activeSubtitle.segmentEndTs + offsetMs;
    const canShow = now >= showAt;
    if (canShow && activeSubtitle.actualShowAt === null) {
      activeSubtitle.actualShowAt = now;
    }
    // Fallback: ensure minimum duration for readability.
    // Manual offset shifts both showAt and hideAt; readability uses actual
    // display time so late arrivals do not instantly disappear.
    const actualShowAt = activeSubtitle.actualShowAt === null ? showAt : activeSubtitle.actualShowAt;
    const minVisibleMs = readableDurationMs(activeSubtitle.text);
    hideAt = Math.max(hideAt, actualShowAt + minVisibleMs);

    if (canShow && now < hideAt) {
      // Within visible window
      let t = normalizeSubtitleText(activeSubtitle.text);
      if (t.length > MAX_VISIBLE_CHARS) t = '…' + t.slice(-MAX_VISIBLE_CHARS);

      if (textEl.textContent !== t) {
        textEl.textContent = t;
        const dir = subtitleDirection(t);
        textEl.setAttribute('dir', dir);
        overlayEl.setAttribute('dir', dir);
      }
      showNativeSubtitle(t);
      if (!overlayEl.classList.contains('kami-visible')) {
        overlayEl.classList.add('kami-visible');
        positionOverlayOverVideo();
      }
    } else {
      // Outside visible window
      if (overlayEl.classList.contains('kami-visible')) hideSubtitleText();
      clearNativeSubtitle();

      // If it's already past the hide time, clear it so we don't keep checking.
      // If now < showAt (due to positive offset), we keep it as activeSubtitle
      // so it will show up when time reaches showAt.
      if (now >= hideAt) {
        activeSubtitle = null;
      }
    }
  } else {
    // No active subtitle
    if (overlayEl.classList.contains('kami-visible')) hideSubtitleText();
    clearNativeSubtitle();
  }
}

function setTranscriptText(msg) {
  const text = (msg.text || '').trim();
  if (msg.sync) currentSyncMetrics = msg.sync;
  const stage = subtitleStage(msg);

  if (stage === 'source' && !showSourceFirstEnabled(msg)) {
    return;
  }

  if (!text) {
    if (shouldIgnoreEmptyTranscript(msg)) return;
    clearPendingSubtitle();
    return;
  }

  const receivedAtMs = Number(msg.receivedAtMs) || Date.now();
  const receivedAt = numberOrNull(msg.receivedAt);

  // Use segment timestamps from backend if available (converted to ms).
  // Otherwise, fallback to arrival time.
  const startFromBackend = timelineSecondsToMs(msg.segmentStartTs, receivedAtMs);
  const endFromBackend = timelineSecondsToMs(msg.segmentEndTs, receivedAtMs);
  let segmentStartTs = startFromBackend === null ? receivedAtMs : startFromBackend;
  let segmentEndTs = endFromBackend === null ? segmentStartTs + subtitleDurationMs() : endFromBackend;
  if (segmentEndTs <= segmentStartTs) {
    segmentEndTs = segmentStartTs + subtitleDurationMs();
  }

  const displayText = displayTextForMessage(msg, text);
  if (!displayText) return;

  if (stage === 'translation') {
    console.debug('[sub-stream-ai overlay] translation emitted', {
      segmentId: msg.segmentId || msg.captionId || msg.chunkId,
      chunkId: msg.chunkId,
      delayMs: msg.transcriptToTranslationDelayMs,
      phase: msg.phase,
    });
  } else {
    console.debug('[sub-stream-ai overlay] transcript emitted', {
      segmentId: msg.segmentId || msg.captionId || msg.chunkId,
      chunkId: msg.chunkId,
      phase: msg.phase,
    });
  }

  enqueueSubtitleItems(buildSubtitleItems(
    displayText,
    segmentStartTs,
    segmentEndTs,
    receivedAt,
    receivedAtMs,
    msg
  ));
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
