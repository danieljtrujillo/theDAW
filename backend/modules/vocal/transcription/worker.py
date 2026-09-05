"""faster-whisper transcription worker.

Runs INSIDE the isolated .whisper_venv, never in the main app process. Reads one
JSON request from stdin, transcribes with faster-whisper, and writes a single
JSON line to stdout as the LAST line. All diagnostics and model-download progress
go to stderr so stdout stays clean for the parent to parse.

Request  : {"audio": str, "language": str|null, "model": str, "device": str,
            "compute_type": str,
            # optional decoding knobs (defaults in parentheses):
            "initial_prompt": str|null (none),
            "condition_on_previous_text": bool (true),
            "vad_filter": bool (true), "beam_size": int (5)}
Response : {"ok": true, "language": str, "text": str, "device_used": str,
            "segments": [{"text", "start", "end",
                          "words": [{"word", "start", "end"}]}]}   (seconds)
            or {"ok": false, "error": str}
"""

import json
import os
import sys

LIB_DIRS_ENV = "theDAW_WHISPER_LIB_DIRS"


def _load_cuda_lib_dirs() -> None:
    """On Windows the cuBLAS / cuDNN DLLs from the nvidia pip wheels are only
    found when their folders are registered with the loader; the sidecar
    passes them in an env var. POSIX gets LD_LIBRARY_PATH from the parent."""
    raw = os.environ.get(LIB_DIRS_ENV, "")
    if not raw or not hasattr(os, "add_dll_directory"):
        return
    for d in raw.split(os.pathsep):
        if d and os.path.isdir(d):
            try:
                os.add_dll_directory(d)
            except OSError:
                pass


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def _fail(msg: object) -> int:
    _emit({"ok": False, "error": str(msg)[:600]})
    return 1


def main() -> int:
    try:
        req = json.loads(sys.stdin.read() or "{}")
    except ValueError as e:
        return _fail(f"bad request json: {e}")

    audio = req.get("audio")
    if not audio:
        return _fail("no audio path")

    language = req.get("language") or None
    if language in ("auto", ""):
        language = None
    model_size = req.get("model") or "small"
    device = req.get("device") or "cpu"
    compute_type = req.get("compute_type") or "int8"
    # Optional decoding knobs. The lyrics aligner primes the decoder with the
    # user's lyrics (initial_prompt), turns off cross-window conditioning so a
    # hallucinated chorus does not snowball, and disables VAD so quiet entries
    # are not trimmed away. Missing keys keep the historical defaults.
    initial_prompt = req.get("initial_prompt") or None
    cond = bool(req.get("condition_on_previous_text", True))
    vad = bool(req.get("vad_filter", True))
    beam = int(req.get("beam_size") or 5)

    _load_cuda_lib_dirs()
    try:
        from faster_whisper import WhisperModel
    except Exception as e:
        return _fail(f"faster-whisper import failed: {e!r}")

    def _run(dev: str, compute: str):
        model = WhisperModel(model_size, device=dev, compute_type=compute)
        return model.transcribe(
            audio,
            language=language,
            word_timestamps=True,
            initial_prompt=initial_prompt,
            condition_on_previous_text=cond,
            vad_filter=vad,
            beam_size=beam,
        )

    device_used = device
    try:
        try:
            segments, info = _run(device, compute_type)
        except Exception as e:  # noqa: BLE001 - any CUDA failure -> CPU
            if not device.lower().startswith("cuda"):
                raise
            sys.stderr.write(
                f"[whisper] {device} failed ({e!r}); retrying on cpu int8\n"
            )
            sys.stderr.flush()
            device_used = "cpu"
            segments, info = _run("cpu", "int8")
        seg_out = []
        text_parts = []
        for seg in segments:
            words = []
            for w in seg.words or []:
                words.append(
                    {
                        "word": w.word,
                        "start": float(w.start) if w.start is not None else None,
                        "end": float(w.end) if w.end is not None else None,
                    }
                )
            seg_out.append(
                {
                    "text": seg.text,
                    "start": float(seg.start),
                    "end": float(seg.end),
                    "words": words,
                }
            )
            text_parts.append(seg.text)
    except Exception as e:
        return _fail(f"transcription failed: {e!r}")

    _emit(
        {
            "ok": True,
            "language": getattr(info, "language", None) or (language or ""),
            "text": "".join(text_parts).strip(),
            "segments": seg_out,
            "device_used": device_used,
        }
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
