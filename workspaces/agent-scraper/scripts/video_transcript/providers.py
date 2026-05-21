"""Provider abstraction — route URLs to the right download strategy.

Each provider knows how to build yt-dlp arguments optimized for its platform.
If a provider fails, it raises ProviderError with clear context.

Providers:
    - youtube   — YouTube videos/shorts
    - tiktok    — TikTok videos
    - facebook  — Facebook Reels / videos
    - local     — Local file (no download needed)
"""

from __future__ import annotations

import re

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

from .errors import DownloadError, ProviderError
from .utils import log, run_command


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class DownloadConfig:
    """Extra options forwarded to yt-dlp."""
    cookies: Optional[str] = None
    referer: Optional[str] = None
    proxy: Optional[str] = None
    user_agent: Optional[str] = None


@dataclass
class DownloadResult:
    """Result of a media download."""
    media_path: Path
    provider_name: str
    metadata: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Base provider
# ---------------------------------------------------------------------------

class BaseProvider:
    """Base class for media providers."""

    name: str = "base"

    def download(self, url: str, temp_dir: Path, config: DownloadConfig) -> DownloadResult:
        """Download media using a multi-strategy approach.

        Strategy order:
        1. Try audio-only format (fastest, smallest file)
        2. Fallback to best video+audio merged (handles sites where audio-only is unavailable)
        3. Fallback to absolute best (whatever yt-dlp can get)
        """
        output_template = str(temp_dir / "source.%(ext)s")

        strategies = self._download_strategies(url, output_template, config)

        last_error: Exception | None = None
        for strategy_name, cmd in strategies:
            try:
                log(f"[INFO] [{self.name}] Trying strategy: {strategy_name}")
                run_command(cmd)
                media_file = _find_single_media_file(temp_dir)
                log(f"[INFO] [{self.name}] Downloaded: {media_file.name} ({strategy_name})")
                return DownloadResult(
                    media_path=media_file,
                    provider_name=self.name,
                    metadata={"strategy": strategy_name},
                )
            except Exception as exc:
                log(f"[WARN] [{self.name}] Strategy '{strategy_name}' failed: {exc}")
                last_error = exc
                # Clean up partial downloads before trying next strategy
                for f in temp_dir.iterdir():
                    if f.is_file() and f.suffix.lower() not in {".json", ".txt"}:
                        f.unlink(missing_ok=True)

        raise DownloadError(
            f"[{self.name}] All download strategies failed for: {url}\n"
            f"Last error: {last_error}"
        )

    def _download_strategies(
        self, url: str, output_template: str, config: DownloadConfig
    ) -> list[tuple[str, list[str]]]:
        """Return ordered list of (strategy_name, command) to try."""
        base_flags = self._common_flags(config)

        strategies: list[tuple[str, list[str]]] = [
            # Strategy 1: audio-only — smallest download, most reliable for transcription
            (
                "audio-only",
                ["yt-dlp", "--no-playlist", "-f", "bestaudio/ba"]
                + base_flags
                + ["-o", output_template, url],
            ),
            # Strategy 2: best video+audio merged — handles cases where audio-only is unavailable
            (
                "merged-best",
                [
                    "yt-dlp",
                    "--no-playlist",
                    "-f", "bv*+ba/b",
                    "--merge-output-format", "mp4",
                ]
                + base_flags
                + ["-o", output_template, url],
            ),
            # Strategy 3: absolute best — last resort
            (
                "best-any",
                ["yt-dlp", "--no-playlist", "-f", "best"]
                + base_flags
                + ["-o", output_template, url],
            ),
        ]
        return strategies

    @staticmethod
    def _common_flags(config: DownloadConfig) -> list[str]:
        """Build common yt-dlp flags from config."""
        flags: list[str] = []
        if config.cookies:
            flags += ["--cookies", config.cookies]
        if config.referer:
            flags += ["--referer", config.referer]
        if config.proxy:
            flags += ["--proxy", config.proxy]
        if config.user_agent:
            flags += ["--user-agent", config.user_agent]
        return flags


# ---------------------------------------------------------------------------
# Concrete providers
# ---------------------------------------------------------------------------

class YouTubeProvider(BaseProvider):
    name = "youtube"


class TikTokProvider(BaseProvider):
    """TikTok provider.

    TikTok videos often have audio baked into the video stream only.
    We prioritize downloading the full video and extracting audio with ffmpeg later.
    """
    name = "tiktok"

    def _download_strategies(
        self, url: str, output_template: str, config: DownloadConfig
    ) -> list[tuple[str, list[str]]]:
        base_flags = self._common_flags(config)

        # TikTok-specific: H265/bytevc1 formats often do not contain audio.
        # We prefer the pre-merged 'download' or H264 formats which always have audio.
        strategies: list[tuple[str, list[str]]] = [
            # Strategy 1: 'download' format (direct MP4 with video and audio)
            (
                "download-format",
                [
                    "yt-dlp",
                    "--no-playlist",
                    "-f", "download",
                ]
                + base_flags
                + ["-o", output_template, url],
            ),
            # Strategy 2: h264 format (always contains audio)
            (
                "h264-format",
                [
                    "yt-dlp",
                    "--no-playlist",
                    "-f", "best[vcodec^=h264]/h264",
                ]
                + base_flags
                + ["-o", output_template, url],
            ),
            # Strategy 3: best video+audio merged (fallback)
            (
                "merged-best",
                [
                    "yt-dlp",
                    "--no-playlist",
                    "-f", "bv*+ba/b",
                    "--merge-output-format", "mp4",
                ]
                + base_flags
                + ["-o", output_template, url],
            ),
            # Strategy 4: absolute best
            (
                "best-any",
                ["yt-dlp", "--no-playlist", "-f", "best"]
                + base_flags
                + ["-o", output_template, url],
            ),
        ]
        return strategies


class FacebookProvider(BaseProvider):
    """Facebook provider (Reels, Watch, regular videos).

    Facebook often requires cookies for higher quality or private videos.
    """
    name = "facebook"

    def _download_strategies(
        self, url: str, output_template: str, config: DownloadConfig
    ) -> list[tuple[str, list[str]]]:
        base_flags = self._common_flags(config)

        strategies: list[tuple[str, list[str]]] = [
            # Strategy 1: best video+audio merged
            (
                "merged-best",
                [
                    "yt-dlp",
                    "--no-playlist",
                    "-f", "bv*+ba/b",
                    "--merge-output-format", "mp4",
                ]
                + base_flags
                + ["-o", output_template, url],
            ),
            # Strategy 2: audio-only
            (
                "audio-only",
                ["yt-dlp", "--no-playlist", "-f", "bestaudio/ba"]
                + base_flags
                + ["-o", output_template, url],
            ),
            # Strategy 3: absolute best
            (
                "best-any",
                ["yt-dlp", "--no-playlist", "-f", "best"]
                + base_flags
                + ["-o", output_template, url],
            ),
        ]
        return strategies


class LocalFileProvider(BaseProvider):
    """Local file — no download needed."""
    name = "local"

    def download(self, url: str, temp_dir: Path, config: DownloadConfig) -> DownloadResult:
        path = Path(url).expanduser().resolve()
        if not path.exists():
            raise ProviderError(self.name, f"File not found: {path}")
        if not path.is_file():
            raise ProviderError(self.name, f"Not a regular file: {path}")
        log(f"[INFO] [{self.name}] Using local file: {path}")
        return DownloadResult(media_path=path, provider_name=self.name)


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

# Pattern matching for URL-to-provider routing
_PROVIDER_PATTERNS: list[tuple[re.Pattern[str], type[BaseProvider]]] = [
    (re.compile(r"(youtube\.com|youtu\.be)", re.IGNORECASE), YouTubeProvider),
    (re.compile(r"tiktok\.com", re.IGNORECASE), TikTokProvider),
    (re.compile(r"facebook\.com|fb\.watch|fb\.com", re.IGNORECASE), FacebookProvider),
]


def detect_provider(value: str) -> BaseProvider:
    """Detect the right provider based on input value.

    Args:
        value: A URL string or a local file path.

    Returns:
        An instance of the appropriate provider.

    Raises:
        ProviderError: If the input is neither a valid URL nor an existing file.
    """
    # Check if it's a local file first
    expanded = Path(value).expanduser()
    if expanded.exists() and expanded.is_file():
        return LocalFileProvider()

    # Try to parse as URL
    try:
        parsed = urlparse(value)
        if parsed.scheme in {"http", "https"} and parsed.netloc:
            # Match against known providers
            for pattern, provider_cls in _PROVIDER_PATTERNS:
                if pattern.search(parsed.netloc):
                    return provider_cls()

            # Unknown URL — use base provider (yt-dlp supports 1000+ sites)
            log(f"[INFO] No specific provider for '{parsed.netloc}', using generic yt-dlp provider.")
            return _GenericProvider()
    except Exception:
        pass

    raise ProviderError(
        "router",
        f"Input is neither a valid URL nor an existing local file: {value}"
    )


class _GenericProvider(BaseProvider):
    """Fallback provider for URLs not matching any known platform.

    yt-dlp supports 1000+ sites, so this may still work.
    """
    name = "generic"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _find_single_media_file(directory: Path) -> Path:
    """Find the downloaded media file in a directory.

    Prefers audio formats, then video formats, then most recently modified.
    """
    candidates = [
        p
        for p in directory.iterdir()
        if p.is_file()
        and p.suffix.lower() not in {".json", ".txt", ".part", ".ytdl"}
        and not p.name.endswith(".part")
    ]

    if not candidates:
        raise DownloadError("No downloaded media file was found in the temp directory.")

    preferred_exts = [
        ".m4a", ".mp3", ".aac", ".ogg", ".opus", ".flac", ".wav",
        ".webm", ".mkv", ".mp4",
    ]
    for ext in preferred_exts:
        for p in candidates:
            if p.suffix.lower() == ext:
                return p

    return max(candidates, key=lambda p: p.stat().st_mtime)
