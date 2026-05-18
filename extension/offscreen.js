// Kami Subs — offscreen document
// Captures tab audio via the streamId provided by background.js,
// sends realtime frames or chunked PCM over WebSocket to the backend,
// forwards transcripts back to background.js -> content overlay.

let mediaStream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let passthroughGain = null;
let audioDelayNode = null;
let ws = null;
let settings = null;
let isRunning = false;          // true between start() and stop()
let reconnectAttempts = 0;
let reconnectTimer = null;
const MAX_RECONNECT_DELAY_MS = 5000;
const MAX_AUDIO_DELAY_MS = 8000;

// Realtime Cloud sends ~100ms 24kHz frames. Local/chunked modes keep 1.5s 16kHz chunks.
const LOCAL_SAMPLE_RATE = 16000;
const REALTIME_SAMPLE_RATE = 24000;
const LOCAL_CHUNK_SECONDS = 1.5;
const REALTIME_FRAME_SECONDS = 0.05;
let chunkBuffer = new Float32Array(0);
let chunkSeq = 0;

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

function currentTranscriber() {
  return (settings && settings.transcriber) || 'openai-realtime';
}

function isRealtimeMode() {
  return currentTranscriber() === 'openai-realtime';
}

function targetSampleRate() {
  return isRealtimeMode() ? REALTIME_SAMPLE_RATE : LOCAL_SAMPLE_RATE;
}

function targetFrameSamples() {
  const seconds = isRealtimeMode() ? REALTIME_FRAME_SECONDS : LOCAL_CHUNK_SECONDS;
  return Math.round(targetSampleRate() * seconds);
}

function scheduleReconnect() {
  if (!isRunning) return;            // user hit Stop; don't reconnect
  if (reconnectTimer) return;        // already scheduled
  reconnectAttempts += 1;
  // Exponential backoff capped at 5s: 250, 500, 1000, 2000, 5000, 5000...
  const delay = Math.min(MAX_RECONNECT_DELAY_MS, 250 * Math.pow(2, reconnectAttempts - 1));
  console.warn('[kami-subs offscreen] WS reconnect in', delay, 'ms (attempt', reconnectAttempts + ')');
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
    ws.send(JSON.stringify({
      type: 'config',
      sampleRate: targetSampleRate(),
      sourceLang: (settings && settings.sourceLang) || 'auto',
      targetLang: (settings && settings.targetLang) || 'ar',
      task: (settings && settings.task) || 'translate',
      transcriber: currentTranscriber()
    }));
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
          mode: data.mode
        });
      } else if (data.type === 'error') {
        chrome.runtime.sendMessage({
          target: 'background',
          type: 'backend:error',
          message: data.message
        });
      }
    } catch (e) {
      console.warn('[kami-subs offscreen] bad ws msg', e);
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
    chrome.runtime.sendMessage({ target: 'background', type: 'ws:state', state: 'closed' });
    // If we're still supposed to be running, try to come back. The server
    // session can die without the process dying (one bad chunk → WS closes
    // but uvicorn keeps listening). Reconnect re-attaches to the same server.
    scheduleReconnect();
  });
}

function sendChunkIfReady() {
  const frameSamples = targetFrameSamples();
  while (chunkBuffer.length >= frameSamples) {
    const chunk = chunkBuffer.slice(0, frameSamples);
    chunkBuffer = chunkBuffer.slice(frameSamples);
    const pcm16 = float32ToInt16(chunk);
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (!isRealtimeMode()) {
        const chunkId = ++chunkSeq;
        ws.send(JSON.stringify({
          type: 'chunk',
          chunkId,
          capturedAt: Date.now() / 1000
        }));
      }
      ws.send(pcm16.buffer);
    }
  }
}

function getAudioDelayMs() {
  const raw = settings && Number(settings.audioDelayMs);
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(MAX_AUDIO_DELAY_MS, raw));
}

function applyAudioDelay() {
  if (!audioContext || !audioDelayNode) return;
  const seconds = getAudioDelayMs() / 1000;
  audioDelayNode.delayTime.setTargetAtTime(seconds, audioContext.currentTime, 0.03);
}

async function start(streamId, incomingSettings) {
  settings = incomingSettings || {};
  isRunning = true;
  reconnectAttempts = 0;
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
  // The delay node lets users manually sync late subtitles by delaying audio.
  passthroughGain = audioContext.createGain();
  passthroughGain.gain.value = 1.0;
  audioDelayNode = audioContext.createDelay(MAX_AUDIO_DELAY_MS / 1000);
  sourceNode.connect(passthroughGain).connect(audioDelayNode).connect(audioContext.destination);
  applyAudioDelay();

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
  reconnectAttempts = 0;

  try { if (processorNode) processorNode.disconnect(); } catch (e) {}
  try { if (sourceNode) sourceNode.disconnect(); } catch (e) {}
  try { if (passthroughGain) passthroughGain.disconnect(); } catch (e) {}
  try { if (audioDelayNode) audioDelayNode.disconnect(); } catch (e) {}
  try { if (audioContext) await audioContext.close(); } catch (e) {}
  try { if (mediaStream) mediaStream.getTracks().forEach(t => t.stop()); } catch (e) {}
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.close(); } catch (e) {}

  mediaStream = null;
  audioContext = null;
  sourceNode = null;
  processorNode = null;
  passthroughGain = null;
  audioDelayNode = null;
  ws = null;
  chunkBuffer = new Float32Array(0);
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
        settings = { ...(settings || {}), ...(msg.settings || {}) };
        applyAudioDelay();
        sendResponse({ ok: true });
      }
    } catch (err) {
      console.error('[kami-subs offscreen]', err);
      sendResponse({ ok: false, error: String(err) });
    }
  })();
  return true;
});
