"""Pipeline orchestrator — ties all stages together."""

from __future__ import annotations

import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from .audio import normalize_audio
from .errors import TranscriptError
from .providers import DownloadConfig, detect_provider
from .transcriber import transcribe
from .utils import log, require_binary, save_json, save_text


@dataclass
class PipelineConfig:
    """All configuration for a single pipeline run."""
    input_value: str
    model: str = "base"
    language: Optional[str] = None
    compute_type: str = "int8"
    device: str = "cpu"
    beam_size: int = 5
    vad_filter: bool = True
    keep_temp: bool = False

    skip_download: bool = False
    # Download options
    cookies: Optional[str] = None
    referer: Optional[str] = None
    proxy: Optional[str] = None
    user_agent: Optional[str] = None


def run_pipeline(config: PipelineConfig) -> dict[str, Any]:
    """Execute the full transcription pipeline.

    Pipeline stages:
    1. Detect provider from input
    2. Download media (or use local file)
    3. Validate audio stream
    4. Normalize audio to 16kHz mono WAV
    5. Transcribe with Whisper
    6. Output results

    Returns:
        Full result dict with transcript and metadata.
    """
    # Check required binaries
    require_binary("ffmpeg")
    require_binary("ffprobe")

    provider = detect_provider(config.input_value)
    is_local = provider.name == "local"

    if not is_local and not config.skip_download:
        require_binary("yt-dlp")

    log(f"[INFO] Provider: {provider.name}")
    log(f"[INFO] Input: {config.input_value}")

    start_time = time.time()
    
    # Create a downloads folder next to the entry-point script
    script_dir = Path(__file__).resolve().parent.parent
    downloads_dir = script_dir / "downloads"
    downloads_dir.mkdir(parents=True, exist_ok=True)
    
    temp_dir_obj = tempfile.TemporaryDirectory(prefix="video_transcript_", dir=downloads_dir)
    temp_dir = Path(temp_dir_obj.name)
    normalized_path = temp_dir / "audio.wav"

    try:
        # Stage 1 & 2: Download or locate media
        if is_local or config.skip_download:
            media_path = Path(config.input_value).expanduser().resolve()
            provider_name = "local"
        else:
            dl_config = DownloadConfig(
                cookies=config.cookies,
                referer=config.referer,
                proxy=config.proxy,
                user_agent=config.user_agent,
            )
            dl_result = provider.download(config.input_value, temp_dir, dl_config)
            media_path = dl_result.media_path
            provider_name = dl_result.provider_name

        # Stage 3 & 4: Validate audio + normalize
        normalize_audio(media_path, normalized_path)

        # Stage 5: Transcribe
        result = transcribe(
            normalized_path,
            model_name=config.model,
            compute_type=config.compute_type,
            device=config.device,
            language=config.language,
            beam_size=config.beam_size,
            vad_filter=config.vad_filter,
        )

        # Add metadata
        result.update({
            "source": config.input_value,
            "source_kind": "file" if is_local else "url",
            "provider": provider_name,
            "model": config.model,
            "device": config.device,
            "compute_type": config.compute_type,
            "processing_time": round(time.time() - start_time, 2),
        })



        return result

    finally:
        if config.keep_temp:
            log(f"[INFO] Temp files kept at: {temp_dir}")
            temp_dir_obj.cleanup = lambda: None  # type: ignore[assignment]
        else:
            temp_dir_obj.cleanup()
