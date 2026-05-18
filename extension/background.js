// Kami Subs — background service worker
// Coordinates: popup <-> offscreen (audio capture) <-> content (overlay)
//             popup -> native host (spawns the Python backend)

const OFFSCREEN_DOC = 'offscreen.html';
const NATIVE_HOST   = 'com.kamisubs.host';
const AI_USAGE_KEY = 'aiUsageEstimate';
const REALTIME_TRANSLATE_USD_PER_MIN = 0.034;

let activeTabId = null;
let isCapturing = false;
let wsState = 'idle';           // idle | connecting | connected | error | closed
let backendState = 'unknown';   // unknown | starting | up | down | unavailable
let backendInfo = {};           // { pid?, wsUrl?, lastError? }
let nativePort = null;          // chrome.runtime.Port to native host, or null

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
    currentStartedAt: null,
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
  const now = Date.now();
  const currentMs = usage.currentStartedAt ? Math.max(0, now - usage.currentStartedAt) : 0;
  const todayMs = usage.todayMs + currentMs;
  const totalMs = usage.totalMs + currentMs;
  const msToCost = (ms) => (ms / 60000) * REALTIME_TRANSLATE_USD_PER_MIN;
  return {
    isTracking: !!usage.currentStartedAt,
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
  if ((settings && settings.transcriber) !== 'openai-realtime') {
    await stopAiUsage();
    return;
  }
  const usage = await readUsage();
  if (!usage.currentStartedAt) {
    usage.currentStartedAt = Date.now();
    await writeUsage(usage);
  }
}

async function stopAiUsage() {
  const usage = await readUsage();
  if (!usage.currentStartedAt) return;
  const elapsedMs = Math.max(0, Date.now() - usage.currentStartedAt);
  usage.todayMs += elapsedMs;
  usage.totalMs += elapsedMs;
  usage.currentStartedAt = null;
  await writeUsage(usage);
}

async function resetAiUsage() {
  const usage = await readUsage();
  const next = emptyUsage();
  if (usage.currentStartedAt) {
    next.currentStartedAt = Date.now();
  }
  await writeUsage(next);
}

async function getAiUsageSnapshot() {
  return usageSnapshot(await readUsage());
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
      target: { tabId },
      files: ['content.css']
    });
  } catch (e) { /* ignore — may already be injected */ }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content.js']
  });
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
    backendInfo = { lastError: String(e) };
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
        backendState = 'down';
        backendInfo = { lastError: msg.message };
        console.error('[kami-subs native]', msg.message);
        break;
      case 'log':
        // Backend stdout/stderr, surfaced for debugging. Comment out if noisy.
        console.log('[kami-backend]', msg.line);
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
      console.warn('[kami-subs] native host unavailable:', err.message);
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
  if (backendState === 'unavailable') return false;
  if (backendState === 'up' && nativePort) return true;

  if (!nativePort) {
    if (!connectNative()) return false;
  }

  // Pull whisper settings off the popup settings object if present.
  const startMsg = {
    type: 'start',
    model:      settings.model      || undefined,
    device:     settings.device     || undefined,
    compute:    settings.compute    || undefined,
    translator: settings.translator || undefined,
    transcriber: settings.transcriber || undefined,
  };
  backendState = 'starting';
  try {
    nativePort.postMessage(startMsg);
  } catch (e) {
    backendState = 'unavailable';
    backendInfo = { lastError: String(e) };
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
      if (backendState === 'up' || backendState === 'unavailable' || Date.now() - t0 > 60000) {
        clearInterval(tick);
        resolve();
      }
    }, 150);
  });
  return backendState !== 'unavailable';
}

function stopBackend() {
  if (!nativePort) return;
  try { nativePort.postMessage({ type: 'stop' }); } catch (e) { /* ignore */ }
  try { nativePort.disconnect(); } catch (e) { /* ignore */ }
  nativePort = null;
  backendState = 'down';
}

async function startCapture(tabId, settings) {
  // Best-effort: try to spawn the backend before we start capturing. If the
  // native host isn't installed, fall through — user may have launched it
  // manually, in which case the WS connect still works.
  await ensureBackend(settings);

  await ensureOffscreen();

  // Make sure the overlay is mounted before we start sending transcripts.
  try {
    await ensureContentScript(tabId);
  } catch (e) {
    console.warn('[kami-subs] could not inject content script (restricted page?):', e);
  }

  const streamId = await new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
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

  // Tell the content script in that tab to mount the overlay
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'overlay:mount', settings });
  } catch (e) {
    console.warn('[kami-subs] could not message content script yet:', e);
  }
}

async function stopCapture() {
  await stopAiUsage();
  if (await hasOffscreenDocument()) {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
  }
  if (activeTabId != null) {
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
  await chrome.storage.local.set({ isCapturing: false, activeTabId: null });
  activeTabId = null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.target && msg.target !== 'background') return;

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
          sendResponse({
            isCapturing,
            activeTabId,
            wsState,
            backendState,
            backendInfo,
            aiUsage: await getAiUsageSnapshot()
          });
          break;
        }
        case 'aiUsage:reset': {
          await resetAiUsage();
          sendResponse({ ok: true, aiUsage: await getAiUsageSnapshot() });
          break;
        }
        case 'capture:updateSettings': {
          const settings = msg.settings || {};
          await chrome.storage.local.set({ settings });
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
                settings
              });
            } catch (e) { /* tab may be gone or content script unavailable */ }
          }
          sendResponse({ ok: true });
          break;
        }
        case 'ws:state': {
          wsState = msg.state;
          break;
        }
        case 'transcript': {
          // Forward transcript from offscreen -> content script overlay
          if (activeTabId != null) {
            try {
              await chrome.tabs.sendMessage(activeTabId, {
                type: 'overlay:text',
                text: msg.text,
                delta: msg.delta,
                isFinal: msg.isFinal,
                mode: msg.mode
              });
            } catch (e) { /* ignore */ }
          }
          break;
        }
        case 'backend:error': {
          if (activeTabId != null) {
            try {
              await chrome.tabs.sendMessage(activeTabId, {
                type: 'overlay:error',
                message: msg.message
              });
            } catch (e) { /* ignore */ }
          }
          break;
        }
      }
    } catch (err) {
      console.error('[kami-subs bg]', err);
      sendResponse({ ok: false, error: String(err) });
    }
  })();
  return true; // keep channel open for async sendResponse
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === activeTabId) await stopCapture();
});
