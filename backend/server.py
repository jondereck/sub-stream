"""
Kami Subs — local Whisper + translation backend.

WebSocket protocol:
  client -> server (text JSON):
    { "type": "config",
      "sampleRate": 16000,
      "sourceLang": "auto" | "en" | "es" | ...,
      "targetLang": "ar",
      "task": "transcribe" | "translate" }
  client -> server (binary): raw little-endian Int16 PCM, mono, sampleRate Hz

  server -> client (text JSON):
    { "type": "transcript", "text": "...", "isFinal": true }
    { "type": "error", "message": "..." }
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import os
import re
import sys
import time
import wave
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path

# Make pip-installed NVIDIA libs discoverable by ctranslate2 on Windows.
# Without this, faster-whisper crashes with "cublas64_12.dll not found"
# even though the package is installed.
def _register_nvidia_dll_dirs() -> None:
    if sys.platform != "win32":
        return
    # `nvidia.cublas` etc are themselves PEP-420 namespace packages — they have
    # no __init__.py, so __file__ is None. Use __path__ (which IS populated for
    # namespace packages) to locate the install root.
    nvidia_root: Path | None = None
    for mod_name in ("nvidia.cublas", "nvidia.cudnn", "nvidia.cuda_nvrtc"):
        try:
            mod = __import__(mod_name, fromlist=["__path__"])
        except ImportError:
            continue
        paths = list(getattr(mod, "__path__", []) or [])
        if paths:
            nvidia_root = Path(paths[0]).resolve().parent
            break
    if nvidia_root is None:
        print("[kami-subs] nvidia packages not installed; running on CPU only")
        return
    print(f"[kami-subs] nvidia root: {nvidia_root}")

    bin_dirs = [nvidia_root / sub for sub in (
        "cuda_runtime/bin", "cublas/bin", "cudnn/bin", "cuda_nvrtc/bin",
    )]
    bin_dirs = [d for d in bin_dirs if d.exists()]

    for d in bin_dirs:
        try:
            os.add_dll_directory(str(d))
        except (AttributeError, OSError):
            pass
        os.environ["PATH"] = str(d) + os.pathsep + os.environ.get("PATH", "")

    # Preload the critical DLLs explicitly. `os.add_dll_directory` doesn't
    # always reach the threads ctranslate2 spawns for GPU work, so we force
    # them into the process address space here. Once loaded, the OS resolves
    # the same name to the in-memory module from any thread.
    import ctypes
    # ORDER MATTERS: load CUDA runtime first since cuBLAS/cuDNN depend on it.
    preload = [
        ("cuda_runtime/bin", "cudart64_12.dll"),
        ("cublas/bin",       "cublas64_12.dll"),
        ("cublas/bin",       "cublasLt64_12.dll"),
        ("cuda_nvrtc/bin",   "nvrtc64_120_0.dll"),
        ("cudnn/bin",        "cudnn64_9.dll"),
        ("cudnn/bin",        "cudnn_cnn64_9.dll"),
        ("cudnn/bin",        "cudnn_ops64_9.dll"),
        ("cudnn/bin",        "cudnn_engines_precompiled64_9.dll"),
        ("cudnn/bin",        "cudnn_engines_runtime_compiled64_9.dll"),
        ("cudnn/bin",        "cudnn_graph64_9.dll"),
        ("cudnn/bin",        "cudnn_heuristic64_9.dll"),
        ("cudnn/bin",        "cudnn_adv64_9.dll"),
    ]
    for sub, name in preload:
        full = nvidia_root / sub / name
        if not full.exists():
            continue
        try:
            ctypes.WinDLL(str(full))
        except OSError as e:
            print(f"[kami-subs] failed to preload {name}: {e}")

_register_nvidia_dll_dirs()

import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from config import (
    MODEL_SIZE, DEVICE, COMPUTE_TYPE, TRANSLATOR, TRANSCRIBER,
    OPENAI_TRANSCRIBE_MODEL, HOST, PORT, SAMPLE_RATE, REALTIME_SAMPLE_RATE,
    VAD_FILTER, MAX_CHUNK_LAG_S,
)

log = logging.getLogger("kami-subs")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

# ----- model load (lazy, once per process) ----------------------------------
_model = None
_openai_client = None

OPENAI_REALTIME_TRANSLATE_MODEL = "gpt-realtime-translate"
OPENAI_REALTIME_TRANSLATE_URL = (
    "wss://api.openai.com/v1/realtime/translations"
    f"?model={OPENAI_REALTIME_TRANSLATE_MODEL}"
)
REALTIME_TRANSCRIBER = "openai-realtime"
REALTIME_PHRASE_CHARS = 90
REALTIME_PHRASE_IDLE_S = 1.3
ALLOWED_TRANSCRIBERS = {"local", "openai", REALTIME_TRANSCRIBER}
ALLOWED_TARGET_LANGS = {
    "ar", "en", "es", "fr", "de", "tr", "ja", "ko", "zh", "hi",
    "it", "pt", "ru", "id", "ms", "th", "vi", "fil",
}

def get_model():
    global _model
    if _model is None:
        from faster_whisper import WhisperModel
        log.info("loading whisper model=%s device=%s compute=%s", MODEL_SIZE, DEVICE, COMPUTE_TYPE)
        _model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
        log.info("whisper model ready")
    return _model


def get_openai_client():
    global _openai_client
    if _openai_client is None:
        if not os.getenv("OPENAI_API_KEY"):
            raise RuntimeError("OPENAI_API_KEY is not set. Add it to .env or backend/.env.")
        from openai import OpenAI
        _openai_client = OpenAI()
    return _openai_client


# ----- hallucination filter -------------------------------------------------
#
# Whisper was trained on millions of fansub files that ended with translator
# credits. On uncertain audio (intro music, accents, silence the gate missed)
# it "completes" by generating those credits — most commonly:
#   "ترجمة موقع xxxx.com" / "ترجمة وتعديل ..." / "Subtitles by ..."
#   "Amara.org community" / "addic7ed.com" / "opensubtitles..."
#   "Thanks for watching" / "Please subscribe" / "شكرا للمشاهدة"
#
# Strategy: only drop the chunk if the ENTIRE transcript looks like a credit
# line. Don't filter on substring match — real video content might genuinely
# reference a website (e.g. a news clip saying "from cnn.com").

_HALLUCINATION_PATTERNS = [
    # Arabic subtitle credits — the dominant hallucination in the user's case.
    # ترجمة (sing), ترجمات (plural), ترجم (verb), ترجمها (he translated it) —
    # all valid lead-ins to a credit. \S* covers the suffix variants.
    re.compile(r"^\s*ترجم\S*\s+(?:موقع|من|بواسطة|وتعديل|تعديل|وعدل|عدل|"
               r"ورفع|وتوقيت|وتدقيق|وإنتاج|فيلم|الفيلم|الحلقة|للعربية)",
               re.IGNORECASE),
    re.compile(r"^\s*ترجم\S*\s+\S+\s*$", re.IGNORECASE),
    re.compile(r"^\s*شكر[ا]?\s+(?:للمشاهدة|على المشاهدة)\s*[!.\s]*$", re.IGNORECASE),
    # English subtitle credits
    re.compile(r"^\s*(?:subtitles?|captions?)\s+(?:by|provided\s+by|from)\b", re.IGNORECASE),
    re.compile(r"^\s*subtitled\s+by\b", re.IGNORECASE),
    re.compile(r"^\s*(?:transcript|translation)\s+by\b", re.IGNORECASE),
    re.compile(r"^\s*(?:thank\s+you|thanks)\s+for\s+watching[!.\s]*$", re.IGNORECASE),
    re.compile(r"^\s*(?:please\s+)?(?:like\s+and\s+)?subscribe\b", re.IGNORECASE),
    # Whole text is just a known subtitle-site domain
    re.compile(r"^\s*(?:www\.|https?://)?(?:amara\.org|addic7ed\.com|opensubtitles|subscene|"
               r"podnapisi|subdl|subtitleseeker|yifysubtitles)\b\S*\s*$", re.IGNORECASE),
    # Whole text is a single bare domain (e.g. "xxx.com")
    re.compile(r"^\s*(?:www\.|https?://)?[a-z0-9-]{2,}\.(?:com|net|org|tv|io|co|me)\b\S*\s*$",
               re.IGNORECASE),
    # Music tags whisper sometimes emits in transcribe mode
    re.compile(r"^\s*[\[\(]?\s*(?:music|applause|silence|♪+)\s*[\]\)]?\s*$", re.IGNORECASE),
]


def looks_like_hallucination(text: str) -> bool:
    t = (text or "").strip()
    if not t:
        return False
    return any(p.search(t) for p in _HALLUCINATION_PATTERNS)


# ----- translation ----------------------------------------------------------
def translate(text: str, src: str, tgt: str) -> str:
    if not text.strip() or src == tgt:
        return text
    if TRANSLATOR == "none":
        return text
    try:
        if TRANSLATOR == "google":
            from deep_translator import GoogleTranslator
            src_arg = "auto" if src in (None, "", "auto") else src
            return GoogleTranslator(source=src_arg, target=tgt).translate(text)
    except Exception as e:
        log.warning("translation failed (%s -> %s): %s", src, tgt, e)
    return text


# ----- session --------------------------------------------------------------
@dataclass
class Session:
    sample_rate: int = SAMPLE_RATE
    source_lang: str = "auto"
    target_lang: str = "ar"
    task: str = "transcribe"
    transcriber: str = TRANSCRIBER if TRANSCRIBER in ALLOWED_TRANSCRIBERS else "local"
    chunk_id: int = 0
    next_chunk_id: int | None = None
    next_chunk_captured_at: float | None = None


def transcribe_chunk(session: Session, pcm_int16: np.ndarray) -> tuple[str, str]:
    """Returns (raw_text, detected_lang)."""
    if session.transcriber == "openai":
        return transcribe_chunk_openai(session, pcm_int16)
    return transcribe_chunk_local(session, pcm_int16)


def safe_transcriber(value: str | None) -> str:
    transcriber = (value or TRANSCRIBER or "local").strip().lower()
    return transcriber if transcriber in ALLOWED_TRANSCRIBERS else "local"


def safe_target_lang(value: str | None) -> str:
    lang = (value or "ar").strip().lower()
    return lang if lang in ALLOWED_TARGET_LANGS else "ar"


def safe_sample_rate(value, default: int) -> int:
    try:
        sample_rate = int(value)
    except (TypeError, ValueError):
        return default
    if sample_rate in (SAMPLE_RATE, REALTIME_SAMPLE_RATE):
        return sample_rate
    return default


def apply_config(session: Session, cfg: dict) -> None:
    if "transcriber" in cfg:
        session.transcriber = safe_transcriber(cfg.get("transcriber"))
    default_rate = REALTIME_SAMPLE_RATE if session.transcriber == REALTIME_TRANSCRIBER else SAMPLE_RATE
    session.sample_rate = safe_sample_rate(cfg.get("sampleRate", session.sample_rate), default_rate)
    session.source_lang = cfg.get("sourceLang", session.source_lang) or "auto"
    session.target_lang = safe_target_lang(cfg.get("targetLang", session.target_lang))
    session.task = cfg.get("task", session.task) or "transcribe"


def transcribe_chunk_local(session: Session, pcm_int16: np.ndarray) -> tuple[str, str]:
    """Returns (raw_text, detected_lang) from local faster-whisper."""
    if pcm_int16.size == 0:
        return "", session.source_lang or "auto"
    audio = pcm_int16.astype(np.float32) / 32768.0
    model = get_model()
    lang = None if session.source_lang in (None, "", "auto") else session.source_lang
    segments, info = model.transcribe(
        audio,
        language=lang,
        task=session.task if session.task in ("transcribe", "translate") else "transcribe",
        vad_filter=VAD_FILTER,
        beam_size=1,                   # fast; bump to 5 for quality
        # initial_prompt is intentionally OMITTED. It primes whisper with the
        # rolling transcript history, which is the #1 cause of fansub-credit
        # hallucinations in live captioning — past credit-shaped fragments
        # in the prompt produce more credit-shaped output. Cross-chunk name
        # consistency loss is worth the trade.
        condition_on_previous_text=False,
        no_speech_threshold=0.6,
        # When whisper is uncertain it tends to fabricate fansub credits.
        # Tight thresholds force a bail-out:
        #   - compression_ratio > 2.4 → output is repetitive/garbage → drop
        #   - avg_logprob < -1.0     → low confidence → drop
        compression_ratio_threshold=2.4,
        log_prob_threshold=-1.0,
    )
    parts = [seg.text for seg in segments]
    text = "".join(parts).strip()
    return text, (info.language if info and info.language else (lang or "auto"))


def pcm_to_wav_file(pcm_int16: np.ndarray, sample_rate: int) -> io.BytesIO:
    wav_file = io.BytesIO()
    with wave.open(wav_file, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        wav.writeframes(pcm_int16.astype(np.int16, copy=False).tobytes())
    wav_file.seek(0)
    wav_file.name = "chunk.wav"
    return wav_file


def transcribe_chunk_openai(session: Session, pcm_int16: np.ndarray) -> tuple[str, str]:
    """Returns (raw_text, detected_lang) from OpenAI speech-to-text."""
    if pcm_int16.size == 0:
        return "", session.source_lang or "auto"
    client = get_openai_client()
    language = None if session.source_lang in (None, "", "auto") else session.source_lang
    kwargs = {
        "model": OPENAI_TRANSCRIBE_MODEL,
        "file": pcm_to_wav_file(pcm_int16, session.sample_rate),
    }
    if language:
        kwargs["language"] = language
    result = client.audio.transcriptions.create(**kwargs)
    text = getattr(result, "text", "") or ""
    return text.strip(), language or "auto"


async def _handle_chunk(
    ws: WebSocket,
    session: Session,
    loop,
    raw_bytes: bytes,
    arrived_at: float,
    captured_at: float | None = None,
    client_chunk_id: int | None = None,
) -> None:
    """One audio chunk: silence-gate -> transcribe -> translate -> send."""
    if client_chunk_id is not None:
        cid = client_chunk_id
        session.chunk_id = max(session.chunk_id, cid)
    else:
        session.chunk_id += 1
        cid = session.chunk_id

    # Backlog drop. If processing has slipped behind real-time, this chunk
    # is already stale by the time we get to it. Subs from 15s ago are
    # worse UX than no subs at all — drop and let the next (fresher) chunk
    # catch us up. Send empty so the overlay clears.
    lag = time.time() - captured_at if captured_at else time.monotonic() - arrived_at
    if lag > MAX_CHUNK_LAG_S:
        log.info("chunk #%d: dropped (lag=%.2fs > %.1fs)", cid, lag, MAX_CHUNK_LAG_S)
        await ws.send_text(json.dumps({
            "type": "transcript",
            "text": "", "raw": "",
            "chunkId": cid, "isFinal": True, "dropped": "lag",
        }))
        return

    pcm = np.frombuffer(raw_bytes, dtype=np.int16)

    if pcm.size:
        rms = float(np.sqrt(np.mean((pcm.astype(np.float32) / 32768.0) ** 2)))
        peak = float(np.max(np.abs(pcm)) / 32768.0)
    else:
        rms = peak = 0.0

    # Silence gate. Whisper hallucinates on silent audio by repeating the
    # initial_prompt context — exactly what causes "the last word spams
    # when the video pauses." Skip transcribe for sub-threshold chunks and
    # send empty text so the overlay clears.
    SILENCE_RMS = 0.005   # voice/music typically > 0.05
    if rms < SILENCE_RMS:
        log.info("chunk #%d: silence skip (rms=%.4f peak=%.3f)", cid, rms, peak)
        await ws.send_text(json.dumps({
            "type": "transcript",
            "text": "", "raw": "",
            "chunkId": cid, "isFinal": True, "silence": True,
        }))
        return

    raw, detected = await loop.run_in_executor(None, transcribe_chunk, session, pcm)
    if not raw:
        log.info("chunk #%d: empty transcript (lang=%s) rms=%.4f peak=%.3f",
                 cid, detected, rms, peak)
        await ws.send_text(json.dumps({
            "type": "transcript",
            "text": "", "raw": "",
            "chunkId": cid, "isFinal": True, "empty": True,
        }))
        return

    # Drop whole-chunk fansub-credit hallucinations BEFORE translating or
    # adding to history. If we add them to history they prime more
    # hallucinations on subsequent chunks via initial_prompt context.
    if looks_like_hallucination(raw):
        log.info("chunk #%d: hallucination filter dropped raw=%r", cid, raw)
        await ws.send_text(json.dumps({
            "type": "transcript",
            "text": "", "raw": raw,
            "chunkId": cid, "isFinal": True, "filtered": "hallucination",
        }, ensure_ascii=False))
        return

    src = detected if session.source_lang == "auto" else session.source_lang
    if session.task == "translate" and session.target_lang == "en":
        out = raw  # whisper already translated to English
    else:
        out = await loop.run_in_executor(
            None, translate, raw, src, session.target_lang
        )

    log.info("chunk #%d [%s->%s] raw=%r out=%r", cid, src, session.target_lang, raw, out)
    await ws.send_text(json.dumps({
        "type": "transcript",
        "text": out, "raw": raw,
        "detectedLang": detected,
        "chunkId": cid, "isFinal": True,
    }, ensure_ascii=False))


def realtime_session_update(target_lang: str) -> dict:
    return {
        "type": "session.update",
        "session": {
            "audio": {
                "output": {
                    "language": target_lang,
                },
            },
        },
    }


def realtime_caption_window(text: str) -> str:
    """Return a subtitle-sized view of the current realtime transcript."""
    state = RealtimeCaptionState()
    output = state.append(text)
    return output[-1][0] if output else ""

    caption = re.sub(r"\s+", " ", text or "").strip()
    if not caption:
        return ""

    if len(caption) <= REALTIME_PHRASE_CHARS:
        return caption

    sentence_boundaries = list(re.finditer(r"[.!?。！？؟]+(?:\s+|$)", caption))
    for index, boundary in enumerate(sentence_boundaries):
        tail = caption[boundary.end():].lstrip()
        if len(tail) <= REALTIME_PHRASE_CHARS:
            if len(tail) >= int(REALTIME_PHRASE_CHARS * 0.35) or index == 0:
                return tail
            if index > 0:
                return caption[sentence_boundaries[index - 1].end():].lstrip()

    start = max(0, len(caption) - REALTIME_PHRASE_CHARS)
    for pattern in (r"[.!?。！？؟]\s+", r"[,;:،؛]\s+", r"\s+"):
        matches = list(re.finditer(pattern, caption[:start + 40]))
        useful = [m for m in matches if m.end() >= start - 40]
        if useful:
            return caption[useful[-1].end():].lstrip()

    return caption[-REALTIME_PHRASE_CHARS:].lstrip()


class RealtimeCaptionState:
    """Groups realtime transcript deltas into subtitle-sized phrase blocks."""

    def __init__(self, limit: int = REALTIME_PHRASE_CHARS) -> None:
        self.limit = limit
        self.current = ""

    @staticmethod
    def clean(text: str) -> str:
        return re.sub(r"\s+", " ", text or "").strip()

    @staticmethod
    def first_sentence_boundary(text: str):
        return re.search(r"[.!?。！？؟]+(?:\s+|$)", text)

    def append(self, delta: str) -> list[tuple[str, bool]]:
        self.current = self.clean(self.current + (delta or ""))
        output: list[tuple[str, bool]] = []

        while self.current:
            boundary = self.first_sentence_boundary(self.current)
            if boundary:
                text = self.current[:boundary.end()].strip()
                rest = self.current[boundary.end():].strip()
                if text:
                    output.append((text, True))
                self.current = rest
                continue

            if len(self.current) > self.limit:
                split_at = self.current.rfind(" ", 0, self.limit + 1)
                if split_at < int(self.limit * 0.55):
                    split_at = self.limit
                text = self.current[:split_at].strip()
                rest = self.current[split_at:].strip()
                if text:
                    output.append((text, True))
                self.current = rest
                continue

            output.append((self.current, False))
            break

        return output

    def flush(self) -> str:
        text = self.clean(self.current)
        self.current = ""
        return text


async def send_safe_error(ws: WebSocket, message: str) -> None:
    try:
        await ws.send_text(json.dumps({"type": "error", "message": message}))
    except Exception:
        pass


async def handle_realtime_socket(ws: WebSocket, session: Session) -> None:
    """Bridge extension PCM frames to OpenAI Realtime Translation."""
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        await send_safe_error(
            ws,
            "OPENAI_API_KEY is not set. Add it to .env or backend/.env before using Realtime Cloud.",
        )
        return

    try:
        import websockets
    except ImportError:
        await send_safe_error(ws, "Python package 'websockets' is not installed in the backend environment.")
        return

    headers = {
        "Authorization": f"Bearer {api_key}",
        "OpenAI-Safety-Identifier": "kami-subs-local-user",
    }

    try:
        async with websockets.connect(
            OPENAI_REALTIME_TRANSLATE_URL,
            additional_headers=headers,
            max_size=None,
        ) as upstream:
            await upstream.send(json.dumps(realtime_session_update(session.target_lang)))
            log.info(
                "openai realtime translation connected rate=%s target=%s",
                session.sample_rate,
                session.target_lang,
            )

            caption_state = RealtimeCaptionState()
            clear_task: asyncio.Task | None = None

            async def send_realtime_caption(text: str, *, is_final: bool = False, delta: str | None = None) -> None:
                payload = {
                    "type": "transcript",
                    "text": text,
                    "isFinal": is_final,
                    "mode": REALTIME_TRANSCRIBER,
                }
                if delta is not None:
                    payload["delta"] = delta
                await ws.send_text(json.dumps(payload, ensure_ascii=False))

            async def clear_after_idle() -> None:
                await asyncio.sleep(REALTIME_PHRASE_IDLE_S)
                caption_state.flush()
                await send_realtime_caption("", is_final=True)

            def schedule_idle_clear() -> None:
                nonlocal clear_task
                if clear_task:
                    clear_task.cancel()
                clear_task = asyncio.create_task(clear_after_idle())

            async def browser_to_openai() -> None:
                while True:
                    msg = await ws.receive()
                    if msg.get("type") == "websocket.disconnect":
                        return
                    if "bytes" in msg and msg["bytes"]:
                        audio = base64.b64encode(msg["bytes"]).decode("ascii")
                        await upstream.send(json.dumps({
                            "type": "session.input_audio_buffer.append",
                            "audio": audio,
                        }))
                    elif "text" in msg and msg["text"]:
                        try:
                            cfg = json.loads(msg["text"])
                        except json.JSONDecodeError:
                            continue
                        if cfg.get("type") == "config":
                            old_target = session.target_lang
                            apply_config(session, cfg)
                            if session.target_lang != old_target:
                                await upstream.send(json.dumps(realtime_session_update(session.target_lang)))

            async def openai_to_browser() -> None:
                async for raw in upstream:
                    try:
                        event = json.loads(raw)
                    except json.JSONDecodeError:
                        continue

                    event_type = event.get("type")
                    if event_type == "session.output_transcript.delta":
                        delta = event.get("delta") or ""
                        if not delta:
                            continue
                        if clear_task:
                            clear_task.cancel()
                        for text, is_final in caption_state.append(delta):
                            await send_realtime_caption(text, is_final=is_final, delta=delta)
                        schedule_idle_clear()
                    elif event_type in ("session.output_transcript.done", "session.output_transcript.completed"):
                        text = caption_state.flush()
                        if text:
                            await send_realtime_caption(text, is_final=True)
                        schedule_idle_clear()
                    elif event_type in ("error", "session.error"):
                        log.warning("openai realtime error event: %s", event)
                        err = event.get("error") or {}
                        code = err.get("code") or err.get("type") or "unknown"
                        await send_safe_error(ws, f"Realtime translation error ({code}).")

            tasks = {
                asyncio.create_task(browser_to_openai()),
                asyncio.create_task(openai_to_browser()),
            }
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            if clear_task:
                clear_task.cancel()
            for task in done:
                task.result()
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.exception("openai realtime bridge failed: %s", e)
        await send_safe_error(
            ws,
            "OpenAI realtime connection failed. Check API key, billing, rate limits, and internet connection.",
        )


# ----- websocket loop -------------------------------------------------------
async def handle_socket(ws: WebSocket):
    await ws.accept()
    session = Session()
    log.info("client connected")

    try:
        # First message must be config (text JSON).
        first = await ws.receive()
        if "text" in first and first["text"]:
            try:
                cfg = json.loads(first["text"])
                if cfg.get("type") == "config":
                    apply_config(session, cfg)
                    log.info("config: rate=%s src=%s tgt=%s task=%s transcriber=%s",
                             session.sample_rate, session.source_lang,
                             session.target_lang, session.task, session.transcriber)
            except json.JSONDecodeError:
                pass

        if session.transcriber == REALTIME_TRANSCRIBER:
            await handle_realtime_socket(ws, session)
            return

        # Main loop: receive binary PCM chunks, transcribe, translate, push back.
        loop = asyncio.get_running_loop()
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break

            if "bytes" in msg and msg["bytes"]:
                # Stamp arrival time NOW so the chunk handler can detect
                # backlog. If we stamped inside _handle_chunk, the time would
                # already include the previous chunk's processing wait.
                arrived_at = time.monotonic()
                # Process each chunk in its own try block — a single bad
                # chunk (translator throw, whisper edge case, etc) used to
                # kill the entire WS session. Now we just log and continue.
                try:
                    captured_at = session.next_chunk_captured_at
                    client_chunk_id = session.next_chunk_id
                    session.next_chunk_captured_at = None
                    session.next_chunk_id = None
                    await _handle_chunk(
                        ws,
                        session,
                        loop,
                        msg["bytes"],
                        arrived_at,
                        captured_at,
                        client_chunk_id,
                    )
                except Exception as e:
                    log.exception("chunk handler error: %s", e)
                    try:
                        await ws.send_text(json.dumps({
                            "type": "error",
                            "message": f"chunk processing failed: {e}",
                        }))
                    except Exception:
                        pass
                    # Don't break — let the session keep running for the next chunk.

            elif "text" in msg and msg["text"]:
                # Allow runtime reconfig and optional per-chunk metadata.
                try:
                    cfg = json.loads(msg["text"])
                    if cfg.get("type") == "config":
                        apply_config(session, cfg)
                    elif cfg.get("type") == "chunk":
                        try:
                            session.next_chunk_id = int(cfg.get("chunkId"))
                        except (TypeError, ValueError):
                            session.next_chunk_id = None
                        try:
                            session.next_chunk_captured_at = float(cfg.get("capturedAt"))
                        except (TypeError, ValueError):
                            session.next_chunk_captured_at = None
                except json.JSONDecodeError:
                    pass

    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.exception("session error: %s", e)
        try:
            await ws.send_text(json.dumps({"type": "error", "message": str(e)}))
        except Exception:
            pass
    finally:
        log.info("client disconnected")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if TRANSCRIBER == "local":
        # Warm the model up front so the first chunk isn't slow.
        try:
            get_model()
        except Exception as e:
            log.warning("model warmup failed: %s", e)
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/")
async def root():
    return {
        "ok": True,
        "model": MODEL_SIZE,
        "device": DEVICE,
        "compute": COMPUTE_TYPE,
        "transcriber": TRANSCRIBER,
        "openai_transcribe_model": OPENAI_TRANSCRIBE_MODEL if TRANSCRIBER == "openai" else None,
        "openai_realtime_model": OPENAI_REALTIME_TRANSLATE_MODEL if TRANSCRIBER == REALTIME_TRANSCRIBER else None,
        "translator": TRANSLATOR,
        "ws": f"ws://{HOST}:{PORT}/ws",
    }


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await handle_socket(ws)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host=HOST, port=PORT, log_level="info")
