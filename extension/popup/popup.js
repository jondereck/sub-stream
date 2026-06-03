// Sub Stream AI popup controller

const $ = (id) => document.getElementById(id);

const els = {
  liveHeroCard: $('liveHeroCard'),
  importedHeroCard: $('importedHeroCard'),
  toggle: $('toggle'),
  status: $('status'),
  modeStatus: $('modeStatus'),
  audioWave: $('audioWave'),
  toast: $('toast'),
  usageSession: $('usageSession'),
  usageToday: $('usageToday'),
  usageTotal: $('usageTotal'),
  usageMeta: $('usageMeta'),
  usagePanel: $('usagePanel'),
  resetUsage: $('resetUsage'),
  sourceLang: $('sourceLang'),
  sourceLangIcon: $('sourceLangIcon'),
  targetLang: $('targetLang'),
  targetLangIcon: $('targetLangIcon'),
  fontSize: $('fontSize'),
  fontSizeVal: $('fontSizeVal'),
  position: $('position'),
  subtitleDelay: $('subtitleDelay'),
  subtitleDelayVal: $('subtitleDelayVal'),
  subtitleDelayManual: $('subtitleDelayManual'),
  subtitleDuration: $('subtitleDuration'),
  subtitleDurationVal: $('subtitleDurationVal'),
  showSourceFirst: $('showSourceFirst'),
  translationDisplayMode: $('translationDisplayMode'),
  translationGraceMs: $('translationGraceMs'),
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
  liveModeButton: $('liveModeButton'),
  importedModeButton: $('importedModeButton'),
  importedSubtitleCard: $('importedSubtitleCard'),
  subtitleFile: $('subtitleFile'),
  subtitleFileMeta: $('subtitleFileMeta'),
  subtitleSearchQuery: $('subtitleSearchQuery'),
  subtitleSearchButton: $('subtitleSearchButton'),
  importedTimingOffset: $('importedTimingOffset'),
  importedNudgeEarlier: $('importedNudgeEarlier'),
  importedNudgeLater: $('importedNudgeLater'),
  importedToggle: $('importedToggle'),
  importedWave: $('importedWave'),
  retranslateSubtitles: $('retranslateSubtitles'),
  importedSubtitleStatus: $('importedSubtitleStatus'),
  advancedToggle: $('advancedToggle'),
  advancedPanel: $('advancedPanel'),
  collapseAdvanced: $('collapseAdvanced'),
  openApiKey: $('openApiKey'),
};

const DEFAULTS = {
  settingsVersion: 18,
  captionMode: 'live',
  sourceLang: 'auto',
  targetLang: 'en',
  translationMode: 'auto',
  fontSize: 28,
  position: 'bottom',
  subtitleDelayMs: 0,
  subtitleDurationMs: 2600,
  showSourceFirst: true,
  translationDisplayMode: 'translation_replace',
  translationGraceMs: 100,
  syncMode: 'auto',
  transcriber: 'openai-realtime-translate',
  backendUrl: 'ws://127.0.0.1:8765/ws',
  realtimeLatency: 'fast',
  chunkDurationMs: 300,
  maxBufferMs: 450,
  vadSilenceMs: 220,
  partialEmitEnabled: true,
  translationFlushMs: 180,
  task: 'translate',
  model: 'base',
  device: 'cpu',
  importedSubtitleModel: 'backend-openai',
};

const IMPORTED_SUBTITLE_START_TIMEOUT_MS = 6000;
const IMPORTED_SUBTITLE_POPUP_STATE_KEY = 'importedSubtitlePopupState';
const SUBTITLE_CAT_BASE_URL = 'https://www.subtitlecat.com';

const SUBTITLE_MODE_PROFILES = {
  fast: {
    chunkDurationMs: 300,
    maxBufferMs: 450,
    vadSilenceMs: 220,
    partialEmitEnabled: true,
    translationFlushMs: 180,
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
  'captionMode',
  'sourceLang',
  'targetLang',
  'fontSize',
  'position',
  'subtitleDelayMs',
  'subtitleDurationMs',
  'showSourceFirst',
  'translationDisplayMode',
  'translationGraceMs',
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
  'showSourceFirst',
  'translationDisplayMode',
  'translationGraceMs',
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
const MIN_SUBTITLE_OFFSET_MS = -300000;
const MAX_SUBTITLE_OFFSET_MS = 300000;
const MIN_SUBTITLE_DURATION_MS = 1200;
const MAX_SUBTITLE_DURATION_MS = 8000;
const TRANSLATION_DISPLAY_MODES = new Set(['translation_replace', 'translation_dual']);
const TRANSLATION_MODES = new Set(['auto', 'filipino_english']);
const MIN_TRANSLATION_GRACE_MS = 0;
const MAX_TRANSLATION_GRACE_MS = 2000;
const REALTIME_TRANSCRIBERS = new Set(['openai-realtime', 'openai-realtime-translate']);

let currentSettings = null;
let apiKeyInfo = { configured: false, source: null, checked: false };
let loadedSettingsVersion = 0;
let toastTimer = null;
let saveDebounceTimer = null;
let importedNudgeHoldTimeout = null;
let importedNudgeHoldInterval = null;
let importedSessionActive = false;
let importedSessionPending = '';
let importedSubtitleState = {
  fileName: '',
  fileHash: '',
  cues: [],
  translatedCues: [],
  cueCount: 0,
  isTranslating: false,
};

const FLAG_ASSETS = {
  ar: 'assets/flags/sa.svg',
  de: 'assets/flags/de.svg',
  en: 'assets/flags/us.svg',
  es: 'assets/flags/es.svg',
  fil: 'assets/flags/ph.svg',
  fr: 'assets/flags/fr.svg',
  hi: 'assets/flags/in.svg',
  ja: 'assets/flags/jp.svg',
  ko: 'assets/flags/kr.svg',
  tr: 'assets/flags/tr.svg',
  zh: 'assets/flags/cn.svg',
};

const TEXT_BADGES = {
  auto: 'AI',
  bottom: 'B',
  middle: 'M',
  top: 'T',
  translation_replace: '1',
  translation_dual: '2',
  manual: 'M',
  auto_local_whisper: 'A',
  openai: 'AI',
  'openai-realtime': 'AI',
  'openai-realtime-translate': 'AI',
  'openai-chunked': 'AI',
  local: 'L',
  cuda: 'GPU',
  cpu: 'CPU',
};

const CUSTOM_SELECTS = new Map();

const PLAY_ICON = '<svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 4.5v15l13-7.5-13-7.5Z" fill="currentColor"></path></svg>';
const STOP_ICON = '<svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"></rect></svg>';
const displayModeButtons = Array.from(document.querySelectorAll('[data-display-mode]'));
const positionButtons = Array.from(document.querySelectorAll('[data-position]'));
const captionModeButtons = Array.from(document.querySelectorAll('[data-caption-mode]'));

const SELECT_LABELS = {
  sourceLang: {
    auto: 'Auto',
    ar: 'Arabic',
    en: 'English',
    es: 'Spanish',
    fr: 'French',
    de: 'German',
    fil: 'Filipino',
    hi: 'Hindi',
    id: 'Indonesian',
    it: 'Italian',
    ja: 'Japanese',
    ko: 'Korean',
    ms: 'Malay',
    pt: 'Portuguese',
    ru: 'Russian',
    th: 'Thai',
    tr: 'Turkish',
    vi: 'Vietnamese',
    zh: 'Chinese',
  },
  targetLang: {
    ar: 'Arabic',
    en: 'English',
    es: 'Spanish',
    fr: 'French',
    de: 'German',
    fil: 'Filipino',
    hi: 'Hindi',
    id: 'Indonesian',
    it: 'Italian',
    ja: 'Japanese',
    ko: 'Korean',
    ms: 'Malay',
    pt: 'Portuguese',
    ru: 'Russian',
    th: 'Thai',
    tr: 'Turkish',
    vi: 'Vietnamese',
    zh: 'Chinese',
  },
};

function setAdvancedOpen(open, focusApiKey = false) {
  if (!els.advancedPanel || !els.advancedToggle) return;
  els.advancedPanel.hidden = !open;
  document.body.classList.toggle('advanced-open', open);
  els.advancedToggle.setAttribute('aria-expanded', String(open));
  if (!open) return;
  requestAnimationFrame(() => {
    els.advancedPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'start' });
    if (focusApiKey && els.apiKey) els.apiKey.focus();
  });
}

function updateLanguageBadges() {
  if (els.sourceLangIcon) {
    renderBadge(els.sourceLangIcon, badgeForValue(els.sourceLang.value));
  }
  if (els.targetLangIcon) {
    renderBadge(els.targetLangIcon, badgeForValue(els.targetLang.value));
  }
  syncCustomSelects();
}

function textBadge(text) {
  return { text };
}

function flagBadge(src) {
  return { src };
}

function badgeForValue(value) {
  if (FLAG_ASSETS[value]) return flagBadge(FLAG_ASSETS[value]);
  return textBadge(TEXT_BADGES[value] || String(value || '').slice(0, 2).toUpperCase());
}

function renderBadge(element, badge) {
  element.textContent = '';
  element.classList.toggle('has-flag', Boolean(badge && badge.src));
  if (!badge) return;
  if (badge.src) {
    const img = document.createElement('img');
    img.src = badge.src;
    img.alt = '';
    img.loading = 'eager';
    element.appendChild(img);
    return;
  }
  element.textContent = badge.text || '';
}

function optionBadge(select, option) {
  if (select.id === 'sourceLang' || select.id === 'targetLang') {
    return badgeForValue(option.value);
  }
  if (select.id === 'position') return textBadge(TEXT_BADGES[option.value] || '');
  if (select.id === 'translationDisplayMode') return textBadge(TEXT_BADGES[option.value] || '');
  if (select.id === 'syncMode') return textBadge(option.value === 'manual' ? 'M' : 'A');
  if (select.id === 'transcriber') return textBadge(TEXT_BADGES[option.value] || 'AI');
  if (select.id === 'realtimeLatency') return textBadge(option.value.slice(0, 1).toUpperCase());
  if (select.id === 'model') return textBadge(option.value.slice(0, 1).toUpperCase());
  if (select.id === 'device') return textBadge(TEXT_BADGES[option.value] || '');
  return null;
}
function optionLabel(select, option) {
  const labels = SELECT_LABELS[select.id];
  if (labels && Object.prototype.hasOwnProperty.call(labels, option.value)) {
    return labels[option.value];
  }
  return option.textContent.trim();
}

function selectedOption(select) {
  return select.options[select.selectedIndex] || select.options[0];
}

function closeCustomSelects(exceptSelect = null) {
  CUSTOM_SELECTS.forEach((parts, select) => {
    if (select !== exceptSelect) {
      parts.root.classList.remove('open');
      parts.button.setAttribute('aria-expanded', 'false');
    }
  });
}

function syncCustomSelect(select) {
  const parts = CUSTOM_SELECTS.get(select);
  if (!parts) return;
  const option = selectedOption(select);
  const badge = option ? optionBadge(select, option) : null;
  renderBadge(parts.badge, badge);
  parts.badge.hidden = !badge;
  parts.text.textContent = option ? optionLabel(select, option) : '';
  parts.button.disabled = select.disabled;
  parts.root.classList.toggle('disabled', select.disabled);
  parts.options.forEach((item) => {
    const selected = item.dataset.value === select.value;
    item.classList.toggle('selected', selected);
    item.setAttribute('aria-selected', String(selected));
  });
}

function syncCustomSelects() {
  CUSTOM_SELECTS.forEach((_, select) => syncCustomSelect(select));
}

function enhanceSelect(select) {
  if (CUSTOM_SELECTS.has(select)) return;
  const root = document.createElement('div');
  root.className = 'custom-select';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'custom-select-button';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  const badge = document.createElement('span');
  badge.className = 'custom-select-badge';
  badge.setAttribute('aria-hidden', 'true');
  const text = document.createElement('span');
  text.className = 'custom-select-text';
  const arrow = document.createElement('span');
  arrow.className = 'custom-select-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  button.append(badge, text, arrow);

  const list = document.createElement('div');
  list.className = 'custom-select-list';
  list.setAttribute('role', 'listbox');
  const optionItems = Array.from(select.options).map((option) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'custom-select-option';
    item.dataset.value = option.value;
    item.setAttribute('role', 'option');
    const itemBadge = document.createElement('span');
    itemBadge.className = 'custom-select-badge';
    const badgeValue = optionBadge(select, option);
    renderBadge(itemBadge, badgeValue);
    itemBadge.hidden = !badgeValue;
    const itemText = document.createElement('span');
    itemText.textContent = optionLabel(select, option);
    item.append(itemBadge, itemText);
    if (option.dataset.help) {
      item.title = option.dataset.help;
      const itemHint = document.createElement('span');
      itemHint.className = 'custom-select-hint';
      itemHint.textContent = '?';
      itemHint.setAttribute('aria-label', option.dataset.help);
      const itemHelp = document.createElement('small');
      itemHelp.className = 'custom-select-option-help';
      itemHelp.textContent = option.dataset.help;
      item.append(itemHint, itemHelp);
    }
    item.addEventListener('click', () => {
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      closeCustomSelects();
    });
    list.appendChild(item);
    return item;
  });

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (select.disabled) return;
    const open = root.classList.contains('open');
    closeCustomSelects(select);
    root.classList.toggle('open', !open);
    button.setAttribute('aria-expanded', String(!open));
  });

  root.append(button, list);
  select.insertAdjacentElement('afterend', root);
  select.classList.add('native-select-hidden');
  CUSTOM_SELECTS.set(select, { root, button, badge, text, options: optionItems });
  syncCustomSelect(select);
}

function enhanceSelects() {
  document.querySelectorAll('select:not(.segment-source)').forEach(enhanceSelect);
  document.addEventListener('click', () => closeCustomSelects());
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeCustomSelects();
  });
}

function syncDisplayModeButtons() {
  const value = normalizeTranslationDisplayMode(els.translationDisplayMode.value);
  displayModeButtons.forEach((button) => {
    const active = button.dataset.displayMode === value;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    button.disabled = els.translationDisplayMode.disabled;
  });
}

function syncPositionButtons() {
  const value = els.position.value || DEFAULTS.position;
  positionButtons.forEach((button) => {
    const active = button.dataset.position === value;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    button.disabled = els.position.disabled;
  });
}

function syncCaptionModeButtons() {
  const mode = currentSettings && currentSettings.captionMode === 'imported' ? 'imported' : 'live';
  captionModeButtons.forEach((button) => {
    const active = button.dataset.captionMode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  if (els.importedSubtitleCard) els.importedSubtitleCard.hidden = mode !== 'imported';
  if (els.usagePanel) els.usagePanel.hidden = mode === 'imported';
  if (els.liveHeroCard) els.liveHeroCard.hidden = mode === 'imported';
  if (els.importedHeroCard) els.importedHeroCard.hidden = mode !== 'imported';
  if (els.toggle) {
    els.toggle.style.display = mode === 'imported' ? 'none' : '';
  }
}

function computeFor(device) { return device === 'cuda' ? 'int8_float32' : 'int8'; }

function translatorForTranscriber(transcriber) {
  return 'openai';
}

function isRealtimeTranscriber(transcriber) {
  return REALTIME_TRANSCRIBERS.has(transcriber);
}

function realtimeStatusLabel(transcriber) {
  return transcriber === 'openai-realtime-translate' ? 'Realtime Translate' : 'Realtime Cloud';
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

function formatSubtitleDelayInput(ms) {
  return (clampSubtitleDelayMs(ms) / 1000).toFixed(1);
}

function syncSubtitleDelayInputs(ms) {
  const clamped = clampSubtitleDelayMs(ms);
  els.subtitleDelay.value = String(clamped);
  els.subtitleDelayVal.textContent = formatSubtitleDelay(clamped);
  if (els.subtitleDelayManual) {
    els.subtitleDelayManual.value = formatSubtitleDelayInput(clamped);
  }
}

function clampSubtitleDurationMs(ms) {
  const value = parseInt(ms, 10);
  if (!Number.isFinite(value)) return DEFAULTS.subtitleDurationMs;
  return Math.max(MIN_SUBTITLE_DURATION_MS, Math.min(MAX_SUBTITLE_DURATION_MS, value));
}

function normalizeTranslationDisplayMode(value) {
  const mode = String(value || DEFAULTS.translationDisplayMode).trim().toLowerCase();
  return TRANSLATION_DISPLAY_MODES.has(mode) ? mode : DEFAULTS.translationDisplayMode;
}

function normalizeTranslationMode(value) {
  const mode = String(value || DEFAULTS.translationMode).trim().toLowerCase().replace(/-/g, '_');
  return TRANSLATION_MODES.has(mode) ? mode : DEFAULTS.translationMode;
}

function clampTranslationGraceMs(ms) {
  const value = parseInt(ms, 10);
  if (!Number.isFinite(value)) return DEFAULTS.translationGraceMs;
  return Math.max(MIN_TRANSLATION_GRACE_MS, Math.min(MAX_TRANSLATION_GRACE_MS, value));
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
  if (els.importedTimingOffset) {
    els.importedTimingOffset.textContent = formatSubtitleDelay((Number(metrics.effectiveOffsetS) || 0) * 1000);
  }
}

function showToast(message, kind = 'ok') {
  if (toastTimer) clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.className = 'toast' + (kind === 'error' ? ' error' : '') + (kind === 'warn' ? ' warn' : '');
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
  s.translationMode = normalizeTranslationMode(s.translationMode);
  if (!Object.prototype.hasOwnProperty.call(saved, 'subtitleDelayMs') && Number.isFinite(Number(saved.audioDelayMs))) {
    s.subtitleDelayMs = saved.audioDelayMs;
  }
  s.subtitleDelayMs = clampSubtitleDelayMs(s.subtitleDelayMs);
  s.subtitleDurationMs = clampSubtitleDurationMs(s.subtitleDurationMs);
  s.showSourceFirst = typeof s.showSourceFirst === 'boolean' ? s.showSourceFirst : DEFAULTS.showSourceFirst;
  s.translationDisplayMode = normalizeTranslationDisplayMode(s.translationDisplayMode);
  s.translationGraceMs = clampTranslationGraceMs(s.translationGraceMs);
  if (s.syncMode === 'auto_local_whisper') {
    s.syncMode = 'auto';
  }
  if (!['manual', 'auto'].includes(s.syncMode)) {
    s.syncMode = DEFAULTS.syncMode;
  }
  if ((saved.settingsVersion || 0) < DEFAULTS.settingsVersion) {
    Object.assign(s, subtitleModeProfile(s.realtimeLatency));
  }
  s.captionMode = s.captionMode === 'imported' ? 'imported' : 'live';
  s.importedSubtitleModel = s.importedSubtitleModel || DEFAULTS.importedSubtitleModel;
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
  syncPositionButtons();
  syncSubtitleDelayInputs(s.subtitleDelayMs);
  els.subtitleDuration.value = s.subtitleDurationMs;
  els.subtitleDurationVal.textContent = formatSubtitleDuration(s.subtitleDurationMs);
  els.showSourceFirst.checked = s.showSourceFirst;
  els.translationDisplayMode.value = s.translationDisplayMode;
  syncDisplayModeButtons();
  els.translationGraceMs.value = s.translationGraceMs;
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
  updateLanguageBadges();
  currentSettings = s;
  syncCaptionModeButtons();
  return s;
}

function readSettingsFromForm() {
  const device = els.device.value;
  const realtimeLatency = normalizeSubtitleMode(els.realtimeLatency.value);
  const modeProfile = subtitleModeProfile(realtimeLatency);
  return {
    settingsVersion: DEFAULTS.settingsVersion,
    captionMode: currentSettings && currentSettings.captionMode === 'imported' ? 'imported' : 'live',
    sourceLang: els.sourceLang.value,
    targetLang: els.targetLang.value,
    translationMode: DEFAULTS.translationMode,
    fontSize: parseInt(els.fontSize.value, 10),
    position: els.position.value,
    subtitleDelayMs: clampSubtitleDelayMs(els.subtitleDelay.value),
    subtitleDurationMs: clampSubtitleDurationMs(els.subtitleDuration.value),
    showSourceFirst: !!els.showSourceFirst.checked,
    translationDisplayMode: normalizeTranslationDisplayMode(els.translationDisplayMode.value),
    translationGraceMs: clampTranslationGraceMs(els.translationGraceMs.value),
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
    importedSubtitleModel: DEFAULTS.importedSubtitleModel,
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
  if (!els.modeStatus) return;
  els.modeStatus.textContent = text;
  els.modeStatus.className = 'mode-status ' + kind;
}

function requiresApiKey(transcriber) {
  return [...REALTIME_TRANSCRIBERS, 'openai-chunked'].includes(transcriber);
}

function updateWaveState(state, level = 0.18) {
  if (!els.audioWave) return;
  const safeLevel = Math.max(0.12, Math.min(1, Number(level) || 0.18));
  els.audioWave.className = 'wave ' + state;
  els.audioWave.style.setProperty('--wave-level', safeLevel.toFixed(2));
}

function apiKeySourceText(info = apiKeyInfo) {
  if (!info.checked) return 'Backend offline';
  if (!info.configured) return 'API key required';
  const masked = info.masked ? ` (${info.masked})` : '';
  if (info.source === '.env' || info.source === 'env') return `.env key active${masked}`;
  if (info.source === 'saved_settings' || info.source === 'stored') return `Saved key active${masked}`;
  return `API key active${masked}`;
}

function confirmedMissingApiKey() {
  return apiKeyInfo.checked && !apiKeyInfo.configured;
}

function renderModeStatus(res = {}) {
  if (res.isCapturing && currentSettings && isRealtimeTranscriber(currentSettings.transcriber)) {
    const label = realtimeStatusLabel(currentSettings.transcriber);
    if (res.wsState === 'connected') return setModeStatus(`${label} connected`, 'ready');
    if (res.wsState === 'error' || res.wsState === 'closed') return setModeStatus(`${label} connection failed`, 'error');
  }

  if (!currentSettings) return setModeStatus('Checking engine...', 'idle');
  if (isRealtimeTranscriber(currentSettings.transcriber)) {
    const label = realtimeStatusLabel(currentSettings.transcriber);
    if (!apiKeyInfo.checked) return setModeStatus('Backend offline', 'warn');
    return apiKeyInfo.configured
      ? setModeStatus(`${label} ready`, 'ready')
      : setModeStatus('API key required', 'warn');
  }
  if (currentSettings.transcriber === 'openai-chunked') {
    if (!apiKeyInfo.checked) return setModeStatus('Backend offline', 'warn');
    return apiKeyInfo.configured
      ? setModeStatus('OpenAI Chunked ready', 'ready')
      : setModeStatus('API key required', 'warn');
  }
  return setModeStatus('Local Whisper transcription ready', 'ready');
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
  syncDisplayModeButtons();
  syncPositionButtons();
  syncCustomSelects();
}

function renderSessionState(res) {
  const appState = res.appState || (res.isCapturing ? 'running' : 'idle');
  const isCritical = ['starting', 'stopping', 'applying_settings'].includes(appState);
  setControlsDisabled(isCritical);
  renderModeStatus(res);

  if (appState === 'starting') {
    updateWaveState('starting', 0.36);
    setToggleLoading('Starting...', false);
    setStatus(currentSettings && isRealtimeTranscriber(currentSettings.transcriber) ? 'Connecting to Realtime...' : (res.backendState === 'starting' ? 'Connecting to backend...' : 'Capturing tab audio...'), 'starting');
    return;
  }
  if (appState === 'stopping') {
    updateWaveState('starting', 0.28);
    setToggleLoading('Stopping...', true);
    setStatus('Stopping session...', 'starting');
    return;
  }
  if (appState === 'applying_settings' || res.wsState === 'applying') {
    updateWaveState('starting', 0.3);
    setToggleLoading('Applying...', true);
    setStatus('Applying settings...', 'starting');
    return;
  }

  els.toggle.disabled = false;
  els.toggle.innerHTML = res.isCapturing ? `${STOP_ICON}<span>Stop Captions</span>` : `${PLAY_ICON}<span>Start Captions</span>`;
  els.toggle.classList.toggle('stop', !!res.isCapturing);

  if (res.isCapturing) {
    switch (res.wsState) {
      case 'connected':
        updateWaveState('live', 0.72);
        setStatus('Status: Streaming', 'live');
        break;
      case 'connecting':
        updateWaveState('starting', 0.38);
        setStatus('Status: Connecting', 'starting');
        break;
      case 'error':
      case 'closed':
        updateWaveState('error', 0.22);
        setStatus('Status: Backend offline', 'error');
        break;
      default:
        updateWaveState('starting', 0.45);
        setStatus('Status: Capturing tab audio', 'starting');
    }
    return;
  }

  if (res.backendState === 'error') {
    updateWaveState('error', 0.16);
    setStatus(shortBackendError(res.backendInfo), 'error');
  } else {
    updateWaveState('idle', 0.18);
    setStatus('Status: Idle', 'idle');
  }
}

async function refresh() {
  const res = await chrome.runtime.sendMessage({ target: 'background', type: 'capture:status' });
  if (!res) return;
  updateUsage(res.aiUsage);
  updateSyncMetrics(res.sync);
  renderSessionState(res);
  await refreshImportedSessionState();
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
      checked: true,
    };
    els.apiKeyStatus.textContent = apiKeySourceText(apiKeyInfo);
    if (loadedSettingsVersion > 0 && loadedSettingsVersion < 9 && currentSettings) {
      const nextTranscriber = apiKeyInfo.configured ? DEFAULTS.transcriber : 'local';
      if (currentSettings.transcriber !== nextTranscriber) {
        els.transcriber.value = nextTranscriber;
        syncCustomSelect(els.transcriber);
        await saveSettings();
      }
      loadedSettingsVersion = DEFAULTS.settingsVersion;
    } else if (
      loadedSettingsVersion > 0 &&
      loadedSettingsVersion < 17 &&
      apiKeyInfo.configured &&
      currentSettings &&
      currentSettings.transcriber === 'openai-realtime'
    ) {
      if (els.transcriber.value !== DEFAULTS.transcriber) {
        els.transcriber.value = DEFAULTS.transcriber;
        syncCustomSelect(els.transcriber);
        await saveSettings();
      }
      loadedSettingsVersion = DEFAULTS.settingsVersion;
    }
    renderModeStatus();
  } catch (e) {
    apiKeyInfo = { configured: false, source: null, checked: false };
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
      checked: true,
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
      checked: true,
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

function sendRuntimeMessageWithTimeout(message, timeoutMs, fallbackMessage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(fallbackMessage)), timeoutMs);
    chrome.runtime.sendMessage(message).then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function importedCueCount() {
  return importedSubtitleState.cues.length || Number(importedSubtitleState.cueCount) || 0;
}

function hasImportedCueData() {
  return importedSubtitleState.cues.length > 0;
}

function cloneImportedCues(cues) {
  return Array.isArray(cues)
    ? cues
        .filter((cue) => cue && typeof cue === 'object')
        .map((cue) => ({
          startMs: Number(cue.startMs) || 0,
          endMs: Number(cue.endMs) || 0,
          originalText: String(cue.originalText || ''),
          translatedText: cue.translatedText == null ? '' : String(cue.translatedText),
        }))
    : [];
}

async function persistImportedSubtitlePopupState(extra = {}) {
  const currentTabId = await activeTabId().catch(() => null);
  await chrome.storage.local.set({
    [IMPORTED_SUBTITLE_POPUP_STATE_KEY]: {
      fileName: importedSubtitleState.fileName || '',
      fileHash: importedSubtitleState.fileHash || '',
      cueCount: importedCueCount(),
      cues: cloneImportedCues(importedSubtitleState.cues),
      translatedCues: cloneImportedCues(importedSubtitleState.translatedCues),
      status: els.importedSubtitleStatus ? els.importedSubtitleStatus.textContent : '',
      statusKind: extra.statusKind || '',
      tabId: currentTabId,
      ...extra,
    },
  });
}

async function restoreImportedSubtitlePopupState() {
  if (importedSubtitleState.cues.length) return;
  const currentTabId = await activeTabId().catch(() => null);
  const stored = await chrome.storage.local.get([
    IMPORTED_SUBTITLE_POPUP_STATE_KEY,
    'importedSubtitlesActive',
    'importedSubtitlesTabId',
  ]);
  const session = stored[IMPORTED_SUBTITLE_POPUP_STATE_KEY];
  if (!session || !session.fileName) return;

  importedSubtitleState = {
    ...importedSubtitleState,
    fileName: String(session.fileName || ''),
    fileHash: String(session.fileHash || ''),
    cues: cloneImportedCues(session.cues),
    translatedCues: cloneImportedCues(session.translatedCues),
    cueCount: Number(session.cueCount) || cloneImportedCues(session.cues).length || 0,
    isTranslating: false,
  };

  const count = importedCueCount();
  els.subtitleFileMeta.textContent = count > 0
    ? `${importedSubtitleState.fileName} - ${count} cues loaded`
    : importedSubtitleState.fileName;

  const isSameTabActive = !!(
    stored.importedSubtitlesActive &&
    currentTabId != null &&
    Number(stored.importedSubtitlesTabId) === Number(currentTabId)
  );
  importedSessionActive = isSameTabActive;
  const status = isSameTabActive
    ? 'Imported subtitles are already loaded in this tab.'
    : (
      importedSubtitleState.cues.length
        ? (session.status || 'Imported subtitle file is ready to sync again.')
        : 'Imported subtitle file was loaded previously. Re-import it to sync again.'
    );
  setImportedStatus(status, isSameTabActive ? 'ok' : (session.statusKind || (importedSubtitleState.cues.length ? 'ok' : 'idle')));
  setImportedControls();
}

function setImportedStatus(message, kind = 'idle') {
  if (!els.importedSubtitleStatus) return;
  els.importedSubtitleStatus.textContent = message;
  els.importedSubtitleStatus.className = `imported-status imported-status--hero ${kind}`;
}

function setImportedWaveState(state, level = 0.18) {
  if (!els.importedWave) return;
  const safeLevel = Math.max(0.12, Math.min(1, Number(level) || 0.18));
  els.importedWave.className = `wave imported-wave ${state}`;
  els.importedWave.style.setProperty('--wave-level', safeLevel.toFixed(2));
}

function renderImportedToggleButton(text, stopMode = false, disabled = false, loading = false) {
  if (!els.importedToggle) return;
  els.importedToggle.disabled = disabled;
  els.importedToggle.classList.toggle('stop', stopMode);
  els.importedToggle.innerHTML = loading
    ? `<span class="spinner" aria-hidden="true"></span>${text}`
    : `${stopMode ? STOP_ICON : PLAY_ICON}<span>${text}</span>`;
}

function setImportedControls() {
  const hasCues = hasImportedCueData();
  const busy = importedSubtitleState.isTranslating;
  const pending = importedSessionPending === 'starting' || importedSessionPending === 'stopping';
  if (pending) {
    const stopping = importedSessionPending === 'stopping';
    renderImportedToggleButton(stopping ? 'Stopping...' : 'Starting...', stopping, true, true);
    setImportedWaveState('starting', 0.3);
  } else if (importedSessionActive) {
    renderImportedToggleButton('Stop Imported Sync', true, !hasCues || busy, false);
    setImportedWaveState('live', 0.72);
  } else {
    renderImportedToggleButton('Start Imported Sync', false, !hasCues || busy, false);
    setImportedWaveState(hasCues ? 'idle' : 'error', hasCues ? 0.18 : 0.16);
  }
  if (els.retranslateSubtitles) els.retranslateSubtitles.disabled = !hasCues || busy || pending;
}

async function refreshImportedSessionState() {
  const currentTabId = await activeTabId().catch(() => null);
  const stored = await chrome.storage.local.get(['importedSubtitlesActive', 'importedSubtitlesTabId']);
  importedSessionActive = !!(
    stored.importedSubtitlesActive &&
    currentTabId != null &&
    Number(stored.importedSubtitlesTabId) === Number(currentTabId)
  );
  setImportedControls();
}

async function activeTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs.length || !tabs[0].id) throw new Error('No active tab found.');
  return tabs[0].id;
}

async function readSubtitleFile(file) {
  if (!file) return;
  const name = file.name || '';
  if (!/\.(srt|vtt)$/i.test(name)) {
    throw new Error('Only .srt and .vtt subtitle files are supported.');
  }
  const text = await file.text();
  const cues = SubStreamSubtitles.parseSubtitleFile(name, text);
  if (!cues.length) throw new Error('No valid subtitle cues found in this file.');
  const fileHash = await SubStreamSubtitles.hashFileContent(text);
  importedSubtitleState = {
    fileName: name,
    fileHash,
    cues,
    translatedCues: cues,
    cueCount: cues.length,
    isTranslating: false,
  };
  els.subtitleFileMeta.textContent = `${name} - ${cues.length} cues loaded`;
  setImportedStatus('Ready to sync. Original subtitles will show while translation loads.');
  setImportedControls();
  await persistImportedSubtitlePopupState({ statusKind: 'idle' });
}

async function importSubtitleText(fileName, text) {
  const name = String(fileName || 'imported-subtitle.srt').trim() || 'imported-subtitle.srt';
  if (!/\.(srt|vtt)$/i.test(name)) {
    throw new Error('Only .srt and .vtt subtitle files are supported.');
  }
  const content = String(text || '');
  const cues = SubStreamSubtitles.parseSubtitleFile(name, content);
  if (!cues.length) throw new Error('No valid subtitle cues found in this subtitle source.');
  const fileHash = await SubStreamSubtitles.hashFileContent(content);
  importedSubtitleState = {
    fileName: name,
    fileHash,
    cues,
    translatedCues: cues,
    cueCount: cues.length,
    isTranslating: false,
  };
  els.subtitleFileMeta.textContent = `${name} - ${cues.length} cues loaded`;
  setImportedStatus('Subtitle imported from Subtitle Cat. Ready to sync.', 'ok');
  setImportedControls();
  await persistImportedSubtitlePopupState({ statusKind: 'ok' });
}

async function openSubtitleCatSearch() {
  const query = String(els.subtitleSearchQuery && els.subtitleSearchQuery.value || '').trim();
  if (!query) {
    setImportedStatus('Enter a movie or episode name first.', 'error');
    return;
  }
  if (els.subtitleSearchButton) els.subtitleSearchButton.disabled = true;
  try {
    const url = `${SUBTITLE_CAT_BASE_URL}/index.php?search=${encodeURIComponent(query)}`;
    await chrome.tabs.create({ url });
    setImportedStatus('Opened Subtitle Cat in a new tab.', 'ok');
  } finally {
    if (els.subtitleSearchButton) els.subtitleSearchButton.disabled = false;
  }
}

async function nudgeImportedSubtitleOffset(deltaMs) {
  const nextValue = clampSubtitleDelayMs((Number(els.subtitleDelay.value) || 0) + deltaMs);
  syncSubtitleDelayInputs(nextValue);
  if (els.importedTimingOffset) {
    els.importedTimingOffset.textContent = formatSubtitleDelay(nextValue);
  }
  await saveAndBroadcastSettings({ restartRequired: false, force: true });
  notifySubtitleDelayAdjusted(nextValue);
}

function notifySubtitleDelayAdjusted(ms) {
  const formatted = formatSubtitleDelay(ms);
  showToast(`Subtitle timing adjusted to ${formatted}`);
  if (currentSettings && currentSettings.captionMode === 'imported') {
    setImportedStatus(`Imported subtitle timing adjusted to ${formatted}.`, 'ok');
  }
}

function stopImportedNudgeHold() {
  if (importedNudgeHoldTimeout) {
    clearTimeout(importedNudgeHoldTimeout);
    importedNudgeHoldTimeout = null;
  }
  if (importedNudgeHoldInterval) {
    clearInterval(importedNudgeHoldInterval);
    importedNudgeHoldInterval = null;
  }
}

function bindImportedNudgeButton(button, deltaMs) {
  if (!button) return;
  const runNudge = () => nudgeImportedSubtitleOffset(deltaMs).catch((e) => {
    const message = errorMessage(e, 'Failed to adjust subtitle timing.');
    setImportedStatus(message, 'error');
    showToast(message, 'error');
    stopImportedNudgeHold();
  });

  button.addEventListener('pointerdown', (event) => {
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    stopImportedNudgeHold();
    runNudge();
    importedNudgeHoldTimeout = setTimeout(() => {
      importedNudgeHoldInterval = setInterval(runNudge, 90);
    }, 260);
  });

  ['pointerup', 'pointercancel', 'pointerleave', 'lostpointercapture'].forEach((eventName) => {
    button.addEventListener(eventName, stopImportedNudgeHold);
  });

  button.addEventListener('keydown', (event) => {
    if (event.repeat) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    runNudge();
  });
}

async function translateImportedSubtitles(force = false) {
  if (!importedSubtitleState.cues.length) throw new Error('Import a subtitle file first.');
  const settings = await saveSettings();
  importedSubtitleState.isTranslating = true;
  setImportedControls();
  setImportedStatus(force ? 'Re-translating subtitles...' : 'Translating subtitles...');
  try {
    const res = await chrome.runtime.sendMessage({
      target: 'background',
      type: 'importedSubtitles:translate',
      fileHash: importedSubtitleState.fileHash,
      fileName: importedSubtitleState.fileName,
      cues: importedSubtitleState.cues,
      settings,
      force,
    });
    if (!res || !res.ok) throw new Error(errorMessage(res && res.error, 'Subtitle translation failed.'));
    importedSubtitleState.translatedCues = res.cues || importedSubtitleState.cues;
    setImportedStatus(res.cacheHit ? 'Loaded translated subtitles from cache.' : 'Translated subtitles are ready.');
    await persistImportedSubtitlePopupState({ statusKind: 'ok' });
    return importedSubtitleState.translatedCues;
  } finally {
    importedSubtitleState.isTranslating = false;
    setImportedControls();
  }
}

async function startImportedSubtitles(forceTranslate = false) {
  if (!importedSubtitleState.cues.length) {
    setImportedStatus('Import a subtitle file first.', 'error');
    return;
  }
  const settings = await saveSettings();
  const tabId = await activeTabId();
  importedSessionPending = 'starting';
  setImportedControls();
  setImportedStatus('Mounting subtitle overlay...');
  try {
    const startRes = await sendRuntimeMessageWithTimeout(
      {
        target: 'background',
        type: 'importedSubtitles:start',
        tabId,
        cues: importedSubtitleState.translatedCues.length ? importedSubtitleState.translatedCues : importedSubtitleState.cues,
        settings,
      },
      IMPORTED_SUBTITLE_START_TIMEOUT_MS,
      'Subtitle overlay mount timed out. Reload the page and try again.'
    );
    if (!startRes || !startRes.ok) {
      const message = errorMessage(startRes && startRes.error, 'Could not start imported subtitles.');
      setImportedStatus(message, 'error');
      showToast(message, 'error');
      return;
    }

    importedSessionActive = true;
    setImportedStatus('Imported subtitles are syncing to video time.');
    await persistImportedSubtitlePopupState({ statusKind: 'ok', tabId });
    try {
      const cues = await translateImportedSubtitles(forceTranslate);
      await chrome.runtime.sendMessage({
        target: 'background',
        type: 'importedSubtitles:update',
        tabId,
        cues,
        settings: readSettingsFromForm(),
      });
    } catch (e) {
      const message = isBackendOfflineError(e)
        ? 'Translation backend is offline. Showing original imported subtitles.'
        : 'Translation failed. Showing original imported subtitles.';
      importedSubtitleState.translatedCues = importedSubtitleState.cues;
      setImportedStatus(message, 'ok');
      showToast(message, isBackendOfflineError(e) ? 'warn' : 'error');
      await persistImportedSubtitlePopupState({ statusKind: 'ok', tabId });
    }
  } finally {
    importedSessionPending = '';
    setImportedControls();
  }
}

async function stopImportedSubtitles() {
  try {
    const tabId = await activeTabId();
    importedSessionPending = 'stopping';
    setImportedControls();
    await chrome.runtime.sendMessage({ target: 'background', type: 'importedSubtitles:stop', tabId });
    importedSessionActive = false;
    setImportedStatus(importedCueCount() ? 'Imported subtitle sync stopped.' : 'No subtitle file loaded.');
    setImportedControls();
    await persistImportedSubtitlePopupState({ statusKind: 'idle', tabId });
  } catch (e) {
    showToast(errorMessage(e, 'Failed to stop imported subtitles.'), 'error');
  } finally {
    importedSessionPending = '';
    setImportedControls();
  }
}

// Poll while popup is open so status reflects WS state changes in real time.
setInterval(refresh, 1000);

async function onToggle() {
  if (requiresApiKey(els.transcriber.value) && confirmedMissingApiKey()) {
    els.transcriber.value = 'local';
    syncCustomSelect(els.transcriber);
    showToast('OpenAI mode needs an API key. Using Local Whisper fallback.', 'warn');
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
  syncSubtitleDelayInputs(els.subtitleDelay.value);
  debounceSettingsApply(false);
});
if (els.subtitleDelayManual) {
  els.subtitleDelayManual.addEventListener('input', () => {
    const parsedMs = Number(els.subtitleDelayManual.value) * 1000;
    if (!Number.isFinite(parsedMs)) return;
    syncSubtitleDelayInputs(parsedMs);
    debounceSettingsApply(false);
  });
  els.subtitleDelayManual.addEventListener('change', () => {
    const parsedMs = Number(els.subtitleDelayManual.value) * 1000;
    const nextValue = Number.isFinite(parsedMs) ? parsedMs : 0;
    syncSubtitleDelayInputs(nextValue);
    saveAndBroadcastSettings({ restartRequired: false, force: true })
      .then(() => notifySubtitleDelayAdjusted(nextValue))
      .catch(() => {});
  });
}
els.subtitleDuration.addEventListener('input', () => {
  els.subtitleDurationVal.textContent = formatSubtitleDuration(els.subtitleDuration.value);
  debounceSettingsApply(false);
});
els.showSourceFirst.addEventListener('change', () => {
  saveAndBroadcastSettings({ restartRequired: false }).catch(() => {});
});
els.translationDisplayMode.addEventListener('change', () => {
  els.translationDisplayMode.value = normalizeTranslationDisplayMode(els.translationDisplayMode.value);
  syncDisplayModeButtons();
  saveAndBroadcastSettings({ restartRequired: false }).catch(() => {});
});
displayModeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    if (button.disabled) return;
    els.translationDisplayMode.value = normalizeTranslationDisplayMode(button.dataset.displayMode);
    els.translationDisplayMode.dispatchEvent(new Event('change', { bubbles: true }));
  });
});
els.translationGraceMs.addEventListener('change', () => {
  els.translationGraceMs.value = clampTranslationGraceMs(els.translationGraceMs.value);
  saveAndBroadcastSettings({ restartRequired: false }).catch(() => {});
});
els.syncMode.addEventListener('change', () => {
  debounceSettingsApply(false);
});
els.resetSubtitleDelay.addEventListener('click', () => {
  syncSubtitleDelayInputs(0);
  saveAndBroadcastSettings({ restartRequired: false, force: true })
    .then(() => notifySubtitleDelayAdjusted(0))
    .catch(() => {});
});
els.position.addEventListener('change', () => {
  syncPositionButtons();
  saveAndBroadcastSettings({ restartRequired: false }).catch(() => {});
});
positionButtons.forEach((button) => {
  button.addEventListener('click', () => {
    if (button.disabled) return;
    els.position.value = button.dataset.position || DEFAULTS.position;
    els.position.dispatchEvent(new Event('change', { bubbles: true }));
  });
});
captionModeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const mode = button.dataset.captionMode === 'imported' ? 'imported' : 'live';
    currentSettings = { ...(currentSettings || DEFAULTS), captionMode: mode };
    syncCaptionModeButtons();
    saveAndBroadcastSettings({ restartRequired: false, force: true }).catch(() => {});
  });
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
    updateLanguageBadges();
    if (importedSubtitleState.cues.length) {
      importedSubtitleState.translatedCues = importedSubtitleState.cues;
      setImportedStatus('Language changed. Re-translate imported subtitles to update the cache.');
      setImportedControls();
    }
    saveAndBroadcastSettings({ restartRequired: false }).catch(() => {});
  });
});
['transcriber', 'backendUrl'].forEach((key) => {
  els[key].addEventListener('change', () => {
    if (key === 'transcriber' && requiresApiKey(els.transcriber.value) && confirmedMissingApiKey()) {
      showToast('OpenAI features need an API key. Add it in Advanced Settings > API Key.', 'warn');
    } else {
      showToast('Applying new settings...');
    }
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
els.advancedToggle.addEventListener('click', () => {
  setAdvancedOpen(els.advancedPanel.hidden);
});
els.collapseAdvanced.addEventListener('click', () => {
  setAdvancedOpen(false);
});
if (els.openApiKey) {
  els.openApiKey.addEventListener('click', () => {
    setAdvancedOpen(true, true);
  });
}
els.resetUsage.addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ target: 'background', type: 'aiUsage:reset' });
  if (res && res.aiUsage) updateUsage(res.aiUsage);
});
els.saveApiKey.addEventListener('click', saveApiKey);
els.testApiKey.addEventListener('click', testApiKey);
els.clearApiKey.addEventListener('click', clearApiKey);
els.subtitleFile.addEventListener('change', async () => {
  try {
    await readSubtitleFile(els.subtitleFile.files && els.subtitleFile.files[0]);
  } catch (e) {
    importedSubtitleState = { fileName: '', fileHash: '', cues: [], translatedCues: [], cueCount: 0, isTranslating: false };
    els.subtitleFileMeta.textContent = 'Upload an .srt or .vtt file.';
    setImportedStatus(errorMessage(e, 'Failed to read subtitle file.'), 'error');
    setImportedControls();
    await chrome.storage.local.remove(IMPORTED_SUBTITLE_POPUP_STATE_KEY);
  }
});
if (els.subtitleSearchButton) {
  els.subtitleSearchButton.addEventListener('click', () => {
    openSubtitleCatSearch().catch((e) => {
      const message = errorMessage(e, 'Could not open Subtitle Cat.');
      setImportedStatus(message, 'error');
      showToast(message, 'error');
    });
  });
}
if (els.subtitleSearchQuery) {
  els.subtitleSearchQuery.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    openSubtitleCatSearch().catch((e) => {
      const message = errorMessage(e, 'Could not open Subtitle Cat.');
      setImportedStatus(message, 'error');
      showToast(message, 'error');
    });
  });
}
bindImportedNudgeButton(els.importedNudgeEarlier, -100);
bindImportedNudgeButton(els.importedNudgeLater, 100);
els.importedToggle.addEventListener('click', () => {
  const action = importedSessionActive ? stopImportedSubtitles() : startImportedSubtitles(false);
  action.catch((e) => {
    const message = errorMessage(e, importedSessionActive ? 'Failed to stop imported subtitles.' : 'Failed to start imported subtitles.');
    setImportedStatus(message, 'error');
    showToast(message, 'error');
  });
});
els.retranslateSubtitles.addEventListener('click', () => {
  startImportedSubtitles(true).catch((e) => {
    const message = errorMessage(e, 'Failed to re-translate subtitles.');
    setImportedStatus(message, 'error');
    showToast(message, 'error');
  });
});

enhanceSelects();

loadSettings().then(async () => {
  await refresh();
  await restoreImportedSubtitlePopupState();
  await refreshApiKeyStatus();
});
