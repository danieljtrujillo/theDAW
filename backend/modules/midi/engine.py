"""Audio → MIDI conversion.

Two engines, both lazy-imported so the main app doesn't take their
weight at startup:

  - **basic-pitch** (Spotify, Apache-2.0, ~25 MB model): multi-instrument
    polyphonic transcription. Default for full tracks and most stems.
  - **piano-transcription-inference** (Bytedance, MIT, ~100 MB): top-
    quality piano transcription. Used when ``hint='piano'`` (e.g., the
    'piano' stem from htdemucs_6s) and the package is available.

Either engine can be missing; ``convert_to_midi()`` returns
``{"ok": False, "error": ...}`` rather than raising, so the caller can
gracefully degrade per stem. Outputs Standard MIDI File (.mid) to the
caller-supplied output path; we don't manage paths internally.
"""

from __future__ import annotations

import contextlib
import importlib
import io
import logging
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Literal, Optional

log = logging.getLogger(__name__)


MidiHint = Literal["auto", "piano", "generic"]


def _basic_pitch_available() -> bool:
    try:
        importlib.import_module("basic_pitch")
        return True
    except ImportError:
        return False


def _piano_transcription_available() -> bool:
    try:
        importlib.import_module("piano_transcription_inference")
        return True
    except ImportError:
        return False


def engine_capabilities() -> dict:
    return {
        "basic_pitch": _basic_pitch_available(),
        "piano_transcription_inference": _piano_transcription_available(),
    }


PACKAGE_FOR_ENGINE: dict[str, str] = {
    "basic_pitch": "basic-pitch",
    "piano_transcription_inference": "piano-transcription-inference",
}


def _pip_install_cmd(python_exe: str, packages: list[str]) -> tuple[list[str], str]:
    """Return ``(argv, mode)`` for installing ``packages`` into the venv
    rooted at ``python_exe``.

    Falls back across three install paths because uv-managed venvs don't
    include pip by default:

      - `python -m pip install ...` (works in pip-bootstrapped venvs)
      - `python -m ensurepip --default-pip` then pip (bootstraps pip)
      - `uv pip install --python <python_exe> ...` (no pip required in target)
    """
    pip_check = subprocess.run(
        [python_exe, "-c", "import pip"],
        capture_output=True,
        text=True,
        timeout=15,
    )
    if pip_check.returncode == 0:
        return ([python_exe, "-m", "pip", "install", *packages], "pip")

    # Try to bootstrap pip via ensurepip.
    ensurepip = subprocess.run(
        [python_exe, "-m", "ensurepip", "--upgrade", "--default-pip"],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if ensurepip.returncode == 0:
        return ([python_exe, "-m", "pip", "install", *packages], "pip-after-ensurepip")

    # Fall back to uv pip.
    return (
        ["uv", "pip", "install", "--python", python_exe, *packages],
        "uv-pip",
    )


def install_engine(engine: str) -> dict:
    """Pip-install one of the MIDI conversion engines into the current
    Python. Returns ``{ok, stdout, stderr, returncode}``. Blocking; can
    take ~minute for basic-pitch (pulls tensorflow), longer for
    piano-transcription-inference (~100 MB model on first import).

    Handles uv-managed venvs that lack pip by ensurepip-bootstrapping or
    falling back to `uv pip install --python <exe>`.
    """
    package = PACKAGE_FOR_ENGINE.get(engine)
    out: dict = {"ok": False, "engine": engine, "python_exe": sys.executable}
    if package is None:
        out["error"] = f"unknown engine: {engine}"
        return out
    try:
        argv, install_mode = _pip_install_cmd(sys.executable, [package])
        out["install_mode"] = install_mode
        result = subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=15 * 60,
        )
    except (subprocess.TimeoutExpired, OSError) as e:
        out["error"] = repr(e)
        return out
    out["returncode"] = result.returncode
    out["stdout"] = result.stdout[-4000:]
    out["stderr"] = result.stderr[-4000:]
    out["ok"] = result.returncode == 0
    # Clear importlib's cache so the next import picks up the new install.
    if out["ok"]:
        importlib.invalidate_caches()
    return out


def _route(hint: MidiHint) -> str:
    """Choose an engine based on hint + availability. Falls back to
    whatever is installed; returns 'none' if nothing is."""
    if hint == "piano" and _piano_transcription_available():
        return "piano_transcription_inference"
    if _basic_pitch_available():
        return "basic_pitch"
    if _piano_transcription_available():
        return "piano_transcription_inference"
    return "none"


def convert_to_midi(
    audio_path: Path,
    output_path: Path,
    *,
    hint: MidiHint = "auto",
    auto_install: bool = True,
) -> dict:
    """Convert ``audio_path`` to a MIDI file at ``output_path``.

    If neither engine is installed and ``auto_install`` is True, this
    transparently runs ``pip install basic-pitch`` and retries. Set
    ``auto_install=False`` to keep the historical fail-fast behavior.

    Returns a result dict — never raises. On success:
      {"ok": True, "engine": ..., "engine_version": ..., "notes_count": int}
    On any failure:
      {"ok": False, "engine": ..., "error": str}
    """
    p = Path(audio_path)
    if not p.is_file():
        return {"ok": False, "error": f"audio not found: {p}"}

    engine = _route(hint)
    if engine == "none":
        if not auto_install:
            return {
                "ok": False,
                "engine": "none",
                "error": (
                    "no MIDI conversion engine installed. Run "
                    "`pip install basic-pitch` (Apache-2.0, ~25 MB) or "
                    "`pip install piano-transcription-inference` (MIT, ~100 MB)."
                ),
            }
        log.info("midi.engine: no engine present — auto-installing basic-pitch")
        install_result = install_engine("basic_pitch")
        if not install_result.get("ok"):
            return {
                "ok": False,
                "engine": "none",
                "error": (
                    "no MIDI engine installed and auto-install failed. "
                    f"pip stderr: {install_result.get('stderr', '')[:400]}"
                ),
                "install_result": install_result,
            }
        engine = _route(hint)
        if engine == "none":
            return {
                "ok": False,
                "engine": "none",
                "error": "auto-install reported success but engine still not importable",
                "install_result": install_result,
            }

    output_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        if engine == "basic_pitch":
            return _run_basic_pitch(p, output_path)
        return _run_piano_transcription(p, output_path)
    except Exception as e:
        log.warning("midi.engine: %s conversion failed for %s: %s", engine, p.name, e)
        return {"ok": False, "engine": engine, "error": repr(e)}


def _run_basic_pitch(audio_path: Path, output_path: Path) -> dict:
    """Use basic-pitch's predict_and_save in a temp dir, then move
    its output to the caller's path. basic-pitch writes files named
    ``<input_stem>_basic_pitch.mid`` so we rename to honour our path."""
    from basic_pitch.inference import predict_and_save  # type: ignore[import]
    from basic_pitch import ICASSP_2022_MODEL_PATH  # type: ignore[import]

    # Use a tempdir adjacent to the output path so the final move is
    # always on the same volume (Path.replace() fails cross-drive on
    # Windows, e.g. tmp on C: → output on D:). shutil.move is the
    # cross-volume-safe fallback regardless.
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=str(output_path.parent)) as td:
        td_path = Path(td)
        # basic-pitch prints status with emoji (🚨, etc.). On Windows the
        # console/log stream is often a legacy code page (cp1252), so the
        # library's own print() raises UnicodeEncodeError ('charmap' codec
        # can't encode '\U0001f6a8') and kills a conversion that would
        # otherwise succeed. Capture its stdout/stderr into a str buffer —
        # StringIO holds text, never encodes, so it cannot crash — then log
        # the (now harmless) chatter at debug level.
        chatter = io.StringIO()
        with contextlib.redirect_stdout(chatter), contextlib.redirect_stderr(chatter):
            predict_and_save(
                audio_path_list=[str(audio_path)],
                output_directory=str(td_path),
                save_midi=True,
                sonify_midi=False,
                save_model_outputs=False,
                save_notes=False,
                model_or_model_path=ICASSP_2022_MODEL_PATH,
            )
        captured = chatter.getvalue().strip()
        if captured:
            log.debug("basic_pitch output: %s", captured)
        # basic-pitch names: <stem>_basic_pitch.mid
        produced = next(td_path.glob("*_basic_pitch.mid"), None)
        if produced is None:
            return {"ok": False, "engine": "basic_pitch", "error": "no MIDI emitted"}
        # shutil.move handles cross-volume moves (Path.replace() does not).
        if output_path.exists():
            output_path.unlink()
        shutil.move(str(produced), str(output_path))

    notes_count = _count_midi_notes(output_path)
    version = _module_version("basic_pitch")
    return {
        "ok": True,
        "engine": "basic_pitch",
        "engine_version": version,
        "notes_count": notes_count,
    }


def _ensure_librosa_core_audio_shim() -> None:
    """piano_transcription_inference's ``load_audio`` calls, at runtime,
    ``librosa.core.audio.resample(y, sr_native, sr, res_type=...)`` (utilities.py).
    librosa >= 0.10 kept that submodule but made ``resample``'s ``orig_sr`` /
    ``target_sr`` keyword-only, so the positional call raises "resample() takes 1
    positional argument but 3 positional arguments ... were given". Override the
    submodule's ``resample`` with a wrapper that accepts the legacy positional
    signature (and provide a minimal ``librosa.core.audio`` if it is ever missing).

    Not guarded by an early return: the submodule is usually already imported by
    startup, and we must patch ``resample`` regardless of whether it exists yet.
    """
    import sys
    import types

    import librosa
    import librosa.core
    import librosa.util

    orig_resample = librosa.resample

    def _resample_compat(y, *args, **kwargs):
        if len(args) >= 1:
            kwargs.setdefault("orig_sr", args[0])
        if len(args) >= 2:
            kwargs.setdefault("target_sr", args[1])
        return orig_resample(y, **kwargs)

    try:
        import librosa.core.audio as core_audio  # the real submodule (librosa >= 0.10)
    except Exception:
        core_audio = types.ModuleType("librosa.core.audio")
        librosa.core.audio = core_audio  # type: ignore[attr-defined]
        sys.modules["librosa.core.audio"] = core_audio

    core_audio.resample = _resample_compat  # type: ignore[attr-defined]
    if not hasattr(core_audio, "to_mono"):
        core_audio.to_mono = librosa.to_mono  # type: ignore[attr-defined]
    if not hasattr(core_audio, "util"):
        core_audio.util = librosa.util  # type: ignore[attr-defined]


# Bytedance piano-transcription checkpoint (~165 MB), the same artifact the
# library auto-fetches — but it shells out to ``wget``, which is absent on
# Windows, so the download silently no-ops and torch.load then raises
# FileNotFoundError. We fetch it in Python to the path the library expects.
PIANO_CKPT_URL = (
    "https://zenodo.org/record/4034264/files/"
    "CRNN_note_F1%3D0.9677_pedal_F1%3D0.9186.pth?download=1"
)
PIANO_CKPT_MIN_BYTES = 160_000_000  # library treats < 1.6e8 as incomplete


def _piano_checkpoint_path() -> Path:
    return (
        Path.home()
        / "piano_transcription_inference_data"
        / "note_F1=0.9677_pedal_F1=0.9186.pth"
    )


def _piano_checkpoint_ready(dest: Path) -> bool:
    return dest.is_file() and dest.stat().st_size >= PIANO_CKPT_MIN_BYTES


def _ensure_piano_checkpoint() -> Path:
    """Download the piano-transcription checkpoint if missing, cross-platform.

    Returns the local checkpoint path; raises on a failed/incomplete download.
    Uses a process-unique temp file so concurrent callers never fight over one
    ``.partial``, and retries the final rename to ride out a transient Windows
    lock (antivirus scanning a freshly written 165 MB file).
    """
    import os
    import time
    import urllib.request

    dest = _piano_checkpoint_path()
    if _piano_checkpoint_ready(dest):
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.parent / f"{dest.name}.{os.getpid()}.partial"
    log.info("midi.engine: downloading piano-transcription checkpoint (~165 MB)…")
    req = urllib.request.Request(PIANO_CKPT_URL, headers={"User-Agent": "theDAW/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=120) as resp, open(tmp, "wb") as f:
            shutil.copyfileobj(resp, f, length=1024 * 256)
        size = tmp.stat().st_size
        if size < PIANO_CKPT_MIN_BYTES:
            raise RuntimeError(
                f"piano checkpoint download incomplete ({size} bytes; expected ~165 MB)"
            )
        last_err: Exception | None = None
        for _ in range(6):
            if _piano_checkpoint_ready(dest):  # another caller won the race
                break
            try:
                os.replace(tmp, dest)
                break
            except PermissionError as e:  # transient lock (AV) — back off and retry
                last_err = e
                time.sleep(1.0)
        else:
            if not _piano_checkpoint_ready(dest):
                raise last_err or RuntimeError("could not finalize piano checkpoint")
    finally:
        with contextlib.suppress(OSError):
            if tmp.exists():
                tmp.unlink()
    log.info("midi.engine: piano-transcription checkpoint ready at %s", dest)
    return dest


def _run_piano_transcription(audio_path: Path, output_path: Path) -> dict:
    _ensure_librosa_core_audio_shim()
    from piano_transcription_inference import (  # type: ignore[import]
        PianoTranscription,
        sample_rate,
        load_audio,
    )

    checkpoint_path = _ensure_piano_checkpoint()
    audio, _ = load_audio(str(audio_path), sr=sample_rate, mono=True)
    transcriptor = PianoTranscription(
        device="cpu", checkpoint_path=str(checkpoint_path)
    )
    transcriptor.transcribe(audio, str(output_path))

    notes_count = _count_midi_notes(output_path)
    version = _module_version("piano_transcription_inference")
    return {
        "ok": True,
        "engine": "piano_transcription_inference",
        "engine_version": version,
        "notes_count": notes_count,
    }


def _count_midi_notes(midi_path: Path) -> int:
    """Best-effort: read the MIDI and count Note-On events. Returns 0
    on failure rather than raising — this is informational only."""
    try:
        import mido  # type: ignore[import]
    except ImportError:
        return 0
    if not midi_path.is_file():
        return 0
    try:
        mid = mido.MidiFile(str(midi_path))
    except Exception:
        return 0
    count = 0
    for track in mid.tracks:
        for msg in track:
            if msg.type == "note_on" and msg.velocity > 0:
                count += 1
    return count


def _module_version(name: str) -> str:
    try:
        mod = importlib.import_module(name)
        return str(getattr(mod, "__version__", "unknown"))
    except ImportError:
        return "unknown"


def hint_for_stem(stem_name: Optional[str]) -> MidiHint:
    """Stem-aware routing: piano-transcription-inference excels on
    pure piano; everything else routes to basic-pitch."""
    if stem_name and stem_name.lower() in {"piano", "keys", "keyboards"}:
        return "piano"
    return "generic"
