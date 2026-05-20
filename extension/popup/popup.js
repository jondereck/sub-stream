// Sub Stream AI popup controller

const $ = (id) => document.getElementById(id);

const els = {
  toggle: $('toggle'),
  status: $('status'),
  modeStatus: $('modeStatus'),
  toast: $('toast'),
  usageSession: $('usageSession'),
  usageToday: $('usageToday'),
  usageTotal: $('usageTotal'),
  usageMeta: $('usageMeta'),
  resetUsage: $('resetUsage'),
  sourceLang: $('sourceLang'),
  targetLang: $('targetLang'),
  fontSize: $('fontSize'),
  fontSizeVal: $('fontSizeVal'),
  position: $('position'),
  subtitleDelay: $('subtitleDelay'),
  subtitleDelayVal: $('subtitleDelayVal'),
  subtitleDuration: $('subtitleDuration'),
  subtitleDurationVal: $('subtitleDurationVal'),
  resetSubtitleDelay: $('resetSubtitleDelay'),
  syncMode: $('syncMode'),
  syncAutoState: $('syncAutoState'),
  syncMeasuredLag: $('syncMeasuredLag'),
  syncAutoOffset: $('syncAutoOffset'),
  syncSavedOffset: $('syncSavedOffset'),
  syncLiveOffset: $('syncLiveOffset'),
  syncEffectiveOffset: $('syncEffectiveOffset'),
  transcriber: $('transcriber'),
  backendUrl: $('backendUrl'),
  realtimeLatency: $('realtimeLatency'),
  chunkDurationMs: $('chunkDurationMs'),
  maxBufferMs: $('maxBufferMs'),
  vadSilenceMs: $('vadSilenceMs'),
  partialEmitEnabled: $('partialEmitEnabled'),
  translationFlushMs: $('translationFlushMs'),
  model: $('model'),
  device: $('device'),
  apiKey: $('apiKey'),
  saveApiKey: $('saveApiKey'),
  testApiKey: $('testApiKey'),
  clearApiKey: $('clearApiKey'),
  apiKeyStatus: $('apiKeyStatus'),
};

const DEFAULTS = {
  settingsVersion: 13,
  sourceLang: 'auto',
  targetLang: 'en',
  fontSize: 28,
  position: 'bottom',
  subtitleDelayMs: 0,
  subtitleDurationMs: 2600,
  syncMode: 'auto',
  transcriber: 'openai-realtime',
  backendUrl: 'ws://127.0.0.1:8765/ws',
  realtimeLatency: 'balanced',
  chunkDurationMs: 650,
  maxBufferMs: 900,
  vadSilenceMs: 350,
  partialEmitEnabled: true,
  translationFlushMs: 450,
  task: 'translate',
  model: 'base',
  device: 'cpu',
};

const SUBTITLE_MODE_PROFILES = {
  fast: {
    chunkDurationMs: 450,
    maxBufferMs: 650,
    vadSilenceMs: 250,
    partialEmitEnabled: true,
    translationFlushMs: 250,
  },
  balanced: {
    chunkDurationMs: 650,
    maxBufferMs: 900,
    vadSilenceMs: 350,
    partialEmitEnabled: true,
    translationFlushMs: 450,
  },
  accurate: {
    chunkDurationMs: 950,
    maxBufferMs: 1300,
    vadSilenceMs: 800,
    partialEmitEnabled: false,
    translationFlushMs: 900,
  },
};

const LIVE_SETTINGS = new Set([
  'sourceLang',
  'targetLang',
  'fontSize',
  'position',
  'subtitleDelayMs',
  'subtitleDurationMs',
  'syncMode',
  'realtimeLatency',
  'chunkDurationMs',
  'maxBufferMs',
  'vadSilenceMs',
  'partialEmitEnabled',
  'translationFlushMs',
]);
const RESTART_SETTINGS = new Set(['model', 'device']);
const SETTING_FIELDS = [
  'sourceLang',
  'targetLang',
  'fontSize',
  'position',
  'subtitleDelay',
  'subtitleDuration',
  'syncMode',
  'transcriber',
  'backendUrl',
  'realtimeLatency',
  'chunkDurationMs',
  'maxBufferMs',
  'vadSilenceMs',
  'partialEmitEnabled',
  'translationFlushMs',
  'model',
  'device',
];
const MIN_SUBTITLE_OFFSET_MS = -10000;
const MAX_SUBTITLE_OFFSET_MS = 10000;
const MIN_SUBTITLE_DURATION_MS = 1200;
const MAX_SUBTITLE_DURATION_MS = 8000;

let currentSettings = null;
let apiKeyInfo = { configured: false, source: null };
let loadedSettingsVersion = 0;
let toastTimer = null;
let saveDebounceTimer = null;

function computeFor(device) { return device === 'cuda' ? 'int8_float32' : 'int8'; }

function translatorForTranscriber(transcriber) {
  return transcriber === 'local' ? 'local' : 'openai';
}

function normalizeSubtitleMode(value) {
  const mode = String(value || DEFAULTS.realtimeLatency).trim().toLowerCase();
  if (mode === 'stable') return 'accurate';
  return Object.prototype.hasOwnProperty.call(SUBTITLE_MODE_PROFILES, mode)
    ? mode
    : DEFAULTS.realtimeLatency;
}

function subtitleModeProfile(mode) {
  return SUBTITLE_MODE_PROFILES[normalizeSubtitleMode(mode)] || SUBTITLE_MODE_PROFILES.balanced;
}

function applySubtitleModeProfileToForm(mode) {
  const profile = subtitleModeProfile(mode);
  els.chunkDurationMs.value = profile.chunkDurationMs;
  els.maxBufferMs.value = profile.maxBufferMs;
  els.vadSilenceMs.value = profile.vadSilenceMs;
  els.partialEmitEnabled.checked = profile.partialEmitEnabled;
  els.partialEmitEnabled.disabled = true;
  els.translationFlushMs.value = profile.translationFlushMs;
}

function errorMessage(err, fallback = 'Something went wrong.') {
  if (!err) return fallback;
  if (typeof err === 'string') return err;
  if (err.detail) return errorMessage(err.detail, fallback);
  if (err.message && typeof err.message === 'object') return errorMessage(err.message, fallback);
  if (err.message) return err.message;
  if (err.error) return errorMessage(err.error, fallback);
  try {
    const json = JSON.stringify(err);
    return json && json !== '{}' ? json : fallback;
  } catch (e) {
    return fallback;
  }
}

function isBackendOfflineError(err) {
  const message = errorMessage(err, '').toLowerCase();
  return (
    message.includes('failed to fetch') ||
    message.includes('networkerror') ||
    message.includes('load failed') ||
    message.includes('backend offline')
  );
}

function clampSubtitleDelayMs(ms) {
  const value = parseInt(ms, 10);
  if (!Number.isFinite(value)) return 0;
  return Math.max(MIN_SUBTITLE_OFFSET_MS, Math.min(MAX_SUBTITLE_OFFSET_MS, value));
}

function formatSubtitleDelay(ms) {
  const seconds = clampSubtitleDelayMs(ms) / 1000;
  if (seconds === 0) return '0.0s';
  return `${seconds > 0 ? '+' : ''}${seconds.toFixed(1)}s`;
}

function clampSubtitleDurationMs(ms) {
  const value = parseInt(ms, 10);
  if (!Number.isFinite(value)) return DEFAULTS.subtitleDurationMs;
  return Math.max(MIN_SUBTITLE_DURATION_MS, Math.min(MAX_SUBTITLE_DURATION_MS, value));
}

function clampMs(ms, min, max, fallback) {
  const value = parseInt(ms, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function formatSubtitleDuration(ms) {
  return `${(clampSubtitleDurationMs(ms) / 1000).toFixed(1)}s`;
}

function formatSeconds(value) {
  return `${(Number(value) || 0).toFixed(1)}s`;
}

function formatCost(value) {
  return '$' + (Number(value) || 0).toFixed(2);
}

function formatMinutes(ms) {
  return ((Number(ms) || 0) / 60000).toFixed(1);
}

function updateUsage(usage) {
  if (!usage) return;
  els.usageSession.textContent = formatCost(usage.currentCostUsd);
  els.usageToday.textContent = formatCost(usage.todayCostUsd);
  els.usageTotal.textContent = formatCost(usage.totalCostUsd);
  const rate = formatCost(usage.usdPerMinute);
  const todayMin = formatMinutes(usage.todayMs);
  els.usageMeta.textContent = `${todayMin} active min today at ${rate}/min`;
}

function updateSyncMetrics(sync) {
  const metrics = sync || {};
  els.syncAutoState.textContent = metrics.autoSyncOn ? 'On' : 'Off';
  els.syncMeasuredLag.textContent = formatSeconds(metrics.rollingAvgLatencyS);
  els.syncAutoOffset.textContent = formatSubtitleDelay((Number(metrics.autoOffsetS) || 0) * 1000);
  if (els.syncSavedOffset) {
    els.syncSavedOffset.textContent = formatSubtitleDelay((Number(metrics.persistedAutoOffsetS) || 0) * 1000);
  }
  if (els.syncLiveOffset) {
    els.syncLiveOffset.textContent = formatSubtitleDelay((Number(metrics.liveAutoOffsetS) || 0) * 1000);
  }
  els.syncEffectiveOffset.textContent = formatSubtitleDelay((Number(metrics.effectiveOffsetS) || 0) * 1000);
}

function showToast(message, kind = 'ok') {
  if (toastTimer) clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.className = 'toast' + (kind === 'error' ? ' error' : '');
  els.toast.hidden = false;
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
    toastTimer = null;
  }, 2600);
}

async function loadSettings() {
  const stored = await chrome.storage.local.get('settings');
  const saved = stored.settings || {};
  loadedSettingsVersion = saved.settingsVersion || 0;
  const s = { ...DEFAULTS, ...saved };
  if (!saved.settingsVersion && saved.transcriber === 'local') {
    s.transcriber = DEFAULTS.transcriber;
  }
  if ((saved.settingsVersion || 0) < 3 && (!saved.model || saved.model === 'small')) {
    s.model = DEFAULTS.model;
  }
  if ((saved.settingsVersion || 0) < 4) {
    if (!saved.targetLang || saved.targetLang === 'ar') s.targetLang = DEFAULTS.targetLang;
    if (!saved.device || saved.device === 'cuda') {
      s.device = DEFAULTS.device;
      s.compute = computeFor(DEFAULTS.device);
    }
  }
  if (s.transcriber === 'openai') {
    s.transcriber = 'local';
  }
  s.translator = translatorForTranscriber(s.transcriber);
  s.realtimeLatency = normalizeSubtitleMode(s.realtimeLatency);
  if (!Object.prototype.hasOwnProperty.call(saved, 'subtitleDelayMs') && Number.isFinite(Number(saved.audioDelayMs))) {
    s.subtitleDelayMs = saved.audioDelayMs;
  }
  s.subtitleDelayMs = clampSubtitleDelayMs(s.subtitleDelayMs);
  s.subtitleDurationMs = clampSubtitleDurationMs(s.subtitleDurationMs);
  if (s.syncMode === 'auto_local_whisper') {
    s.syncMode = 'auto';
  }
  if (!['manual', 'auto'].includes(s.syncMode)) {
    s.syncMode = DEFAULTS.syncMode;
  }
  if ((saved.settingsVersion || 0) < DEFAULTS.settingsVersion) {
    Object.assign(s, subtitleModeProfile(s.realtimeLatency));
  }
  s.chunkDurationMs = clampMs(s.chunkDurationMs, 250, 5000, DEFAULTS.chunkDurationMs);
  s.maxBufferMs = clampMs(s.maxBufferMs, 250, 10000, DEFAULTS.maxBufferMs);
  s.vadSilenceMs = clampMs(s.vadSilenceMs, 150, 2000, DEFAULTS.vadSilenceMs);
  s.partialEmitEnabled = subtitleModeProfile(s.realtimeLatency).partialEmitEnabled;
  s.translationFlushMs = clampMs(s.translationFlushMs, 150, 3000, DEFAULTS.translationFlushMs);
  s.settingsVersion = DEFAULTS.settingsVersion;
  els.sourceLang.value = s.sourceLang;
  els.targetLang.value = s.targetLang;
  els.fontSize.value = s.fontSize;
  els.fontSizeVal.textContent = s.fontSize;
  els.position.value = s.position;
  els.subtitleDelay.value = s.subtitleDelayMs;
  els.subtitleDelayVal.textContent = formatSubtitleDelay(s.subtitleDelayMs);
  els.subtitleDuration.value = s.subtitleDurationMs;
  els.subtitleDurationVal.textContent = formatSubtitleDuration(s.subtitleDurationMs);
  els.syncMode.value = s.syncMode;
  els.transcriber.value = s.transcriber;
  els.backendUrl.value = s.backendUrl;
  els.realtimeLatency.value = s.realtimeLatency;
  els.chunkDurationMs.value = s.chunkDurationMs;
  els.maxBufferMs.value = s.maxBufferMs;
  els.vadSilenceMs.value = s.vadSilenceMs;
  els.partialEmitEnabled.checked = s.partialEmitEnabled;
  els.partialEmitEnabled.disabled = true;
  els.translationFlushMs.value = s.translationFlushMs;
  els.model.value = s.model;
  els.device.value = s.device;
  currentSettings = s;
  return s;
}

function readSettingsFromForm() {
  const device = els.device.value;
  const realtimeLatency = normalizeSubtitleMode(els.realtimeLatency.value);
  const modeProfile = subtitleModeProfile(realtimeLatency);
  return {
    settingsVersion: DEFAULTS.settingsVersion,
    sourceLang: els.sourceLang.value,
    targetLang: els.targetLang.value,
    fontSize: parseInt(els.fontSize.value, 10),
    position: els.position.value,
    subtitleDelayMs: clampSubtitleDelayMs(els.subtitleDelay.value),
    subtitleDurationMs: clampSubtitleDurationMs(els.subtitleDuration.value),
    syncMode: els.syncMode.value === 'manual' ? 'manual' : 'auto',
    transcriber: els.transcriber.value,
    translator: translatorForTranscriber(els.transcriber.value),
    backendUrl: els.backendUrl.value.trim() || DEFAULTS.backendUrl,
    realtimeLatency,
    chunkDurationMs: clampMs(els.chunkDurationMs.value, 250, 5000, DEFAULTS.chunkDurationMs),
    maxBufferMs: clampMs(els.maxBufferMs.value, 250, 10000, DEFAULTS.maxBufferMs),
    vadSilenceMs: clampMs(els.vadSilenceMs.value, 150, 2000, DEFAULTS.vadSilenceMs),
    partialEmitEnabled: modeProfile.partialEmitEnabled,
    translationFlushMs: clampMs(els.translationFlushMs.value, 150, 3000, DEFAULTS.translationFlushMs),
    task: 'translate',
    model: els.model.value,
    device,
    compute: computeFor(device),
  };
}

async function saveSettings() {
  const s = readSettingsFromForm();
  await chrome.storage.local.set({ settings: s });
  currentSettings = s;
  return s;
}

function changedSettingKeys(prev, next) {
  const before = prev || DEFAULTS;
  return Object.keys(next).filter((key) => before[key] !== next[key]);
}

function changeNeedsRestart(keys) {
  return keys.some((key) => RESTART_SETTINGS.has(key));
}

async function saveAndBroadcastSettings(options = {}) {
  const previous = currentSettings;
  const settings = await saveSettings();
  const changedKeys = changedSettingKeys(previous, settings);
  const restartRequired = options.restartRequired ?? changeNeedsRestart(changedKeys);
  if (!changedKeys.length && !options.force) return { ok: true, skipped: true };

  try {
    const res = await chrome.runtime.sendMessage({
      target: 'background',
      type: 'capture:updateSettings',
      settings,
      restartRequired,
    });
    if (res && !res.ok) throw new Error(errorMessage(res.error, 'Failed to apply settings'));
    if (restartRequired && res && res.restarted) showToast('New settings applied');
    else if (restartRequired) showToast('Settings saved');
    else if (changedKeys.some((key) => LIVE_SETTINGS.has(key))) showToast('Settings applied');
    return res || { ok: true };
  } catch (e) {
    showToast(errorMessage(e, 'Failed to apply settings'), 'error');
    throw e;
  }
}

function setStatus(text, kind) {
  els.status.textContent = text;
  els.status.className = 'status ' + (kind || 'idle');
}

function setModeStatus(text, kind = 'idle') {
  els.modeStatus.textContent = text;
  els.modeStatus.className = 'mode-status ' + kind;
}

function apiKeySourceText(info = apiKeyInfo) {
  if (!info.configured) return 'API key required';
  const masked = info.masked ? ` (${info.masked})` : '';
  if (info.source === '.env' || info.source === 'env') return `.env key active${masked}`;
  if (info.source === 'saved_settings' || info.source === 'stored') return `Saved key active${masked}`;
  return `API key active${masked}`;
}

function renderModeStatus(res = {}) {
  if (res.isCapturing && currentSettings && currentSettings.transcriber === 'openai-realtime') {
    if (res.wsState === 'connected') return setModeStatus('Realtime connected', 'ready');
    if (res.wsState === 'error' || res.wsState === 'closed') return setModeStatus('Realtime connection failed', 'error');
  }

  if (!currentSettings) return setModeStatus('Checking engine...', 'idle');
  if (currentSettings.transcriber === 'openai-realtime') {
    return apiKeyInfo.configured
      ? setModeStatus('Realtime Cloud ready', 'ready')
      : setModeStatus('API key required', 'warn');
  }
  if (currentSettings.transcriber === 'openai-chunked') {
    return apiKeyInfo.configured
      ? setModeStatus('OpenAI Chunked ready', 'ready')
      : setModeStatus('API key required', 'warn');
  }
  return setModeStatus('Local Whisper, no API key', 'ready');
}

function shortBackendError(info) {
  const msg = (info && info.lastError) || '';
  if (/Backend already running/i.test(msg)) {
    return 'Backend settings mismatch. Stop backend and restart.';
  }
  return msg || 'Backend failed to start.';
}

function setToggleLoading(text, stopMode = false) {
  els.toggle.innerHTML = `<span class="spinner" aria-hidden="true"></span>${text}`;
  els.toggle.disabled = true;
  els.toggle.classList.toggle('stop', stopMode);
}

function setControlsDisabled(disabled) {
  SETTING_FIELDS.forEach((key) => {
    if (els[key]) els[key].disabled = key === 'partialEmitEnabled' ? true : disabled;
  });
  els.resetSubtitleDelay.disabled = disabled;
}

function renderSessionState(res) {
  const appState = res.appState || (res.isCapturing ? 'running' : 'idle');
  const isCritical = ['starting', 'stopping', 'applying_settings'].includes(appState);
  setControlsDisabled(isCritical);
  renderModeStatus(res);

  if (appState === 'starting') {
    setToggleLoading('Starting...', false);
    setStatus(currentSettings && currentSettings.transcriber === 'openai-realtime' ? 'Connecting to Realtime...' : (res.backendState === 'starting' ? 'Connecting to backend...' : 'Capturing tab audio...'), 'starting');
    return;
  }
  if (appState === 'stopping') {
    setToggleLoading('Stopping...', true);
    setStatus('Stopping session...', 'starting');
    return;
  }
  if (appState === 'applying_settings' || res.wsState === 'applying') {
    setToggleLoading('Applying...', true);
    setStatus('Applying settings...', 'starting');
    return;
  }

  els.toggle.disabled = false;
  els.toggle.innerHTML = res.isCapturing ? 'Stop' : 'Start';
  els.toggle.classList.toggle('stop', !!res.isCapturing);

  if (res.isCapturing) {
    switch (res.wsState) {
      case 'connected':  setStatus('Status: Streaming', 'live'); break;
      case 'connecting': setStatus('Status: Connecting', 'starting'); break;
      case 'error':
      case 'closed':     setStatus('Status: Backend offline', 'error'); break;
      default:           setStatus('Status: Capturing tab audio', 'starting');
    }
    return;
  }

  if (res.backendState === 'error') {
    setStatus(shortBackendError(res.backendInfo), 'error');
  } else {
    setStatus('Status: Idle', 'idle');
  }
}

async function refresh() {
  const res = await chrome.runtime.sendMessage({ target: 'background', type: 'capture:status' });
  if (!res) return;
  updateUsage(res.aiUsage);
  updateSyncMetrics(res.sync);
  renderSessionState(res);
}

function backendHttpBase() {
  const settings = readSettingsFromForm();
  try {
    const url = new URL(settings.backendUrl);
    url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch (e) {
    return 'http://127.0.0.1:8765';
  }
}

async function fetchBackend(path, options = {}) {
  const res = await fetch(`${backendHttpBase()}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error(errorMessage(data.detail || data.error, 'Backend request failed'));
  return data;
}

async function refreshApiKeyStatus() {
  try {
    const data = await fetchBackend('/settings/api-key');
    apiKeyInfo = {
      configured: !!data.configured,
      source: data.source || null,
      masked: data.masked || null,
    };
    els.apiKeyStatus.textContent = apiKeySourceText(apiKeyInfo);
    if (loadedSettingsVersion > 0 && loadedSettingsVersion < 9 && currentSettings) {
      const nextTranscriber = apiKeyInfo.configured ? 'openai-realtime' : 'local';
      if (currentSettings.transcriber !== nextTranscriber) {
        els.transcriber.value = nextTranscriber;
        await saveSettings();
      }
      loadedSettingsVersion = DEFAULTS.settingsVersion;
    }
    renderModeStatus();
  } catch (e) {
    apiKeyInfo = { configured: false, source: null };
    els.apiKeyStatus.textContent = 'Backend offline';
    renderModeStatus();
  }
}

async function saveApiKey() {
  const apiKey = els.apiKey.value.trim();
  if (!apiKey) {
    els.apiKeyStatus.textContent = 'API key is empty or whitespace';
    return;
  }
  els.saveApiKey.disabled = true;
  els.apiKeyStatus.textContent = 'Saving and testing key...';
  try {
    const data = await fetchBackend('/settings/api-key', {
      method: 'POST',
      body: JSON.stringify({ apiKey, test: true }),
    });
    els.apiKey.value = '';
    await refreshApiKeyStatus();
    showToast(data.message || 'API key saved');
  } catch (e) {
    const message = isBackendOfflineError(e) ? 'Backend offline' : errorMessage(e, 'API key validation failed');
    els.apiKeyStatus.textContent = message;
    showToast(message, 'error');
  } finally {
    els.saveApiKey.disabled = false;
  }
}

async function testApiKey() {
  const rawApiKey = els.apiKey.value;
  const apiKey = rawApiKey.trim();
  if (!apiKey && rawApiKey.length > 0) {
    els.apiKeyStatus.textContent = 'API key is empty or whitespace';
    return;
  }
  els.testApiKey.disabled = true;
  els.apiKeyStatus.textContent = apiKey ? 'Saving and testing key...' : 'Testing saved backend key...';
  try {
    const data = await fetchBackend('/settings/api-key/test', {
      method: 'POST',
      body: JSON.stringify({ apiKey: apiKey || null }),
    });
    if (apiKey) els.apiKey.value = '';
    apiKeyInfo = {
      configured: true,
      source: data.source || apiKeyInfo.source,
      masked: data.masked || apiKeyInfo.masked,
    };
    els.apiKeyStatus.textContent = data.message || 'Connection successful';
    showToast(data.message || 'Connection successful');
  } catch (e) {
    const message = isBackendOfflineError(e) ? 'Backend offline' : errorMessage(e, 'API key validation failed');
    els.apiKeyStatus.textContent = message;
    showToast(message, 'error');
  } finally {
    els.testApiKey.disabled = false;
  }
}

async function clearApiKey() {
  els.clearApiKey.disabled = true;
  els.apiKeyStatus.textContent = 'Clearing saved key...';
  try {
    const data = await fetchBackend('/settings/api-key', { method: 'DELETE' });
    els.apiKey.value = '';
    apiKeyInfo = {
      configured: !!data.configured,
      source: data.source || null,
      masked: data.masked || null,
    };
    els.apiKeyStatus.textContent = apiKeySourceText(apiKeyInfo);
    showToast(data.message || 'Saved API key cleared');
    renderModeStatus();
  } catch (e) {
    const message = isBackendOfflineError(e) ? 'Backend offline' : errorMessage(e, 'Failed to clear saved key');
    els.apiKeyStatus.textContent = message;
    showToast(message, 'error');
  } finally {
    els.clearApiKey.disabled = false;
  }
}

// Poll while popup is open so status reflects WS state changes in real time.
setInterval(refresh, 1000);

async function onToggle() {
  if (['openai-realtime', 'openai-chunked'].includes(els.transcriber.value) && !apiKeyInfo.configured) {
    els.transcriber.value = 'local';
    showToast('Using Local Whisper fallback', 'error');
  }
  const settings = await saveSettings();
  const status = await chrome.runtime.sendMessage({ target: 'background', type: 'capture:status' });
  if (status && status.isCapturing) {
    setToggleLoading('Stopping...', true);
    setStatus('Stopping session...', 'starting');
    await chrome.runtime.sendMessage({ target: 'background', type: 'capture:stop' });
  } else {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length) return setStatus('No active tab', 'error');
    setToggleLoading('Starting...', false);
    setStatus('Starting transcription...', 'starting');
    const res = await chrome.runtime.sendMessage({
      target: 'background',
      type: 'capture:start',
      tabId: tabs[0].id,
      settings,
    });
    if (res && !res.ok) {
      const message = errorMessage(res.error, 'Failed to start');
      setStatus(message, 'error');
      showToast(message, 'error');
    }
  }
  await refresh();
}

function debounceSettingsApply(restartRequired) {
  if (saveDebounceTimer) clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => {
    saveDebounceTimer = null;
    saveAndBroadcastSettings({ restartRequired }).catch(() => {});
  }, restartRequired ? 450 : 180);
}

els.fontSize.addEventListener('input', () => {
  els.fontSizeVal.textContent = els.fontSize.value;
  debounceSettingsApply(false);
});
els.subtitleDelay.addEventListener('input', () => {
  els.subtitleDelayVal.textContent = formatSubtitleDelay(els.subtitleDelay.value);
  debounceSettingsApply(false);
});
els.subtitleDuration.addEventListener('input', () => {
  els.subtitleDurationVal.textContent = formatSubtitleDuration(els.subtitleDuration.value);
  debounceSettingsApply(false);
});
els.syncMode.addEventListener('change', () => {
  debounceSettingsApply(false);
});
els.resetSubtitleDelay.addEventListener('click', () => {
  els.subtitleDelay.value = '0';
  els.subtitleDelayVal.textContent = formatSubtitleDelay(0);
  saveAndBroadcastSettings({ restartRequired: false, force: true }).catch(() => {});
});
els.position.addEventListener('change', () => {
  saveAndBroadcastSettings({ restartRequired: false }).catch(() => {});
});
els.realtimeLatency.addEventListener('change', () => {
  els.realtimeLatency.value = normalizeSubtitleMode(els.realtimeLatency.value);
  applySubtitleModeProfileToForm(els.realtimeLatency.value);
  saveAndBroadcastSettings({ restartRequired: false }).catch(() => {});
});
['chunkDurationMs', 'maxBufferMs', 'vadSilenceMs', 'translationFlushMs'].forEach((key) => {
  els[key].addEventListener('change', () => {
    saveAndBroadcastSettings({ restartRequired: false }).catch(() => {});
  });
});
els.partialEmitEnabled.addEventListener('change', () => {
  saveAndBroadcastSettings({ restartRequired: false }).catch(() => {});
});
['sourceLang', 'targetLang'].forEach((key) => {
  els[key].addEventListener('change', () => {
    saveAndBroadcastSettings({ restartRequired: false }).catch(() => {});
  });
});
['transcriber', 'backendUrl'].forEach((key) => {
  els[key].addEventListener('change', () => {
    showToast('Applying new settings...');
    debounceSettingsApply(false);
  });
});
['model', 'device'].forEach((key) => {
  els[key].addEventListener('change', () => {
    showToast('Applying new settings...');
    debounceSettingsApply(true);
  });
});
els.toggle.addEventListener('click', onToggle);
els.resetUsage.addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ target: 'background', type: 'aiUsage:reset' });
  if (res && res.aiUsage) updateUsage(res.aiUsage);
});
els.saveApiKey.addEventListener('click', saveApiKey);
els.testApiKey.addEventListener('click', testApiKey);
els.clearApiKey.addEventListener('click', clearApiKey);

loadSettings().then(async () => {
  await refresh();
  await refreshApiKeyStatus();
});
