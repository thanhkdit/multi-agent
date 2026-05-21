"""Whisper transcription layer using faster-whisper."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .errors import TranscribeError
from .utils import log

MODEL_CACHE: dict[tuple[str, str, str], Any] = {}
SUPPORTED_MODELS = ["tiny", "base", "small", "medium", "large-v3"]


def _import_whisper():
    try:
        from faster_whisper import WhisperModel
        return WhisperModel
    except ImportError:
        raise TranscribeError(
            "faster-whisper is not installed. Install: pip install faster-whisper"
        )


def get_model(model_name: str, compute_type: str, device: str) -> Any:
    key = (model_name, compute_type, device)
    if key not in MODEL_CACHE:
        WhisperModel = _import_whisper()
        log(f"[INFO] Loading Whisper model: {model_name} (device={device}, compute={compute_type})")
        try:
            MODEL_CACHE[key] = WhisperModel(model_name, device=device, compute_type=compute_type)
        except Exception as e:
            raise TranscribeError(f"Failed to load model '{model_name}': {e}") from e
    return MODEL_CACHE[key]


def transcribe(
    audio_path: Path,
    *,
    model_name: str = "base",
    compute_type: str = "int8",
    device: str = "cpu",
    language: str | None = None,
    beam_size: int = 5,
    vad_filter: bool = True,
) -> dict[str, Any]:
    """Transcribe a WAV audio file using faster-whisper.

    Returns dict with: language, language_probability, duration, text, segments.
    """
    if not audio_path.exists():
        raise TranscribeError(f"Audio file not found: {audio_path}")
    if audio_path.stat().st_size == 0:
        raise TranscribeError(f"Audio file is empty: {audio_path}")

    model = get_model(model_name, compute_type, device)
    log("[INFO] Transcribing audio with Whisper...")

    try:
        segments_iter, info = model.transcribe(
            str(audio_path),
            beam_size=beam_size,
            vad_filter=vad_filter,
            language=language,
        )
    except Exception as e:
        raise TranscribeError(f"Whisper transcription failed: {e}") from e

    seg_list: list[dict[str, Any]] = []
    texts: list[str] = []

    for seg in segments_iter:
        text = seg.text.strip()
        if not text:
            continue
        seg_list.append({
            "start": round(float(seg.start), 2),
            "end": round(float(seg.end), 2),
            "text": text,
        })
        texts.append(text)

    duration = (
        round(float(info.duration), 2)
        if getattr(info, "duration", None) is not None
        else None
    )

    log(f"[INFO] Done: {len(seg_list)} segments, lang={info.language}, duration={duration}s")

    return {
        "language": info.language,
        "language_probability": getattr(info, "language_probability", None),
        "duration": duration,
        "text": "\n".join(texts).strip(),
        "segments": seg_list,
    }
