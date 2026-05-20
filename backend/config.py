import os
from pathlib import Path

"""Runtime config for Sub Stream AI backend. Override via env vars."""

try:
    from dotenv import load_dotenv
except ImportError:
    load_dotenv = None

if load_dotenv:
    _backend_dir = Path(__file__).resolve().parent
    load_dotenv(_backend_dir.parent / ".env")
    load_dotenv(_backend_dir / ".env", override=True)

# Transcription engine:
#   "openai-realtime" streams audio to OpenAI Realtime transcription.
#   "openai-chunked" sends short audio chunks to OpenAI speech-to-text.
#   "local" uses faster-whisper.
TRANSCRIBER = os.getenv("KAMI_TRANSCRIBER", "local").strip().lower()
OPENAI_TRANSCRIBE_MODEL = os.getenv("KAMI_OPENAI_TRANSCRIBE_MODEL", "gpt-4o-mini-transcribe").strip()

# faster-whisper model: tiny | base | small | medium | large-v3
# "base" keeps local captions closer to live on low-VRAM GPUs.
MODEL_SIZE = os.getenv("KAMI_MODEL", "base")

# "cpu" | "cuda" | "auto"
DEVICE = os.getenv("KAMI_DEVICE", "cpu")

# "int8" (CPU), "int8_float32" (older CUDA/low VRAM), "float16" (newer GPU), "float32"
COMPUTE_TYPE = os.getenv(
    "KAMI_COMPUTE",
    "int8_float32" if DEVICE == "cuda" else "int8",
)

# Translation backend: "openai" (best quality, needs API key) | "google" | "none"
# Future: "argos" for fully offline.
TRANSLATOR = os.getenv("KAMI_TRANSLATOR", "openai").strip().lower()

# OpenAI text model used only for translation. Realtime speech recognition
# still uses OPENAI_REALTIME_TRANSCRIBE_MODEL from server.py.
OPENAI_TRANSLATION_MODEL = os.getenv("OPENAI_TRANSLATION_MODEL", "gpt-5-mini").strip()

HOST = os.getenv("KAMI_HOST", "127.0.0.1")
PORT = int(os.getenv("KAMI_PORT", "8765"))

# Chunked input audio from the extension is 16kHz mono PCM Int16.
# Realtime transcription sessions use 24kHz mono PCM Int16.
SAMPLE_RATE = 16000
REALTIME_SAMPLE_RATE = 24000

# VAD trims silence/music before transcription. Enabled by default because
# whisper hallucinates fansub credits on non-speech audio — Silero VAD
# kills that at the source by simply not feeding non-speech to the model.
# Set KAMI_VAD=false to disable if you need to caption noisy/quiet content.
VAD_FILTER = os.getenv("KAMI_VAD", "true").lower() in ("1", "true", "yes")

# Max age of a chunk (seconds) before we drop it instead of transcribing.
# Prevents unbounded backlog: if processing slips behind real-time, we
# discard stale chunks so the user always sees what's *currently* playing
# instead of subs from 30 seconds ago.
MAX_CHUNK_LAG_S = float(os.getenv("KAMI_MAX_LAG_S", "2.0"))

# Low-latency pipeline knobs. These are also accepted per WebSocket session
# from the extension popup, so users can tune without changing audio playback.
CHUNK_DURATION_MS = int(os.getenv("SUBSTREAM_CHUNK_DURATION_MS", "650"))
MAX_BUFFER_MS = int(os.getenv("SUBSTREAM_MAX_BUFFER_MS", "900"))
VAD_SILENCE_MS = int(os.getenv("SUBSTREAM_VAD_SILENCE_MS", "350"))
PARTIAL_EMIT_ENABLED = os.getenv("SUBSTREAM_PARTIAL_EMIT_ENABLED", "true").lower() in ("1", "true", "yes")
TRANSLATION_FLUSH_MS = int(os.getenv("SUBSTREAM_TRANSLATION_FLUSH_MS", "450"))

# Optional shared token for Android clients. Leave empty for local/dev use.
MOBILE_TOKEN = os.getenv("SUBSTREAM_MOBILE_TOKEN", "")
