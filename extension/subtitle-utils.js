(function (root) {
  const TIMESTAMP_RE = /(?:(\d{1,2}):)?(\d{2}):(\d{2})[,.](\d{3})/;

  function normalizeSubtitleText(text) {
    return String(text || '')
      .replace(/\r/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function parseTimestamp(value) {
    const match = String(value || '').trim().match(TIMESTAMP_RE);
    if (!match) return null;
    const hours = Number(match[1] || 0);
    const minutes = Number(match[2] || 0);
    const seconds = Number(match[3] || 0);
    const millis = Number(match[4] || 0);
    return (((hours * 60 + minutes) * 60 + seconds) * 1000) + millis;
  }

  function stripVttSettings(value) {
    return String(value || '').trim().split(/\s+/)[0];
  }

  function parseSrt(input) {
    const blocks = String(input || '')
      .replace(/^\uFEFF/, '')
      .replace(/\r/g, '')
      .split(/\n{2,}/);
    const cues = [];

    for (const block of blocks) {
      const lines = block.split('\n').map((line) => line.trimEnd()).filter(Boolean);
      if (!lines.length) continue;
      const timingIndex = lines.findIndex((line) => line.includes('-->'));
      if (timingIndex === -1) continue;
      const [rawStart, rawEnd] = lines[timingIndex].split('-->');
      const startMs = parseTimestamp(rawStart);
      const endMs = parseTimestamp(rawEnd);
      if (startMs === null || endMs === null || endMs < startMs) continue;
      const text = normalizeSubtitleText(lines.slice(timingIndex + 1).join('\n'));
      if (!text) continue;
      cues.push({
        id: lines[0] && timingIndex > 0 ? lines[0] : String(cues.length + 1),
        startMs,
        endMs,
        originalText: text,
        translatedText: '',
      });
    }

    return cues;
  }

  function parseVtt(input) {
    const lines = String(input || '')
      .replace(/^\uFEFF/, '')
      .replace(/\r/g, '')
      .split('\n');
    const cues = [];
    let i = 0;

    while (i < lines.length) {
      let line = lines[i].trim();
      if (!line || line === 'WEBVTT' || line.startsWith('NOTE') || line.startsWith('STYLE') || line.startsWith('REGION')) {
        i += 1;
        continue;
      }

      let id = '';
      if (!line.includes('-->') && i + 1 < lines.length && lines[i + 1].includes('-->')) {
        id = line;
        i += 1;
        line = lines[i].trim();
      }
      if (!line.includes('-->')) {
        i += 1;
        continue;
      }

      const [rawStart, rawEndWithSettings] = line.split('-->');
      const startMs = parseTimestamp(rawStart);
      const endMs = parseTimestamp(stripVttSettings(rawEndWithSettings));
      i += 1;
      const textLines = [];
      while (i < lines.length && lines[i].trim() !== '') {
        textLines.push(lines[i].trimEnd());
        i += 1;
      }
      const text = normalizeSubtitleText(textLines.join('\n'));
      if (startMs !== null && endMs !== null && endMs >= startMs && text) {
        cues.push({
          id: id || String(cues.length + 1),
          startMs,
          endMs,
          originalText: text,
          translatedText: '',
        });
      }
    }

    return cues;
  }

  async function hashFileContent(text) {
    const cryptoApi = root.crypto || (typeof crypto !== 'undefined' ? crypto : null);
    if (cryptoApi && cryptoApi.subtle && typeof TextEncoder !== 'undefined') {
      const bytes = new TextEncoder().encode(String(text || ''));
      const digest = await cryptoApi.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
    }

    let hash = 2166136261;
    const source = String(text || '');
    for (let i = 0; i < source.length; i += 1) {
      hash ^= source.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function getActiveCue(cues, currentTimeMs, offsetMs = 0) {
    const t = Number(currentTimeMs || 0) + Number(offsetMs || 0);
    return (cues || []).find((cue) => cue.startMs <= t && t <= cue.endMs) || null;
  }

  function parseSubtitleFile(filename, text) {
    const lower = String(filename || '').toLowerCase();
    if (lower.endsWith('.vtt')) return parseVtt(text);
    if (lower.endsWith('.srt')) return parseSrt(text);
    throw new Error('Only .srt and .vtt subtitle files are supported.');
  }

  const api = {
    parseSrt,
    parseVtt,
    parseSubtitleFile,
    parseTimestamp,
    hashFileContent,
    getActiveCue,
  };

  root.SubStreamSubtitles = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
