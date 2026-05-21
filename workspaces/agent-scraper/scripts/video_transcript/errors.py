"""Custom exceptions for the video transcript pipeline."""

from __future__ import annotations


class TranscriptError(RuntimeError):
    """Base error for all transcript pipeline failures."""
    pass


class DownloadError(TranscriptError):
    """Raised when media download fails."""
    pass


class NoAudioStreamError(TranscriptError):
    """Raised when the media file has no audio stream."""
    pass


class AudioNormalizeError(TranscriptError):
    """Raised when audio normalization via ffmpeg fails."""
    pass


class TranscribeError(TranscriptError):
    """Raised when Whisper transcription fails."""
    pass


class ProviderError(TranscriptError):
    """Raised when a specific provider encounters an error."""

    def __init__(self, provider: str, message: str) -> None:
        self.provider = provider
        super().__init__(f"[{provider}] {message}")
