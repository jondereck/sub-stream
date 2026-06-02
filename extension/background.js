// Sub Stream AI — background service worker
// Coordinates: popup <-> offscreen (audio capture) <-> content (overlay)
//             popup -> native host (spawns the Python backend)

try { importScripts('subtitle-utils.js'); } catch (e) { /* loaded in tests without importScripts */ }

const OFFSCREEN_DOC = 'offscreen.html';
const NATIVE_HOST   = 'com.kamisubs.host';
const AI_USAGE_KEY = 'aiUsageEstimate';
const CALIBRATIONS_KEY = 'substream.calibrations.v1';
const REALTIME_TRANSLATE_USD_PER_MIN = 0.034;
const SYNC_MODE_AUTO = 'auto';
const SYNC_MODE_MANUAL = 'manual';
const SYNC_MODE_AUTO_LOCAL_WHISPER = 'auto_local_whisper';
const LOCAL_WHISPER_ENGINE = 'local-whisper';
const REALTIME_TRANSCRIBER = 'openai-realtime';
const REALTIME_TRANSLATE_TRANSCRIBER = 'openai-realtime-translate';
const OPENAI_CHUNKED_TRANSCRIBER = 'openai-chunked';
const MIN_AUTO_STEP_CHANGE_MS = 200;
const MIN_CALIBRATION_SAMPLES = 8;
const MIN_CALIBRATION_SAVE_CHANGE_S = 0.1;
const MIN_SUBTITLE_OFFSET_MS = -10000;
const MAX_SUBTITLE_OFFSET_MS = 10000;
const IMPORTED_SUBTITLE_CACHE_KEY = 'substream.importedSubtitleCache.v1';
const IMPORTED_SUBTITLE_BATCH_SIZE = 12;
const IMPORTED_SUBTITLE_BATCH_CHAR_LIMIT = 1800;
const IMPORTED_SUBTITLE_FRAME_DISCOVERY_TIMEOUT_MS = 2500;
const IMPORTED_SUBTITLE_MESSAGE_TIMEOUT_MS = 2000;
const SUBTITLE_CAT_BASE_URL = 'https://www.subtitlecat.com';
const SUBTITLE_CAT_SEARCH_LIMIT = 8;

let activeTabId = null;
let isCapturing = false;
let appState = 'idle';          // idle | starting | running | stopping | error | applying_settings
let wsState = 'idle';           // idle | applying | connecting | connected | error | closed
let backendState = 'unknown';   // unknown | starting | up | down | error | unavailable
let backendInfo = {};           // { pid?, wsUrl?, lastError? }
let nativePort = null;          // chrome.runtime.Port to native host, or null
let syncMetrics = emptySyncMetrics();
let activeSettings = null;
let activeCalibrationKey = null;
let activeCalibrationProfile = null;
let importedSubtitleFrameId = null;
const previousWindowStates = new Map();

function setAppState(nextState) {
  appState = nextState;
}

function errorMessage(err, fallback = 'Something went wrong.') {
  if (!err) return fallback;
  if (typeof err === 'string') return err;
  if (err.message) return err.message;
  if (err.error) return errorMessage(err.error, fallback);
  try {
    const json = JSON.stringify(err);
    return json && json !== '{}' ? json : fallback;
  } catch (e) {
    return fallback;
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripHtmlTags(value) {
  return decodeHtmlEntities(String(value || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function absoluteSubtitleCatUrl(path) {
  if (!path) return SUBTITLE_CAT_BASE_URL;
  if (/^https?:\/\//i.test(path)) return path;
  return new URL(path, `${SUBTITLE_CAT_BASE_URL}/`).toString();
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) for ${url}`);
  }
  return response.text();
}

function emptySyncMetrics() {
  return {
    sampleCount: 0,
    rollingAvgLatencyS: 0,
    recommendedAutoOffsetS: 0,
    persistedAutoOffsetS: 0,
    liveAutoOffsetS: 0,
    autoOffsetS: 0,
    manualOffsetS: 0,
    effectiveOffsetS: 0,
    updatedAt: 0,
    autoSyncOn: false,
  };
}

function syncMode(settings) {
  const value = settings && settings.syncMode;
  if (value === SYNC_MODE_MANUAL) return SYNC_MODE_MANUAL;
  if (value === SYNC_MODE_AUTO || value === SYNC_MODE_AUTO_LOCAL_WHISPER) return SYNC_MODE_AUTO;
  return SYNC_MODE_AUTO;
}

function manualOffsetS(settings) {
  const raw = Number(settings && settings.subtitleDelayMs);
  const offsetMs = Number.isFinite(raw) ? raw : 0;
  return clamp(offsetMs, MIN_SUBTITLE_OFFSET_MS, MAX_SUBTITLE_OFFSET_MS) / 1000;
}

function autoSyncEnabled(settings, backendSync) {
  return (
    localCalibrationEnabled(settings) &&
    backendSync &&
    backendSync.engine === LOCAL_WHISPER_ENGINE
  );
}

function timelineAutoSyncEnabled(settings) {
  return !!(
    settings &&
    syncMode(settings) === SYNC_MODE_AUTO &&
    (
      settings.transcriber === 'local' ||
      settings.transcriber === REALTIME_TRANSCRIBER ||
      settings.transcriber === REALTIME_TRANSLATE_TRANSCRIBER ||
      settings.transcriber === OPENAI_CHUNKED_TRANSCRIBER
    )
  );
}

function localCalibrationEnabled(settings) {
  return !!(
    settings &&
    syncMode(settings) === SYNC_MODE_AUTO &&
    settings.transcriber === 'local'
  );
}

function engineForSettings(settings) {
  return settings && settings.transcriber === 'local' ? LOCAL_WHISPER_ENGINE : settings && settings.transcriber;
}

function translatorForSettings(settings) {
  return 'openai';
}

function calibrationKey(settings) {
  const engine = engineForSettings(settings) || 'default';
  const model = (settings && settings.model) || 'default';
  const device = (settings && settings.device) || 'default';
  return `${engine}:${model}:${device}`;
}

async function loadCalibrationMap() {
  const stored = await chrome.storage.local.get(CALIBRATIONS_KEY);
  return stored[CALIBRATIONS_KEY] || {};
}

async function loadCalibrationProfile(settings) {
  const key = calibrationKey(settings);
  const map = await loadCalibrationMap();
  const profile = map[key] || null;
  activeCalibrationKey = key;
  activeCalibrationProfile = profile;
  syncMetrics = {
    ...syncMetrics,
    persistedAutoOffsetS: localCalibrationEnabled(settings) ? Number(profile && profile.learnedOffsetS) || 0 : 0,
    liveAutoOffsetS: 0,
    autoOffsetS: localCalibrationEnabled(settings) ? Number(profile && profile.learnedOffsetS) || 0 : 0,
  };
  recomputeSyncMetrics(settings);
  return profile;
}

async function ensureCalibrationForSettings(settings) {
  if (!settings) return null;
  const key = calibrationKey(settings);
  if (activeCalibrationKey === key) {
    return activeCalibrationProfile;
  }
  return loadCalibrationProfile(settings);
}

async function saveCalibrationProfile(profile) {
  const map = await loadCalibrationMap();
  map[profile.key] = profile;
  await chrome.storage.local.set({ [CALIBRATIONS_KEY]: map });
  activeCalibrationProfile = profile;
}

function autoSyncOnForSettings(settings) {
  return timelineAutoSyncEnabled(settings);
}

function recomputeSyncMetrics(settings) {
  const manual = manualOffsetS(settings);
  const useAuto = autoSyncOnForSettings(settings);
  const useLocalCalibration = localCalibrationEnabled(settings);
  const persistedAuto = useLocalCalibration ? Number(syncMetrics.persistedAutoOffsetS) || 0 : 0;
  const liveAuto = useLocalCalibration ? Number(syncMetrics.liveAutoOffsetS) || 0 : 0;
  const auto = persistedAuto + liveAuto;
  syncMetrics = {
    ...syncMetrics,
    persistedAutoOffsetS: persistedAuto,
    liveAutoOffsetS: liveAuto,
    autoOffsetS: auto,
    manualOffsetS: manual,
    effectiveOffsetS: clamp(manual + auto, MIN_SUBTITLE_OFFSET_MS / 1000, MAX_SUBTITLE_OFFSET_MS / 1000),
    autoSyncOn: useAuto,
  };
  return syncMetrics;
}

async function persistCalibrationIfNeeded(settings, backendSync, learnedOffsetS) {
  if (!autoSyncEnabled(settings, backendSync)) return;
  const sampleCount = Number(backendSync.sampleCount) || 0;
  if (sampleCount < MIN_CALIBRATION_SAMPLES) return;

  const previous = activeCalibrationProfile;
  if (previous && Math.abs((Number(previous.learnedOffsetS) || 0) - learnedOffsetS) < MIN_CALIBRATION_SAVE_CHANGE_S) {
    return;
  }

  const key = activeCalibrationKey || calibrationKey(settings);
  const profile = {
    key,
    engine: LOCAL_WHISPER_ENGINE,
    whisperModel: (settings && settings.model) || 'default',
    device: (settings && settings.device) || 'default',
    learnedOffsetS,
    lastRollingAvgLatencyS: Number(backendSync.rollingAvgLatencyS) || 0,
    sampleCount,
    updatedAt: Number(backendSync.updatedAt) || Date.now() / 1000,
  };

  await saveCalibrationProfile(profile);
  syncMetrics = {
    ...syncMetrics,
    persistedAutoOffsetS: learnedOffsetS,
    liveAutoOffsetS: 0,
    autoOffsetS: learnedOffsetS,
  };
}

async function updateSyncMetrics(backendSync, settings) {
  if (!backendSync) return recomputeSyncMetrics(settings);

  const recommended = Number(backendSync.recommendedAutoOffsetS);
  const persistedAuto = Number(syncMetrics.persistedAutoOffsetS) || 0;
  let nextLiveAuto = syncMetrics.liveAutoOffsetS;
  if (autoSyncEnabled(settings, backendSync) && Number.isFinite(recommended)) {
    const measuredDelta = recommended - persistedAuto;
    if (Math.abs(measuredDelta - syncMetrics.liveAutoOffsetS) * 1000 >= MIN_AUTO_STEP_CHANGE_MS) {
      nextLiveAuto = measuredDelta;
    }
  } else {
    nextLiveAuto = 0;
  }

  syncMetrics = {
    ...syncMetrics,
    sampleCount: Number(backendSync.sampleCount) || 0,
    rollingAvgLatencyS: Number(backendSync.rollingAvgLatencyS) || 0,
    recommendedAutoOffsetS: Number.isFinite(recommended) ? recommended : 0,
    liveAutoOffsetS: nextLiveAuto,
    updatedAt: Number(backendSync.updatedAt) || Date.now() / 1000,
  };
  if (Number.isFinite(recommended)) {
    await persistCalibrationIfNeeded(settings, backendSync, recommended);
  }
  return recomputeSyncMetrics(settings);
}

function todayKey() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function emptyUsage() {
  return {
    today: todayKey(),
    todayMs: 0,
    totalMs: 0,
    currentMs: 0,
    currentSessionActive: false,
    usdPerMinute: REALTIME_TRANSLATE_USD_PER_MIN,
  };
}

async function readUsage() {
  const stored = await chrome.storage.local.get(AI_USAGE_KEY);
  const usage = { ...emptyUsage(), ...(stored[AI_USAGE_KEY] || {}) };
  if (usage.today !== todayKey()) {
    usage.today = todayKey();
    usage.todayMs = 0;
  }
  usage.usdPerMinute = REALTIME_TRANSLATE_USD_PER_MIN;
  return usage;
}

function usageSnapshot(usage) {
  const currentMs = Number(usage.currentMs) || 0;
  const todayMs = Number(usage.todayMs) || 0;
  const totalMs = Number(usage.totalMs) || 0;
  const msToCost = (ms) => (ms / 60000) * REALTIME_TRANSLATE_USD_PER_MIN;
  return {
    isTracking: !!usage.currentSessionActive,
    currentMs,
    todayMs,
    totalMs,
    currentCostUsd: msToCost(currentMs),
    todayCostUsd: msToCost(todayMs),
    totalCostUsd: msToCost(totalMs),
    usdPerMinute: REALTIME_TRANSLATE_USD_PER_MIN,
  };
}

async function writeUsage(usage) {
  await chrome.storage.local.set({ [AI_USAGE_KEY]: usage });
}

async function startAiUsage(settings) {
  if (
    (settings && settings.transcriber) !== REALTIME_TRANSCRIBER &&
    (settings && settings.transcriber) !== REALTIME_TRANSLATE_TRANSCRIBER
  ) {
    await stopAiUsage();
    return;
  }
  const usage = await readUsage();
  usage.currentMs = 0;
  usage.currentSessionActive = true;
  await writeUsage(usage);
}

async function stopAiUsage() {
  const usage = await readUsage();
  usage.currentMs = 0;
  usage.currentSessionActive = false;
  await writeUsage(usage);
}

async function resetAiUsage() {
  const usage = await readUsage();
  const next = emptyUsage();
  next.currentSessionActive = !!usage.currentSessionActive;
  await writeUsage(next);
}

async function toggleBrowserFullscreen(windowId) {
  if (!windowId) throw new Error('No active browser window found.');
  const win = await chrome.windows.get(windowId);
  if (win.state === 'fullscreen') {
    const previousState = previousWindowStates.get(windowId) || 'maximized';
    previousWindowStates.delete(windowId);
    await chrome.windows.update(windowId, { state: previousState });
    return previousState;
  }

  previousWindowStates.set(windowId, win.state === 'minimized' ? 'normal' : (win.state || 'normal'));
  await chrome.windows.update(windowId, { state: 'fullscreen' });
  return 'fullscreen';
}

async function getAiUsageSnapshot() {
  return usageSnapshot(await readUsage());
}

async function getActiveSettings() {
  if (activeSettings) return activeSettings;
  const stored = await chrome.storage.local.get('settings');
  activeSettings = stored.settings || {};
  return activeSettings;
}

async function addActiveAiUsage(activeMs, transcriber) {
  if (transcriber !== REALTIME_TRANSCRIBER && transcriber !== REALTIME_TRANSLATE_TRANSCRIBER) return;
  const ms = Math.max(0, Number(activeMs) || 0);
  if (!ms) return;
  const usage = await readUsage();
  if (!usage.currentSessionActive) return;
  usage.currentMs = (Number(usage.currentMs) || 0) + ms;
  usage.todayMs = (Number(usage.todayMs) || 0) + ms;
  usage.totalMs = (Number(usage.totalMs) || 0) + ms;
  await writeUsage(usage);
}

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_DOC)]
    });
    return contexts.length > 0;
  }
  return false;
}

async function ensureOffscreen() {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOC,
    reasons: ['USER_MEDIA'],
    justification: 'Capture tab audio for live subtitle generation'
  });
}

async function ensureContentScript(tabId) {
  // First try to ping the content script.
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'ping' });
    return; // already there
  } catch (e) {
    // Not loaded — inject programmatically. Required for tabs opened before
    // the extension was installed/reloaded.
  }
  try {
    await chrome.scripting.insertCSS({
      target: { tabId, allFrames: true },
      files: ['content.css']
    });
  } catch (e) { /* ignore — may already be injected */ }
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['subtitle-utils.js', 'content.js']
  });
}

function parseSubtitleCatSearchResults(html) {
  const matches = String(html || '').matchAll(
    /<tr>\s*<td><a href="([^"]+)">([\s\S]*?)<\/a>\s*(?:\(([^)]*)\))?<\/td>\s*<td>[\s\S]*?<\/td>\s*<td[^>]*>[\s\S]*?<span class="sub-table__metric-value">([\s\S]*?)<\/span><\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/gi
  );
  const results = [];
  for (const match of matches) {
    const detailPath = match[1];
    const title = stripHtmlTags(match[2]);
    if (!detailPath || !title) continue;
    results.push({
      id: detailPath,
      title,
      detailUrl: absoluteSubtitleCatUrl(detailPath),
      sourceNote: stripHtmlTags(match[3] || ''),
      size: stripHtmlTags(match[4] || ''),
      downloads: stripHtmlTags(match[5] || ''),
      languages: stripHtmlTags(match[6] || ''),
      provider: 'subtitlecat',
    });
    if (results.length >= SUBTITLE_CAT_SEARCH_LIMIT) break;
  }
  return results;
}

function parseSubtitleCatOriginalSubtitleUrl(html) {
  const match = String(html || '').match(/translate_from_server_folder\(\s*'[^']*'\s*,\s*'([^']+?-orig\.srt)'\s*,\s*'([^']+)'\s*\)/i);
  if (!match) return null;
  return absoluteSubtitleCatUrl(`${match[2]}${match[1]}`);
}

async function searchSubtitleCat(query) {
  const trimmed = String(query || '').trim();
  if (!trimmed) throw new Error('Search query is required.');
  const url = absoluteSubtitleCatUrl(`/index.php?search=${encodeURIComponent(trimmed)}`);
  const html = await fetchText(url);
  return {
    provider: 'subtitlecat',
    query: trimmed,
    results: parseSubtitleCatSearchResults(html),
  };
}

async function fetchSubtitleCatSubtitle(detailUrl) {
  const resolvedDetailUrl = absoluteSubtitleCatUrl(detailUrl);
  const detailHtml = await fetchText(resolvedDetailUrl);
  const originalSubtitleUrl = parseSubtitleCatOriginalSubtitleUrl(detailHtml);
  if (!originalSubtitleUrl) {
    throw new Error('Could not find an original subtitle file for this result.');
  }
  const subtitleText = await fetchText(originalSubtitleUrl);
  const pathname = new URL(originalSubtitleUrl).pathname;
  const fileName = pathname.split('/').pop() || 'subtitlecat-import.srt';
  return {
    provider: 'subtitlecat',
    detailUrl: resolvedDetailUrl,
    subtitleUrl: originalSubtitleUrl,
    fileName,
    text: subtitleText,
  };
}

async function findImportedSubtitleFrameId(tabId) {
  try {
    const results = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => {
          const videos = Array.from(document.querySelectorAll('video'));
          if (!videos.length) return { hasVideo: false, score: 0 };
          let bestScore = 0;
          for (const video of videos) {
            const rect = typeof video.getBoundingClientRect === 'function'
              ? video.getBoundingClientRect()
              : { width: 0, height: 0 };
            const style = typeof getComputedStyle === 'function' ? getComputedStyle(video) : null;
            const visible = !!(
              rect.width > 0 &&
              rect.height > 0 &&
              style &&
              style.display !== 'none' &&
              style.visibility !== 'hidden' &&
              Number(style.opacity || 1) !== 0
            );
            if (!visible) continue;
            const score = rect.width * rect.height;
            if (score > bestScore) bestScore = score;
          }
          return { hasVideo: bestScore > 0, score: bestScore };
        },
      }),
      IMPORTED_SUBTITLE_FRAME_DISCOVERY_TIMEOUT_MS,
      'Timed out while locating the video frame.'
    );
    let bestFrameId = null;
    let bestScore = -1;
    for (const entry of results || []) {
      const result = entry && entry.result;
      if (!result || !result.hasVideo) continue;
      const score = Number(result.score) || 0;
      if (score > bestScore) {
        bestScore = score;
        bestFrameId = entry.frameId;
      }
    }
    return Number.isInteger(bestFrameId) ? bestFrameId : null;
  } catch (e) {
    return null;
  }
}

async function sendImportedSubtitleMessage(tabId, message, frameId = null) {
  if (Number.isInteger(frameId)) {
    try {
      return await withTimeout(
        chrome.tabs.sendMessage(tabId, message, { frameId }),
        IMPORTED_SUBTITLE_MESSAGE_TIMEOUT_MS,
        'Timed out while contacting the video frame.'
      );
    } catch (error) {
      if (frameId !== 0) {
        return withTimeout(
          chrome.tabs.sendMessage(tabId, message),
          IMPORTED_SUBTITLE_MESSAGE_TIMEOUT_MS,
          'Timed out while mounting imported subtitles.'
        );
      }
      throw error;
    }
  }
  return withTimeout(
    chrome.tabs.sendMessage(tabId, message),
    IMPORTED_SUBTITLE_MESSAGE_TIMEOUT_MS,
    'Timed out while mounting imported subtitles.'
  );
}

// ---- Native Messaging: spawn the Python backend on demand ------------------
//
// Graceful degradation: if the user hasn't installed the native host, every
// Start still works as long as they launched the backend manually. The host
// is a nice-to-have, not a hard dependency.

function connectNative() {
  // chrome.runtime.connectNative is synchronous — failure shows up on the
  // onDisconnect listener with chrome.runtime.lastError set.
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (e) {
    backendState = 'unavailable';
    backendInfo = { lastError: errorMessage(e, 'Native host unavailable.') };
    nativePort = null;
    return false;
  }

  nativePort.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'started':
        backendState = 'up';
        backendInfo = { pid: msg.pid, wsUrl: msg.wsUrl };
        break;
      case 'already_up':
        backendState = 'up';
        backendInfo = { wsUrl: msg.wsUrl, note: 'attached to existing backend' };
        break;
      case 'stopped':
        backendState = 'down';
        backendInfo = {};
        break;
      case 'status':
        backendState = msg.running ? 'up' : 'down';
        backendInfo = { pid: msg.pid || null, wsUrl: msg.wsUrl };
        break;
      case 'error':
        backendState = 'error';
        backendInfo = { lastError: msg.message };
        console.error('[sub-stream-ai native]', msg.message);
        break;
      case 'log':
        // Backend stdout/stderr, surfaced for debugging. Comment out if noisy.
        console.log('[sub-stream-ai backend]', msg.line);
        break;
    }
  });

  nativePort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    if (err) {
      // Most common: "Specified native messaging host not found." — the user
      // hasn't run install.ps1 yet. Mark unavailable so we stop trying.
      backendState = 'unavailable';
      backendInfo = { lastError: err.message || String(err) };
      console.warn('[sub-stream-ai] native host unavailable:', err.message);
    } else if (backendState !== 'down') {
      backendState = 'down';
    }
    nativePort = null;
  });

  return true;
}

async function ensureBackend(settings) {
  // Already attempted and unavailable — don't keep retrying; user will start
  // the backend manually or run install.ps1.
  if (backendState === 'unavailable') return true;
  if (!nativePort) {
    if (!connectNative()) return true;
  }

  // Pull whisper settings off the popup settings object if present.
  const startMsg = {
    type: 'start',
    model:      settings.model      || undefined,
    device:     settings.device     || undefined,
    compute:    settings.compute    || undefined,
    translator: translatorForSettings(settings),
    transcriber: settings.transcriber || undefined,
    chunkDurationMs: settings.chunkDurationMs || undefined,
    maxBufferMs: settings.maxBufferMs || undefined,
    vadSilenceMs: settings.vadSilenceMs || undefined,
    partialEmitEnabled: typeof settings.partialEmitEnabled === 'boolean' ? settings.partialEmitEnabled : undefined,
    translationFlushMs: settings.translationFlushMs || undefined,
    showSourceFirst: typeof settings.showSourceFirst === 'boolean' ? settings.showSourceFirst : undefined,
    translationDisplayMode: settings.translationDisplayMode || undefined,
    translationGraceMs: settings.translationGraceMs || undefined,
    translationMode: settings.translationMode || undefined,
  };
  backendState = 'starting';
  try {
    nativePort.postMessage(startMsg);
  } catch (e) {
    backendState = 'unavailable';
    backendInfo = { lastError: errorMessage(e, 'Could not start backend.') };
    nativePort = null;
    return false;
  }

  // Block startCapture until the backend confirms ready (or errors out).
  // The launcher.py only sends 'started' after the port is actually accepting
  // connections, so 'up' = WS will succeed. Without this wait, the offscreen
  // WS open call races whisper model load (1-4s warm, 10s+ cold large-v3).
  // 60s ceiling matches launcher's deadline.
  await new Promise((resolve) => {
    const t0 = Date.now();
    const tick = setInterval(() => {
      if (
        backendState === 'up' ||
        backendState === 'error' ||
        backendState === 'unavailable' ||
        Date.now() - t0 > 60000
      ) {
        clearInterval(tick);
        resolve();
      }
    }, 150);
  });
  return backendState !== 'error';
}

function stopBackend() {
  if (!nativePort) return;
  try { nativePort.postMessage({ type: 'stop' }); } catch (e) { /* ignore */ }
  try { nativePort.disconnect(); } catch (e) { /* ignore */ }
  nativePort = null;
  backendState = 'down';
}

async function startCapture(tabId, settings) {
  if (appState === 'starting' || appState === 'stopping' || appState === 'applying_settings') {
    throw new Error('Session is already changing state.');
  }
  setAppState('starting');
  activeSettings = settings || {};
  syncMetrics = emptySyncMetrics();
  await loadCalibrationProfile(activeSettings);
  // Best-effort: try to spawn the backend before we start capturing. If the
  // native host isn't installed, fall through — user may have launched it
  // manually, in which case the WS connect still works.
  try {
    const backendOk = await ensureBackend(settings);
    if (!backendOk) {
      const message = backendInfo.lastError || 'Backend failed to start.';
      throw new Error(message);
    }

    // Make sure the overlay is mounted before we start sending transcripts.
    await ensureContentScript(tabId);
    await chrome.tabs.sendMessage(tabId, {
      type: 'overlay:mount',
      settings,
      sync: recomputeSyncMetrics(settings)
    });

    await ensureOffscreen();

    const streamId = await new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
        if (chrome.runtime.lastError) return reject(new Error(errorMessage(chrome.runtime.lastError, 'Could not capture tab audio.')));
        resolve(id);
      });
    });

    await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'start',
      streamId,
      settings
    });

    activeTabId = tabId;
    isCapturing = true;
    wsState = 'connecting';
    await chrome.storage.local.set({ isCapturing: true, activeTabId: tabId });
    await startAiUsage(settings);
    setAppState('running');
  } catch (e) {
    if (await hasOffscreenDocument()) {
      try {
        await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
      } catch (_) { /* ignore cleanup failure */ }
    }
    await stopAiUsage();
    stopBackend();
    isCapturing = false;
    wsState = 'idle';
    activeTabId = null;
    await chrome.storage.local.set({ isCapturing: false, activeTabId: null });
    setAppState('error');
    throw e;
  }
}

async function stopCapture(options = {}) {
  const keepOverlayMounted = !!options.keepOverlayMounted;
  if (appState !== 'applying_settings') setAppState('stopping');
  if (await hasOffscreenDocument()) {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
  }
  await stopAiUsage();
  if (!keepOverlayMounted && activeTabId != null) {
    try {
      await chrome.tabs.sendMessage(activeTabId, { type: 'overlay:unmount' });
    } catch (e) { /* tab may be gone */ }
  }
  // Tear down the backend too — Stop should fully clean up, not leave the
  // Python process running silently. If the user prefers always-on, they can
  // launch server.py manually and we'll attach via 'already_up' next Start.
  stopBackend();
  isCapturing = false;
  wsState = 'idle';
  syncMetrics = emptySyncMetrics();
  activeSettings = null;
  activeCalibrationKey = null;
  activeCalibrationProfile = null;
  await chrome.storage.local.set({ isCapturing: false, activeTabId: null });
  activeTabId = null;
  setAppState('idle');
}

async function applySettings(settings, restartRequired) {
  await chrome.storage.local.set({ settings });
  const previousSettings = activeSettings;
  activeSettings = settings || activeSettings;
  const calibrationChanged =
    !previousSettings ||
    calibrationKey(previousSettings) !== calibrationKey(activeSettings) ||
    syncMode(previousSettings) !== syncMode(activeSettings);
  if (calibrationChanged) {
    await loadCalibrationProfile(activeSettings);
  }
  recomputeSyncMetrics(activeSettings);
  if (!isCapturing || !restartRequired) {
    if (isCapturing) {
      if (settings.transcriber === REALTIME_TRANSCRIBER || settings.transcriber === REALTIME_TRANSLATE_TRANSCRIBER) {
        const usage = await readUsage();
        if (!usage.currentSessionActive) await startAiUsage(settings);
      } else {
        await stopAiUsage();
      }
    }
    if (await hasOffscreenDocument()) {
      try {
        await chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'settings:update',
          settings
        });
      } catch (e) { /* offscreen may not be running */ }
    }
    if (activeTabId != null) {
      try {
        await chrome.tabs.sendMessage(activeTabId, {
          type: 'overlay:update',
          settings,
          sync: recomputeSyncMetrics(settings)
        });
      } catch (e) { /* tab may be gone or content script unavailable */ }
    }
    return { restarted: false };
  }

  const tabId = activeTabId;
  if (tabId == null) return { restarted: false };
  setAppState('applying_settings');
  wsState = 'applying';
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'overlay:text',
      text: 'Applying settings...'
    });
  } catch (e) { /* ignore */ }

  try {
    await stopCapture({ keepOverlayMounted: true });
    await startCapture(tabId, settings);
    return { restarted: true };
  } catch (e) {
    setAppState('error');
    throw e;
  }
}

function importedSubtitleCacheKey(fileHash, settings) {
  const sourceLang = settings.sourceLang || 'auto';
  const targetLang = settings.targetLang || 'en';
  const model = settings.importedSubtitleModel || 'backend-openai';
  return `${fileHash}:${sourceLang}:${targetLang}:${model}`;
}

async function readImportedSubtitleCache() {
  const stored = await chrome.storage.local.get(IMPORTED_SUBTITLE_CACHE_KEY);
  return stored[IMPORTED_SUBTITLE_CACHE_KEY] || {};
}

async function writeImportedSubtitleCache(cache) {
  await chrome.storage.local.set({ [IMPORTED_SUBTITLE_CACHE_KEY]: cache });
}

function backendHttpBaseFromSettings(settings) {
  try {
    const url = new URL(settings.backendUrl || 'ws://127.0.0.1:8765/ws');
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch (e) {
    return 'http://127.0.0.1:8765';
  }
}

async function translateTextViaBackend(text, settings) {
  const response = await fetch(`${backendHttpBaseFromSettings(settings)}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text,
      sourceLang: settings.sourceLang || 'auto',
      targetLang: settings.targetLang || 'en',
      translationMode: settings.translationMode || 'auto',
    }),
  });
  let data = {};
  try { data = await response.json(); } catch (e) {}
  if (!response.ok) throw new Error(errorMessage(data.detail || data.error, 'Backend translation failed.'));
  return String(data.text || '').trim();
}

function makeSubtitleBatches(cues) {
  const batches = [];
  let batch = [];
  let chars = 0;
  for (const cue of cues) {
    const textLength = (cue.originalText || '').length + 8;
    if (
      batch.length &&
      (batch.length >= IMPORTED_SUBTITLE_BATCH_SIZE || chars + textLength > IMPORTED_SUBTITLE_BATCH_CHAR_LIMIT)
    ) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(cue);
    chars += textLength;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function buildBatchTranslationInput(batch) {
  return batch.map((cue, index) => `${index + 1}. ${cue.originalText.replace(/\n+/g, ' / ')}`).join('\n');
}

function splitBatchTranslationOutput(output, expectedCount) {
  const lines = String(output || '')
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:\d+[\).\-\:]|\-\s*)\s*/, '').trim())
    .filter(Boolean);
  return lines.length === expectedCount ? lines : null;
}

async function translateSubtitleBatch(batch, settings) {
  if (!batch.length) return [];
  if (batch.length === 1) {
    return [await translateTextViaBackend(batch[0].originalText, settings)];
  }
  const translatedBatch = await translateTextViaBackend(buildBatchTranslationInput(batch), settings);
  const split = splitBatchTranslationOutput(translatedBatch, batch.length);
  if (split) return split;
  const translated = [];
  for (const cue of batch) {
    translated.push(await translateTextViaBackend(cue.originalText, settings));
  }
  return translated;
}

async function translateImportedSubtitleCues({ fileHash, cues, settings, force }) {
  if (!fileHash) throw new Error('Subtitle file hash is missing.');
  if (!Array.isArray(cues) || cues.length === 0) throw new Error('No subtitle cues to translate.');
  const cacheKey = importedSubtitleCacheKey(fileHash, settings || {});
  const cache = await readImportedSubtitleCache();
  if (!force && cache[cacheKey] && Array.isArray(cache[cacheKey].cues)) {
    return { cues: cache[cacheKey].cues, cacheHit: true, cacheKey };
  }

  const nextCues = cues.map((cue) => ({ ...cue, translatedText: cue.translatedText || '' }));
  for (const batch of makeSubtitleBatches(nextCues)) {
    const translatedTexts = await translateSubtitleBatch(batch, settings || {});
    batch.forEach((cue, index) => {
      cue.translatedText = translatedTexts[index] || cue.originalText;
    });
  }

  cache[cacheKey] = {
    cues: nextCues,
    sourceLang: settings.sourceLang || 'auto',
    targetLang: settings.targetLang || 'en',
    model: settings.importedSubtitleModel || 'backend-openai',
    updatedAt: Date.now(),
  };
  await writeImportedSubtitleCache(cache);
  return { cues: nextCues, cacheHit: false, cacheKey };
}

async function startImportedSubtitles(tabId, cues, settings) {
  if (!tabId) throw new Error('No active tab found.');
  if (isCapturing) {
    await stopCapture();
  }
  await ensureContentScript(tabId);
  const frameId = await findImportedSubtitleFrameId(tabId);
  const response = await sendImportedSubtitleMessage(tabId, {
    type: 'importedSubtitles:start',
    cues,
    settings,
  }, frameId);
  if (response && response.ok === false) throw new Error(response.error || 'Could not start imported subtitles.');
  activeTabId = tabId;
  activeSettings = settings || activeSettings;
  importedSubtitleFrameId = frameId;
  await chrome.storage.local.set({
    importedSubtitlesActive: true,
    importedSubtitlesTabId: tabId,
    importedSubtitlesFrameId: frameId,
  });
  return response || { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || (msg.target && msg.target !== 'background')) return false;

  (async () => {
    try {
      switch (msg.type) {
        case 'capture:start': {
          const tab = msg.tabId
            ? await chrome.tabs.get(msg.tabId)
            : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
          await startCapture(tab.id, msg.settings || {});
          sendResponse({ ok: true });
          break;
        }
        case 'capture:stop': {
          await stopCapture();
          sendResponse({ ok: true });
          break;
        }
        case 'capture:status': {
          const settings = await getActiveSettings();
          await ensureCalibrationForSettings(settings);
          sendResponse({
            appState,
            isCapturing,
            activeTabId,
            wsState,
            backendState,
            backendInfo,
            aiUsage: await getAiUsageSnapshot(),
            sync: recomputeSyncMetrics(settings)
          });
          break;
        }
        case 'aiUsage:reset': {
          await resetAiUsage();
          sendResponse({ ok: true, aiUsage: await getAiUsageSnapshot() });
          break;
        }
        case 'aiUsage:addActiveMs': {
          await addActiveAiUsage(msg.activeMs, msg.transcriber);
          sendResponse({ ok: true });
          break;
        }
        case 'browserFullscreen:toggle': {
          const nextState = await toggleBrowserFullscreen(sender && sender.tab && sender.tab.windowId);
          sendResponse({ ok: true, state: nextState });
          break;
        }
        case 'capture:updateSettings': {
          const settings = msg.settings || {};
          const result = await applySettings(settings, !!msg.restartRequired);
          sendResponse({ ok: true, ...result });
          break;
        }
        case 'importedSubtitles:translate': {
          const result = await translateImportedSubtitleCues({
            fileHash: msg.fileHash,
            cues: msg.cues || [],
            settings: msg.settings || await getActiveSettings(),
            force: !!msg.force,
          });
          sendResponse({ ok: true, ...result });
          break;
        }
        case 'subtitleSearch:search': {
          const provider = String(msg.provider || 'subtitlecat').toLowerCase();
          if (provider !== 'subtitlecat') throw new Error(`Unsupported subtitle provider: ${provider}`);
          const result = await searchSubtitleCat(msg.query || '');
          sendResponse({ ok: true, ...result });
          break;
        }
        case 'subtitleSearch:load': {
          const provider = String(msg.provider || 'subtitlecat').toLowerCase();
          if (provider !== 'subtitlecat') throw new Error(`Unsupported subtitle provider: ${provider}`);
          const result = await fetchSubtitleCatSubtitle(msg.detailUrl || '');
          sendResponse({ ok: true, ...result });
          break;
        }
        case 'importedSubtitles:start': {
          const result = await startImportedSubtitles(msg.tabId, msg.cues || [], msg.settings || {});
          sendResponse({ ok: true, ...result });
          break;
        }
        case 'importedSubtitles:update': {
          const tabId = msg.tabId || activeTabId;
          if (!tabId) throw new Error('No active tab found.');
          await sendImportedSubtitleMessage(tabId, {
            type: 'importedSubtitles:update',
            cues: msg.cues || [],
            settings: msg.settings || {},
          }, Number.isInteger(msg.frameId) ? msg.frameId : importedSubtitleFrameId);
          sendResponse({ ok: true });
          break;
        }
        case 'importedSubtitles:stop': {
          const tabId = msg.tabId || activeTabId;
          if (tabId) {
            try {
              await sendImportedSubtitleMessage(
                tabId,
                { type: 'importedSubtitles:stop' },
                Number.isInteger(msg.frameId) ? msg.frameId : importedSubtitleFrameId
              );
            } catch (e) {}
          }
          importedSubtitleFrameId = null;
          await chrome.storage.local.set({
            importedSubtitlesActive: false,
            importedSubtitlesTabId: null,
            importedSubtitlesFrameId: null,
          });
          sendResponse({ ok: true });
          break;
        }
        case 'ws:state': {
          const previousState = wsState;
          wsState = msg.state;
          if (activeTabId != null && wsState === 'applying') {
            try {
              await chrome.tabs.sendMessage(activeTabId, {
                type: 'overlay:text',
                text: 'Applying subtitle engine...'
              });
            } catch (e) { /* ignore */ }
          } else if (activeTabId != null && previousState === 'applying' && wsState === 'connected') {
            try {
              await chrome.tabs.sendMessage(activeTabId, {
                type: 'overlay:text',
                text: ''
              });
            } catch (e) { /* ignore */ }
          }
          sendResponse({ ok: true });
          break;
        }
        case 'transcript': {
          const receivedAtMs = Date.now();
          const settings = await getActiveSettings();
          const nextSyncMetrics = await updateSyncMetrics(msg.sync, settings);
          // Forward transcript from offscreen -> content script overlay
          if (activeTabId != null) {
            try {
              await chrome.tabs.sendMessage(activeTabId, {
                type: 'overlay:text',
                text: msg.text,
                delta: msg.delta,
                isFinal: msg.isFinal,
                mode: msg.mode,
                stage: msg.stage,
                sourceText: msg.sourceText,
                translatedText: msg.translatedText,
                captionId: msg.captionId,
                segmentId: msg.segmentId,
                phase: msg.phase,
                chunkId: msg.chunkId,
                receivedAt: msg.receivedAt,
                receivedAtMs,
                segmentStartTs: msg.segmentStartTs,
                segmentEndTs: msg.segmentEndTs,
                transcriptEmittedAt: msg.transcriptEmittedAt,
                translationStartedAt: msg.translationStartedAt,
                translationEmittedAt: msg.translationEmittedAt,
                transcriptToTranslationDelayMs: msg.transcriptToTranslationDelayMs,
                showSourceFirst: msg.showSourceFirst,
                translationDisplayMode: msg.translationDisplayMode,
                translationGraceMs: msg.translationGraceMs,
                sync: nextSyncMetrics,
                effectiveOffsetMs: Math.round(nextSyncMetrics.effectiveOffsetS * 1000)
              });
            } catch (e) { /* ignore */ }
          }
          sendResponse({ ok: true });
          break;
        }
        case 'backend:error': {
          wsState = 'error';
          backendInfo = { ...backendInfo, lastError: msg.message };
          if (activeTabId != null) {
            try {
              await chrome.tabs.sendMessage(activeTabId, {
                type: 'overlay:error',
                message: msg.message
              });
            } catch (e) { /* ignore */ }
          }
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'Unknown background message.' });
          break;
      }
    } catch (err) {
      const message = errorMessage(err, 'Sub Stream failed.');
      console.error('[sub-stream-ai bg]', err);
      sendResponse({ ok: false, error: message });
    }
  })();
  return true; // keep channel open for async sendResponse
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === activeTabId) {
    importedSubtitleFrameId = null;
    await stopCapture();
  }
});
