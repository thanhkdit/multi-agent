"""Audio processing — probe, validate, and normalize audio streams."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .errors import AudioNormalizeError, NoAudioStreamError, TranscriptError
from .utils import log, run_command


def probe_audio_streams(input_path: Path) -> list[dict[str, Any]]:
    """Use ffprobe to get all audio stream information from a media file.

    Returns:
        List of audio stream dicts. Empty list means no audio.
    """
    cmd = [
        "ffprobe",
        "-v", "error",
        "-select_streams", "a",
        "-show_entries", "stream=index,codec_name,codec_type,sample_rate,channels,duration,bit_rate",
        "-of", "json",
        str(input_path),
    ]
    proc = run_command(cmd, check=False)

    try:
        payload = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        return []

    return payload.get("streams", [])


def has_audio_stream(input_path: Path) -> bool:
    """Check whether a media file contains at least one audio stream."""
    return len(probe_audio_streams(input_path)) > 0


def validate_audio(input_path: Path) -> None:
    """Validate that the input file has audio. Raise NoAudioStreamError if not.

    Provides a detailed error message with ffprobe info to help debugging.
    """
    if not input_path.exists():
        raise TranscriptError(f"Input file does not exist: {input_path}")

    streams = probe_audio_streams(input_path)
    if not streams:
        # Get all stream info for debugging
        all_streams = _probe_all_streams(input_path)
        stream_summary = ", ".join(
            f"{s.get('codec_type', '?')}:{s.get('codec_name', '?')}"
            for s in all_streams
        ) or "none"

        raise NoAudioStreamError(
            f"No audio stream found in: {input_path.name}\n"
            f"  File streams: [{stream_summary}]\n"
            f"  This file appears to be video-only or corrupted.\n"
            f"  Transcription requires an audio track."
        )

    audio = streams[0]
    log(
        f"[INFO] Audio stream found: "
        f"codec={audio.get('codec_name', '?')}, "
        f"sample_rate={audio.get('sample_rate', '?')}Hz, "
        f"channels={audio.get('channels', '?')}"
    )


def normalize_audio(input_path: Path, output_path: Path) -> None:
    """Extract and normalize audio to 16kHz mono WAV for Whisper.

    Steps:
    1. Validate audio stream exists
    2. Extract first audio stream
    3. Convert to 16kHz mono PCM WAV
    """
    validate_audio(input_path)

    log("[INFO] Normalizing audio to 16kHz mono WAV...")
    cmd = [
        "ffmpeg",
        "-y",                  # overwrite output
        "-i", str(input_path),
        "-map", "a:0",         # first audio stream only
        "-vn",                 # drop video
        "-ac", "1",            # mono
        "-ar", "16000",        # 16kHz
        "-c:a", "pcm_s16le",   # 16-bit PCM
        str(output_path),
    ]

    try:
        run_command(cmd)
    except TranscriptError as e:
        raise AudioNormalizeError(
            f"Audio normalization failed for {input_path.name}.\n"
            f"This may indicate a corrupted audio stream.\n"
            f"Detail: {e}"
        ) from e

    if not output_path.exists() or output_path.stat().st_size == 0:
        raise AudioNormalizeError(
            f"Audio normalization produced empty or missing output: {output_path}"
        )

    log(f"[INFO] Normalized audio: {output_path.name} ({output_path.stat().st_size} bytes)")


def _probe_all_streams(input_path: Path) -> list[dict[str, Any]]:
    """Get info about ALL streams (audio, video, subtitle, etc.)."""
    cmd = [
        "ffprobe",
        "-v", "error",
        "-show_entries", "stream=index,codec_type,codec_name",
        "-of", "json",
        str(input_path),
    ]
    proc = run_command(cmd, check=False)
    try:
        payload = json.loads(proc.stdout or "{}")
    except json.JSONDecodeError:
        return []
    return payload.get("streams", [])
