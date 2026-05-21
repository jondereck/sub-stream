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
from functools import partial
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
    nvidia_root: Optional[Path] = None
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
    MAX_CHUNK_LAG_S, MOBILE_TOKEN, OPENAI_TRANSLATION_MODEL,
    OPENAI_TRANSCRIBE_MODEL, CHUNK_DURATION_MS, MAX_BUFFER_MS,
    VAD_SILENCE_MS, PARTIAL_EMIT_ENABLED, TRANSLATION_FLUSH_MS,
    SHOW_SOURCE_FIRST, TRANSLATION_DISPLAY_MODE, TRANSLATION_GRACE_MS,
)

log = logging.getLogger("sub-stream-ai")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

# ----- model load (lazy, once per process) ----------------------------------
_model = None
_openai_client = None
_effective_compute_type = None

OPENAI_REALTIME_TRANSCRIBE_MODEL = os.getenv("OPENAI_REALTIME_TRANSCRIBE_MODEL", "gpt-4o-transcribe")
OPENAI_REALTIME_TRANSCRIBE_URL = "wss://api.openai.com/v1/realtime?intent=transcription"
OPENAI_REALTIME_TRANSLATE_MODEL = os.getenv("OPENAI_REALTIME_TRANSLATE_MODEL", "gpt-realtime-translate").strip()
OPENAI_REALTIME_TRANSLATE_URL = (
    "wss://api.openai.com/v1/realtime/translations"
    f"?model={OPENAI_REALTIME_TRANSLATE_MODEL}"
)
OPENAI_REALTIME_CONNECT_TIMEOUT_S = float(os.getenv("OPENAI_REALTIME_CONNECT_TIMEOUT_S", "15"))
REALTIME_TRANSCRIBER = "openai-realtime"
REALTIME_TRANSLATE_TRANSCRIBER = "openai-realtime-translate"
OPENAI_CHUNKED_TRANSCRIBER = "openai-chunked"
REALTIME_TRANSCRIBERS = {REALTIME_TRANSCRIBER, REALTIME_TRANSLATE_TRANSCRIBER}
REALTIME_PHRASE_CHARS = 72
REALTIME_PHRASE_IDLE_S = 0.75
REALTIME_MIN_SEGMENT_S = 0.45
REALTIME_MAX_SEGMENT_S = 4.0
REALTIME_TEXT_SECONDS_PER_CHAR = 1 / 16
REALTIME_LATENCY_PROFILES = {
    "fast": {"phrase_chars": 42, "phrase_words": 6, "stable_s": 0.24, "idle_s": 0.65},
    "balanced": {"phrase_chars": 60, "phrase_words": 8, "stable_s": 0.42, "idle_s": 0.90},
    "accurate": {"phrase_chars": 92, "phrase_words": 12, "stable_s": 0.75, "idle_s": 1.25},
}
REALTIME_LATENCY_ALIASES = {"stable": "accurate"}
PARTIAL_TRANSLATION_BY_LATENCY = {
    "fast": True,
    "balanced": True,
    "accurate": False,
}
ALLOWED_TRANSCRIBERS = {"local", REALTIME_TRANSCRIBER, REALTIME_TRANSLATE_TRANSCRIBER, OPENAI_CHUNKED_TRANSCRIBER}
ALLOWED_TRANSLATORS = {"openai", "gpt", "google", "local", "none"}
ALLOWED_TRANSLATION_DISPLAY_MODES = {"translation_replace", "translation_dual"}
ALLOWED_TRANSLATION_MODES = {"auto", "filipino_english"}
MAX_GLOSSARY_TERMS = 40
MAX_GLOSSARY_TERM_CHARS = 80
MAX_GLOSSARY_TOTAL_CHARS = 1000
MAX_CONTEXT_SEGMENTS = 2
MAX_CONTEXT_SEGMENT_CHARS = 300
REALTIME_MERGE_GAP_S = 0.25
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
    translationMode: str = "auto"
    glossaryTerms: list[str] | str | None = None
    contextSegments: list[str] | None = None


class TranslateResponse(BaseModel):
    text: str


class ApiKeySaveRequest(BaseModel):
    apiKey: str = Field(default="", max_length=300)
    test: bool = True


class ApiKeyTestRequest(BaseModel):
    apiKey: Optional[str] = Field(default=None, max_length=300)


class ApiKeyStatusResponse(BaseModel):
    configured: bool
    source: Optional[str] = None
    masked: Optional[str] = None


class ApiKeyActionResponse(BaseModel):
    ok: bool
    configured: bool
    message: Optional[str] = None
    source: Optional[str] = None
    masked: Optional[str] = None


def mobile_token_required() -> bool:
    return bool(MOBILE_TOKEN.strip())


def mobile_token_matches(value: Optional[str]) -> bool:
    if not mobile_token_required():
        return True
    return hmac.compare_digest((value or "").strip(), MOBILE_TOKEN.strip())


def is_android_client(cfg: dict) -> bool:
    return (cfg.get("client") or "").strip().lower() == "android"


def validate_mobile_ws_config(cfg: dict) -> Optional[str]:
    if is_android_client(cfg) and not mobile_token_matches(cfg.get("token")):
        return "Android client token is missing or invalid."
    return None


def require_mobile_token(token: Optional[str]) -> None:
    if not mobile_token_matches(token):
        raise HTTPException(status_code=403, detail="Invalid mobile token.")


def safe_source_lang_or_error(value: Optional[str]) -> str:
    lang = (value or "auto").strip().lower()
    if lang not in ALLOWED_SOURCE_LANGS:
        raise HTTPException(status_code=400, detail="Unsupported source language.")
    return lang


def safe_target_lang_or_error(value: Optional[str]) -> str:
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


def read_stored_openai_key() -> Optional[str]:
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


def normalize_openai_key(api_key: Optional[str]) -> Optional[str]:
    key = (api_key or "").strip()
    return key or None


def mask_openai_key(api_key: Optional[str]) -> Optional[str]:
    key = normalize_openai_key(api_key)
    if not key:
        return None
    if len(key) <= 12:
        return f"{key[:4]}...{key[-2:]}"
    return f"{key[:8]}...{key[-4:]}"


def resolve_openai_api_key(context: str) -> tuple[Optional[str], Optional[str]]:
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
        status: Optional[int] = None,
        body: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status
        self.body = body


def openai_error_message(code: str, status: Optional[int] = None, body: Optional[str] = None) -> str:
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


def parse_openai_error_code(body: Optional[str], status: Optional[int] = None) -> str:
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


def extract_ws_status(exc: Exception) -> tuple[Optional[int], Optional[str]]:
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


def log_openai_key_state(context: str, api_key: Optional[str], source: Optional[str]) -> None:
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


def require_request_openai_key(api_key: Optional[str]) -> str:
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


def restore_previous_openai_key(previous_key: Optional[str]) -> None:
    try:
        if previous_key:
            write_stored_openai_key(previous_key)
        else:
            delete_stored_openai_key()
    except Exception as e:
        log.warning("could not restore previous OpenAI API key after failed save: %s", e)


async def save_and_resolve_openai_key(
    raw_api_key: Optional[str],
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
LANGUAGE_NAMES = {
    "ar": "Arabic",
    "en": "English",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "tr": "Turkish",
    "ja": "Japanese",
    "ko": "Korean",
    "zh": "Chinese",
    "hi": "Hindi",
    "it": "Italian",
    "pt": "Portuguese",
    "ru": "Russian",
    "id": "Indonesian",
    "ms": "Malay",
    "th": "Thai",
    "vi": "Vietnamese",
    "fil": "Filipino",
    "auto": "the detected source language",
}


def language_name(code: Optional[str]) -> str:
    normalized = (code or "auto").strip().lower()
    return LANGUAGE_NAMES.get(normalized, normalized or "the detected source language")


def safe_translation_mode(value: Optional[str]) -> str:
    mode = (value or "auto").strip().lower().replace("-", "_")
    return mode if mode in ALLOWED_TRANSLATION_MODES else "auto"


def safe_translation_mode_or_error(value: Optional[str]) -> str:
    mode = (value or "auto").strip().lower().replace("-", "_")
    if mode not in ALLOWED_TRANSLATION_MODES:
        raise HTTPException(status_code=400, detail="Unsupported translation mode.")
    return mode


def normalize_glossary_terms(value) -> list[str]:
    if value is None:
        return []
    raw_terms = value
    if isinstance(value, str):
        raw_terms = re.split(r"[\n,;]+", value)
    if not isinstance(raw_terms, list):
        return []

    terms: list[str] = []
    seen: set[str] = set()
    total_chars = 0
    for raw in raw_terms:
        term = cleanup_transcript_text(str(raw or ""))[:MAX_GLOSSARY_TERM_CHARS]
        if not term:
            continue
        key = term.casefold()
        if key in seen:
            continue
        if len(terms) >= MAX_GLOSSARY_TERMS:
            break
        if total_chars + len(term) > MAX_GLOSSARY_TOTAL_CHARS:
            break
        seen.add(key)
        terms.append(term)
        total_chars += len(term)
    return terms


def normalize_context_segments(value) -> list[str]:
    if not isinstance(value, list):
        return []
    segments: list[str] = []
    for raw in value[-MAX_CONTEXT_SEGMENTS:]:
        segment = cleanup_transcript_text(str(raw or ""))[:MAX_CONTEXT_SEGMENT_CHARS]
        if segment:
            segments.append(segment)
    return segments


def reject_oversized_translation_inputs(glossary_terms, context_segments) -> None:
    if isinstance(glossary_terms, str) and len(glossary_terms) > MAX_GLOSSARY_TOTAL_CHARS:
        raise HTTPException(status_code=400, detail="Glossary is too large.")
    if isinstance(glossary_terms, list):
        raw_terms = [str(term or "") for term in glossary_terms]
        if len(raw_terms) > MAX_GLOSSARY_TERMS:
            raise HTTPException(status_code=400, detail="Too many glossary terms.")
        if any(len(term) > MAX_GLOSSARY_TERM_CHARS for term in raw_terms):
            raise HTTPException(status_code=400, detail="A glossary term is too long.")
        if sum(len(term) for term in raw_terms) > MAX_GLOSSARY_TOTAL_CHARS:
            raise HTTPException(status_code=400, detail="Glossary is too large.")
    if isinstance(context_segments, list):
        raw_segments = [str(segment or "") for segment in context_segments]
        if len(raw_segments) > MAX_CONTEXT_SEGMENTS:
            raise HTTPException(status_code=400, detail="Too many context segments.")
        if any(len(segment) > MAX_CONTEXT_SEGMENT_CHARS for segment in raw_segments):
            raise HTTPException(status_code=400, detail="A context segment is too long.")


def should_use_filipino_english_mode(mode: str, src: str, tgt: str) -> bool:
    if mode == "filipino_english":
        return True
    langs = {src, tgt}
    return "fil" in langs and ("en" in langs or src == "auto")


_FILLER_TOKENS = {
    "ah",
    "eh",
    "er",
    "erm",
    "hm",
    "hmm",
    "mm",
    "mhm",
    "uh",
    "uhh",
    "uhm",
    "um",
}
_UNSTABLE_SINGLE_WORDS = {
    "a",
    "am",
    "an",
    "and",
    "are",
    "as",
    "at",
    "but",
    "for",
    "he",
    "i",
    "in",
    "is",
    "it",
    "of",
    "on",
    "or",
    "she",
    "so",
    "that",
    "the",
    "they",
    "this",
    "to",
    "we",
    "you",
}
_TOKEN_STRIP_CHARS = " \t\r\n.,!?;:()[]{}\"'`"
_NOISE_ONLY_RE = re.compile(
    r"^\s*[\[\(]?\s*(?:background\s+music|music|applause|laughter|laughs|noise|"
    r"silence|inaudible|foreign\s+language|speaking\s+foreign\s+language|"
    r"crosstalk)\s*[\]\)]?\s*$",
    re.IGNORECASE,
)
_WORD_RE = re.compile(r"\b[\w']+\b", re.UNICODE)


@dataclass
class PreparedTranscript:
    text: str
    held: bool = False
    reason: Optional[str] = None
    raw: str = ""
    pending_age_s: float = 0.0


def _token_key(token: str) -> str:
    return token.strip(_TOKEN_STRIP_CHARS).casefold()


def _transcript_words(text: str) -> list[str]:
    return [word for word in _WORD_RE.findall(text or "") if word.strip("_")]


def _is_filler_token(token: str) -> bool:
    key = _token_key(token)
    return bool(key) and key in _FILLER_TOKENS


def _strip_edge_fillers(text: str) -> str:
    parts = text.split()
    if not parts:
        return ""
    if all(_is_filler_token(part) for part in parts):
        return ""
    while len(parts) > 1 and _is_filler_token(parts[0]):
        parts.pop(0)
    while len(parts) > 1 and _is_filler_token(parts[-1]):
        parts.pop()
    return " ".join(parts)


def _collapse_repeated_tokens(text: str) -> str:
    parts = text.split()
    if not parts:
        return ""

    output: list[str] = []
    last_key = ""
    repeat_count = 0
    for part in parts:
        key = _token_key(part)
        if key and key == last_key:
            repeat_count += 1
        else:
            last_key = key
            repeat_count = 1

        max_repeats = 1 if key in _FILLER_TOKENS else 2
        if not key or repeat_count <= max_repeats:
            output.append(part)

    return " ".join(output)


def _fix_leading_sentence_punctuation(text: str) -> str:
    cleaned = (text or "").strip()
    if not cleaned:
        return ""

    match = re.match(r"^([.!?。！？؟]+)\s*(\S.*)$", cleaned)
    if not match:
        return cleaned

    leading, rest = match.groups()
    if not re.match(r"^[\w\"'(\[]", rest, flags=re.UNICODE):
        return cleaned

    terminal = leading[-1]
    rest = rest.strip()
    if re.search(r"[.!?。！？؟]$", rest):
        return rest
    return f"{rest}{terminal}"


def cleanup_transcript_text(text: str) -> str:
    cleaned = (text or "").replace("\ufeff", " ").replace("\u200b", " ")
    cleaned = cleaned.replace("\r", " ").replace("\n", " ")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned or _NOISE_ONLY_RE.search(cleaned):
        return ""

    cleaned = re.sub(r"\.{4,}", "...", cleaned)
    cleaned = re.sub(r"([!?])\1{1,}", r"\1", cleaned)
    cleaned = re.sub(r"([,;:])\1{1,}", r"\1", cleaned)
    cleaned = re.sub(r"\s+([,.!?;:])", r"\1", cleaned)
    cleaned = re.sub(r"([¿¡])\s+", r"\1", cleaned)
    cleaned = _strip_edge_fillers(cleaned)
    cleaned = _fix_leading_sentence_punctuation(_collapse_repeated_tokens(cleaned))
    return re.sub(r"\s+", " ", cleaned).strip()


def merge_transcript_fragments(previous: str, current: str) -> str:
    previous = cleanup_transcript_text(previous)
    current = cleanup_transcript_text(current)
    if not previous:
        return current
    if not current:
        return previous
    if previous.endswith("-"):
        return cleanup_transcript_text(previous[:-1] + current)
    if current[0] in ".,!?;:":
        return cleanup_transcript_text(previous + current)
    return cleanup_transcript_text(previous + " " + current)


def transcript_has_boundary(text: str) -> bool:
    return bool(re.search(r"[.!?。！？؟]\s*$", text or ""))


def transcript_needs_more_context(
    text: str,
    *,
    had_pending: bool,
    pending_age_s: float,
    max_pending_s: float = 1.2,
) -> bool:
    cleaned = cleanup_transcript_text(text)
    if not cleaned:
        return False
    if transcript_has_boundary(cleaned):
        return False
    if had_pending and pending_age_s >= max_pending_s:
        return False

    words = _transcript_words(cleaned)
    compact_len = len(re.sub(r"\s+", "", cleaned))
    if len(words) == 1:
        key = _token_key(words[0])
        return key in _UNSTABLE_SINGLE_WORDS or compact_len <= 2
    if len(words) == 2 and compact_len < 10 and not had_pending:
        return True
    return False


@dataclass
class TranscriptStabilityBuffer:
    pending_text: str = ""
    pending_since: Optional[float] = None

    def reset(self) -> None:
        self.pending_text = ""
        self.pending_since = None

    def prepare(
        self,
        text: str,
        *,
        force: bool = False,
        max_pending_s: float = 1.2,
    ) -> PreparedTranscript:
        cleaned = cleanup_transcript_text(text)
        if not cleaned:
            self.reset()
            return PreparedTranscript(text="", reason="empty-or-noise", raw=text)

        now = time.time()
        had_pending = bool(self.pending_text)
        if had_pending and self.pending_since is None:
            self.pending_since = now
        pending_age_s = now - self.pending_since if self.pending_since is not None else 0.0
        candidate = merge_transcript_fragments(self.pending_text, cleaned) if had_pending else cleaned

        if looks_like_hallucination(candidate):
            self.reset()
            return PreparedTranscript(text="", reason="hallucination", raw=text)

        if not force and transcript_needs_more_context(
            candidate,
            had_pending=had_pending,
            pending_age_s=pending_age_s,
            max_pending_s=max_pending_s,
        ):
            self.pending_text = candidate
            if self.pending_since is None:
                self.pending_since = now
            return PreparedTranscript(
                text="",
                held=True,
                reason="unstable-fragment",
                raw=text,
                pending_age_s=pending_age_s,
            )

        self.reset()
        return PreparedTranscript(text=candidate, raw=text, pending_age_s=pending_age_s)


def translate_with_google(text: str, src: str, tgt: str) -> str:
    from deep_translator import GoogleTranslator
    src_arg = "auto" if src in (None, "", "auto") else src
    return GoogleTranslator(source=src_arg, target=tgt).translate(text)


def translate_with_openai(
    text: str,
    src: str,
    tgt: str,
    *,
    translation_mode: str = "auto",
    glossary_terms: Optional[list[str]] = None,
    context_segments: Optional[list[str]] = None,
) -> str:
    client = get_openai_client()
    mode = safe_translation_mode(translation_mode)
    glossary_terms = normalize_glossary_terms(glossary_terms)
    context_segments = normalize_context_segments(context_segments)
    filipino_english = should_use_filipino_english_mode(mode, src, tgt)
    extra_rules = ""
    if filipino_english:
        extra_rules += (
            " Treat Filipino-English code-switching as normal speech. "
            "Preserve English words, technical terms, app names, brands, places, and proper nouns when they are already natural. "
            "Do not force every Taglish segment into pure English or pure Filipino if that would sound awkward. "
            "Lightly normalize fillers such as ano, parang, kasi, ganun, diba, ah, uhm only when they hurt readability; keep them when they carry tone or meaning. "
        )
    if glossary_terms:
        extra_rules += " Protected terms that must stay consistent: " + ", ".join(glossary_terms) + ". "

    input_parts = []
    if context_segments:
        input_parts.append("Recent context:\n" + "\n".join(f"- {segment}" for segment in context_segments))
    input_parts.append("Current subtitle:\n" + cleanup_transcript_text(text))

    response = client.responses.create(
        model=OPENAI_TRANSLATION_MODEL,
        instructions=(
            "You are a professional subtitle translator for live captions. "
            f"Translate from {language_name(src)} to clean, natural {language_name(tgt)}. "
            "Write subtitle-friendly text, not a literal word-by-word gloss. "
            "Remove obvious ASR junk, repeated filler, stutters, and meaningless fragments. "
            "If the input is incomplete, produce the most natural readable subtitle that preserves the intent. "
            "Do not leave source-language words unless they are proper nouns, names, titles, brands, quoted terms, or natural code-switched terms. "
            "Preserve names, numbers, speaker intent, and important tone. "
            "Use recent context only to resolve meaning; translate only the current subtitle. "
            f"{extra_rules}"
            "Output only the final subtitle text."
        ),
        input="\n\n".join(input_parts),
        max_output_tokens=400,
    )
    translated = (getattr(response, "output_text", "") or "").strip()
    return cleanup_transcript_text(translated) or cleanup_transcript_text(text)


def translate(
    text: str,
    src: str,
    tgt: str,
    translator: Optional[str] = None,
    *,
    translation_mode: str = "auto",
    glossary_terms: Optional[list[str]] = None,
    context_segments: Optional[list[str]] = None,
) -> str:
    text = cleanup_transcript_text(text)
    if not text or src == tgt:
        return text
    selected = (translator or TRANSLATOR or "openai").strip().lower()
    if selected not in ALLOWED_TRANSLATORS:
        selected = "openai"
    if selected in ("local", "none"):
        return text

    if selected in ("openai", "gpt"):
        try:
            return translate_with_openai(
                text,
                src,
                tgt,
                translation_mode=translation_mode,
                glossary_terms=glossary_terms,
                context_segments=context_segments,
            )
        except Exception as e:
            log.warning(
                "openai translation failed model=%s (%s -> %s): %s; falling back to google",
                OPENAI_TRANSLATION_MODEL,
                src,
                tgt,
                e,
            )

    if selected in ("openai", "gpt", "google"):
        try:
            return translate_with_google(text, src, tgt)
        except Exception as e:
            log.warning("google translation failed (%s -> %s): %s", src, tgt, e)

    return text


# ----- session --------------------------------------------------------------
@dataclass
class SyncSnapshot:
    session_id: str
    engine: str
    whisper_model: Optional[str]
    device: Optional[str]
    sample_count: int
    rolling_avg_latency_s: float
    recommended_auto_offset_s: float
    updated_at: float


@dataclass
class SessionLatencyTracker:
    session_id: str
    engine: str
    whisper_model: Optional[str] = None
    device: Optional[str] = None
    max_samples: int = 12
    min_valid_latency_s: float = 0.2
    max_valid_latency_s: float = 6.0
    offset_factor: float = 0.7
    min_auto_offset_s: float = -1.5
    max_auto_offset_s: float = 0.0
    samples: Deque[float] = field(default_factory=lambda: deque(maxlen=12))
    last_snapshot: Optional[SyncSnapshot] = None
    _lock: Lock = field(default_factory=Lock)

    def __post_init__(self) -> None:
        if self.samples.maxlen != self.max_samples:
            self.samples = deque(self.samples, maxlen=self.max_samples)

    def register_transcript_emit(
        self,
        captured_at: Optional[float],
        emitted_at: Optional[float] = None,
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
    translator: str = TRANSLATOR if TRANSLATOR in ALLOWED_TRANSLATORS else "openai"
    chunk_duration_ms: int = CHUNK_DURATION_MS
    max_buffer_ms: int = MAX_BUFFER_MS
    vad_silence_ms: int = VAD_SILENCE_MS
    partial_emit_enabled: bool = PARTIAL_EMIT_ENABLED
    translation_flush_ms: int = TRANSLATION_FLUSH_MS
    show_source_first: bool = SHOW_SOURCE_FIRST
    translation_display_mode: str = (
        TRANSLATION_DISPLAY_MODE
        if TRANSLATION_DISPLAY_MODE in ALLOWED_TRANSLATION_DISPLAY_MODES
        else "translation_replace"
    )
    translation_grace_ms: int = TRANSLATION_GRACE_MS
    translation_mode: str = "auto"
    glossary_terms: list[str] = field(default_factory=list)
    recent_segments: Deque[str] = field(default_factory=lambda: deque(maxlen=MAX_CONTEXT_SEGMENTS))
    chunk_id: int = 0
    next_chunk_id: Optional[int] = None
    next_chunk_captured_at: Optional[float] = None
    local_transcript_buffer: TranscriptStabilityBuffer = field(default_factory=TranscriptStabilityBuffer)
    realtime_transcript_buffer: TranscriptStabilityBuffer = field(default_factory=TranscriptStabilityBuffer)
    sync_tracker: SessionLatencyTracker = field(init=False)

    def __post_init__(self) -> None:
        self.sync_tracker = SessionLatencyTracker(
            session_id=self.session_id,
            engine=engine_name_for_transcriber(self.transcriber),
            whisper_model=MODEL_SIZE,
            device=DEVICE,
        )

    def context_segments(self) -> list[str]:
        return list(self.recent_segments)[-MAX_CONTEXT_SEGMENTS:]

    def remember_segment(self, text: str) -> None:
        cleaned = cleanup_transcript_text(text)[:MAX_CONTEXT_SEGMENT_CHARS]
        if cleaned:
            self.recent_segments.append(cleaned)


@dataclass
class ChunkItem:
    raw_bytes: bytes
    arrived_at: float
    captured_at: Optional[float] = None
    client_chunk_id: Optional[int] = None


@dataclass
class AudioChunkTiming:
    chunk_id: int
    start_ts: float
    end_ts: float
    received_at: float


class RealtimeAudioTimeline:
    """Tracks capture-time windows for realtime audio frames sent upstream."""

    def __init__(self, max_chunks: int = 1200) -> None:
        self.chunks: Deque[AudioChunkTiming] = deque(maxlen=max_chunks)
        self.last_chunk_id = 0
        self.phrase_start_ts: Optional[float] = None

    def add_chunk(
        self,
        *,
        raw_bytes: bytes,
        sample_rate: int,
        received_at: float,
        chunk_id: Optional[int] = None,
        captured_at: Optional[float] = None,
        duration: Optional[float] = None,
    ) -> AudioChunkTiming:
        if chunk_id is None:
            chunk_id = self.last_chunk_id + 1
        self.last_chunk_id = max(self.last_chunk_id, chunk_id)

        duration_s = valid_duration(duration)
        if duration_s is None:
            duration_s = chunk_duration_s(len(raw_bytes) // 2, sample_rate)

        previous = self.chunks[-1] if self.chunks else None
        if captured_at is None:
            captured_at = previous.end_ts if previous else received_at

        timing = AudioChunkTiming(
            chunk_id=chunk_id,
            start_ts=captured_at,
            end_ts=max(captured_at + duration_s, captured_at + 0.001),
            received_at=received_at,
        )
        self.chunks.append(timing)
        log.info(
            "realtime chunk #%d: chunkStartTs=%.3f chunkEndTs=%.3f receivedAt=%.3f",
            timing.chunk_id,
            timing.start_ts,
            timing.end_ts,
            timing.received_at,
        )
        return timing

    def caption_window(self, text: str, *, is_final: bool, now: float) -> AudioChunkTiming:
        latest = self.chunks[-1] if self.chunks else None
        if latest is None:
            fallback_duration = caption_duration_s(text)
            start_ts = now
            end_ts = now + fallback_duration
            chunk_id = self.last_chunk_id + 1
            self.last_chunk_id = chunk_id
            return AudioChunkTiming(chunk_id, start_ts, end_ts, now)

        if self.phrase_start_ts is None:
            target_duration = caption_duration_s(text)
            self.phrase_start_ts = max(latest.start_ts, latest.end_ts - target_duration)

        end_ts = max(latest.end_ts, self.phrase_start_ts + REALTIME_MIN_SEGMENT_S)
        if end_ts - self.phrase_start_ts > REALTIME_MAX_SEGMENT_S:
            self.phrase_start_ts = end_ts - REALTIME_MAX_SEGMENT_S

        timing = AudioChunkTiming(latest.chunk_id, self.phrase_start_ts, end_ts, latest.received_at)
        if is_final:
            self.phrase_start_ts = None
        return timing

    def reset_phrase(self) -> None:
        self.phrase_start_ts = None


def valid_duration(value: Optional[float]) -> Optional[float]:
    if value is None:
        return None
    try:
        duration = float(value)
    except (TypeError, ValueError):
        return None
    if duration <= 0 or duration > 30:
        return None
    return duration


def chunk_duration_s(sample_count: int, sample_rate: int) -> float:
    if sample_count <= 0 or sample_rate <= 0:
        return 0.001
    return sample_count / sample_rate


def caption_duration_s(text: str) -> float:
    text_len = len((text or "").strip())
    estimated = text_len * REALTIME_TEXT_SECONDS_PER_CHAR
    return max(REALTIME_MIN_SEGMENT_S, min(REALTIME_MAX_SEGMENT_S, estimated))


def chunk_age_s(created_at: Optional[float], fallback_at: float) -> float:
    return time.time() - (created_at if created_at is not None else fallback_at)


def chunk_is_stale(created_at: Optional[float], fallback_at: float) -> bool:
    return chunk_age_s(created_at, fallback_at) > MAX_CHUNK_LAG_S


def chunk_timing_payload(
    *,
    chunk_id: int,
    received_at: float,
    sample_count: int,
    sample_rate: int,
    captured_at: Optional[float] = None,
    segment_start_rel: Optional[float] = None,
    segment_end_rel: Optional[float] = None,
) -> dict:
    base_ts = captured_at if captured_at is not None else received_at
    duration_s = chunk_duration_s(sample_count, sample_rate)
    segment_start_ts = base_ts + segment_start_rel if segment_start_rel is not None else base_ts
    segment_end_ts = base_ts + segment_end_rel if segment_end_rel is not None else base_ts + duration_s
    if segment_end_ts <= segment_start_ts:
        segment_end_ts = segment_start_ts + max(duration_s, REALTIME_MIN_SEGMENT_S)

    log.info(
        "chunk #%d: chunkStartTs=%.3f chunkEndTs=%.3f segmentStartTs=%.3f segmentEndTs=%.3f receivedAt=%.3f",
        chunk_id,
        base_ts,
        base_ts + duration_s,
        segment_start_ts,
        segment_end_ts,
        received_at,
    )
    return {
        "chunkId": chunk_id,
        "receivedAt": received_at,
        "segmentStartTs": segment_start_ts,
        "segmentEndTs": segment_end_ts,
    }


def caption_id_for(session: Session, prefix: str, chunk_id: int) -> str:
    return f"{session.session_id}:{prefix}:{chunk_id}"


def subtitle_stage_from_phase(phase: str) -> str:
    return "translation" if (phase or "").startswith("translated") else "source"


def transcript_payload(
    session: Session,
    *,
    text: str,
    caption_id: str,
    segment_id: str,
    phase: str,
    is_final: bool,
    timing: dict,
    sync: dict,
    emitted_at: float,
    source_text: Optional[str] = None,
    translated_text: Optional[str] = None,
    detected_lang: Optional[str] = None,
    delta: Optional[str] = None,
    translation_started_at: Optional[float] = None,
    extra: Optional[dict] = None,
) -> dict:
    stage = subtitle_stage_from_phase(phase)
    source = cleanup_transcript_text(source_text if source_text is not None else text)
    translated = cleanup_transcript_text(translated_text if translated_text is not None else (text if stage == "translation" else ""))
    payload = {
        "type": "transcript",
        "text": text,
        "raw": source,
        "sourceText": source,
        "translatedText": translated,
        "stage": stage,
        "captionId": caption_id,
        "segmentId": segment_id,
        "phase": phase,
        "isFinal": is_final,
        "showSourceFirst": session.show_source_first,
        "translationDisplayMode": session.translation_display_mode,
        "translationGraceMs": session.translation_grace_ms,
        **timing,
        "transcriptEmittedAt": emitted_at,
        "sync": sync,
    }
    if detected_lang:
        payload["detectedLang"] = detected_lang
    if delta is not None:
        payload["delta"] = delta
    if translation_started_at is not None:
        payload["translationStartedAt"] = translation_started_at
        payload["translationEmittedAt"] = emitted_at
        payload["transcriptToTranslationDelayMs"] = max(0, round((emitted_at - translation_started_at) * 1000))
    if extra:
        payload.update(extra)
    return payload


def log_subtitle_emit(payload: dict) -> None:
    stage = payload.get("stage")
    segment_id = payload.get("segmentId")
    chunk_id = payload.get("chunkId")
    phase = payload.get("phase")
    text = payload.get("text") or ""
    if stage == "translation":
        log.info(
            "translation emitted segmentId=%s chunkId=%s phase=%s chars=%d transcriptToTranslationDelayMs=%s",
            segment_id,
            chunk_id,
            phase,
            len(text),
            payload.get("transcriptToTranslationDelayMs"),
        )
    else:
        log.info(
            "transcript emitted segmentId=%s chunkId=%s phase=%s chars=%d",
            segment_id,
            chunk_id,
            phase,
            len(text),
        )


async def send_transcript_payload(ws: WebSocket, payload: dict) -> None:
    log_subtitle_emit(payload)
    await ws.send_text(json.dumps(payload, ensure_ascii=False))


def transcribe_chunk(session: Session, pcm_int16: np.ndarray) -> tuple[str, str, Optional[float], Optional[float]]:
    """Returns (raw_text, detected_lang, start, end)."""
    if session.transcriber == OPENAI_CHUNKED_TRANSCRIBER:
        return transcribe_chunk_openai(session, pcm_int16)
    return transcribe_chunk_local(session, pcm_int16)


def safe_transcriber(value: Optional[str]) -> str:
    transcriber = (value or TRANSCRIBER or "local").strip().lower()
    return transcriber if transcriber in ALLOWED_TRANSCRIBERS else "local"


def safe_translator(value: Optional[str]) -> str:
    translator = (value or TRANSLATOR or "openai").strip().lower()
    return translator if translator in ALLOWED_TRANSLATORS else "openai"


def safe_target_lang(value: Optional[str]) -> str:
    lang = (value or "ar").strip().lower()
    return lang if lang in ALLOWED_TARGET_LANGS else "ar"


def safe_realtime_latency(value: Optional[str]) -> str:
    latency = (value or "balanced").strip().lower()
    latency = REALTIME_LATENCY_ALIASES.get(latency, latency)
    return latency if latency in REALTIME_LATENCY_PROFILES else "balanced"


def safe_translation_display_mode(value: Optional[str]) -> str:
    mode = (value or "translation_replace").strip().lower()
    return mode if mode in ALLOWED_TRANSLATION_DISPLAY_MODES else "translation_replace"


def safe_int_range(value, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, parsed))


def safe_bool(value, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    normalized = str(value).strip().lower()
    if normalized in ("1", "true", "yes", "on"):
        return True
    if normalized in ("0", "false", "no", "off"):
        return False
    return default


def should_translate_session(session: Session) -> bool:
    return session.task == "translate" and session.source_lang != session.target_lang


def session_partial_translation_enabled(session: Session) -> bool:
    default_for_latency = PARTIAL_TRANSLATION_BY_LATENCY.get(session.realtime_latency, True)
    return bool(session.partial_emit_enabled and default_for_latency)


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
    default_rate = REALTIME_SAMPLE_RATE if session.transcriber in REALTIME_TRANSCRIBERS else SAMPLE_RATE
    session.sample_rate = safe_sample_rate(cfg.get("sampleRate", session.sample_rate), default_rate)
    session.source_lang = cfg.get("sourceLang", session.source_lang) or "auto"
    session.target_lang = safe_target_lang(cfg.get("targetLang", session.target_lang))
    session.realtime_latency = safe_realtime_latency(cfg.get("realtimeLatency", session.realtime_latency))
    session.task = cfg.get("task", session.task) or "transcribe"
    session.translator = safe_translator(cfg.get("translator", session.translator))
    session.chunk_duration_ms = safe_int_range(cfg.get("chunkDurationMs"), session.chunk_duration_ms, 250, 5000)
    session.max_buffer_ms = safe_int_range(cfg.get("maxBufferMs"), session.max_buffer_ms, 250, 10000)
    session.vad_silence_ms = safe_int_range(cfg.get("vadSilenceMs"), session.vad_silence_ms, 150, 2000)
    session.partial_emit_enabled = safe_bool(cfg.get("partialEmitEnabled"), session.partial_emit_enabled)
    session.translation_flush_ms = safe_int_range(
        cfg.get("translationFlushMs"),
        session.translation_flush_ms,
        150,
        3000,
    )
    session.show_source_first = safe_bool(cfg.get("showSourceFirst"), session.show_source_first)
    session.translation_display_mode = safe_translation_display_mode(
        cfg.get("translationDisplayMode", session.translation_display_mode)
    )
    session.translation_grace_ms = safe_int_range(
        cfg.get("translationGraceMs"),
        session.translation_grace_ms,
        0,
        2000,
    )
    session.translation_mode = safe_translation_mode(cfg.get("translationMode", session.translation_mode))
    if "glossaryTerms" in cfg:
        session.glossary_terms = normalize_glossary_terms(cfg.get("glossaryTerms"))
    if any(key in cfg for key in ("sourceLang", "targetLang", "task", "transcriber", "translator")):
        session.local_transcript_buffer.reset()
        session.realtime_transcript_buffer.reset()
        session.recent_segments.clear()


def transcribe_chunk_local(session: Session, pcm_int16: np.ndarray) -> tuple[str, str, Optional[float], Optional[float]]:
    """Returns (raw_text, detected_lang, start, end) from local faster-whisper."""
    if pcm_int16.size == 0:
        return "", session.source_lang or "auto", None, None
    audio = pcm_int16.astype(np.float32) / 32768.0
    model = get_model()
    lang = None if session.source_lang in (None, "", "auto") else session.source_lang
    whisper_task = "translate" if (
        session.translator == "local" and
        should_translate_session(session) and
        session.target_lang == "en"
    ) else "transcribe"
    segments, info = model.transcribe(
        audio,
        language=lang,
        task=whisper_task,
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


def transcribe_chunk_openai(session: Session, pcm_int16: np.ndarray) -> tuple[str, str, Optional[float], Optional[float]]:
    """Returns (raw_text, detected_lang, start, end) from short OpenAI batch chunks."""
    if pcm_int16.size == 0:
        return "", session.source_lang or "auto", None, None

    client = get_openai_client()
    wav_file = pcm_to_wav_file(pcm_int16, session.sample_rate)
    language = None if session.source_lang in (None, "", "auto") else session.source_lang
    kwargs = {
        "model": OPENAI_TRANSCRIBE_MODEL,
        "file": wav_file,
        "response_format": "json",
    }
    if language:
        kwargs["language"] = language
    response = client.audio.transcriptions.create(**kwargs)
    text = cleanup_transcript_text(getattr(response, "text", "") or "")
    duration = chunk_duration_s(pcm_int16.size, session.sample_rate)
    return text, language or session.source_lang or "auto", 0.0 if text else None, duration if text else None


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
    captured_at: Optional[float] = None,
    client_chunk_id: Optional[int] = None,
) -> None:
    """One audio chunk: silence-gate -> transcribe -> translate -> send."""
    if client_chunk_id is not None:
        cid = client_chunk_id
        session.chunk_id = max(session.chunk_id, cid)
    else:
        session.chunk_id += 1
        cid = session.chunk_id

    caption_id = caption_id_for(session, "chunk", cid)
    segment_id = caption_id
    pcm = np.frombuffer(raw_bytes, dtype=np.int16)
    timing = chunk_timing_payload(
        chunk_id=cid,
        received_at=arrived_at,
        sample_count=pcm.size,
        sample_rate=session.sample_rate,
        captured_at=captured_at,
    )
    created_at = (captured_at if captured_at is not None else arrived_at)
    receive_lag_ms = (arrived_at - created_at) * 1000
    log.info(
        "latency chunk-created chunkId=%d createdAt=%.3f sendToBackendAt=%.3f backendReceiveAt=%.3f receiveLagMs=%.0f bytes=%d",
        cid,
        created_at,
        arrived_at,
        time.time(),
        receive_lag_ms,
        len(raw_bytes),
    )

    # Backlog drop. If processing has slipped behind real-time, this chunk
    # is already stale by the time we get to it. Subs from 15s ago are
    # worse UX than no subs at all — drop and let the next (fresher) chunk
    # catch us up. Send empty so the overlay clears.
    lag = chunk_age_s(captured_at, arrived_at)
    if lag > MAX_CHUNK_LAG_S:
        session.local_transcript_buffer.reset()
        log.info("chunk #%d: dropped (lag=%.2fs > %.1fs)", cid, lag, MAX_CHUNK_LAG_S)
        log.info(
            "transcript emitted chunkId=%d segmentStartTs=%.3f segmentEndTs=%.3f",
            cid,
            timing["segmentStartTs"],
            timing["segmentEndTs"],
        )
        await send_transcript_payload(ws, transcript_payload(
            session,
            text="",
            caption_id=caption_id,
            segment_id=segment_id,
            phase="source-final",
            is_final=True,
            timing=timing,
            sync=sync_payload(session.sync_tracker.current_snapshot()),
            emitted_at=time.time(),
            extra={"dropped": "lag"},
        ))
        return

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
        session.local_transcript_buffer.reset()
        log.info("chunk #%d: silence skip (rms=%.4f peak=%.3f)", cid, rms, peak)
        log.info(
            "transcript emitted chunkId=%d segmentStartTs=%.3f segmentEndTs=%.3f",
            cid,
            timing["segmentStartTs"],
            timing["segmentEndTs"],
        )
        await send_transcript_payload(ws, transcript_payload(
            session,
            text="",
            caption_id=caption_id,
            segment_id=segment_id,
            phase="source-final",
            is_final=True,
            timing=timing,
            sync=sync_payload(session.sync_tracker.current_snapshot()),
            emitted_at=time.time(),
            extra={"silence": True},
        ))
        return

    transcribe_started_at = time.time()
    log.info("latency transcribe-start chunkId=%d engine=%s at=%.3f", cid, session.transcriber, transcribe_started_at)
    raw, detected, s_rel, e_rel = await loop.run_in_executor(None, transcribe_chunk, session, pcm)
    transcript_ready_at = time.time()
    log.info(
        "latency transcript-ready chunkId=%d engine=%s at=%.3f transcribeMs=%.0f totalLagMs=%.0f",
        cid,
        session.transcriber,
        transcript_ready_at,
        (transcript_ready_at - transcribe_started_at) * 1000,
        (transcript_ready_at - created_at) * 1000,
    )
    if chunk_is_stale(captured_at, arrived_at):
        session.local_transcript_buffer.reset()
        log.info(
            "chunk #%d: dropped after transcribe (age=%.2fs > %.1fs) raw=%r",
            cid,
            chunk_age_s(captured_at, arrived_at),
            MAX_CHUNK_LAG_S,
            raw,
        )
        return
    emitted_at = transcript_ready_at
    timing = chunk_timing_payload(
        chunk_id=cid,
        received_at=arrived_at,
        sample_count=pcm.size,
        sample_rate=session.sample_rate,
        captured_at=captured_at if captured_at is not None else emitted_at - lag,
        segment_start_rel=s_rel,
        segment_end_rel=e_rel,
    )

    if not raw:
        session.local_transcript_buffer.reset()
        log.info("chunk #%d: empty transcript (lang=%s) rms=%.4f peak=%.3f",
                 cid, detected, rms, peak)
        log.info(
            "transcript emitted chunkId=%d segmentStartTs=%.3f segmentEndTs=%.3f",
            cid,
            timing["segmentStartTs"],
            timing["segmentEndTs"],
        )
        await send_transcript_payload(ws, transcript_payload(
            session,
            text="",
            caption_id=caption_id,
            segment_id=segment_id,
            phase="source-final",
            is_final=True,
            timing=timing,
            sync=sync_payload(session.sync_tracker.current_snapshot()),
            emitted_at=emitted_at,
            extra={"empty": True},
        ))
        return

    # Drop whole-chunk fansub-credit hallucinations BEFORE translating or
    # adding to history. If we add them to history they prime more
    # hallucinations on subsequent chunks via initial_prompt context.
    if looks_like_hallucination(raw):
        session.local_transcript_buffer.reset()
        log.info("chunk #%d: hallucination filter dropped raw=%r", cid, raw)
        log.info(
            "transcript emitted chunkId=%d segmentStartTs=%.3f segmentEndTs=%.3f",
            cid,
            timing["segmentStartTs"],
            timing["segmentEndTs"],
        )
        await send_transcript_payload(ws, transcript_payload(
            session,
            text="",
            source_text=raw,
            caption_id=caption_id,
            segment_id=segment_id,
            phase="source-final",
            is_final=True,
            timing=timing,
            sync=sync_payload(session.sync_tracker.current_snapshot()),
            emitted_at=emitted_at,
            extra={"filtered": "hallucination"},
        ))
        return

    source_preview_sent = False
    raw_source_text = cleanup_transcript_text(raw)
    if should_translate_session(session) and session.show_source_first and session.translator != "local" and raw_source_text:
        emitted_at = time.time()
        snapshot = session.sync_tracker.register_transcript_emit(captured_at, emitted_at)
        await send_transcript_payload(ws, transcript_payload(
            session,
            text=raw_source_text,
            source_text=raw_source_text,
            caption_id=caption_id,
            segment_id=segment_id,
            phase="source-preview",
            is_final=False,
            timing=timing,
            sync=sync_payload(snapshot),
            emitted_at=emitted_at,
            detected_lang=detected,
        ))
        source_preview_sent = True

    prepared = session.local_transcript_buffer.prepare(
        raw,
        force=not should_translate_session(session),
        max_pending_s=max(0.15, session.translation_flush_ms / 1000),
    )
    if not prepared.text:
        log.info(
            "chunk #%d: transcript preparation suppressed raw=%r reason=%s held=%s pendingAge=%.2fs",
            cid,
            raw,
            prepared.reason,
            prepared.held,
            prepared.pending_age_s,
        )
        log.info(
            "transcript emitted chunkId=%d segmentStartTs=%.3f segmentEndTs=%.3f",
            cid,
            timing["segmentStartTs"],
            timing["segmentEndTs"],
        )
        await send_transcript_payload(ws, transcript_payload(
            session,
            text="",
            source_text=cleanup_transcript_text(raw),
            caption_id=caption_id,
            segment_id=segment_id,
            phase="source-final",
            is_final=True,
            timing=timing,
            sync=sync_payload(session.sync_tracker.current_snapshot()),
            emitted_at=emitted_at,
            extra={
                "filtered": prepared.reason or "transcript-prep",
                "held": prepared.held,
            },
        ))
        return

    source_text = prepared.text
    src = detected if session.source_lang == "auto" else session.source_lang
    local_translation_done = (
        session.translator == "local" and
        should_translate_session(session) and
        session.target_lang == "en"
    )
    needs_translation = should_translate_session(session) and session.translator != "local"
    emitted_at = time.time()
    snapshot = session.sync_tracker.register_transcript_emit(captured_at, emitted_at)

    if needs_translation and not source_preview_sent:
        await send_transcript_payload(ws, transcript_payload(
            session,
            text=source_text,
            source_text=source_text,
            caption_id=caption_id,
            segment_id=segment_id,
            phase="source-preview",
            is_final=False,
            timing=timing,
            sync=sync_payload(snapshot),
            emitted_at=emitted_at,
            detected_lang=detected,
        ))
    if needs_translation:
        translation_started_at = time.time()
        log.info(
            "latency translation-start chunkId=%d source=%s target=%s at=%.3f transcriptLagMs=%.0f",
            cid,
            src,
            session.target_lang,
            translation_started_at,
            (translation_started_at - created_at) * 1000,
        )
        out = await loop.run_in_executor(
            None,
            partial(
                translate,
                source_text,
                src,
                session.target_lang,
                session.translator,
                translation_mode=session.translation_mode,
                glossary_terms=session.glossary_terms,
                context_segments=session.context_segments(),
            ),
        )
        if chunk_is_stale(captured_at, arrived_at):
            log.info(
                "chunk #%d: dropped translation after processing (age=%.2fs > %.1fs) source=%r translated=%r",
                cid,
                chunk_age_s(captured_at, arrived_at),
                MAX_CHUNK_LAG_S,
                source_text,
                out,
            )
            return
        final_phase = "translated-final"
    else:
        out = source_text
        final_phase = "translated-final" if local_translation_done else "source-final"
    session.remember_segment(source_text)

    emitted_at = time.time()
    if needs_translation:
        snapshot = session.sync_tracker.register_transcript_emit(captured_at, emitted_at)
        log.info(
            "latency translation-emitted chunkId=%d at=%.3f translateMs=%.0f totalLagMs=%.0f",
            cid,
            emitted_at,
            (emitted_at - translation_started_at) * 1000,
            (emitted_at - created_at) * 1000,
        )
    else:
        log.info(
            "latency transcript-emitted chunkId=%d at=%.3f totalLagMs=%.0f",
            cid,
            emitted_at,
            (emitted_at - created_at) * 1000,
        )
    log.info(
        "chunk #%d [%s->%s] raw=%r out=%r start=%.3f end=%.3f latency=%.3fs auto_offset=%.3fs",
        cid,
        src,
        session.target_lang,
        source_text,
        out,
        timing["segmentStartTs"],
        timing["segmentEndTs"],
        snapshot.rolling_avg_latency_s,
        snapshot.recommended_auto_offset_s,
    )
    log.info(
        "transcript emitted chunkId=%d segmentStartTs=%.3f segmentEndTs=%.3f",
        cid,
        timing["segmentStartTs"],
        timing["segmentEndTs"],
    )
    await send_transcript_payload(ws, transcript_payload(
        session,
        text=out,
        source_text=source_text,
        translated_text=out if final_phase.startswith("translated") else "",
        caption_id=caption_id,
        segment_id=segment_id,
        phase=final_phase,
        is_final=True,
        timing=timing,
        sync=sync_payload(snapshot),
        emitted_at=emitted_at,
        detected_lang=detected,
        translation_started_at=translation_started_at if needs_translation else None,
    ))


async def replace_latest_chunk(
    queue: asyncio.Queue[Optional[ChunkItem]],
    item: Optional[ChunkItem],
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
    queue: asyncio.Queue[Optional[ChunkItem]],
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


def realtime_transcription_session_update(
    source_lang: Optional[str] = None,
    vad_silence_ms: int = VAD_SILENCE_MS,
) -> dict:
    transcription: dict[str, str] = {"model": OPENAI_REALTIME_TRANSCRIBE_MODEL}
    if source_lang and source_lang != "auto":
        transcription["language"] = source_lang
    silence_ms = safe_int_range(vad_silence_ms, VAD_SILENCE_MS, 150, 2000)
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
                        "prefix_padding_ms": 180,
                        "silence_duration_ms": silence_ms,
                    },
                    "noise_reduction": {
                        "type": "near_field",
                    },
                },
            },
        },
    }


def realtime_translate_instructions(session: Session) -> str:
    target = language_name(session.target_lang)
    source = language_name(session.source_lang)
    rules = [
        f"Translate live speech from {source} to natural {target}.",
        "Output concise subtitle text only.",
        "Keep partial translations readable and revise them as needed.",
        "Preserve names, numbers, app names, brands, places, and protected terms.",
    ]
    if should_use_filipino_english_mode(session.translation_mode, session.source_lang, session.target_lang):
        rules.append(
            "Treat Filipino-English code-switching as normal Taglish speech. "
            "Preserve English technical words when natural and avoid awkward over-translation."
        )
    if session.glossary_terms:
        rules.append("Protected terms: " + ", ".join(session.glossary_terms) + ".")
    return " ".join(rules)


def realtime_translate_session_update(session: Session) -> dict:
    input_audio: dict = {
        "format": {
            "type": "audio/pcm",
            "rate": REALTIME_SAMPLE_RATE,
        },
        "turn_detection": {
            "type": "server_vad",
            "threshold": 0.5,
            "prefix_padding_ms": 180,
            "silence_duration_ms": safe_int_range(session.vad_silence_ms, VAD_SILENCE_MS, 150, 2000),
            "create_response": True,
            "interrupt_response": True,
        },
        "noise_reduction": {
            "type": "near_field",
        },
    }
    if session.show_source_first:
        transcription: dict[str, str] = {"model": OPENAI_REALTIME_TRANSCRIBE_MODEL}
        if session.source_lang and session.source_lang != "auto":
            transcription["language"] = session.source_lang
        input_audio["transcription"] = transcription

    return {
        "type": "session.update",
        "session": {
            "type": "realtime",
            "model": OPENAI_REALTIME_TRANSLATE_MODEL,
            "output_modalities": ["text"],
            "instructions": realtime_translate_instructions(session),
            "audio": {
                "input": input_audio,
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
    state = RealtimePhraseSegmenter()
    return state.append(text, now=time.time())



class RealtimePhraseSegmenter:
    """Buffers realtime transcript deltas into short stable subtitle phrases."""

    def __init__(self, latency: str = "balanced") -> None:
        self.set_latency(latency)
        self.current = ""
        self.started_at: Optional[float] = None
        self.last_delta_at: Optional[float] = None

    def set_latency(self, latency: str) -> None:
        profile = REALTIME_LATENCY_PROFILES.get(safe_realtime_latency(latency), REALTIME_LATENCY_PROFILES["balanced"])
        self.limit = int(profile["phrase_chars"])
        self.word_limit = int(profile["phrase_words"])
        self.stable_s = float(profile["stable_s"])
        self.idle_s = float(profile["idle_s"])

    @staticmethod
    def clean(text: str) -> str:
        return re.sub(r"\s+", " ", text or "").strip()

    @staticmethod
    def first_sentence_boundary(text: str):
        return re.search(r"[.!?。！？؟]+(?:\s+|$)", text)

    @staticmethod
    def phrase_boundary(text: str):
        return re.search(
            r"(?:[,;:]\s+|\b(?:and|but|so|because|kasi|pero|tapos|then|diba|di ba|para)\s+)",
            text or "",
            re.IGNORECASE,
        )

    def word_count(self) -> int:
        return len(re.findall(r"\b[\w'-]+\b", self.current, re.UNICODE))

    @property
    def has_pending(self) -> bool:
        return bool(self.current)

    def append(self, delta: str, *, now: Optional[float] = None) -> str:
        now = now if now is not None else time.time()
        if not self.current:
            self.started_at = now
        self.current = self.clean(self.current + (delta or ""))
        self.last_delta_at = now
        return self.current

    def ready_reason(self, *, now: Optional[float] = None) -> Optional[str]:
        if not self.current:
            return None
        now = now if now is not None else time.time()
        if self.first_sentence_boundary(self.current):
            return "boundary"
        if self.word_count() >= self.word_limit and self.phrase_boundary(self.current):
            return "phrase-boundary"
        if self.word_count() >= self.word_limit:
            return "word-limit"
        if len(self.current) >= self.limit:
            return "length"
        if self.last_delta_at is not None and now - self.last_delta_at >= self.stable_s:
            return "stable"
        return None

    def flush(self, *, force: bool = False, now: Optional[float] = None) -> str:
        if not force and self.ready_reason(now=now) is None:
            return ""
        text = self.clean(self.current)
        self.current = ""
        self.started_at = None
        self.last_delta_at = None
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
            await upstream.send(json.dumps(realtime_transcription_session_update(
                session.source_lang,
                session.vad_silence_ms,
            )))
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

            phrase_segmenter = RealtimePhraseSegmenter(session.realtime_latency)
            stable_task: Optional[asyncio.Task] = None
            clear_task: Optional[asyncio.Task] = None
            send_lock = asyncio.Lock()
            translation_tasks: set[asyncio.Task] = set()
            audio_frames_sent = 0
            audio_bytes_sent = 0
            raw_transcript_parts: list[str] = []
            realtime_timeline = RealtimeAudioTimeline()
            pending_chunk_meta: Optional[dict] = None
            realtime_caption_seq = 0
            active_caption_id: Optional[str] = None
            last_stable_caption_id: Optional[str] = None
            last_stable_source_text = ""
            last_stable_at = 0.0
            last_stable_timing: Optional[AudioChunkTiming] = None
            translation_tasks_by_caption: dict[str, asyncio.Task] = {}

            def current_realtime_caption_id() -> str:
                nonlocal realtime_caption_seq, active_caption_id
                if active_caption_id is None:
                    realtime_caption_seq += 1
                    active_caption_id = caption_id_for(session, "rt", realtime_caption_seq)
                return active_caption_id

            def reset_realtime_caption() -> None:
                nonlocal active_caption_id
                active_caption_id = None

            async def send_realtime_caption(
                text: str,
                *,
                caption_id: str,
                timing: AudioChunkTiming,
                is_final: bool = False,
                delta: Optional[str] = None,
                phase: str = "interim",
                source_text: Optional[str] = None,
                translated_text: Optional[str] = None,
                translation_started_at: Optional[float] = None,
            ) -> None:
                now = time.time()
                log.info(
                    "latency realtime-transcript-emitted text=%r captionId=%s phase=%s chunkId=%d segmentStartTs=%.3f segmentEndTs=%.3f emittedAt=%.3f totalLagMs=%.0f",
                    text,
                    caption_id,
                    phase,
                    timing.chunk_id,
                    timing.start_ts,
                    timing.end_ts,
                    now,
                    (now - timing.start_ts) * 1000,
                )
                timing_payload = {
                    "chunkId": timing.chunk_id,
                    "receivedAt": now,
                    "segmentStartTs": timing.start_ts,
                    "segmentEndTs": timing.end_ts,
                }
                payload = transcript_payload(
                    session,
                    text=text,
                    source_text=source_text,
                    translated_text=translated_text,
                    caption_id=caption_id,
                    segment_id=caption_id,
                    phase=phase,
                    is_final=is_final,
                    timing=timing_payload,
                    sync=sync_payload(session.sync_tracker.register_transcript_emit(timing.start_ts, now)),
                    emitted_at=now,
                    delta=delta,
                    translation_started_at=translation_started_at,
                    extra={"mode": REALTIME_TRANSCRIBER},
                )
                async with send_lock:
                    await send_transcript_payload(ws, payload)

            async def emit_source_preview(text: str, *, delta: Optional[str] = None) -> None:
                if not text:
                    return
                if should_translate_session(session) and not session.show_source_first:
                    return
                now = time.time()
                caption_id = current_realtime_caption_id()
                timing = realtime_timeline.caption_window(text, is_final=False, now=now)
                await send_realtime_caption(
                    text,
                    caption_id=caption_id,
                    timing=timing,
                    is_final=False,
                    delta=delta,
                    phase="source-preview" if should_translate_session(session) else "interim",
                    source_text=text,
                )

            async def translate_and_emit(
                *,
                caption_id: str,
                timing: AudioChunkTiming,
                source_text: str,
                src: str,
                translation_started_at: float,
            ) -> None:
                try:
                    translated = await asyncio.to_thread(
                        translate,
                        source_text,
                        src,
                        session.target_lang,
                        session.translator,
                        translation_mode=session.translation_mode,
                        glossary_terms=session.glossary_terms,
                        context_segments=session.context_segments(),
                    )
                    translated_at = time.time()
                    log.info(
                        "latency realtime-translation-emitted phase=stable source=%s target=%s rawChars=%d outChars=%d translateMs=%.0f totalLagMs=%.0f",
                        src,
                        session.target_lang,
                        len(source_text),
                        len(translated or ""),
                        (translated_at - translation_started_at) * 1000,
                        (translated_at - timing.start_ts) * 1000,
                    )
                    if not translated:
                        return
                    session.remember_segment(source_text)
                    await send_realtime_caption(
                        translated,
                        caption_id=caption_id,
                        timing=timing,
                        is_final=True,
                        phase="translated-final",
                        source_text=source_text,
                        translated_text=translated,
                        translation_started_at=translation_started_at,
                    )
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    log.warning("realtime stable phrase translation failed: %s", e)

            def track_translation_task(task: asyncio.Task) -> None:
                translation_tasks.add(task)
                task.add_done_callback(lambda finished: translation_tasks.discard(finished))

            def track_caption_translation_task(caption_id: str, task: asyncio.Task) -> None:
                old_task = translation_tasks_by_caption.pop(caption_id, None)
                if old_task and not old_task.done():
                    old_task.cancel()
                translation_tasks_by_caption[caption_id] = task
                track_translation_task(task)
                task.add_done_callback(lambda finished: translation_tasks_by_caption.pop(caption_id, None))

            async def emit_stable_phrase(*, force: bool = False, reason: str = "stable") -> None:
                nonlocal stable_task, last_stable_caption_id, last_stable_source_text, last_stable_at, last_stable_timing
                current_task = asyncio.current_task()
                if stable_task and stable_task is not current_task:
                    stable_task.cancel()
                stable_task = None

                now = time.time()
                text = phrase_segmenter.flush(force=force, now=now)
                if not text:
                    return

                prepared = session.realtime_transcript_buffer.prepare(text, force=True)
                if not prepared.text:
                    log.info(
                        "openai realtime phrase suppressed reason=%s raw=%r",
                        prepared.reason,
                        text,
                    )
                    realtime_timeline.reset_phrase()
                    reset_realtime_caption()
                    return

                source_text = prepared.text
                should_merge = (
                    last_stable_caption_id is not None and
                    last_stable_timing is not None and
                    now - last_stable_at <= REALTIME_MERGE_GAP_S
                )
                if should_merge:
                    caption_id = last_stable_caption_id
                    source_text = merge_transcript_fragments(last_stable_source_text, source_text)
                    timing = AudioChunkTiming(
                        last_stable_timing.chunk_id,
                        last_stable_timing.start_ts,
                        max(last_stable_timing.end_ts, realtime_timeline.caption_window(source_text, is_final=True, now=now).end_ts),
                        last_stable_timing.received_at,
                    )
                else:
                    caption_id = current_realtime_caption_id()
                    timing = realtime_timeline.caption_window(source_text, is_final=True, now=now)
                last_stable_caption_id = caption_id
                last_stable_source_text = source_text
                last_stable_at = now
                last_stable_timing = timing
                log.info(
                    "openai realtime phrase stable reason=%s captionId=%s chars=%d segmentStartTs=%.3f segmentEndTs=%.3f",
                    reason,
                    caption_id,
                    len(source_text),
                    timing.start_ts,
                    timing.end_ts,
                )

                if should_translate_session(session):
                    if session.show_source_first:
                        await send_realtime_caption(
                            source_text,
                            caption_id=caption_id,
                            timing=timing,
                            is_final=False,
                            phase="source-preview",
                            source_text=source_text,
                        )
                    src = session.source_lang if session.source_lang != "auto" else "auto"
                    translation_started_at = time.time()
                    track_caption_translation_task(caption_id, asyncio.create_task(translate_and_emit(
                        caption_id=caption_id,
                        timing=timing,
                        source_text=source_text,
                        src=src,
                        translation_started_at=translation_started_at,
                    )))
                else:
                    session.remember_segment(source_text)
                    await send_realtime_caption(
                        source_text,
                        caption_id=caption_id,
                        timing=timing,
                        is_final=True,
                        phase="source-final",
                        source_text=source_text,
                    )

                reset_realtime_caption()

            async def clear_after_idle() -> None:
                await asyncio.sleep(phrase_segmenter.idle_s)
                if phrase_segmenter.has_pending:
                    await emit_stable_phrase(force=True, reason="idle")

            def schedule_idle_clear() -> None:
                nonlocal clear_task
                if clear_task:
                    clear_task.cancel()
                clear_task = asyncio.create_task(clear_after_idle())

            async def flush_after_stable(expected_last_delta_at: Optional[float]) -> None:
                await asyncio.sleep(phrase_segmenter.stable_s)
                if (
                    phrase_segmenter.has_pending and
                    phrase_segmenter.last_delta_at == expected_last_delta_at and
                    phrase_segmenter.ready_reason(now=time.time()) == "stable"
                ):
                    await emit_stable_phrase(force=True, reason="stable-window")

            def schedule_stable_flush() -> None:
                nonlocal stable_task
                if stable_task:
                    stable_task.cancel()
                stable_task = asyncio.create_task(flush_after_stable(phrase_segmenter.last_delta_at))

            def reset_realtime_buffers() -> None:
                nonlocal stable_task, clear_task, last_stable_caption_id, last_stable_source_text, last_stable_at, last_stable_timing
                raw_transcript_parts.clear()
                phrase_segmenter.flush(force=True)
                session.realtime_transcript_buffer.reset()
                session.recent_segments.clear()
                realtime_timeline.reset_phrase()
                reset_realtime_caption()
                last_stable_caption_id = None
                last_stable_source_text = ""
                last_stable_at = 0.0
                last_stable_timing = None
                if stable_task:
                    stable_task.cancel()
                    stable_task = None
                if clear_task:
                    clear_task.cancel()
                    clear_task = None
                for task in list(translation_tasks_by_caption.values()):
                    task.cancel()
                translation_tasks_by_caption.clear()

            async def browser_to_openai() -> None:
                nonlocal audio_frames_sent, audio_bytes_sent, pending_chunk_meta
                while True:
                    msg = await ws.receive()
                    if msg.get("type") == "websocket.disconnect":
                        return
                    if "bytes" in msg and msg["bytes"]:
                        received_at = time.time()
                        meta = pending_chunk_meta or {}
                        pending_chunk_meta = None
                        try:
                            meta_chunk_id = int(meta.get("chunkId")) if meta.get("chunkId") is not None else None
                        except (TypeError, ValueError):
                            meta_chunk_id = None
                        try:
                            meta_captured_at = float(meta.get("capturedAt")) if meta.get("capturedAt") is not None else None
                        except (TypeError, ValueError):
                            meta_captured_at = None
                        meta_duration = valid_duration(meta.get("duration"))
                        realtime_timeline.add_chunk(
                            raw_bytes=msg["bytes"],
                            sample_rate=session.sample_rate,
                            received_at=received_at,
                            chunk_id=meta_chunk_id,
                            captured_at=meta_captured_at,
                            duration=meta_duration,
                        )
                        created_at = meta_captured_at if meta_captured_at is not None else received_at
                        audio_frames_sent += 1
                        audio_bytes_sent += len(msg["bytes"])
                        log.info(
                            "latency realtime-send chunkId=%s createdAt=%.3f backendReceiveAt=%.3f sendToOpenAIAt=%.3f receiveLagMs=%.0f bytes=%d",
                            meta_chunk_id,
                            created_at,
                            received_at,
                            time.time(),
                            (received_at - created_at) * 1000,
                            len(msg["bytes"]),
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
                            old_vad_silence_ms = session.vad_silence_ms
                            apply_config(session, cfg)
                            if session.realtime_latency != old_latency:
                                phrase_segmenter.set_latency(session.realtime_latency)
                            if session.source_lang != old_source or session.vad_silence_ms != old_vad_silence_ms:
                                reset_realtime_buffers()
                                await upstream.send(json.dumps(realtime_transcription_session_update(
                                    session.source_lang,
                                    session.vad_silence_ms,
                                )))
                            if session.target_lang != old_target:
                                reset_realtime_buffers()
                                log.info("realtime target changed target=%s; translation is applied after transcription", session.target_lang)
                        elif cfg.get("type") == "chunk":
                            pending_chunk_meta = cfg

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
                        delta_at = time.time()
                        latest_chunk = realtime_timeline.chunks[-1] if realtime_timeline.chunks else None
                        latest_start = latest_chunk.start_ts if latest_chunk else delta_at
                        log.info(
                            "latency realtime-transcript-delta chars=%d at=%.3f totalLagMs=%.0f",
                            len(delta),
                            delta_at,
                            (delta_at - latest_start) * 1000,
                        )
                        raw_transcript_parts.append(delta)
                        if clear_task:
                            clear_task.cancel()
                        text = phrase_segmenter.append(delta, now=delta_at)
                        if text:
                            await emit_source_preview(text, delta=delta)
                        reason = phrase_segmenter.ready_reason(now=delta_at)
                        if reason in ("boundary", "phrase-boundary", "word-limit", "length"):
                            await emit_stable_phrase(force=True, reason=reason)
                        elif phrase_segmenter.has_pending:
                            schedule_stable_flush()
                        schedule_idle_clear()
                    elif event_type in (
                        "conversation.item.input_audio_transcription.completed",
                        "conversation.item.input_audio_transcription.done",
                        "response.audio_transcript.done",
                    ):
                        had_deltas = bool(raw_transcript_parts)
                        text = event.get("transcript") or ""
                        raw_transcript_parts.clear()
                        log.info("openai realtime transcript completed chars=%d", len(text or ""))
                        if phrase_segmenter.has_pending:
                            await emit_stable_phrase(force=True, reason="completed")
                        elif text and not had_deltas:
                            phrase_segmenter.append(text, now=time.time())
                            await emit_source_preview(text)
                            await emit_stable_phrase(force=True, reason="completed")
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
            if stable_task:
                stable_task.cancel()
            for task in list(translation_tasks):
                task.cancel()
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


def realtime_event_delta_text(event: dict) -> str:
    for key in ("delta", "text", "transcript"):
        value = event.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


def realtime_event_final_text(event: dict) -> str:
    for key in ("text", "transcript", "output_text"):
        value = event.get(key)
        if isinstance(value, str) and value:
            return value
    response = event.get("response")
    if isinstance(response, dict):
        output_text = response.get("output_text")
        if isinstance(output_text, str) and output_text:
            return output_text
        output = response.get("output")
        if isinstance(output, list):
            parts: list[str] = []
            for item in output:
                if not isinstance(item, dict):
                    continue
                for content in item.get("content", []) or []:
                    if not isinstance(content, dict):
                        continue
                    text = content.get("text") or content.get("transcript")
                    if isinstance(text, str) and text:
                        parts.append(text)
            if parts:
                return cleanup_transcript_text(" ".join(parts))
    return ""


async def handle_realtime_translate_socket(ws: WebSocket, session: Session) -> None:
    """Bridge PCM frames to OpenAI Realtime Translate and emit translated deltas directly."""
    api_key, source = resolve_openai_api_key("realtime_translate_socket")
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
                OPENAI_REALTIME_TRANSLATE_URL,
                additional_headers=headers,
                max_size=None,
            ),
            timeout=OPENAI_REALTIME_CONNECT_TIMEOUT_S,
        )
        openai_connected = True
        try:
            await upstream.send(json.dumps(realtime_translate_session_update(session)))
            await wait_for_openai_session_ack(upstream, context="translate_runtime")
            log.info(
                "openai realtime translate connected status=101 source=%s masked=%s rate=%s lang=%s target=%s model=%s",
                source,
                mask_openai_key(api_key),
                session.sample_rate,
                session.source_lang,
                session.target_lang,
                OPENAI_REALTIME_TRANSLATE_MODEL,
            )

            send_lock = asyncio.Lock()
            realtime_timeline = RealtimeAudioTimeline()
            pending_chunk_meta: Optional[dict] = None
            caption_seq = 0
            active_caption_id: Optional[str] = None
            source_text = ""
            translated_text = ""
            translation_started_at: Optional[float] = None

            def current_caption_id() -> str:
                nonlocal caption_seq, active_caption_id, translation_started_at
                if active_caption_id is None:
                    caption_seq += 1
                    active_caption_id = caption_id_for(session, "rtx", caption_seq)
                    translation_started_at = time.time()
                return active_caption_id

            def reset_caption() -> None:
                nonlocal active_caption_id, source_text, translated_text, translation_started_at
                if source_text:
                    session.remember_segment(source_text)
                active_caption_id = None
                source_text = ""
                translated_text = ""
                translation_started_at = None

            async def send_realtime_translate_caption(
                text: str,
                *,
                stage: str,
                phase: str,
                is_final: bool,
                delta: Optional[str] = None,
            ) -> None:
                if not text:
                    return
                now = time.time()
                caption_id = current_caption_id()
                timing = realtime_timeline.caption_window(text, is_final=is_final, now=now)
                log.info(
                    "latency realtime-translate-%s text=%r captionId=%s chunkId=%d segmentStartTs=%.3f segmentEndTs=%.3f emittedAt=%.3f totalLagMs=%.0f",
                    stage,
                    text,
                    caption_id,
                    timing.chunk_id,
                    timing.start_ts,
                    timing.end_ts,
                    now,
                    (now - timing.start_ts) * 1000,
                )
                payload = transcript_payload(
                    session,
                    text=text,
                    source_text=source_text or (text if stage == "source" else ""),
                    translated_text=translated_text or (text if stage == "translation" else ""),
                    caption_id=caption_id,
                    segment_id=caption_id,
                    phase=phase,
                    is_final=is_final,
                    timing={
                        "chunkId": timing.chunk_id,
                        "receivedAt": now,
                        "segmentStartTs": timing.start_ts,
                        "segmentEndTs": timing.end_ts,
                    },
                    sync=sync_payload(session.sync_tracker.register_transcript_emit(timing.start_ts, now)),
                    emitted_at=now,
                    delta=delta,
                    translation_started_at=translation_started_at,
                    extra={"mode": REALTIME_TRANSLATE_TRANSCRIBER},
                )
                async with send_lock:
                    await send_transcript_payload(ws, payload)

            async def browser_to_openai() -> None:
                nonlocal pending_chunk_meta
                while True:
                    msg = await ws.receive()
                    if msg.get("type") == "websocket.disconnect":
                        return
                    if "bytes" in msg and msg["bytes"]:
                        received_at = time.time()
                        meta = pending_chunk_meta or {}
                        pending_chunk_meta = None
                        try:
                            meta_chunk_id = int(meta.get("chunkId")) if meta.get("chunkId") is not None else None
                        except (TypeError, ValueError):
                            meta_chunk_id = None
                        try:
                            meta_captured_at = float(meta.get("capturedAt")) if meta.get("capturedAt") is not None else None
                        except (TypeError, ValueError):
                            meta_captured_at = None
                        meta_duration = valid_duration(meta.get("duration"))
                        timing = realtime_timeline.add_chunk(
                            raw_bytes=msg["bytes"],
                            sample_rate=session.sample_rate,
                            received_at=received_at,
                            chunk_id=meta_chunk_id,
                            captured_at=meta_captured_at,
                            duration=meta_duration,
                        )
                        log.info(
                            "latency realtime-translate-send chunkId=%s createdAt=%.3f backendReceiveAt=%.3f sendToOpenAIAt=%.3f receiveLagMs=%.0f bytes=%d",
                            meta_chunk_id,
                            timing.start_ts,
                            received_at,
                            time.time(),
                            (received_at - timing.start_ts) * 1000,
                            len(msg["bytes"]),
                        )
                        await upstream.send(json.dumps({
                            "type": "input_audio_buffer.append",
                            "audio": base64.b64encode(msg["bytes"]).decode("ascii"),
                        }))
                    elif "text" in msg and msg["text"]:
                        try:
                            cfg = json.loads(msg["text"])
                        except json.JSONDecodeError:
                            continue
                        if cfg.get("type") == "config":
                            old_source = session.source_lang
                            old_target = session.target_lang
                            old_vad_silence_ms = session.vad_silence_ms
                            old_translation_mode = session.translation_mode
                            old_glossary_terms = list(session.glossary_terms)
                            apply_config(session, cfg)
                            if (
                                session.source_lang != old_source or
                                session.target_lang != old_target or
                                session.vad_silence_ms != old_vad_silence_ms or
                                session.translation_mode != old_translation_mode or
                                session.glossary_terms != old_glossary_terms
                            ):
                                reset_caption()
                                realtime_timeline.reset_phrase()
                                await upstream.send(json.dumps(realtime_translate_session_update(session)))
                        elif cfg.get("type") == "chunk":
                            pending_chunk_meta = cfg

            async def openai_to_browser() -> None:
                nonlocal source_text, translated_text
                async for raw in upstream:
                    try:
                        event = json.loads(raw)
                    except json.JSONDecodeError:
                        continue
                    event_type = event.get("type")
                    if event_type in (
                        "conversation.item.input_audio_transcription.delta",
                        "response.input_audio_transcription.delta",
                        "input_audio_transcription.delta",
                    ):
                        delta = realtime_event_delta_text(event)
                        if not delta or not session.show_source_first:
                            continue
                        source_text = cleanup_transcript_text(source_text + delta)
                        await send_realtime_translate_caption(
                            source_text,
                            stage="source",
                            phase="source-preview",
                            is_final=False,
                            delta=delta,
                        )
                    elif event_type in (
                        "conversation.item.input_audio_transcription.completed",
                        "conversation.item.input_audio_transcription.done",
                        "response.input_audio_transcription.done",
                        "input_audio_transcription.done",
                    ):
                        final = cleanup_transcript_text(realtime_event_final_text(event))
                        if final:
                            source_text = final
                    elif event_type in (
                        "response.output_text.delta",
                        "response.text.delta",
                        "response.audio_transcript.delta",
                        "response.output_audio_transcript.delta",
                    ):
                        delta = realtime_event_delta_text(event)
                        if not delta:
                            continue
                        translated_text = cleanup_transcript_text(translated_text + delta)
                        await send_realtime_translate_caption(
                            translated_text,
                            stage="translation",
                            phase="translated-preview",
                            is_final=False,
                            delta=delta,
                        )
                    elif event_type in (
                        "response.output_text.done",
                        "response.text.done",
                        "response.audio_transcript.done",
                        "response.output_audio_transcript.done",
                    ):
                        final = cleanup_transcript_text(realtime_event_final_text(event))
                        if final:
                            translated_text = final
                            await send_realtime_translate_caption(
                                translated_text,
                                stage="translation",
                                phase="translated-final",
                                is_final=True,
                            )
                    elif event_type == "response.done":
                        final = cleanup_transcript_text(realtime_event_final_text(event))
                        if final:
                            translated_text = final
                            await send_realtime_translate_caption(
                                translated_text,
                                stage="translation",
                                phase="translated-final",
                                is_final=True,
                            )
                        reset_caption()
                    elif event_type in ("session.created", "session.updated"):
                        log.info("openai realtime translate event type=%s", event_type)
                    elif event_type in ("error", "session.error"):
                        log.warning("openai realtime translate error event: %s", event)
                        await send_safe_error(ws, openai_event_error_message(event))

            tasks = {
                asyncio.create_task(browser_to_openai()),
                asyncio.create_task(openai_to_browser()),
            }
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            for task in done:
                task.result()
        finally:
            await upstream.close()
    except WebSocketDisconnect:
        pass
    except TimeoutError:
        log.warning("openai realtime translate websocket connection timeout after %.1fs", OPENAI_REALTIME_CONNECT_TIMEOUT_S)
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
            "openai realtime translate bridge failed exc=%s status=%s code=%s body=%s",
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
    chunk_queue: Optional[asyncio.Queue[Optional[ChunkItem]]] = None
    chunk_worker: Optional[asyncio.Task] = None
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
                    log.info("config: rate=%s src=%s tgt=%s task=%s transcriber=%s translator=%s",
                             session.sample_rate, session.source_lang,
                             session.target_lang, session.task, session.transcriber,
                             session.translator)
            except json.JSONDecodeError:
                pass

        if session.transcriber == REALTIME_TRANSCRIBER:
            await handle_realtime_socket(ws, session)
            return
        if session.transcriber == REALTIME_TRANSLATE_TRANSCRIBER:
            await handle_realtime_translate_socket(ws, session)
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
                        arrived_at=time.time(),
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
        "openai_transcribe_model": OPENAI_TRANSCRIBE_MODEL,
        "openai_realtime_model": OPENAI_REALTIME_TRANSCRIBE_MODEL,
        "openai_realtime_url": OPENAI_REALTIME_TRANSCRIBE_URL,
        "openai_realtime_translate_model": OPENAI_REALTIME_TRANSLATE_MODEL,
        "openai_realtime_translate_url": OPENAI_REALTIME_TRANSLATE_URL,
        "latency": {
            "chunkDurationMs": CHUNK_DURATION_MS,
            "maxBufferMs": MAX_BUFFER_MS,
            "vadSilenceMs": VAD_SILENCE_MS,
            "partialEmitEnabled": PARTIAL_EMIT_ENABLED,
            "translationFlushMs": TRANSLATION_FLUSH_MS,
            "showSourceFirst": SHOW_SOURCE_FIRST,
            "translationDisplayMode": (
                TRANSLATION_DISPLAY_MODE
                if TRANSLATION_DISPLAY_MODE in ALLOWED_TRANSLATION_DISPLAY_MODES
                else "translation_replace"
            ),
            "translationGraceMs": TRANSLATION_GRACE_MS,
        },
        "api_key_configured": bool(api_key),
        "api_key_source": api_key_source,
        "api_key_masked": mask_openai_key(api_key),
        "ready": True,
        "translator": TRANSLATOR,
        "openai_translation_model": OPENAI_TRANSLATION_MODEL,
        "ws": f"ws://{HOST}:{PORT}/ws",
        "mobile_token_required": mobile_token_required(),
    }


@app.get("/health")
async def health():
    return await root()


@app.post("/translate", response_model=TranslateResponse)
async def translate_text(req: TranslateRequest):
    require_mobile_token(req.token)
    reject_oversized_translation_inputs(req.glossaryTerms, req.contextSegments)
    prepared = TranscriptStabilityBuffer().prepare((req.text or "")[:MAX_TRANSLATE_CHARS], force=True)
    if not prepared.text:
        return TranslateResponse(text="")
    src = safe_source_lang_or_error(req.sourceLang)
    tgt = safe_target_lang_or_error(req.targetLang)
    translation_mode = safe_translation_mode_or_error(req.translationMode)
    return TranslateResponse(text=translate(
        prepared.text,
        src,
        tgt,
        translation_mode=translation_mode,
        glossary_terms=normalize_glossary_terms(req.glossaryTerms),
        context_segments=normalize_context_segments(req.contextSegments),
    ))


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
