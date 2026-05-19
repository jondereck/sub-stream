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
  audioDelay: $('audioDelay'),
  audioDelayVal: $('audioDelayVal'),
  transcriber: $('transcriber'),
  backendUrl: $('backendUrl'),
  realtimeLatency: $('realtimeLatency'),
  model: $('model'),
  device: $('device'),
  apiKey: $('apiKey'),
  saveApiKey: $('saveApiKey'),
  testApiKey: $('testApiKey'),
  apiKeyStatus: $('apiKeyStatus'),
};

const DEFAULTS = {
  settingsVersion: 5,
  sourceLang: 'auto',
  targetLang: 'en',
  fontSize: 28,
  position: 'bottom',
  audioDelayMs: 0,
  transcriber: 'openai-realtime',
  backendUrl: 'ws://127.0.0.1:8765/ws',
  realtimeLatency: 'balanced',
  task: 'translate',
  model: 'base',
  device: 'cpu',
};

const LIVE_SETTINGS = new Set(['fontSize', 'position', 'audioDelayMs', 'realtimeLatency']);
const RESTART_SETTINGS = new Set(['sourceLang', 'targetLang', 'transcriber', 'backendUrl', 'model', 'device']);
const SETTING_FIELDS = ['sourceLang', 'targetLang', 'fontSize', 'position', 'audioDelay', 'transcriber', 'backendUrl', 'realtimeLatency', 'model', 'device'];

let currentSettings = null;
let apiKeyInfo = { configured: false, source: null };
let loadedSettingsVersion = 0;
let toastTimer = null;
let saveDebounceTimer = null;

function computeFor(device) { return device === 'cuda' ? 'int8_float32' : 'int8'; }

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

function isBackendOfflineError(err) {
  const message = errorMessage(err, '').toLowerCase();
  return (
    message.includes('failed to fetch') ||
    message.includes('networkerror') ||
    message.includes('load failed') ||
    message.includes('backend offline')
  );
}

function formatDelay(ms) {
  return (Math.max(0, parseInt(ms, 10) || 0) / 1000).toFixed(1);
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
  if (!['fast', 'balanced', 'stable'].includes(s.realtimeLatency)) {
    s.realtimeLatency = DEFAULTS.realtimeLatency;
  }
  s.settingsVersion = DEFAULTS.settingsVersion;
  els.sourceLang.value = s.sourceLang;
  els.targetLang.value = s.targetLang;
  els.fontSize.value = s.fontSize;
  els.fontSizeVal.textContent = s.fontSize;
  els.position.value = s.position;
  els.audioDelay.value = s.audioDelayMs;
  els.audioDelayVal.textContent = formatDelay(s.audioDelayMs);
  els.transcriber.value = s.transcriber;
  els.backendUrl.value = s.backendUrl;
  els.realtimeLatency.value = s.realtimeLatency;
  els.model.value = s.model;
  els.device.value = s.device;
  currentSettings = s;
  return s;
}

function readSettingsFromForm() {
  const device = els.device.value;
  return {
    settingsVersion: DEFAULTS.settingsVersion,
    sourceLang: els.sourceLang.value,
    targetLang: els.targetLang.value,
    fontSize: parseInt(els.fontSize.value, 10),
    position: els.position.value,
    audioDelayMs: parseInt(els.audioDelay.value, 10) || 0,
    transcriber: els.transcriber.value,
    backendUrl: els.backendUrl.value.trim() || DEFAULTS.backendUrl,
    realtimeLatency: els.realtimeLatency.value,
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
  if (info.source === 'env') return '.env key active';
  if (info.source === 'stored') return 'Saved key active';
  return 'API key active';
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
  return setModeStatus(apiKeyInfo.configured ? 'Using Local Whisper fallback' : 'Using Local Whisper fallback', 'warn');
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
    if (els[key]) els[key].disabled = disabled;
  });
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
    };
    els.apiKeyStatus.textContent = apiKeySourceText(apiKeyInfo);
    if (loadedSettingsVersion < DEFAULTS.settingsVersion && currentSettings) {
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
    els.apiKeyStatus.textContent = 'Enter an API key first';
    return;
  }
  els.saveApiKey.disabled = true;
  els.apiKeyStatus.textContent = 'Validating key...';
  try {
    await fetchBackend('/settings/api-key', {
      method: 'POST',
      body: JSON.stringify({ apiKey, test: true }),
    });
    els.apiKey.value = '';
    await refreshApiKeyStatus();
    showToast('API key saved');
  } catch (e) {
    const message = isBackendOfflineError(e) ? 'Backend offline' : 'API key validation failed';
    els.apiKeyStatus.textContent = message;
    showToast(message, 'error');
  } finally {
    els.saveApiKey.disabled = false;
  }
}

async function testApiKey() {
  const apiKey = els.apiKey.value.trim();
  if (!apiKey) {
    els.apiKeyStatus.textContent = 'Enter an API key first';
    showToast('Enter an API key first', 'error');
    return;
  }
  els.testApiKey.disabled = true;
  els.apiKeyStatus.textContent = 'Testing connection...';
  try {
    await fetchBackend('/settings/api-key/test', {
      method: 'POST',
      body: JSON.stringify({ apiKey }),
    });
    els.apiKeyStatus.textContent = 'Connection successful';
    showToast('Connection successful');
  } catch (e) {
    const message = isBackendOfflineError(e) ? 'Backend offline' : 'API key validation failed';
    els.apiKeyStatus.textContent = message;
    showToast(message, 'error');
  } finally {
    els.testApiKey.disabled = false;
  }
}

// Poll while popup is open so status reflects WS state changes in real time.
setInterval(refresh, 1000);

async function onToggle() {
  if (els.transcriber.value === 'openai-realtime' && !apiKeyInfo.configured) {
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
els.audioDelay.addEventListener('input', () => {
  els.audioDelayVal.textContent = formatDelay(els.audioDelay.value);
  debounceSettingsApply(false);
});
els.position.addEventListener('change', () => {
  saveAndBroadcastSettings({ restartRequired: false }).catch(() => {});
});
els.realtimeLatency.addEventListener('change', () => {
  saveAndBroadcastSettings({ restartRequired: false }).catch(() => {});
});
['sourceLang', 'targetLang', 'transcriber', 'backendUrl', 'model', 'device'].forEach((key) => {
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

loadSettings().then(async () => {
  await refresh();
  await refreshApiKeyStatus();
});
