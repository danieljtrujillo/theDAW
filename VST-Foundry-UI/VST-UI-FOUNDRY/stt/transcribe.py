#!/usr/bin/env python
"""Local speech-to-text via faster-whisper.

Usage:
    python transcribe.py <audio_file_path> [model]

Transcribes the given audio file and prints ONLY the transcript text to stdout.
All diagnostics (device chosen, errors) go to stderr so the calling process can
read clean text off stdout.

Device strategy: try CUDA (float16) first; on any init/load/transcribe failure
fall back to CPU (int8). The model auto-downloads on first use and is cached by
faster-whisper under the HuggingFace cache.
"""

import os
import sys
import warnings

# The HuggingFace hub honours HF_HUB_ENABLE_HF_TRANSFER=1, but that fast path
# needs the optional `hf_transfer` package and hard-errors the model download if
# it is missing. Force it off so the standard downloader is used regardless of
# the caller's environment.
os.environ["HF_HUB_ENABLE_HF_TRANSFER"] = "0"

# Keep stdout clean: silence library warnings (they go to stderr anyway).
warnings.filterwarnings("ignore")


def log(*args):
    print(*args, file=sys.stderr, flush=True)


def main() -> int:
    if len(sys.argv) < 2:
        log("error: missing audio file path argument")
        return 2

    audio_path = sys.argv[1]
    model_size = sys.argv[2] if len(sys.argv) > 2 else "small"

    if not os.path.isfile(audio_path):
        log(f"error: audio file not found: {audio_path}")
        return 2

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # import failure
        log(f"error: failed to import faster_whisper: {exc}")
        return 3

    model = None
    device_used = None

    # Try CUDA first, fall back to CPU on any failure.
    for device, compute_type in (("cuda", "float16"), ("cpu", "int8")):
        try:
            log(f"loading model '{model_size}' on {device} ({compute_type})...")
            model = WhisperModel(model_size, device=device, compute_type=compute_type)
            device_used = device
            break
        except Exception as exc:
            log(f"warn: {device} init failed: {exc}")
            model = None

    if model is None:
        log("error: could not initialize whisper model on cuda or cpu")
        return 4

    try:
        segments, info = model.transcribe(audio_path, beam_size=5)
        text = "".join(seg.text for seg in segments).strip()
    except Exception as exc:
        log(f"error: transcription failed: {exc}")
        return 5

    log(
        f"device={device_used} language={getattr(info, 'language', '?')} "
        f"duration={getattr(info, 'duration', '?')}"
    )

    # The ONLY thing written to stdout: the transcript text.
    sys.stdout.write(text)
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
