const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const subtitles = require('../extension/subtitle-utils.js');

function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok - ${name}`))
    .catch((error) => {
      console.error(`not ok - ${name}`);
      console.error(error);
      process.exitCode = 1;
    });
}

test('SRT parsing keeps timing and multi-line text', () => {
  const cues = subtitles.parseSrt(`1
00:00:01,200 --> 00:00:03,400
hello
world

2
00:00:04,000 --> 00:00:05,000
next`);
  assert.strictEqual(cues.length, 2);
  assert.deepStrictEqual(cues[0], {
    id: '1',
    startMs: 1200,
    endMs: 3400,
    originalText: 'hello\nworld',
    translatedText: '',
  });
});

test('VTT parsing supports cue ids and settings', () => {
  const cues = subtitles.parseVtt(`WEBVTT

intro
00:00:00.500 --> 00:00:02.000 align:center
first line

00:00:03.000 --> 00:00:04.250
second line`);
  assert.strictEqual(cues.length, 2);
  assert.strictEqual(cues[0].id, 'intro');
  assert.strictEqual(cues[0].startMs, 500);
  assert.strictEqual(cues[1].endMs, 4250);
});

test('cue sync applies manual offset', () => {
  const cues = [
    { id: 'a', startMs: 1000, endMs: 2000, originalText: 'a', translatedText: '' },
    { id: 'b', startMs: 2500, endMs: 3000, originalText: 'b', translatedText: '' },
  ];
  assert.strictEqual(subtitles.getActiveCue(cues, 900, 100).id, 'a');
  assert.strictEqual(subtitles.getActiveCue(cues, 2100, 400).id, 'b');
  assert.strictEqual(subtitles.getActiveCue(cues, 2100, 0), null);
});

test('background translation cache returns cached cues', async () => {
  const storage = {
    'substream.importedSubtitleCache.v1': {
      'hash:auto:en:backend-openai': {
        cues: [{ id: '1', startMs: 0, endMs: 1000, originalText: 'hola', translatedText: 'hello' }],
      },
    },
  };
  const sandbox = loadBackgroundSandbox(storage);
  const result = await sandbox.translateImportedSubtitleCues({
    fileHash: 'hash',
    cues: [{ id: '1', startMs: 0, endMs: 1000, originalText: 'hola', translatedText: '' }],
    settings: { sourceLang: 'auto', targetLang: 'en', importedSubtitleModel: 'backend-openai' },
    force: false,
  });
  assert.strictEqual(result.cacheHit, true);
  assert.strictEqual(result.cues[0].translatedText, 'hello');
});

test('background translates multi-line subtitle batches', async () => {
  const storage = {};
  const sandbox = loadBackgroundSandbox(storage);
  sandbox.fetch = async () => ({
    ok: true,
    json: async () => ({ text: '1. hello there\n2. good night' }),
  });
  const result = await sandbox.translateImportedSubtitleCues({
    fileHash: 'new-hash',
    cues: [
      { id: '1', startMs: 0, endMs: 1000, originalText: 'hola\namigo', translatedText: '' },
      { id: '2', startMs: 1500, endMs: 2500, originalText: 'buenas noches', translatedText: '' },
    ],
    settings: { sourceLang: 'es', targetLang: 'en', backendUrl: 'ws://127.0.0.1:8765/ws' },
    force: true,
  });
  assert.strictEqual(result.cacheHit, false);
  assert.strictEqual(result.cues[0].translatedText, 'hello there');
  assert.strictEqual(result.cues[1].translatedText, 'good night');
});

test('background picks the frame with the largest visible video for imported subtitles', async () => {
  const storage = {};
  const sandbox = loadBackgroundSandbox(storage);
  sandbox.chrome.scripting.executeScript = async () => ([
    { frameId: 0, result: { hasVideo: false, score: 0 } },
    { frameId: 2, result: { hasVideo: true, score: 64000 } },
    { frameId: 5, result: { hasVideo: true, score: 230400 } },
  ]);
  const frameId = await sandbox.findImportedSubtitleFrameId(123);
  assert.strictEqual(frameId, 5);
});

test('background falls back to a tab-level message when frame-targeted imported subtitle send fails', async () => {
  const storage = {};
  const sandbox = loadBackgroundSandbox(storage);
  const calls = [];
  sandbox.chrome.tabs.sendMessage = async (tabId, message, options) => {
    calls.push({ tabId, message, options });
    if (options && options.frameId === 7) throw new Error('frame unavailable');
    return { ok: true };
  };
  const result = await sandbox.sendImportedSubtitleMessage(55, { type: 'importedSubtitles:start' }, 7);
  assert.deepStrictEqual(result, { ok: true });
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].options.frameId, 7);
  assert.strictEqual(calls[1].options, undefined);
});

function loadBackgroundSandbox(storage) {
  const backgroundPath = path.resolve(__dirname, '../extension/background.js');
  const source = fs.readFileSync(backgroundPath, 'utf8');
  const sandbox = {
    console,
    URL,
    setTimeout,
    clearTimeout,
    fetch: async () => { throw new Error('fetch should not be called'); },
    importScripts: () => {},
    SubStreamSubtitles: subtitles,
    chrome: {
      storage: {
        local: {
          get: async (key) => ({ [key]: storage[key] }),
          set: async (value) => Object.assign(storage, value),
        },
      },
      runtime: { onMessage: { addListener: () => {} } },
      tabs: {
        onRemoved: { addListener: () => {} },
        sendMessage: async () => ({ ok: true }),
      },
      scripting: {
        insertCSS: async () => {},
        executeScript: async () => {},
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${source}
this.translateImportedSubtitleCues = translateImportedSubtitleCues;
this.findImportedSubtitleFrameId = findImportedSubtitleFrameId;
this.sendImportedSubtitleMessage = sendImportedSubtitleMessage;`, sandbox);
  return sandbox;
}
