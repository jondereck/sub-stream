// Sub Stream AI — offscreen document
// Captures tab audio via the streamId provided by background.js,
// sends realtime frames or chunked PCM over WebSocket to the backend,
// forwards transcripts back to background.js -> content overlay.

let mediaStream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let passthroughGain = null;
let ws = null;
let settings = null;
let isRunning = false;          // true between start() and stop()
let reconnectAttempts = 0;
let reconnectTimer = null;
let reconnectingForConfig = false;
const MAX_RECONNECT_DELAY_MS = 5000;

// Realtime Cloud sends tiny 24kHz frames. Local Whisper adapts chunk size by model.
const LOCAL_SAMPLE_RATE = 16000;
const REALTIME_SAMPLE_RATE = 24000;
const REALTIME_FRAME_SECONDS = 0.05;
const ACTIVE_AUDIO_RMS = 0.005;
let chunkBuffer = new Float32Array(0);
let chunkBufferStartTs = null;
let chunkSeq = 0;
let usageMsBuffer = 0;
let usageFlushTimer = null;

function concatFloat32(a, b) {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// Naive linear-interpolation resampler.
// For tighter quality swap in an OfflineAudioContext resample later.
function resample(input, inputRate, targetRate) {
  if (inputRate === targetRate) return input;
  const ratio = inputRate / targetRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcIdx = i * ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, input.length - 1);
    const t = srcIdx - lo;
    out[i] = input[lo] * (1 - t) + input[hi] * t;
  }
  return out;
}

function float32ToInt16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function audioRms(float32) {
  if (!float32.length) return 0;
  let sumSquares = 0;
  for (let i = 0; i < float32.length; i++) sumSquares += float32[i] * float32[i];
  return Math.sqrt(sumSquares / float32.length);
}

function currentTranscriber() {
  return (settings && settings.transcriber) || 'local';
}

function isRealtimeMode() {
  return currentTranscriber() === 'openai-realtime';
}

function targetSampleRate() {
  return isRealtimeMode() ? REALTIME_SAMPLE_RATE : LOCAL_SAMPLE_RATE;
}

function localChunkSeconds() {
  const model = ((settings && settings.model) || 'base').toLowerCase();
  if (model === 'tiny' || model === 'base') return 0.8;
  if (model === 'small') return 1.0;
  return 1.5;
}

function targetFrameSamples() {
  const seconds = isRealtimeMode() ? REALTIME_FRAME_SECONDS : localChunkSeconds();
  return Math.round(targetSampleRate() * seconds);
}

function buildConfigMessage() {
  return {
    type: 'config',
    sampleRate: targetSampleRate(),
    sourceLang: (settings && settings.sourceLang) || 'auto',
    targetLang: (settings && settings.targetLang) || 'ar',
    realtimeLatency: (settings && settings.realtimeLatency) || 'balanced',
    task: (settings && settings.task) || 'translate',
    transcriber: currentTranscriber(),
    model: (settings && settings.model) || 'base',
    device: (settings && settings.device) || 'cpu'
  };
}

function sendConfig() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(buildConfigMessage()));
  return true;
}

async function flushActiveUsage() {
  if (!usageMsBuffer) return;
  const activeMs = Math.round(usageMsBuffer);
  usageMsBuffer = 0;
  try {
    await chrome.runtime.sendMessage({
      target: 'background',
      type: 'aiUsage:addActiveMs',
      activeMs,
      transcriber: currentTranscriber()
    });
  } catch (e) {}
}

function trackActiveUsage(ms) {
  if (!isRealtimeMode()) return;
  usageMsBuffer += ms;
  if (usageFlushTimer) return;
  usageFlushTimer = setTimeout(() => {
    usageFlushTimer = null;
    flushActiveUsage();
  }, 1000);
}

function scheduleReconnect() {
  if (!isRunning) return;            // user hit Stop; don't reconnect
  if (reconnectTimer) return;        // already scheduled
  reconnectAttempts += 1;
  // Exponential backoff capped at 5s: 250, 500, 1000, 2000, 5000, 5000...
  const delay = Math.min(MAX_RECONNECT_DELAY_MS, 250 * Math.pow(2, reconnectAttempts - 1));
  console.warn('[sub-stream-ai offscreen] WS reconnect in', delay, 'ms (attempt', reconnectAttempts + ')');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (isRunning) openSocket();
  }, delay);
}

function openSocket() {
  const url = (settings && settings.backendUrl) || 'ws://127.0.0.1:8765/ws';
  ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  ws.addEventListener('open', () => {
    reconnectAttempts = 0;
    reconnectingForConfig = false;
    sendConfig();
    chrome.runtime.sendMessage({ target: 'background', type: 'ws:state', state: 'connected' });
  });

  ws.addEventListener('message', (evt) => {
    try {
      const data = JSON.parse(evt.data);
      if (data.type === 'transcript') {
        chrome.runtime.sendMessage({
          target: 'background',
          type: 'transcript',
          text: data.text,
          delta: data.delta,
          isFinal: !!data.isFinal,
          mode: data.mode,
          chunkId: data.chunkId,
          transcriptEmittedAt: data.transcriptEmittedAt,
          sync: data.sync
        });
      } else if (data.type === 'error') {
        chrome.runtime.sendMessage({
          target: 'background',
          type: 'backend:error',
          message: data.message
        });
      }
    } catch (e) {
      console.warn('[sub-stream-ai offscreen] bad ws msg', e);
    }
  });

  ws.addEventListener('error', () => {
    chrome.runtime.sendMessage({ target: 'background', type: 'ws:state', state: 'error' });
    // Don't spam the overlay with errors on transient drops — only the initial
    // connect failure should surface as user-visible. After we've succeeded
    // once (reconnectAttempts started at 0 and got bumped here), reconnect
    // silently in the background.
    if (reconnectAttempts === 0) {
      chrome.runtime.sendMessage({
        target: 'background',
        type: 'backend:error',
        message: 'Cannot reach backend at ' + url + '. Is the server running?'
      });
    }
  });

  ws.addEventListener('close', () => {
    if (reconnectingForConfig && isRunning) {
      reconnectingForConfig = false;
      openSocket();
      return;
    }
    chrome.runtime.sendMessage({ target: 'background', type: 'ws:state', state: 'closed' });
    // If we're still supposed to be running, try to come back. The server
    // session can die without the process dying (one bad chunk → WS closes
    // but uvicorn keeps listening). Reconnect re-attaches to the same server.
    scheduleReconnect();
  });
}

function reconnectSocketForConfig() {
  if (!isRunning) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  chunkBuffer = new Float32Array(0);
  chunkSeq = 0;
  reconnectAttempts = 0;
  reconnectingForConfig = true;
  chrome.runtime.sendMessage({ target: 'background', type: 'ws:state', state: 'applying' });

  if (!ws || ws.readyState === WebSocket.CLOSED) {
    reconnectingForConfig = false;
    openSocket();
    return;
  }
  try {
    ws.close();
  } catch (e) {
    reconnectingForConfig = false;
    openSocket();
  }
}

function sendChunkIfReady() {
  const frameSamples = targetFrameSamples();
  const sampleRate = targetSampleRate();
  while (chunkBuffer.length >= frameSamples) {
    const chunk = chunkBuffer.slice(0, frameSamples);
    chunkBuffer = chunkBuffer.slice(frameSamples);

    // The start timestamp for THIS chunk is the buffer start.
    const capturedAt = chunkBufferStartTs || (Date.now() / 1000);

    // The NEXT chunk starts after this one finishes.
    chunkBufferStartTs = capturedAt + (frameSamples / sampleRate);

    const rms = audioRms(chunk);
    const pcm16 = float32ToInt16(chunk);
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (!isRealtimeMode()) {
        const chunkId = ++chunkSeq;
        ws.send(JSON.stringify({
          type: 'chunk',
          chunkId,
          capturedAt
        }));
      }
      ws.send(pcm16.buffer);
      if (isRealtimeMode() && rms >= ACTIVE_AUDIO_RMS) {
        trackActiveUsage((pcm16.length / targetSampleRate()) * 1000);
      }
    }
  }
}

async function start(streamId, incomingSettings) {
  settings = incomingSettings || {};
  isRunning = true;
  reconnectAttempts = 0;
  usageMsBuffer = 0;
  if (usageFlushTimer) { clearTimeout(usageFlushTimer); usageFlushTimer = null; }
  chrome.runtime.sendMessage({ target: 'background', type: 'ws:state', state: 'connecting' });

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  audioContext = new AudioContext();
  sourceNode = audioContext.createMediaStreamSource(mediaStream);

  // Keep the user hearing the tab audio (capture mutes the tab by default).
  passthroughGain = audioContext.createGain();
  passthroughGain.gain.value = 1.0;
  sourceNode.connect(passthroughGain).connect(audioContext.destination);

  // Mono mixdown + buffer for realtime streaming or chunked send.
  // ScriptProcessorNode is deprecated but works reliably in offscreen contexts
  // without requiring an extra worklet file. Swap to AudioWorklet later if needed.
  processorNode = audioContext.createScriptProcessor(1024, 2, 1);
  processorNode.onaudioprocess = (e) => {
    const inBuf = e.inputBuffer;
    const ch0 = inBuf.getChannelData(0);
    const ch1 = inBuf.numberOfChannels > 1 ? inBuf.getChannelData(1) : ch0;
    const mono = new Float32Array(ch0.length);
    for (let i = 0; i < ch0.length; i++) mono[i] = (ch0[i] + ch1[i]) * 0.5;
    const resampled = resample(mono, audioContext.sampleRate, targetSampleRate());

    if (chunkBuffer.length === 0) {
      chunkBufferStartTs = Date.now() / 1000;
    }
    chunkBuffer = concatFloat32(chunkBuffer, resampled);
    sendChunkIfReady();
  };
  sourceNode.connect(processorNode);
  // Connect processor to destination with zero gain to keep it running without double audio.
  const sink = audioContext.createGain();
  sink.gain.value = 0;
  processorNode.connect(sink).connect(audioContext.destination);

  openSocket();
}

async function stop() {
  // Flip this FIRST so the WS close handler doesn't schedule a reconnect
  // against a deliberate teardown.
  isRunning = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (usageFlushTimer) { clearTimeout(usageFlushTimer); usageFlushTimer = null; }
  reconnectingForConfig = false;
  await flushActiveUsage();
  reconnectAttempts = 0;

  try { if (processorNode) processorNode.disconnect(); } catch (e) {}
  try { if (sourceNode) sourceNode.disconnect(); } catch (e) {}
  try { if (passthroughGain) passthroughGain.disconnect(); } catch (e) {}
  try { if (audioContext) await audioContext.close(); } catch (e) {}
  try { if (mediaStream) mediaStream.getTracks().forEach(t => t.stop()); } catch (e) {}
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.close(); } catch (e) {}

  mediaStream = null;
  audioContext = null;
  sourceNode = null;
  processorNode = null;
  passthroughGain = null;
  ws = null;
  chunkBuffer = new Float32Array(0);
  chunkBufferStartTs = null;
  chunkSeq = 0;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'offscreen') return;
  (async () => {
    try {
      if (msg.type === 'start') {
        await start(msg.streamId, msg.settings);
        sendResponse({ ok: true });
      } else if (msg.type === 'stop') {
        await stop();
        sendResponse({ ok: true });
      } else if (msg.type === 'settings:update') {
        const oldTranscriber = currentTranscriber();
        const oldBackendUrl = (settings && settings.backendUrl) || 'ws://127.0.0.1:8765/ws';
        if (currentTranscriber() === 'openai-realtime') await flushActiveUsage();
        settings = { ...(settings || {}), ...(msg.settings || {}) };
        const nextBackendUrl = (settings && settings.backendUrl) || 'ws://127.0.0.1:8765/ws';
        if (oldTranscriber !== currentTranscriber() || oldBackendUrl !== nextBackendUrl) {
          reconnectSocketForConfig();
        } else {
          sendConfig();
        }
        sendResponse({ ok: true });
      }
    } catch (err) {
      console.error('[sub-stream-ai offscreen]', err);
      sendResponse({ ok: false, error: String(err) });
    }
  })();
  return true;
});
