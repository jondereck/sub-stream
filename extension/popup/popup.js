// Sub Stream AI — popup controller

const $ = (id) => document.getElementById(id);

const els = {
  toggle: $('toggle'),
  status: $('status'),
  backendStatus: $('backendStatus'),
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
  model: $('model'),
  device: $('device'),
};

const DEFAULTS = {
  settingsVersion: 3,
  sourceLang: 'auto',
  targetLang: 'ar',
  fontSize: 28,
  position: 'bottom',
  audioDelayMs: 0,
  transcriber: 'openai-realtime',
  backendUrl: 'ws://127.0.0.1:8765/ws',
  task: 'translate',
  model: 'base',
  device: 'cuda',
};

function computeFor(device) { return device === 'cuda' ? 'int8_float32' : 'int8'; }

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

async function loadSettings() {
  const stored = await chrome.storage.local.get('settings');
  const saved = stored.settings || {};
  const s = { ...DEFAULTS, ...saved };
  if (!saved.settingsVersion && saved.transcriber === 'local') {
    s.transcriber = DEFAULTS.transcriber;
  }
  if ((saved.settingsVersion || 0) < 3 && (!saved.model || saved.model === 'small')) {
    s.model = DEFAULTS.model;
  }
  els.sourceLang.value = s.sourceLang;
  els.targetLang.value = s.targetLang;
  els.fontSize.value = s.fontSize;
  els.fontSizeVal.textContent = s.fontSize;
  els.position.value = s.position;
  els.audioDelay.value = s.audioDelayMs;
  els.audioDelayVal.textContent = formatDelay(s.audioDelayMs);
  els.transcriber.value = s.transcriber;
  els.backendUrl.value = s.backendUrl;
  els.model.value = s.model;
  els.device.value = s.device;
  return s;
}

async function saveSettings() {
  const device = els.device.value;
  const s = {
    settingsVersion: DEFAULTS.settingsVersion,
    sourceLang: els.sourceLang.value,
    targetLang: els.targetLang.value,
    fontSize: parseInt(els.fontSize.value, 10),
    position: els.position.value,
    audioDelayMs: parseInt(els.audioDelay.value, 10) || 0,
    transcriber: els.transcriber.value,
    backendUrl: els.backendUrl.value.trim() || DEFAULTS.backendUrl,
    task: 'translate',
    model: els.model.value,
    device,
    compute: computeFor(device),
  };
  await chrome.storage.local.set({ settings: s });
  return s;
}

async function saveAndBroadcastSettings() {
  const settings = await saveSettings();
  try {
    await chrome.runtime.sendMessage({
      target: 'background',
      type: 'capture:updateSettings',
      settings
    });
  } catch (e) {
    // Background may be asleep while not capturing; saved settings still apply on next start.
  }
  return settings;
}

function setStatus(text, kind) {
  els.status.textContent = text;
  els.status.className = 'status ' + (kind || 'idle');
}

function setBackendStatus(state, info) {
  // state: unknown | starting | up | down | unavailable
  const map = {
    unknown:     ['Backend: unknown',                'idle'],
    starting:    ['Backend: starting…',              'starting'],
    up:          [`Backend: up${info && info.pid ? ' (pid ' + info.pid + ')' : ''}`, 'up'],
    down:        ['Backend: down',                   'down'],
    unavailable: ['Backend: native host missing — run install.ps1', 'bad'],
  };
  const [text, cls] = map[state] || map.unknown;
  els.backendStatus.textContent = text;
  els.backendStatus.className = 'backend-status ' + cls;
}

async function refresh() {
  const res = await chrome.runtime.sendMessage({ target: 'background', type: 'capture:status' });
  if (!res) return;
  setBackendStatus(res.backendState, res.backendInfo);
  updateUsage(res.aiUsage);
  if (res.isCapturing) {
    els.toggle.textContent = 'Stop';
    els.toggle.classList.add('stop');
    switch (res.wsState) {
      case 'connected':  setStatus('Live', 'live'); break;
      case 'connecting': setStatus('Connecting…', 'idle'); break;
      case 'error':
      case 'closed':     setStatus('Backend offline — start server', 'error'); break;
      default:           setStatus('Capturing (no backend)', 'error');
    }
  } else {
    els.toggle.textContent = 'Start';
    els.toggle.classList.remove('stop');
    setStatus('Idle', 'idle');
  }
}

// Poll while popup is open so status reflects WS state changes in real time.
setInterval(refresh, 1000);

async function onToggle() {
  const settings = await saveSettings();
  const status = await chrome.runtime.sendMessage({ target: 'background', type: 'capture:status' });
  if (status && status.isCapturing) {
    await chrome.runtime.sendMessage({ target: 'background', type: 'capture:stop' });
  } else {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length) return setStatus('No active tab', 'error');
    const res = await chrome.runtime.sendMessage({
      target: 'background',
      type: 'capture:start',
      tabId: tabs[0].id,
      settings
    });
    if (res && !res.ok) setStatus(res.error || 'Failed to start', 'error');
  }
  await refresh();
}

els.fontSize.addEventListener('input', () => {
  els.fontSizeVal.textContent = els.fontSize.value;
  saveAndBroadcastSettings();
});
els.audioDelay.addEventListener('input', () => {
  els.audioDelayVal.textContent = formatDelay(els.audioDelay.value);
  saveAndBroadcastSettings();
});
['sourceLang','targetLang','fontSize','position','audioDelay','transcriber','backendUrl','model','device'].forEach(k => {
  els[k].addEventListener('change', saveAndBroadcastSettings);
});
els.toggle.addEventListener('click', onToggle);
els.resetUsage.addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ target: 'background', type: 'aiUsage:reset' });
  if (res && res.aiUsage) updateUsage(res.aiUsage);
});

loadSettings().then(refresh);
