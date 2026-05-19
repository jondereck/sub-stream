"""
Sub Stream AI — local Whisper + translation backend.

WebSocket protocol:
  client -> server (text JSON):
    { "type": "config",
      "sampleRate": 16000,
      "sourceLang": "auto" | "en" | "es" | ...,
      "targetLang": "ar",
      "task": "transcribe" | "translate",
      "client": "android",
      "token": "optional shared mobile token" }
  client -> server (binary): raw little-endian Int16 PCM, mono, sampleRate Hz

  server -> client (text JSON):
    { "type": "transcript", "text": "...", "isFinal": true }
    { "type": "error", "message": "..." }
"""
from __future__ import annotations

import asyncio
import base64
import ctypes
import hmac
import io
import json
import logging
import os
import re
import secrets
import sys
import time
import wave
import uuid
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from statistics import mean
from threading import Lock
from typing import Deque, Optional

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
        print("[sub-stream-ai] nvidia packages not installed; running on CPU only")
        return
    print(f"[sub-stream-ai] nvidia root: {nvidia_root}")

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
            print(f"[sub-stream-ai] failed to preload {name}: {e}")

_register_nvidia_dll_dirs()

import numpy as np
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from config import (
    MODEL_SIZE, DEVICE, COMPUTE_TYPE, TRANSLATOR, TRANSCRIBER,
    HOST, PORT, SAMPLE_RATE, REALTIME_SAMPLE_RATE, VAD_FILTER,
    MAX_CHUNK_LAG_S, MOBILE_TOKEN,
)

log = logging.getLogger("sub-stream-ai")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

# ----- model load (lazy, once per process) ----------------------------------
_model = None
_openai_client = None
_effective_compute_type = None

OPENAI_REALTIME_TRANSCRIBE_MODEL = os.getenv("OPENAI_REALTIME_TRANSCRIBE_MODEL", "gpt-4o-transcribe")
OPENAI_REALTIME_TRANSCRIBE_URL = "wss://api.openai.com/v1/realtime?intent=transcription"
OPENAI_REALTIME_CONNECT_TIMEOUT_S = float(os.getenv("OPENAI_REALTIME_CONNECT_TIMEOUT_S", "15"))
REALTIME_TRANSCRIBER = "openai-realtime"
REALTIME_PHRASE_CHARS = 72
REALTIME_PHRASE_IDLE_S = 0.75
REALTIME_LATENCY_PROFILES = {
    "fast": {"phrase_chars": 56, "idle_s": 1.0},
    "balanced": {"phrase_chars": 72, "idle_s": 1.6},
    "stable": {"phrase_chars": 92, "idle_s": 2.3},
}
ALLOWED_TRANSCRIBERS = {"local", REALTIME_TRANSCRIBER}
ALLOWED_TARGET_LANGS = {
    "ar", "en", "es", "fr", "de", "tr", "ja", "ko", "zh", "hi",
    "it", "pt", "ru", "id", "ms", "th", "vi", "fil",
}
ALLOWED_SOURCE_LANGS = ALLOWED_TARGET_LANGS | {"auto"}
MAX_TRANSLATE_CHARS = 2000
LOCAL_WHISPER_ENGINE = "local-whisper"
API_KEY_SOURCE_SAVED = "saved_settings"
API_KEY_SOURCE_ENV = ".env"


class TranslateRequest(BaseModel):
    text: str = Field(default="", max_length=MAX_TRANSLATE_CHARS)
    sourceLang: str = "auto"
    targetLang: str = "ar"
    token: Optional[str] = None


class TranslateResponse(BaseModel):
    text: str


class ApiKeySaveRequest(BaseModel):
    apiKey: str = Field(default="", max_length=300)
    test: bool = True


class ApiKeyTestRequest(BaseModel):
    apiKey: str | None = Field(default=None, max_length=300)


class ApiKeyStatusResponse(BaseModel):
    configured: bool
    source: str | None = None
    masked: str | None = None


class ApiKeyActionResponse(BaseModel):
    ok: bool
    configured: bool
    message: str | None = None
    source: str | None = None
    masked: str | None = None


def mobile_token_required() -> bool:
    return bool(MOBILE_TOKEN.strip())


def mobile_token_matches(value: str | None) -> bool:
    if not mobile_token_required():
        return True
    return hmac.compare_digest((value or "").strip(), MOBILE_TOKEN.strip())


def is_android_client(cfg: dict) -> bool:
    return (cfg.get("client") or "").strip().lower() == "android"


def validate_mobile_ws_config(cfg: dict) -> str | None:
    if is_android_client(cfg) and not mobile_token_matches(cfg.get("token")):
        return "Android client token is missing or invalid."
    return None


def require_mobile_token(token: str | None) -> None:
    if not mobile_token_matches(token):
        raise HTTPException(status_code=403, detail="Invalid mobile token.")


def safe_source_lang_or_error(value: str | None) -> str:
    lang = (value or "auto").strip().lower()
    if lang not in ALLOWED_SOURCE_LANGS:
        raise HTTPException(status_code=400, detail="Unsupported source language.")
    return lang


def safe_target_lang_or_error(value: str | None) -> str:
    lang = (value or "ar").strip().lower()
    if lang not in ALLOWED_TARGET_LANGS:
        raise HTTPException(status_code=400, detail="Unsupported target language.")
    return lang


def api_key_store_path() -> Path:
    configured = os.getenv("SUBSTREAM_OPENAI_KEY_FILE")
    if configured:
        return Path(configured).expanduser()
    if sys.platform == "win32" and os.getenv("APPDATA"):
        return Path(os.environ["APPDATA"]) / "SubStreamAI" / "openai_api_key.dat"
    return Path.home() / ".config" / "sub-stream-ai" / "openai_api_key.dat"


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_uint), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _blob_from_bytes(data: bytes) -> _DataBlob:
    buf = ctypes.create_string_buffer(data)
    blob = _DataBlob(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char)))
    blob._buf = buf
    return blob


def _windows_protect(data: bytes) -> bytes:
    blob_in = _blob_from_bytes(data)
    blob_out = _DataBlob()
    crypt32 = ctypes.windll.crypt32
    if not crypt32.CryptProtectData(
        ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)
    ):
        raise OSError("Could not protect API key with Windows DPAPI.")
    try:
        protected = ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)
    return protected


def _windows_unprotect(data: bytes) -> bytes:
    blob_in = _blob_from_bytes(data)
    blob_out = _DataBlob()
    crypt32 = ctypes.windll.crypt32
    if not crypt32.CryptUnprotectData(
        ctypes.byref(blob_in), None, None, None, None, 0, ctypes.byref(blob_out)
    ):
        raise OSError("Could not read the saved API key.")
    try:
        plain = ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(blob_out.pbData)
    return plain


def encode_stored_secret(secret: str) -> bytes:
    raw = secret.encode("utf-8")
    if sys.platform == "win32":
        return b"win-dpapi:" + base64.b64encode(_windows_protect(raw))
    return b"plain:" + base64.b64encode(raw)


def decode_stored_secret(payload: bytes) -> str:
    if payload.startswith(b"win-dpapi:"):
        raw = base64.b64decode(payload.removeprefix(b"win-dpapi:"))
        return _windows_unprotect(raw).decode("utf-8")
    if payload.startswith(b"plain:"):
        raw = base64.b64decode(payload.removeprefix(b"plain:"))
        return raw.decode("utf-8")
    return payload.decode("utf-8")


def read_stored_openai_key() -> str | None:
    path = api_key_store_path()
    if not path.exists():
        return None
    try:
        key = normalize_openai_key(decode_stored_secret(path.read_bytes()))
        return key or None
    except Exception as e:
        log.warning("could not read stored OpenAI API key: %s", e)
        return None


def write_stored_openai_key(api_key: str) -> None:
    key = normalize_openai_key(api_key)
    if not key:
        raise ValueError("API key is empty or whitespace.")
    path = api_key_store_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    tmp.write_bytes(encode_stored_secret(key))
    if sys.platform != "win32":
        os.chmod(tmp, 0o600)
    tmp.replace(path)


def delete_stored_openai_key() -> bool:
    path = api_key_store_path()
    if not path.exists():
        return False
    try:
        path.unlink()
        return True
    except OSError as e:
        log.warning("could not delete stored OpenAI API key: %s", e)
        raise HTTPException(status_code=500, detail="Could not clear saved API key.") from e


def normalize_openai_key(api_key: str | None) -> str | None:
    key = (api_key or "").strip()
    return key or None


def mask_openai_key(api_key: str | None) -> str | None:
    key = normalize_openai_key(api_key)
    if not key:
        return None
    if len(key) <= 12:
        return f"{key[:4]}...{key[-2:]}"
    return f"{key[:8]}...{key[-4:]}"


def resolve_openai_api_key(context: str) -> tuple[str | None, str | None]:
    stored_key = read_stored_openai_key()
    raw_env_key = os.getenv("OPENAI_API_KEY")
    env_key = normalize_openai_key(raw_env_key)
    if raw_env_key is not None and not env_key:
        log.warning("openai api key .env value ignored because it is empty or whitespace context=%s", context)
    if stored_key:
        log.info(
            "openai api key resolved context=%s source=%s masked=%s dot_env_ignored=%s",
            context,
            API_KEY_SOURCE_SAVED,
            mask_openai_key(stored_key),
            bool(env_key),
        )
        return stored_key, API_KEY_SOURCE_SAVED
    if env_key:
        log.info(
            "openai api key resolved context=%s source=%s masked=%s",
            context,
            API_KEY_SOURCE_ENV,
            mask_openai_key(env_key),
        )
        return env_key, API_KEY_SOURCE_ENV
    log.warning("openai api key resolved context=%s source=none masked=none", context)
    return None, None


class OpenAIRealtimeError(Exception):
    def __init__(
        self,
        message: str,
        *,
        code: str = "openai_realtime_error",
        status: int | None = None,
        body: str | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status
        self.body = body


def openai_error_message(code: str, status: int | None = None, body: str | None = None) -> str:
    normalized_code = (code or "").lower()
    if "invalid_api_key" in normalized_code or status == 401:
        return "invalid_api_key: OpenAI rejected the API key. Check that the key is active and was copied correctly."
    if "insufficient_quota" in normalized_code or status == 402:
        return "insufficient_quota: OpenAI accepted the key but the project has no available quota or billing credit."
    if "rate_limit_exceeded" in normalized_code or status == 429:
        return "rate_limit_exceeded: OpenAI rate limits were hit. Wait briefly or increase the project's limits."
    if normalized_code == "connection_timeout":
        return "connection_timeout: Timed out while connecting to OpenAI Realtime. Check internet/proxy/firewall."
    if normalized_code == "websocket_handshake_failure":
        detail = f" HTTP {status}" if status else ""
        return f"websocket_handshake_failure:{detail} OpenAI rejected the Realtime WebSocket handshake."
    if normalized_code == "openai_realtime_closed":
        return f"openai_realtime_closed: OpenAI accepted the WebSocket but closed the Realtime session. {body or ''}".strip()
    if body:
        return f"{code}: {body[:300]}"
    return "OpenAI realtime connection failed. Check API key, billing, rate limits, and internet connection."


def parse_openai_error_code(body: str | None, status: int | None = None) -> str:
    if status == 401:
        return "invalid_api_key"
    if status == 402:
        return "insufficient_quota"
    if status == 429:
        return "rate_limit_exceeded"
    if not body:
        return "websocket_handshake_failure"
    try:
        parsed = json.loads(body)
        err = parsed.get("error") if isinstance(parsed, dict) else None
        if isinstance(err, dict):
            return str(err.get("code") or err.get("type") or "openai_realtime_error")
    except json.JSONDecodeError:
        lower = body.lower()
        for known in ("invalid_api_key", "insufficient_quota", "rate_limit_exceeded"):
            if known in lower:
                return known
    return "openai_realtime_error"


async def probe_openai_realtime_connection(api_key: str, *, source: str = "provided") -> None:
    key = normalize_openai_key(api_key)
    if not key:
        raise OpenAIRealtimeError(
            "empty_api_key: API key is empty or whitespace. Paste a valid OpenAI key before saving.",
            code="empty_api_key",
        )
    try:
        import websockets
    except ImportError as e:
        raise OpenAIRealtimeError(
            "Python package 'websockets' is not installed in the backend environment.",
            code="backend_dependency_missing",
        ) from e

    headers = openai_realtime_headers(key)
    log.info(
        "openai realtime probe start url=%s source=%s masked=%s",
        OPENAI_REALTIME_TRANSCRIBE_URL,
        source,
        mask_openai_key(key),
    )
    try:
        upstream = await asyncio.wait_for(
            websockets.connect(
                OPENAI_REALTIME_TRANSCRIBE_URL,
                additional_headers=headers,
                max_size=None,
            ),
            timeout=OPENAI_REALTIME_CONNECT_TIMEOUT_S,
        )
        log.info(
            "openai realtime probe connected status=101 source=%s masked=%s",
            source,
            mask_openai_key(key),
        )
        await upstream.send(json.dumps(realtime_transcription_session_update("auto")))
        await wait_for_openai_session_ack(upstream, context="probe")
        await upstream.close()
    except TimeoutError as e:
        message = openai_error_message("connection_timeout")
        log.warning("openai realtime probe timeout after %.1fs", OPENAI_REALTIME_CONNECT_TIMEOUT_S)
        raise OpenAIRealtimeError(message, code="connection_timeout") from e
    except Exception as e:
        status, body = extract_ws_status(e)
        code = parse_openai_error_code(body, status)
        message = openai_error_message(code, status, body)
        log.warning(
            "openai realtime probe failed exc=%s status=%s code=%s body=%s",
            type(e).__name__,
            status,
            code,
            body,
        )
        raise OpenAIRealtimeError(message, code=code, status=status, body=body) from e


def openai_realtime_headers(api_key: str) -> dict[str, str]:
    key = normalize_openai_key(api_key) or ""
    return {
        "Authorization": f"Bearer {key}",
        "OpenAI-Safety-Identifier": "sub-stream-ai-local-user",
    }


async def wait_for_openai_session_ack(upstream, *, context: str) -> None:
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        raw = await asyncio.wait_for(upstream.recv(), timeout=max(0.1, deadline - time.monotonic()))
        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            log.warning("openai realtime %s non-json event: %r", context, raw)
            continue

        event_type = event.get("type")
        log.info("openai realtime %s session event type=%s", context, event_type)
        if event_type in ("error", "session.error"):
            message = openai_event_error_message(event)
            err = event.get("error") if isinstance(event.get("error"), dict) else {}
            code = str(err.get("code") or err.get("type") or "openai_realtime_error")
            raise OpenAIRealtimeError(message, code=code, body=json.dumps(event))
        if event_type in ("session.updated", "transcription_session.updated"):
            return
    raise OpenAIRealtimeError(
        "connection_timeout: OpenAI Realtime connected but did not acknowledge the transcription session.",
        code="connection_timeout",
    )


def extract_ws_status(exc: Exception) -> tuple[int | None, str | None]:
    response = getattr(exc, "response", None)
    status = getattr(response, "status_code", None) or getattr(response, "status", None)
    body = None
    if response is not None:
        raw_body = getattr(response, "body", None)
        if isinstance(raw_body, bytes):
            body = raw_body.decode("utf-8", errors="replace")
        elif raw_body is not None:
            body = str(raw_body)
    status = status or getattr(exc, "status_code", None) or getattr(exc, "status", None)
    return status, body


def log_openai_key_state(context: str, api_key: str | None, source: str | None) -> None:
    log.info(
        "openai api key state context=%s loaded=%s source=%s masked=%s",
        context,
        bool(api_key),
        source or "none",
        mask_openai_key(api_key),
    )


async def validate_openai_key(api_key: str, *, source: str = "provided") -> None:
    key = normalize_openai_key(api_key)
    log_openai_key_state("validate", key, source)
    if not key:
        raise HTTPException(
            status_code=400,
            detail="empty_api_key: API key is empty or whitespace. Paste a valid OpenAI key before saving.",
        )
    if not key.startswith("sk-"):
        raise HTTPException(
            status_code=400,
            detail="invalid_api_key: OpenAI API keys must start with sk-.",
        )
    try:
        await probe_openai_realtime_connection(key, source=source)
    except OpenAIRealtimeError as e:
        log.warning(
            "OpenAI realtime validation failed code=%s status=%s body=%s",
            e.code,
            e.status,
            e.body,
        )
        raise HTTPException(status_code=400, detail=e.message) from e


def require_request_openai_key(api_key: str | None) -> str:
    key = normalize_openai_key(api_key)
    if not key:
        raise HTTPException(
            status_code=400,
            detail="empty_api_key: API key is empty or whitespace. Paste a valid OpenAI key before saving.",
        )
    if not key.startswith("sk-"):
        raise HTTPException(
            status_code=400,
            detail="invalid_api_key: OpenAI API keys must start with sk-.",
        )
    return key


def saved_key_not_persisted_error() -> HTTPException:
    return HTTPException(
        status_code=500,
        detail=(
            "saved_key_not_persisted: API key could not be saved or reloaded. "
            "Check backend file permissions and try again."
        ),
    )


def missing_openai_key_error() -> HTTPException:
    return HTTPException(
        status_code=400,
        detail=(
            "missing_api_key: No OpenAI API key is loaded by the backend. "
            "Save a key in Advanced settings or add OPENAI_API_KEY to .env."
        ),
    )


def write_stored_openai_key_or_error(api_key: str) -> None:
    try:
        write_stored_openai_key(api_key)
    except Exception as e:
        log.exception("could not persist OpenAI API key: %s", e)
        raise saved_key_not_persisted_error() from e


def verify_stored_openai_key_or_error(expected_key: str) -> None:
    persisted_key = read_stored_openai_key()
    if persisted_key != expected_key:
        log.error(
            "saved OpenAI API key verification failed expected_masked=%s actual_masked=%s",
            mask_openai_key(expected_key),
            mask_openai_key(persisted_key),
        )
        raise saved_key_not_persisted_error()


def restore_previous_openai_key(previous_key: str | None) -> None:
    try:
        if previous_key:
            write_stored_openai_key(previous_key)
        else:
            delete_stored_openai_key()
    except Exception as e:
        log.warning("could not restore previous OpenAI API key after failed save: %s", e)


async def save_and_resolve_openai_key(
    raw_api_key: str | None,
    *,
    context: str,
    test_connection: bool,
) -> tuple[str, str]:
    requested_key = require_request_openai_key(raw_api_key)
    previous_key = read_stored_openai_key()
    storage_updated = False
    try:
        write_stored_openai_key_or_error(requested_key)
        storage_updated = True
        verify_stored_openai_key_or_error(requested_key)
        resolved_key, source = resolve_openai_api_key(context)
        if source != API_KEY_SOURCE_SAVED or resolved_key != requested_key:
            log.error(
                "saved OpenAI API key is not active after save active_source=%s active_masked=%s expected_masked=%s",
                source or "none",
                mask_openai_key(resolved_key),
                mask_openai_key(requested_key),
            )
            raise saved_key_not_persisted_error()
        if test_connection:
            await validate_openai_key(resolved_key, source=source)
        return resolved_key, source
    except HTTPException:
        if storage_updated:
            restore_previous_openai_key(previous_key)
        raise


async def validate_resolved_openai_key(context: str) -> tuple[str, str]:
    api_key, source = resolve_openai_api_key(context)
    if not api_key:
        raise missing_openai_key_error()
    await validate_openai_key(api_key, source=source or "none")
    return api_key, source or "none"


def resolve_compute_type(device: str, requested: str) -> str:
    if device != "cuda":
        return requested
    try:
        import ctranslate2
        supported = ctranslate2.get_supported_compute_types("cuda")
    except Exception as e:
        log.warning("could not inspect CUDA compute types: %s", e)
        return requested

    if requested in supported:
        return requested

    for fallback in ("int8_float32", "int8", "float32"):
        if fallback in supported:
            log.warning(
                "compute type %s is unsupported on this CUDA device; using %s",
                requested,
                fallback,
            )
            return fallback
    return requested


def get_model():
    global _model, _effective_compute_type
    if _model is None:
        from faster_whisper import WhisperModel
        _effective_compute_type = resolve_compute_type(DEVICE, COMPUTE_TYPE)
        log.info("loading whisper model=%s device=%s compute=%s", MODEL_SIZE, DEVICE, _effective_compute_type)
        _model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=_effective_compute_type)
        log.info("whisper model ready")
    return _model


def get_openai_client():
    global _openai_client
    if _openai_client is None:
        api_key, _source = resolve_openai_api_key("openai_client")
        if not api_key:
            raise RuntimeError(
                "missing_api_key: No OpenAI API key is loaded by the backend. "
                "Save a key in Advanced settings or add OPENAI_API_KEY to .env."
            )
        from openai import OpenAI
        _openai_client = OpenAI(api_key=api_key)
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
class SyncSnapshot:
    session_id: str
    engine: str
    whisper_model: str | None
    device: str | None
    sample_count: int
    rolling_avg_latency_s: float
    recommended_auto_offset_s: float
    updated_at: float


@dataclass
class SessionLatencyTracker:
    session_id: str
    engine: str
    whisper_model: str | None = None
    device: str | None = None
    max_samples: int = 12
    min_valid_latency_s: float = 0.2
    max_valid_latency_s: float = 6.0
    offset_factor: float = 0.7
    min_auto_offset_s: float = -1.5
    max_auto_offset_s: float = 0.0
    samples: Deque[float] = field(default_factory=lambda: deque(maxlen=12))
    last_snapshot: SyncSnapshot | None = None
    _lock: Lock = field(default_factory=Lock)

    def __post_init__(self) -> None:
        if self.samples.maxlen != self.max_samples:
            self.samples = deque(self.samples, maxlen=self.max_samples)

    def register_transcript_emit(
        self,
        captured_at: float | None,
        emitted_at: float | None = None,
    ) -> SyncSnapshot:
        if emitted_at is None:
            emitted_at = time.time()

        with self._lock:
            if captured_at is not None:
                latency_s = emitted_at - captured_at
                if self._is_valid_latency(latency_s):
                    self.samples.append(latency_s)

            snapshot = self._build_snapshot_unlocked()
            self.last_snapshot = snapshot
            return snapshot

    def current_snapshot(self) -> SyncSnapshot:
        with self._lock:
            if self.last_snapshot is not None:
                return self.last_snapshot
            return self._build_snapshot_unlocked()

    def _is_valid_latency(self, latency_s: float) -> bool:
        return self.min_valid_latency_s <= latency_s <= self.max_valid_latency_s

    def _build_snapshot_unlocked(self) -> SyncSnapshot:
        avg_latency_s = self._trimmed_mean(list(self.samples))
        recommended_auto_offset_s = self._clamp(
            -(avg_latency_s * self.offset_factor),
            self.min_auto_offset_s,
            self.max_auto_offset_s,
        )
        return SyncSnapshot(
            session_id=self.session_id,
            engine=self.engine,
            whisper_model=self.whisper_model,
            device=self.device,
            sample_count=len(self.samples),
            rolling_avg_latency_s=round(avg_latency_s, 3),
            recommended_auto_offset_s=round(recommended_auto_offset_s, 3),
            updated_at=time.time(),
        )

    @staticmethod
    def _trimmed_mean(values: list[float]) -> float:
        if not values:
            return 0.0
        if len(values) < 5:
            return mean(values)
        ordered = sorted(values)
        trim = max(1, int(len(ordered) * 0.1))
        trimmed = ordered[trim: len(ordered) - trim]
        return mean(trimmed or ordered)

    @staticmethod
    def _clamp(value: float, minimum: float, maximum: float) -> float:
        return max(minimum, min(maximum, value))


def engine_name_for_transcriber(transcriber: str) -> str:
    return LOCAL_WHISPER_ENGINE if transcriber == "local" else transcriber


def sync_payload(snapshot: SyncSnapshot) -> dict:
    return {
        "sessionId": snapshot.session_id,
        "engine": snapshot.engine,
        "whisperModel": snapshot.whisper_model,
        "device": snapshot.device,
        "sampleCount": snapshot.sample_count,
        "rollingAvgLatencyS": snapshot.rolling_avg_latency_s,
        "recommendedAutoOffsetS": snapshot.recommended_auto_offset_s,
        "updatedAt": snapshot.updated_at,
    }


@dataclass
class Session:
    session_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    sample_rate: int = SAMPLE_RATE
    source_lang: str = "auto"
    target_lang: str = "ar"
    realtime_latency: str = "balanced"
    task: str = "transcribe"
    transcriber: str = TRANSCRIBER if TRANSCRIBER in ALLOWED_TRANSCRIBERS else "local"
    chunk_id: int = 0
    next_chunk_id: int | None = None
    next_chunk_captured_at: float | None = None
    sync_tracker: SessionLatencyTracker = field(init=False)

    def __post_init__(self) -> None:
        self.sync_tracker = SessionLatencyTracker(
            session_id=self.session_id,
            engine=engine_name_for_transcriber(self.transcriber),
            whisper_model=MODEL_SIZE,
            device=DEVICE,
        )


@dataclass
class ChunkItem:
    raw_bytes: bytes
    arrived_at: float
    captured_at: float | None = None
    client_chunk_id: int | None = None


def transcribe_chunk(session: Session, pcm_int16: np.ndarray) -> tuple[str, str, Optional[float], Optional[float]]:
    """Returns (raw_text, detected_lang, start, end)."""
    return transcribe_chunk_local(session, pcm_int16)


def safe_transcriber(value: str | None) -> str:
    transcriber = (value or TRANSCRIBER or "local").strip().lower()
    return transcriber if transcriber in ALLOWED_TRANSCRIBERS else "local"


def safe_target_lang(value: str | None) -> str:
    lang = (value or "ar").strip().lower()
    return lang if lang in ALLOWED_TARGET_LANGS else "ar"


def safe_realtime_latency(value: str | None) -> str:
    latency = (value or "balanced").strip().lower()
    return latency if latency in REALTIME_LATENCY_PROFILES else "balanced"


def should_translate_session(session: Session) -> bool:
    return session.task == "translate" and session.source_lang != session.target_lang


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
        session.sync_tracker.engine = engine_name_for_transcriber(session.transcriber)
        session.sync_tracker.last_snapshot = None
    if "model" in cfg:
        model = str(cfg.get("model") or MODEL_SIZE).strip()
        session.sync_tracker.whisper_model = model[:50] or MODEL_SIZE
        session.sync_tracker.last_snapshot = None
    if "device" in cfg:
        device = str(cfg.get("device") or DEVICE).strip()
        session.sync_tracker.device = device[:30] or DEVICE
        session.sync_tracker.last_snapshot = None
    default_rate = REALTIME_SAMPLE_RATE if session.transcriber == REALTIME_TRANSCRIBER else SAMPLE_RATE
    session.sample_rate = safe_sample_rate(cfg.get("sampleRate", session.sample_rate), default_rate)
    session.source_lang = cfg.get("sourceLang", session.source_lang) or "auto"
    session.target_lang = safe_target_lang(cfg.get("targetLang", session.target_lang))
    session.realtime_latency = safe_realtime_latency(cfg.get("realtimeLatency", session.realtime_latency))
    session.task = cfg.get("task", session.task) or "transcribe"


def transcribe_chunk_local(session: Session, pcm_int16: np.ndarray) -> tuple[str, str, Optional[float], Optional[float]]:
    """Returns (raw_text, detected_lang, start, end) from local faster-whisper."""
    if pcm_int16.size == 0:
        return "", session.source_lang or "auto", None, None
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
    parts = []
    start = None
    end = None
    for seg in segments:
        if start is None:
            start = seg.start
        end = seg.end
        parts.append(seg.text)
    text = "".join(parts).strip()
    return text, (info.language if info and info.language else (lang or "auto")), start, end


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
            "sync": sync_payload(session.sync_tracker.current_snapshot()),
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
            "sync": sync_payload(session.sync_tracker.current_snapshot()),
        }))
        return

    raw, detected, s_rel, e_rel = await loop.run_in_executor(None, transcribe_chunk, session, pcm)
    emitted_at = time.time()

    # Calculate absolute timestamps based on when the chunk was captured.
    # We prefer captured_at if provided by the client, otherwise we fall back
    # to a best-effort estimate based on arrival time and current lag.
    captured_at_val = captured_at if captured_at else (emitted_at - lag)
    s_abs = captured_at_val + s_rel if s_rel is not None else captured_at_val
    e_abs = captured_at_val + e_rel if e_rel is not None else (captured_at_val + (pcm.size / session.sample_rate))

    log.info("chunk #%d: receivedAt=%.3f capturedAt=%.3f startTs=%.3f endTs=%.3f",
             cid, arrived_at, captured_at_val, s_abs, e_abs)

    if not raw:
        log.info("chunk #%d: empty transcript (lang=%s) rms=%.4f peak=%.3f",
                 cid, detected, rms, peak)
        await ws.send_text(json.dumps({
            "type": "transcript",
            "text": "", "raw": "",
            "chunkId": cid, "isFinal": True, "empty": True,
            "receivedAt": arrived_at,
            "transcriptEmittedAt": emitted_at,
            "segmentStartTs": s_abs,
            "segmentEndTs": e_abs,
            "sync": sync_payload(session.sync_tracker.current_snapshot()),
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
            "receivedAt": arrived_at,
            "transcriptEmittedAt": emitted_at,
            "segmentStartTs": s_abs,
            "segmentEndTs": e_abs,
            "sync": sync_payload(session.sync_tracker.current_snapshot()),
        }, ensure_ascii=False))
        return

    src = detected if session.source_lang == "auto" else session.source_lang
    if should_translate_session(session) and session.target_lang == "en":
        out = raw  # whisper already translated to English
    elif should_translate_session(session):
        out = await loop.run_in_executor(
            None, translate, raw, src, session.target_lang
        )
    else:
        out = raw

    emitted_at = time.time()
    snapshot = session.sync_tracker.register_transcript_emit(captured_at, emitted_at)
    log.info(
        "chunk #%d [%s->%s] raw=%r out=%r start=%.3f end=%.3f latency=%.3fs auto_offset=%.3fs",
        cid,
        src,
        session.target_lang,
        raw,
        out,
        s_abs,
        e_abs,
        snapshot.rolling_avg_latency_s,
        snapshot.recommended_auto_offset_s,
    )
    await ws.send_text(json.dumps({
        "type": "transcript",
        "text": out, "raw": raw,
        "detectedLang": detected,
        "chunkId": cid, "isFinal": True,
        "receivedAt": arrived_at,
        "transcriptEmittedAt": emitted_at,
        "segmentStartTs": s_abs,
        "segmentEndTs": e_abs,
        "sync": sync_payload(snapshot),
    }, ensure_ascii=False))


async def replace_latest_chunk(
    queue: asyncio.Queue[ChunkItem | None],
    item: ChunkItem | None,
) -> None:
    while True:
        try:
            queue.put_nowait(item)
            return
        except asyncio.QueueFull:
            try:
                queue.get_nowait()
                queue.task_done()
            except asyncio.QueueEmpty:
                continue


async def handle_latest_chunk_queue(
    ws: WebSocket,
    session: Session,
    queue: asyncio.Queue[ChunkItem | None],
) -> None:
    loop = asyncio.get_running_loop()
    while True:
        item = await queue.get()
        try:
            if item is None:
                return
            await _handle_chunk(
                ws,
                session,
                loop,
                item.raw_bytes,
                item.arrived_at,
                item.captured_at,
                item.client_chunk_id,
            )
        except Exception as e:
            log.exception("chunk handler error: %s", e)
            await send_safe_error(ws, f"chunk processing failed: {e}")
        finally:
            queue.task_done()


def realtime_transcription_session_update(source_lang: str | None = None) -> dict:
    transcription: dict[str, str] = {"model": OPENAI_REALTIME_TRANSCRIBE_MODEL}
    if source_lang and source_lang != "auto":
        transcription["language"] = source_lang
    return {
        "type": "session.update",
        "session": {
            "type": "transcription",
            "audio": {
                "input": {
                    "format": {
                        "type": "audio/pcm",
                        "rate": REALTIME_SAMPLE_RATE,
                    },
                    "transcription": transcription,
                    "turn_detection": {
                        "type": "server_vad",
                        "threshold": 0.5,
                        "prefix_padding_ms": 300,
                        "silence_duration_ms": 500,
                    },
                    "noise_reduction": {
                        "type": "near_field",
                    },
                },
            },
        },
    }


def openai_event_error_message(event: dict) -> str:
    err = event.get("error") if isinstance(event, dict) else None
    if not isinstance(err, dict):
        return "OpenAI realtime connection failed."
    code = str(err.get("code") or err.get("type") or "openai_realtime_error")
    message = str(err.get("message") or "")
    if any(known in code.lower() for known in ("invalid_api_key", "insufficient_quota", "rate_limit_exceeded")):
        return openai_error_message(code)
    return f"OpenAI realtime error ({code}): {message[:240] or 'No message returned.'}"


def realtime_caption_window(text: str) -> str:
    """Return a subtitle-sized view of the current realtime transcript."""
    state = RealtimeCaptionState()
    output = state.append(text)
    return output[-1][0] if output else ""



class RealtimeCaptionState:
    """Groups realtime transcript deltas into subtitle-sized phrase blocks."""

    def __init__(self, latency: str = "balanced") -> None:
        self.set_latency(latency)
        self.current = ""

    def set_latency(self, latency: str) -> None:
        profile = REALTIME_LATENCY_PROFILES.get(safe_realtime_latency(latency), REALTIME_LATENCY_PROFILES["balanced"])
        self.limit = int(profile["phrase_chars"])
        self.idle_s = float(profile["idle_s"])

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
    """Bridge extension PCM frames to backend-owned OpenAI Realtime transcription."""
    api_key, source = resolve_openai_api_key("realtime_socket")
    if not api_key:
        await send_safe_error(ws, str(missing_openai_key_error().detail))
        return

    try:
        import websockets
    except ImportError:
        await send_safe_error(ws, "Python package 'websockets' is not installed in the backend environment.")
        return

    headers = openai_realtime_headers(api_key)
    openai_connected = False

    try:
        upstream = await asyncio.wait_for(
            websockets.connect(
                OPENAI_REALTIME_TRANSCRIBE_URL,
                additional_headers=headers,
                max_size=None,
            ),
            timeout=OPENAI_REALTIME_CONNECT_TIMEOUT_S,
        )
        openai_connected = True
        try:
            await upstream.send(json.dumps(realtime_transcription_session_update(session.source_lang)))
            await wait_for_openai_session_ack(upstream, context="runtime")
            log.info(
                "openai realtime transcription connected status=101 source=%s masked=%s rate=%s lang=%s target=%s model=%s",
                source,
                mask_openai_key(api_key),
                session.sample_rate,
                session.source_lang,
                session.target_lang,
                OPENAI_REALTIME_TRANSCRIBE_MODEL,
            )

            caption_state = RealtimeCaptionState(session.realtime_latency)
            clear_task: asyncio.Task | None = None
            audio_frames_sent = 0
            audio_bytes_sent = 0
            raw_transcript_parts: list[str] = []

            phrase_start_ts: float | None = None
            rt_chunk_id = 0

            async def send_realtime_caption(text: str, *, is_final: bool = False, delta: str | None = None) -> None:
                nonlocal phrase_start_ts, rt_chunk_id
                now = time.time()
                if not phrase_start_ts:
                    phrase_start_ts = now

                rt_chunk_id += 1

                # Realtime best-effort timestamps.
                # Start is when the first delta of this phrase arrived.
                # End is 'now' for deltas, or estimated for final.
                s_abs = phrase_start_ts
                e_abs = now + 1.5 if not is_final else now + 0.5

                log.info("realtime transcript emitted: text=%r chunkId=%d start=%.3f end=%.3f",
                         text, rt_chunk_id, s_abs, e_abs)

                payload = {
                    "type": "transcript",
                    "text": text,
                    "isFinal": is_final,
                    "mode": REALTIME_TRANSCRIBER,
                    "chunkId": rt_chunk_id,
                    "receivedAt": now,
                    "segmentStartTs": s_abs,
                    "segmentEndTs": e_abs,
                }
                if delta is not None:
                    payload["delta"] = delta
                if is_final:
                    phrase_start_ts = None
                await ws.send_text(json.dumps(payload, ensure_ascii=False))

            async def clear_after_idle() -> None:
                await asyncio.sleep(caption_state.idle_s)
                caption_state.flush()
                await send_realtime_caption("", is_final=True)

            def schedule_idle_clear() -> None:
                nonlocal clear_task
                if clear_task:
                    clear_task.cancel()
                clear_task = asyncio.create_task(clear_after_idle())

            async def browser_to_openai() -> None:
                nonlocal audio_frames_sent, audio_bytes_sent
                while True:
                    msg = await ws.receive()
                    if msg.get("type") == "websocket.disconnect":
                        return
                    if "bytes" in msg and msg["bytes"]:
                        audio_frames_sent += 1
                        audio_bytes_sent += len(msg["bytes"])
                        if audio_frames_sent == 1 or audio_frames_sent % 100 == 0:
                            log.info(
                                "openai realtime audio forwarded frames=%d bytes=%d",
                                audio_frames_sent,
                                audio_bytes_sent,
                            )
                        audio = base64.b64encode(msg["bytes"]).decode("ascii")
                        await upstream.send(json.dumps({
                            "type": "input_audio_buffer.append",
                            "audio": audio,
                        }))
                    elif "text" in msg and msg["text"]:
                        try:
                            cfg = json.loads(msg["text"])
                        except json.JSONDecodeError:
                            continue
                        if cfg.get("type") == "config":
                            old_target = session.target_lang
                            old_source = session.source_lang
                            old_latency = session.realtime_latency
                            apply_config(session, cfg)
                            if session.realtime_latency != old_latency:
                                caption_state.set_latency(session.realtime_latency)
                            if session.source_lang != old_source:
                                raw_transcript_parts.clear()
                                caption_state.flush()
                                await upstream.send(json.dumps(realtime_transcription_session_update(session.source_lang)))
                            if session.target_lang != old_target:
                                raw_transcript_parts.clear()
                                caption_state.flush()
                                log.info("realtime target changed target=%s; translation is applied after transcription", session.target_lang)

            async def openai_to_browser() -> None:
                async for raw in upstream:
                    try:
                        event = json.loads(raw)
                    except json.JSONDecodeError:
                        continue

                    event_type = event.get("type")
                    if event_type in (
                        "conversation.item.input_audio_transcription.delta",
                        "response.audio_transcript.delta",
                    ):
                        delta = event.get("delta") or ""
                        if not delta:
                            continue
                        log.info("openai realtime transcript delta chars=%d", len(delta))
                        is_new_buffer = not raw_transcript_parts
                        raw_transcript_parts.append(delta)
                        if should_translate_session(session):
                            if is_new_buffer:
                                if clear_task:
                                    clear_task.cancel()
                                await send_realtime_caption("", is_final=False)
                            log.info(
                                "openai realtime transcript delta buffered for translation target=%s",
                                session.target_lang,
                            )
                            continue
                        if clear_task:
                            clear_task.cancel()
                        for text, is_final in caption_state.append(delta):
                            await send_realtime_caption(text, is_final=is_final, delta=delta)
                        schedule_idle_clear()
                    elif event_type in (
                        "conversation.item.input_audio_transcription.completed",
                        "conversation.item.input_audio_transcription.done",
                        "response.audio_transcript.done",
                    ):
                        text = event.get("transcript") or "".join(raw_transcript_parts) or caption_state.flush()
                        raw_transcript_parts.clear()
                        caption_state.flush()
                        log.info("openai realtime transcript completed chars=%d", len(text or ""))
                        if text and should_translate_session(session):
                            src = session.source_lang if session.source_lang != "auto" else "auto"
                            raw_text = text
                            text = await asyncio.to_thread(translate, text, src, session.target_lang)
                            log.info(
                                "openai realtime translated final source=%s target=%s raw_chars=%d out_chars=%d",
                                src,
                                session.target_lang,
                                len(raw_text),
                                len(text or ""),
                            )
                        if text:
                            await send_realtime_caption(text, is_final=True)
                        schedule_idle_clear()
                    elif event_type in ("session.created", "transcription_session.created", "transcription_session.updated"):
                        log.info("openai realtime event type=%s", event_type)
                    elif event_type in ("error", "session.error"):
                        log.warning("openai realtime error event: %s", event)
                        await send_safe_error(ws, openai_event_error_message(event))

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
        finally:
            await upstream.close()
    except WebSocketDisconnect:
        pass
    except TimeoutError:
        log.warning("openai realtime websocket connection timeout after %.1fs", OPENAI_REALTIME_CONNECT_TIMEOUT_S)
        await send_safe_error(ws, openai_error_message("connection_timeout"))
    except Exception as e:
        status, body = extract_ws_status(e)
        code = parse_openai_error_code(body, status)
        if openai_connected and code == "websocket_handshake_failure":
            code = "openai_realtime_closed"
            reason = getattr(e, "reason", None)
            close_code = getattr(e, "code", None)
            body = body or f"closed after connect code={close_code} reason={reason or type(e).__name__}"
        log.exception(
            "openai realtime bridge failed exc=%s status=%s code=%s body=%s",
            type(e).__name__,
            status,
            code,
            body,
        )
        await send_safe_error(ws, openai_error_message(code, status, body))


# ----- websocket loop -------------------------------------------------------
async def handle_socket(ws: WebSocket):
    await ws.accept()
    session = Session()
    chunk_queue: asyncio.Queue[ChunkItem | None] | None = None
    chunk_worker: asyncio.Task | None = None
    log.info("client connected")

    try:
        # First message must be config (text JSON).
        first = await ws.receive()
        if "text" in first and first["text"]:
            try:
                cfg = json.loads(first["text"])
                if cfg.get("type") == "config":
                    token_error = validate_mobile_ws_config(cfg)
                    if token_error:
                        await send_safe_error(ws, token_error)
                        await ws.close(code=1008)
                        return
                    apply_config(session, cfg)
                    log.info("config: rate=%s src=%s tgt=%s task=%s transcriber=%s",
                             session.sample_rate, session.source_lang,
                             session.target_lang, session.task, session.transcriber)
            except json.JSONDecodeError:
                pass

        if session.transcriber == REALTIME_TRANSCRIBER:
            await handle_realtime_socket(ws, session)
            return

        # Keep only the newest pending chunk while local Whisper work
        # is running. Live subtitles should skip stale audio, not build backlog.
        chunk_queue = asyncio.Queue(maxsize=1)
        chunk_worker = asyncio.create_task(handle_latest_chunk_queue(ws, session, chunk_queue))
        while True:
            msg = await ws.receive()
            if msg.get("type") == "websocket.disconnect":
                break

            if "bytes" in msg and msg["bytes"]:
                await replace_latest_chunk(
                    chunk_queue,
                    ChunkItem(
                        raw_bytes=msg["bytes"],
                        arrived_at=time.monotonic(),
                        captured_at=session.next_chunk_captured_at,
                        client_chunk_id=session.next_chunk_id,
                    ),
                )
                session.next_chunk_captured_at = None
                session.next_chunk_id = None

            elif "text" in msg and msg["text"]:
                # Allow runtime reconfig and optional per-chunk metadata.
                try:
                    cfg = json.loads(msg["text"])
                    if cfg.get("type") == "config":
                        token_error = validate_mobile_ws_config(cfg)
                        if token_error:
                            await send_safe_error(ws, token_error)
                            await ws.close(code=1008)
                            break
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

        await replace_latest_chunk(chunk_queue, None)
        await chunk_worker

    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.exception("session error: %s", e)
        try:
            await ws.send_text(json.dumps({"type": "error", "message": str(e)}))
        except Exception:
            pass
    finally:
        if chunk_worker and not chunk_worker.done() and chunk_queue:
            await replace_latest_chunk(chunk_queue, None)
            try:
                await chunk_worker
            except Exception as e:
                log.debug("chunk worker stopped with error: %s", e)
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
    api_key, api_key_source = resolve_openai_api_key("root")
    return {
        "ok": True,
        "model": MODEL_SIZE,
        "device": DEVICE,
        "compute": _effective_compute_type or resolve_compute_type(DEVICE, COMPUTE_TYPE),
        "transcriber": TRANSCRIBER,
        "openai_realtime_model": OPENAI_REALTIME_TRANSCRIBE_MODEL,
        "openai_realtime_url": OPENAI_REALTIME_TRANSCRIBE_URL,
        "api_key_configured": bool(api_key),
        "api_key_source": api_key_source,
        "api_key_masked": mask_openai_key(api_key),
        "ready": True,
        "translator": TRANSLATOR,
        "ws": f"ws://{HOST}:{PORT}/ws",
        "mobile_token_required": mobile_token_required(),
    }


@app.post("/translate", response_model=TranslateResponse)
async def translate_text(req: TranslateRequest):
    require_mobile_token(req.token)
    text = (req.text or "").strip()
    if not text:
        return TranslateResponse(text="")
    src = safe_source_lang_or_error(req.sourceLang)
    tgt = safe_target_lang_or_error(req.targetLang)
    return TranslateResponse(text=translate(text[:MAX_TRANSLATE_CHARS], src, tgt))


@app.get("/settings/api-key", response_model=ApiKeyStatusResponse)
async def api_key_status():
    api_key, source = resolve_openai_api_key("status")
    return ApiKeyStatusResponse(configured=bool(api_key), source=source, masked=mask_openai_key(api_key))


@app.post("/settings/api-key", response_model=ApiKeyActionResponse)
async def save_api_key(req: ApiKeySaveRequest):
    global _openai_client
    api_key, source = await save_and_resolve_openai_key(
        req.apiKey,
        context="save_api_key",
        test_connection=req.test,
    )
    _openai_client = None
    return ApiKeyActionResponse(
        ok=True,
        configured=True,
        message="OpenAI API key saved and Realtime connection successful." if req.test else "OpenAI API key saved.",
        source=source,
        masked=mask_openai_key(api_key),
    )


@app.post("/settings/api-key/test", response_model=ApiKeyActionResponse)
async def test_api_key(req: ApiKeyTestRequest):
    global _openai_client
    if req.apiKey is not None:
        api_key, source = await save_and_resolve_openai_key(
            req.apiKey,
            context="test_api_key_save",
            test_connection=True,
        )
        _openai_client = None
    else:
        api_key, source = await validate_resolved_openai_key("test_api_key")
    return ApiKeyActionResponse(
        ok=True,
        configured=True,
        message="OpenAI Realtime connection successful.",
        source=source,
        masked=mask_openai_key(api_key),
    )


@app.delete("/settings/api-key", response_model=ApiKeyActionResponse)
async def clear_saved_api_key():
    global _openai_client
    deleted = delete_stored_openai_key()
    _openai_client = None
    api_key, source = resolve_openai_api_key("clear_api_key")
    log.info(
        "openai saved api key clear deleted=%s fallback_source=%s fallback_masked=%s",
        deleted,
        source or "none",
        mask_openai_key(api_key),
    )
    return ApiKeyActionResponse(
        ok=True,
        configured=bool(api_key),
        message="Saved API key cleared." if deleted else "No saved API key to clear.",
        source=source,
        masked=mask_openai_key(api_key),
    )


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await handle_socket(ws)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host=HOST, port=PORT, log_level="info")
