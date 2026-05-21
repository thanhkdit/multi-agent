"""Shared utilities for the video transcript pipeline."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from .errors import TranscriptError


def log(*args: object) -> None:
    """Print a log message to stderr so stdout remains clean for JSON output."""
    print(*args, file=sys.stderr, flush=True)


def require_binary(name: str) -> None:
    """Raise if a required binary is not on PATH."""
    if shutil.which(name) is None:
        raise TranscriptError(
            f"Required binary not found: {name}. "
            "Install it and ensure it is on PATH."
        )


def run_command(
    cmd: list[str],
    *,
    cwd: str | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    """Run a shell command, optionally raising on non-zero exit."""
    log(f"[CMD] {' '.join(cmd)}")
    proc = subprocess.run(
        cmd,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if check and proc.returncode != 0:
        raise TranscriptError(
            "Command failed\n"
            f"CMD: {' '.join(cmd)}\n"
            f"EXIT CODE: {proc.returncode}\n"
            f"STDOUT:\n{proc.stdout}\n"
            f"STDERR:\n{proc.stderr}"
        )
    return proc


def save_json(data: dict[str, Any], path: Path) -> None:
    """Write a dict to a JSON file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def save_text(text: str, path: Path) -> None:
    """Write plain text to a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
