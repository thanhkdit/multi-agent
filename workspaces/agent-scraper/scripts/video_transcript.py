#!/usr/bin/env python3
"""Universal video-to-text transcription tool.

Supports:
- TikTok
- YouTube
- Facebook / Facebook Reels
- Many other sites supported by yt-dlp
- Local media files

Pipeline:
1) Route input to the right provider (youtube, tiktok, facebook, local, generic)
2) Download media with yt-dlp using multi-strategy fallback
3) Validate audio stream with ffprobe
4) Normalize audio to 16kHz mono WAV with ffmpeg
5) Transcribe with faster-whisper
6) Output JSON and/or plain text

Dependencies (all free):
- yt-dlp       (pip install yt-dlp)
- ffmpeg       (apt install ffmpeg)
- ffprobe      (bundled with ffmpeg)
- faster-whisper (pip install faster-whisper)

Usage:
    # YouTube
    python video_transcript.py "https://www.youtube.com/watch?v=VIDEO_ID"

    # TikTok
    python video_transcript.py "https://www.tiktok.com/@user/video/123456"

    # Facebook Reel
    python video_transcript.py "https://www.facebook.com/reel/123456"

    # Local file
    python video_transcript.py /path/to/video.mp4

    # With options
    python video_transcript.py "URL" --model small --language vi \\
        --output-json result.json --output-text result.txt
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from video_transcript.errors import TranscriptError
from video_transcript.pipeline import PipelineConfig, run_pipeline
from video_transcript.transcriber import SUPPORTED_MODELS
from video_transcript.utils import log, save_json, save_text


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Universal video/audio transcript tool.\n"
            "Supports TikTok, YouTube, Facebook Reels, and local files.\n"
            "All processing is local and free."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            '  python video_transcript.py "https://www.youtube.com/watch?v=dQw4w9WgXcQ"\n'
            '  python video_transcript.py "https://www.tiktok.com/@user/video/123" --model small\n'
            '  python video_transcript.py "https://www.facebook.com/reel/456" --language vi\n'
            "  python video_transcript.py ./local_video.mp4 --output-json out.json\n"
        ),
    )

    parser.add_argument("inputs", nargs="+", help="One or more Video URLs or local media file paths")

    # Whisper options
    parser.add_argument("--model", default="base", choices=SUPPORTED_MODELS, help="Whisper model size (default: base)")
    parser.add_argument("--language", default=None, help="Force language code (e.g. vi, en, ja). Auto-detect if omitted")
    parser.add_argument("--compute-type", default="int8", help="Whisper compute type (default: int8)")
    parser.add_argument("--device", default="cpu", help="Whisper device: cpu or cuda (default: cpu)")
    parser.add_argument("--beam-size", type=int, default=5, help="Decoding beam size (default: 5)")
    parser.add_argument("--no-vad", action="store_true", help="Disable voice activity detection filtering")

    # Output options
    parser.add_argument("--output-json", default=None, help="Write JSON transcript to this file")
    parser.add_argument("--output-text", default=None, help="Write plain text transcript to this file")

    # Download options
    parser.add_argument("--cookies", default=None, help="Path to cookies.txt for sites requiring login")
    parser.add_argument("--referer", default=None, help="HTTP referer header for yt-dlp")
    parser.add_argument("--proxy", default=None, help="Proxy URL for yt-dlp")
    parser.add_argument("--user-agent", default=None, help="Custom user agent for yt-dlp")

    # Misc
    parser.add_argument("--keep-temp", action="store_true", help="Keep temporary files for debugging")
    parser.add_argument("--skip-download", action="store_true", help="Treat input as local file, skip yt-dlp")

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    results = []
    has_error = False

    for input_val in args.inputs:
        config = PipelineConfig(
            input_value=input_val,
            model=args.model,
            language=args.language,
            compute_type=args.compute_type,
            device=args.device,
            beam_size=args.beam_size,
            vad_filter=not args.no_vad,
            keep_temp=args.keep_temp,
            skip_download=args.skip_download,
            cookies=args.cookies,
            referer=args.referer,
            proxy=args.proxy,
            user_agent=args.user_agent,
        )

        try:
            result = run_pipeline(config)
            results.append(result)
        except TranscriptError as e:
            log(f"[ERROR] {e}")
            error_out = {
                "status": "error",
                "error_type": type(e).__name__,
                "error_details": str(e),
                "source": input_val,
            }
            results.append(error_out)
            has_error = True
        except KeyboardInterrupt:
            log("[INFO] Interrupted by user.")
            return 130

    final_output = results[0] if len(args.inputs) == 1 else results

    if args.output_json:
        save_json(final_output, Path(args.output_json))
        log(f"[INFO] JSON saved to: {args.output_json}")

    if args.output_text:
        # Combine text from all successful results
        combined_text = "\n\n---\n\n".join(
            r.get("text", "") for r in results if r.get("status") != "error"
        )
        save_text(combined_text, Path(args.output_text))
        log(f"[INFO] Text saved to: {args.output_text}")

    print(json.dumps(final_output, ensure_ascii=False, indent=2))
    return 1 if has_error else 0


if __name__ == "__main__":
    raise SystemExit(main())
