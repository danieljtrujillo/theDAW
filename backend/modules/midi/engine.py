"""Audio → MIDI conversion.

Three engines, all lazy-imported so the main app doesn't take their
weight at startup:

  - **basic-pitch** (Spotify, Apache-2.0, ~25 MB model): multi-instrument
    polyphonic transcription. Default for full tracks and most stems.
  - **piano-transcription-inference** (Bytedance, MIT, ~100 MB): top-
    quality piano transcription. Used when ``hint='piano'`` (e.g., the
    'piano' stem from htdemucs_6s) and the package is available.
  - **drum-onsets** (:mod:`.drums`, model-free, always available): onset
    detection + spectral rules → General MIDI drum notes on one
    ``is_drum`` instrument. Used when ``hint='drums'`` (the 'drums' stem);
    basic-pitch on a drum stem emits hundreds of spurious pitched notes.

The pitched engines can be missing; ``convert_to_midi()`` returns
``{"ok": False, "error": ...}`` rather than raising, so the caller can
gracefully degrade per stem. Outputs Standard MIDI File (.mid) to the
caller-supplied output path; we don't manage paths internally.
"""

from __future__ import annotations

import contextlib
import importlib
import importlib.metadata
import io
import logging
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Literal, Optional
from backend.lib.launch_token import child_env

log = logging.getLogger(__name__)


MidiHint = Literal["auto", "piano", "generic", "drums"]

#: Engine id used for routing (``_route``) — the result dict / ``midis`` row
#: carries the engine's own name, ``drums.ENGINE_NAME`` (``"drum-onsets"``).
DRUM_ENGINE = "drum_onsets"


@contextlib.contextmanager
def _quiet_basic_pitch_import():
    """Mute basic-pitch's import-time backend warnings.

    It emits a root-logger WARNING for every backend it cannot find --
    CoreML, TFLite, TensorFlow -- and then uses whichever it has. theDAW
    pins it to ONNX deliberately (the TensorFlow chain is overridden out of
    the lock), so all three always fire on every import and all three are
    noise telling the user to install things that would break resolution.
    """
    root = logging.getLogger()
    previous = root.level
    root.setLevel(max(previous, logging.ERROR))
    try:
        yield
    finally:
        root.setLevel(previous)


def _basic_pitch_available() -> bool:
    try:
        with _quiet_basic_pitch_import():
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


def engine_devices() -> dict:
    """Which device each pitched engine runs on right now."""
    return {
        "basic_pitch": "cuda"
        if onnx_providers()[0] == "CUDAExecutionProvider"
        else "cpu",
        "piano_transcription_inference": torch_device(),
        "drum_onsets": "cpu",
    }


def engine_capabilities() -> dict:
    return {
        "basic_pitch": _basic_pitch_available(),
        "piano_transcription_inference": _piano_transcription_available(),
        # librosa + pretty_midi are base dependencies: nothing to install.
        DRUM_ENGINE: True,
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
        encoding="utf-8",
        errors="replace",
        timeout=15,
        stdin=subprocess.DEVNULL,
        env=child_env(),
    )
    if pip_check.returncode == 0:
        return ([python_exe, "-m", "pip", "install", *packages], "pip")

    # Try to bootstrap pip via ensurepip.
    ensurepip = subprocess.run(
        [python_exe, "-m", "ensurepip", "--upgrade", "--default-pip"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
        stdin=subprocess.DEVNULL,
        env=child_env(),
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
            encoding="utf-8",
            errors="replace",
            timeout=15 * 60,
            stdin=subprocess.DEVNULL,
            env=child_env(),
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
    whatever is installed; returns 'none' if nothing is. The drum engine
    is model-free and always wins for ``hint='drums'``."""
    if hint == "drums":
        return DRUM_ENGINE
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
    bpm: Optional[float] = None,
    beats: Optional[list[float]] = None,
) -> dict:
    """Convert ``audio_path`` to a MIDI file at ``output_path``.

    If neither pitched engine is installed and ``auto_install`` is True,
    this transparently runs ``pip install basic-pitch`` and retries. Set
    ``auto_install=False`` to keep the historical fail-fast behavior.

    ``bpm`` / ``beats`` (seconds) are the entry's analysis-row tempo map.
    The drum engine uses both (tempo track + 1/16 quantisation of on-grid
    hits). The pitched engines ignore ``beats``, but ``bpm`` is stamped into
    their output afterwards so every file carries the song's real tempo
    instead of a 120 BPM placeholder.

    Returns a result dict — never raises. On success:
      {"ok": True, "engine": ..., "engine_version": ..., "notes_count": int}
    On any failure:
      {"ok": False, "engine": ..., "error": str}
    """
    p = Path(audio_path)
    if not p.is_file():
        return {"ok": False, "error": f"audio not found: {p}"}

    engine = _route(hint)
    if engine == DRUM_ENGINE:
        try:
            return _run_drum_onsets(p, output_path, bpm=bpm, beats=beats)
        except Exception as e:
            log.warning("midi.engine: drum-onsets failed for %s: %s", p.name, e)
            return {"ok": False, "engine": DRUM_ENGINE, "error": repr(e)}
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
            result = _run_basic_pitch(p, output_path)
        else:
            result = _run_piano_transcription(p, output_path)
        # Neither pitched engine knows the song's tempo, so both stamp a stock
        # 120 BPM. Replace it with the entry's real tempo, rescaling ticks so
        # no note moves. Never fatal: a placeholder tempo beats no MIDI.
        if result.get("ok") and bpm and _stamp_tempo(output_path, float(bpm)):
            result["tempo_bpm"] = float(bpm)
        return result
    except Exception as e:
        log.warning("midi.engine: %s conversion failed for %s: %s", engine, p.name, e)
        return {"ok": False, "engine": engine, "error": repr(e)}


def _run_drum_onsets(
    audio_path: Path,
    output_path: Path,
    *,
    bpm: Optional[float] = None,
    beats: Optional[list[float]] = None,
) -> dict:
    """Model-free drum transcription (see :mod:`.drums`). The result dict
    carries ``engine == "drum-onsets"`` — that string lands in the ``midis``
    row so the notation layer can recognise a drum MIDI."""
    from .drums import transcribe_drums

    return transcribe_drums(audio_path, output_path, bpm=bpm, beats=beats)


def _preload_cuda_dlls() -> None:
    """onnxruntime-gpu loads cuBLAS / cuDNN by name; on Windows the DLLs
    live in torch's wheel, so importing torch (and registering its lib
    folder) before the session is created is what makes the CUDA provider
    resolve. Harmless without torch or on POSIX."""
    try:
        import os

        import torch  # noqa: F401

        lib = Path(torch.__file__).resolve().parent / "lib"
        if lib.is_dir() and hasattr(os, "add_dll_directory"):
            os.add_dll_directory(str(lib))
    except Exception:  # noqa: BLE001
        pass


def onnx_providers() -> list[str]:
    """The ONNX Runtime providers to run basic-pitch with: CUDA first when
    the installed runtime has it (onnxruntime-gpu) and torch sees a card,
    CPU otherwise. Never raises."""
    try:
        _preload_cuda_dlls()
        import onnxruntime as ort

        available = set(ort.get_available_providers())
    except Exception:  # noqa: BLE001
        return ["CPUExecutionProvider"]
    want_cuda = False
    try:
        import torch

        want_cuda = bool(torch.cuda.is_available())
    except Exception:  # noqa: BLE001
        want_cuda = False
    if want_cuda and "CUDAExecutionProvider" in available:
        return ["CUDAExecutionProvider", "CPUExecutionProvider"]
    return ["CPUExecutionProvider"]


def torch_device() -> str:
    try:
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:  # noqa: BLE001
        return "cpu"


_basic_pitch_model = None
_basic_pitch_providers: list[str] = []


def _load_basic_pitch_model():
    """basic-pitch's Model, with its ONNX session rebuilt on the CUDA
    provider when there is one (the library hard-codes CPU). Cached: the
    session is reused across every stem of every entry."""
    global _basic_pitch_model, _basic_pitch_providers
    if _basic_pitch_model is not None:
        return _basic_pitch_model
    # The first load imports basic-pitch's note-creation stack (mir_eval, which
    # pulls scipy.stats): 20 s on an idle machine, over a minute while the app
    # is busy. The opening line keeps the LOG showing a live conversion.
    log.info("midi.engine: loading basic-pitch for the first conversion")
    started = time.perf_counter()
    with _quiet_basic_pitch_import():
        from basic_pitch import ICASSP_2022_MODEL_PATH
        from basic_pitch.inference import Model

    model = Model(ICASSP_2022_MODEL_PATH)
    providers = onnx_providers()
    if (
        providers[0] != "CPUExecutionProvider"
        and getattr(model, "model_type", None) == Model.MODEL_TYPES.ONNX
    ):
        try:
            import onnxruntime as ort

            model.model = ort.InferenceSession(
                str(ICASSP_2022_MODEL_PATH), providers=providers
            )
            providers = list(model.model.get_providers())
        except Exception as e:  # noqa: BLE001 - CPU session stays
            log.warning("midi.engine: basic-pitch CUDA session failed (%s); CPU", e)
            providers = ["CPUExecutionProvider"]
    _basic_pitch_model = model
    _basic_pitch_providers = providers
    # basic-pitch's import logs a WARNING for each backend it probes and does
    # not find (CoreML, TFLite, TensorFlow); theDAW runs its ONNX model, so
    # _quiet_basic_pitch_import above mutes them and this line is the record.
    log.info(
        "midi.engine: basic-pitch ONNX model on %s, loaded in %.0f s",
        providers[0],
        time.perf_counter() - started,
    )
    return model


def _run_basic_pitch(audio_path: Path, output_path: Path) -> dict:
    """Use basic-pitch's predict_and_save in a temp dir, then move
    its output to the caller's path. basic-pitch writes files named
    ``<input_stem>_basic_pitch.mid`` so we rename to honour our path."""
    # The model load logs before it imports basic_pitch.inference (the slow
    # import), so it runs first.
    model = _load_basic_pitch_model()
    from basic_pitch.inference import predict_and_save

    # Use a tempdir adjacent to the output path so the final move is
    # always on the same volume (Path.replace() fails cross-drive on
    # Windows, e.g. tmp on C: → output on D:). shutil.move is the
    # cross-volume-safe fallback regardless.
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=str(output_path.parent)) as td:
        td_path = Path(td)
        # basic-pitch prints status with emoji. On Windows the
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
                model_or_model_path=model,
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
        "device": "cuda"
        if _basic_pitch_providers[:1] == ["CUDAExecutionProvider"]
        else "cpu",
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
    from piano_transcription_inference import (
        PianoTranscription,
        sample_rate,
        load_audio,
    )

    checkpoint_path = _ensure_piano_checkpoint()
    audio, _ = load_audio(str(audio_path), sr=sample_rate, mono=True)
    device = torch_device()
    transcriptor = PianoTranscription(
        device=device, checkpoint_path=str(checkpoint_path)
    )
    transcriptor.transcribe(audio, str(output_path))

    notes_count = _count_midi_notes(output_path)
    version = _module_version("piano_transcription_inference")
    return {
        "ok": True,
        "engine": "piano_transcription_inference",
        "engine_version": version,
        "notes_count": notes_count,
        "device": device,
    }


def _stamp_tempo(midi_path: Path, bpm: float) -> bool:
    """Rewrite ``midi_path``'s tempo to ``bpm`` without moving a single note.

    The pitched engines emit note times in seconds under a stock 120 BPM
    header. The notes are right in wall-clock time, but every bar line is
    wrong, so the file fights quantisation and bar-snap against the song it
    came from.

    Changing the tempo alone WOULD move every note, because ticks are
    beat-relative: at 99 BPM a beat is longer, so the same tick lands later.
    Each event's absolute tick is therefore rescaled by ``old_us / new_us``
    first; the two changes cancel exactly and the audible timing is
    unchanged. Absolute positions are scaled rather than deltas so rounding
    error stays under one tick per event instead of accumulating down the
    track.

    Returns True when the file was rewritten. Never raises — a file that
    keeps its placeholder tempo is still a usable file.
    """
    try:
        import mido
    except ImportError:
        return False
    if not midi_path.is_file() or bpm <= 0:
        return False
    try:
        mid = mido.MidiFile(str(midi_path))
        if not mid.tracks:
            return False
        tempos = {m.tempo for tr in mid.tracks for m in tr if m.type == "set_tempo"}
        # Two or more distinct tempos is a real tempo map — the drum engine
        # writes those. Flattening it to one value would be destructive.
        if len(tempos) > 1:
            return False
        old_us = tempos.pop() if tempos else 500_000  # MIDI default = 120 BPM
        new_us = int(round(60_000_000.0 / bpm))
        if new_us <= 0 or new_us == old_us:
            return False
        scale = old_us / new_us
        for track in mid.tracks:
            absolute: list[tuple[int, mido.Message | mido.MetaMessage]] = []
            clock = 0
            for msg in track:
                clock += msg.time
                if msg.type != "set_tempo":
                    absolute.append((clock, msg))
            track.clear()
            previous = 0
            for when, msg in absolute:
                scaled = int(round(when * scale))
                msg.time = scaled - previous
                previous = scaled
                track.append(msg)
        mid.tracks[0].insert(0, mido.MetaMessage("set_tempo", tempo=new_us, time=0))
        mid.save(str(midi_path))
        return True
    except Exception as e:
        log.debug("midi.engine: tempo stamp failed for %s: %s", midi_path.name, e)
        return False


def _count_midi_notes(midi_path: Path) -> int:
    """Best-effort: read the MIDI and count Note-On events. Returns 0
    on failure rather than raising — this is informational only."""
    try:
        import mido
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
    """The installed version of an engine: its distribution's metadata first
    (basic-pitch defines no ``__version__``), then the module's
    ``__version__``."""
    try:
        return importlib.metadata.version(PACKAGE_FOR_ENGINE.get(name, name))
    except importlib.metadata.PackageNotFoundError:
        pass
    try:
        mod = importlib.import_module(name)
        return str(getattr(mod, "__version__", "unknown"))
    except ImportError:
        return "unknown"


#: Stem names of a split kit (a 12-stem run's LARSNET parts and their usual
#: spellings): each is drums, read by the drum engine like a whole kit.
_KIT_PIECE_STEMS = frozenset(
    {
        "kick",
        "snare",
        "toms",
        "tom",
        "hihat",
        "hihats",
        "hi-hat",
        "hi_hat",
        "cymbals",
        "overheads",
        "percussion",
    }
)


def hint_for_stem(stem_name: Optional[str]) -> MidiHint:
    """Stem-aware routing: a drum stem (any name containing 'drum', or a
    piece of a split kit: kick, snare, toms, hi-hat, cymbals) goes to the
    model-free drum engine, piano-transcription-inference excels on pure
    piano, everything else routes to basic-pitch."""
    if not stem_name:
        return "generic"
    name = stem_name.lower()
    if "drum" in name or name in _KIT_PIECE_STEMS:
        return "drums"
    if name in {"piano", "keys", "keyboards"}:
        return "piano"
    return "generic"
