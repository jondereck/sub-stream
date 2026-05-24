// Sub Stream AI — offscreen document
// Captures tab audio via the streamId provided by background.js,
// sends realtime frames or chunked PCM over WebSocket to the backend,
// forwards transcripts back to background.js -> content overlay.

let mediaStream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let passthroughGain = null;
let processorSink = null;
let ws = null;
let settings = null;
let isRunning = false;          // true between start() and stop()
let reconnectAttempts = 0;
let reconnectTimer = null;
let reconnectingForConfig = false;
const MAX_RECONNECT_DELAY_MS = 5000;

// Realtime Cloud sends tiny 24kHz frames. Chunked engines use shorter windows
// than classic subtitle batching so transcription starts sooner.
const LOCAL_SAMPLE_RATE = 16000;
const REALTIME_SAMPLE_RATE = 24000;
const REALTIME_FRAME_SECONDS = 0.02;
const DEFAULT_CHUNK_DURATION_MS = 300;
const DEFAULT_MAX_BUFFER_MS = 450;
const DEFAULT_VAD_SILENCE_MS = 220;
const DEFAULT_TRANSLATION_FLUSH_MS = 180;
const DEFAULT_TRANSLATION_DISPLAY_MODE = 'translation_replace';
const DEFAULT_TRANSLATION_GRACE_MS = 100;
const SUBTITLE_MODES = new Set(['fast', 'balanced', 'accurate']);
const TRANSLATION_DISPLAY_MODES = new Set(['translation_replace', 'translation_dual']);
const TRANSLATION_MODES = new Set(['auto', 'filipino_english']);
const ACTIVE_AUDIO_RMS = 0.005;
const REALTIME_TRANSCRIBERS = new Set(['openai-realtime', 'openai-realtime-translate']);
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

function handleInputAudio(mono) {
  if (!isRunning || !audioContext) return;
  const resampled = resample(mono, audioContext.sampleRate, targetSampleRate());

  if (chunkBuffer.length === 0) {
    chunkBufferStartTs = Date.now() / 1000;
  }
  chunkBuffer = concatFloat32(chunkBuffer, resampled);
  sendChunkIfReady();
}

async function createAudioProcessorNode() {
  if (audioContext.audioWorklet) {
    await audioContext.audioWorklet.addModule(chrome.runtime.getURL('audio-worklet.js'));
    const node = new AudioWorkletNode(audioContext, 'substream-audio-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    node.port.onmessage = (event) => {
      if (event.data instanceof Float32Array) {
        handleInputAudio(event.data);
      }
    };
    return node;
  }

  const node = audioContext.createScriptProcessor(1024, 2, 1);
  node.onaudioprocess = (e) => {
    const inBuf = e.inputBuffer;
    const ch0 = inBuf.getChannelData(0);
    const ch1 = inBuf.numberOfChannels > 1 ? inBuf.getChannelData(1) : ch0;
    const mono = new Float32Array(ch0.length);
    for (let i = 0; i < ch0.length; i++) mono[i] = (ch0[i] + ch1[i]) * 0.5;
    handleInputAudio(mono);
  };
  return node;
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

function currentSubtitleMode() {
  const mode = String((settings && settings.realtimeLatency) || 'balanced').toLowerCase();
  if (mode === 'stable') return 'accurate';
  return SUBTITLE_MODES.has(mode) ? mode : 'balanced';
}

function currentTranslator() {
  return 'openai';
}

function isRealtimeMode() {
  return REALTIME_TRANSCRIBERS.has(currentTranscriber());
}

function isOpenAiChunkedMode() {
  return currentTranscriber() === 'openai-chunked';
}

function targetSampleRate() {
  return isRealtimeMode() ? REALTIME_SAMPLE_RATE : LOCAL_SAMPLE_RATE;
}

function localChunkSeconds() {
  const configuredMs = clampLatencyMs(settings && settings.chunkDurationMs, 250, 5000, DEFAULT_CHUNK_DURATION_MS);
  if (isOpenAiChunkedMode()) return Math.min(configuredMs, 900) / 1000;
  const model = ((settings && settings.model) || 'base').toLowerCase();
  const modelDefaultMs = model === 'tiny' || model === 'base' ? 650 : model === 'small' ? 850 : 1200;
  return Math.min(configuredMs, modelDefaultMs) / 1000;
}

function clampLatencyMs(value, min, max, fallback) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function partialEmitEnabled() {
  return currentSubtitleMode() !== 'accurate';
}

function currentTranslationDisplayMode() {
  const mode = String((settings && settings.translationDisplayMode) || DEFAULT_TRANSLATION_DISPLAY_MODE).toLowerCase();
  return TRANSLATION_DISPLAY_MODES.has(mode) ? mode : DEFAULT_TRANSLATION_DISPLAY_MODE;
}

function currentTranslationMode() {
  const mode = String((settings && settings.translationMode) || 'auto').toLowerCase().replace(/-/g, '_');
  return TRANSLATION_MODES.has(mode) ? mode : 'auto';
}

function currentTranslationGraceMs() {
  const graceMs = clampLatencyMs(settings && settings.translationGraceMs, 0, 2000, DEFAULT_TRANSLATION_GRACE_MS);
  return currentTranscriber() === 'openai-realtime-translate' ? Math.min(graceMs, 75) : graceMs;
}

function targetFrameSamples() {
  const maxBufferMs = clampLatencyMs(settings && settings.maxBufferMs, 250, 10000, DEFAULT_MAX_BUFFER_MS);
  const seconds = isRealtimeMode()
    ? Math.min(REALTIME_FRAME_SECONDS, maxBufferMs / 1000)
    : Math.min(localChunkSeconds(), maxBufferMs / 1000);
  return Math.round(targetSampleRate() * seconds);
}

function buildConfigMessage() {
  return {
    type: 'config',
    sampleRate: targetSampleRate(),
    sourceLang: (settings && settings.sourceLang) || 'auto',
    targetLang: (settings && settings.targetLang) || 'ar',
    translationMode: currentTranslationMode(),
    realtimeLatency: currentSubtitleMode(),
    task: (settings && settings.task) || 'translate',
    translator: currentTranslator(),
    transcriber: currentTranscriber(),
    model: (settings && settings.model) || 'base',
    device: (settings && settings.device) || 'cpu',
    chunkDurationMs: clampLatencyMs(settings && settings.chunkDurationMs, 250, 5000, DEFAULT_CHUNK_DURATION_MS),
    maxBufferMs: clampLatencyMs(settings && settings.maxBufferMs, 250, 10000, DEFAULT_MAX_BUFFER_MS),
    vadSilenceMs: clampLatencyMs(settings && settings.vadSilenceMs, 150, 2000, DEFAULT_VAD_SILENCE_MS),
    partialEmitEnabled: partialEmitEnabled(),
    translationFlushMs: clampLatencyMs(settings && settings.translationFlushMs, 150, 3000, DEFAULT_TRANSLATION_FLUSH_MS),
    showSourceFirst: settings && typeof settings.showSourceFirst === 'boolean' ? settings.showSourceFirst : true,
    translationDisplayMode: currentTranslationDisplayMode(),
    translationGraceMs: currentTranslationGraceMs()
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
          stage: data.stage,
          sourceText: data.sourceText,
          translatedText: data.translatedText,
          captionId: data.captionId,
          segmentId: data.segmentId,
          phase: data.phase,
          chunkId: data.chunkId,
          receivedAt: data.receivedAt,
          segmentStartTs: data.segmentStartTs,
          segmentEndTs: data.segmentEndTs,
          transcriptEmittedAt: data.transcriptEmittedAt,
          translationStartedAt: data.translationStartedAt,
          translationEmittedAt: data.translationEmittedAt,
          transcriptToTranslationDelayMs: data.transcriptToTranslationDelayMs,
          showSourceFirst: data.showSourceFirst,
          translationDisplayMode: data.translationDisplayMode,
          translationGraceMs: data.translationGraceMs,
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
      const chunkId = ++chunkSeq;
      const createdAtMs = Date.now();
      console.debug('[sub-stream-ai offscreen] chunk created', {
        chunkId,
        capturedAt,
        durationMs: Math.round((frameSamples / sampleRate) * 1000),
        bufferedSamples: chunkBuffer.length,
        transcriber: currentTranscriber()
      });
      ws.send(JSON.stringify({
        type: 'chunk',
        chunkId,
        capturedAt,
        duration: frameSamples / sampleRate,
        sampleRate
      }));
      ws.send(pcm16.buffer);
      console.debug('[sub-stream-ai offscreen] chunk sent', {
        chunkId,
        sentAt: createdAtMs / 1000,
        sendDelayMs: Math.max(0, createdAtMs - Math.round(capturedAt * 1000))
      });
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
  processorNode = await createAudioProcessorNode();
  sourceNode.connect(processorNode);
  // Connect processor to destination with zero gain to keep it running without double audio.
  processorSink = audioContext.createGain();
  processorSink.gain.value = 0;
  processorNode.connect(processorSink).connect(audioContext.destination);

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
  try { if (processorSink) processorSink.disconnect(); } catch (e) {}
  try { if (sourceNode) sourceNode.disconnect(); } catch (e) {}
  try { if (passthroughGain) passthroughGain.disconnect(); } catch (e) {}
  try { if (audioContext) await audioContext.close(); } catch (e) {}
  try { if (mediaStream) mediaStream.getTracks().forEach(t => t.stop()); } catch (e) {}
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.close(); } catch (e) {}

  mediaStream = null;
  audioContext = null;
  sourceNode = null;
  processorNode = null;
  processorSink = null;
  passthroughGain = null;
  ws = null;
  chunkBuffer = new Float32Array(0);
  chunkBufferStartTs = null;
  chunkSeq = 0;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;
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
        if (isRealtimeMode()) await flushActiveUsage();
        settings = { ...(settings || {}), ...(msg.settings || {}) };
        const nextBackendUrl = (settings && settings.backendUrl) || 'ws://127.0.0.1:8765/ws';
        if (oldTranscriber !== currentTranscriber() || oldBackendUrl !== nextBackendUrl) {
          reconnectSocketForConfig();
        } else {
          sendConfig();
        }
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: 'Unknown offscreen message.' });
      }
    } catch (err) {
      console.error('[sub-stream-ai offscreen]', err);
      sendResponse({ ok: false, error: String(err) });
    }
  })();
  return true;
});
