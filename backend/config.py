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
#   "openai-realtime" streams audio to OpenAI Realtime Translation.
#   "local" uses faster-whisper.
TRANSCRIBER = os.getenv("KAMI_TRANSCRIBER", "local").strip().lower()

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

# Translation backend: "google" (deep-translator via web, zero setup) | "none"
# Future: "argos" for fully offline.
TRANSLATOR = os.getenv("KAMI_TRANSLATOR", "google")

HOST = os.getenv("KAMI_HOST", "127.0.0.1")
PORT = int(os.getenv("KAMI_PORT", "8765"))

# Chunked input audio from the extension is 16kHz mono PCM Int16.
# Realtime translation sessions use 24kHz mono PCM Int16.
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

# Optional shared token for Android clients. Leave empty for local/dev use.
MOBILE_TOKEN = os.getenv("SUBSTREAM_MOBILE_TOKEN", "")
