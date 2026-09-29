"""Audio → MIDI conversion.

Three engines, all lazy-imported so the main app doesn't take their
weight at startup:

  - **basic-pitch** (Spotify, Apache-2.0, ~25 MB model): multi-instrument
    polyphonic transcription. Default for full tracks and most stems. A stem
    runs with the settings of its role (:data:`BASIC_PITCH_ROLE_SETTINGS`:
    pitch range, thresholds, shortest note) and is written as that
    instrument (a General MIDI program); a bass or lead vocal comes out one
    note at a time (:func:`monophonic_line`).
  - **piano-transcription-inference** (Bytedance, MIT, ~100 MB): top-
    quality piano transcription. Used when ``hint='piano'`` (e.g., the
    'piano' stem from htdemucs_6s) and the package is available.
  - **drum-onsets** (:mod:`.drums`, model-free, always available): onset
    detection + spectral rules → General MIDI drum notes on one
    ``is_drum`` instrument (channel 10). Used when ``hint='drums'``: the
    'drums' stem and each LARSNET kit part of a 12-stem run, a part on its
    own voice; basic-pitch on a drum stem emits hundreds of spurious pitched
    notes.

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
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, Optional, Sequence
from backend.lib.launch_token import child_env

log = logging.getLogger(__name__)


MidiHint = Literal["auto", "piano", "generic", "drums"]

#: Engine id used for routing (``_route``) — the result dict / ``midis`` row
#: carries the engine's own name, ``drums.ENGINE_NAME`` (``"drum-onsets"``).
DRUM_ENGINE = "drum_onsets"

#: The LARSNET kit parts a 12-stem run writes in place of ``drums``. Each is
#: one piece of the kit, transcribed on that piece's General MIDI voice.
DRUM_PARTS: tuple[str, ...] = ("kick", "snare", "toms", "hihat", "cymbals")

#: Every role the drum engine takes: the whole kit and each of its parts.
PERCUSSIVE_ROLES = frozenset({"drums", *DRUM_PARTS})

MonophonicPick = Literal["lowest", "loudest"]


@dataclass(frozen=True)
class BasicPitchSettings:
    """How basic-pitch transcribes one kind of stem, and what it is written as.

    ``onset_threshold`` to ``maximum_frequency`` are
    ``basic_pitch.inference.predict`` parameters: note detection thresholds
    (0-1), the shortest note kept, and the pitch range in Hz outside which no
    note is written. ``program`` is the General
    MIDI program (0-based) the file carries. ``monophonic`` reduces the notes
    to one at a time, keeping the lowest (a bass line) or the loudest (a sung
    melody) where notes are struck together; a monophonic file keeps each
    note's own pitch bend, and a polyphonic one has none, because the pitch
    wheel bends every note sounding on its channel.
    """

    role: str
    name: str
    program: int
    onset_threshold: float = 0.5
    frame_threshold: float = 0.3
    minimum_note_length_ms: float = 127.70
    minimum_frequency: Optional[float] = None
    maximum_frequency: Optional[float] = None
    monophonic: Optional[MonophonicPick] = None


#: The full mix, a ``no_vocals`` bed and any stem whose name says nothing:
#: basic-pitch's own defaults and the program it has always written
#: (4, Electric Piano 1). A mix is chords, so it carries no pitch wheel.
MIX_SETTINGS = BasicPitchSettings(role="mix", name="Mix", program=4)

#: Per-role settings. Ranges are the instrument's written range with a little
#: headroom (Hz): bass B0 to G4, voice C2 to C#6, guitar drop-D D2 to the 24th
#: fret of the high E, piano A0 to C8. A bass line or a sung line starts
#: notes softly, so its onset threshold is a little lower; the overtones and
#: breaths that lets through are removed by the one-note reduction. "other" is
#: what the separator could not name (synths, strings, pads, horns plus
#: bleed), so it asks for a firmer onset and a longer note.
BASIC_PITCH_ROLE_SETTINGS: dict[str, BasicPitchSettings] = {
    "bass": BasicPitchSettings(
        role="bass",
        name="Bass",
        program=33,  # Electric Bass (finger)
        onset_threshold=0.45,
        frame_threshold=0.3,
        minimum_note_length_ms=70.0,
        minimum_frequency=30.0,
        maximum_frequency=400.0,
        monophonic="lowest",
    ),
    "vocals": BasicPitchSettings(
        role="vocals",
        name="Lead Vocal",
        program=53,  # Voice Oohs
        onset_threshold=0.45,
        frame_threshold=0.3,
        minimum_note_length_ms=100.0,
        minimum_frequency=65.0,
        maximum_frequency=1110.0,
        monophonic="loudest",
    ),
    "backing_vocals": BasicPitchSettings(
        role="backing_vocals",
        name="Backing Vocals",
        program=52,  # Choir Aahs
        onset_threshold=0.45,
        frame_threshold=0.3,
        minimum_note_length_ms=100.0,
        minimum_frequency=65.0,
        maximum_frequency=1110.0,
    ),
    "guitar": BasicPitchSettings(
        role="guitar",
        name="Guitar",
        program=25,  # Acoustic Guitar (steel)
        onset_threshold=0.5,
        frame_threshold=0.3,
        minimum_note_length_ms=80.0,
        minimum_frequency=70.0,
        maximum_frequency=1400.0,
    ),
    "piano": BasicPitchSettings(
        role="piano",
        name="Piano",
        program=0,  # Acoustic Grand Piano
        onset_threshold=0.5,
        frame_threshold=0.3,
        minimum_note_length_ms=60.0,
        minimum_frequency=27.5,
        maximum_frequency=4200.0,
    ),
    "other": BasicPitchSettings(
        role="other",
        name="Other",
        program=48,  # String Ensemble 1
        onset_threshold=0.6,
        frame_threshold=0.3,
        minimum_note_length_ms=100.0,
        minimum_frequency=40.0,
        maximum_frequency=4200.0,
    ),
    "mix": MIX_SETTINGS,
}


def basic_pitch_settings(role: Optional[str]) -> BasicPitchSettings:
    """The basic-pitch settings for a stem role; the mix settings for the
    full track (``None``) and for any role basic-pitch has none for."""
    return BASIC_PITCH_ROLE_SETTINGS.get(role or "mix", MIX_SETTINGS)


def _name_tokens(stem_name: str) -> list[str]:
    return [t for t in re.split(r"[^a-z0-9]+", stem_name.lower()) if t]


def role_for_stem(stem_name: Optional[str]) -> Optional[str]:
    """The instrument a stem carries, read from its name.

    Covers the names the separator writes (Demucs ``vocals`` / ``drums`` /
    ``bass`` / ``other`` / ``guitar`` / ``piano`` / ``no_vocals``, the LARSNET
    kit parts, the lead/backing vocal split) and the common ways a person
    names the same stems. Returns one of the keys of
    :data:`BASIC_PITCH_ROLE_SETTINGS`, ``"drums"`` or a :data:`DRUM_PARTS`
    name, or ``None`` for a name that says nothing about the instrument.
    """
    if not stem_name:
        return None
    name = stem_name.lower()
    tokens = _name_tokens(stem_name)
    joined = "".join(tokens)
    words = set(tokens)
    if "kick" in joined or "bassdrum" in joined:
        return "kick"
    if "snare" in joined:
        return "snare"
    if any(re.fullmatch(r"(floor|rack)?toms?\d*", t) for t in tokens):
        return "toms"
    if "hihat" in joined or words & {"hat", "hats", "hh"}:
        return "hihat"
    if "cymbal" in joined or words & {"crash", "ride", "overhead", "overheads"}:
        return "cymbals"
    if "drum" in name or words & {"kit", "percussion", "perc"}:
        return "drums"
    if words & {"mix", "full", "instrumental", "accompaniment", "karaoke"} or (
        "no" in words and ("vocals" in words or "vocal" in words)
    ):
        return "mix"
    if "vocal" in name or words & {"vox", "voice", "bgv", "choir"}:
        if words & {"back", "backing", "bgv", "harmony", "harmonies", "choir"}:
            return "backing_vocals"
        return "vocals"
    if re.search(r"bass(?!oon)", name):
        return "bass"
    if "guitar" in name or words & {"gtr", "gtrs"}:
        return "guitar"
    if "piano" in name or words & {"keys", "keyboard", "keyboards"}:
        return "piano"
    if "other" in words:
        return "other"
    return None


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


#: Why each pitched engine failed its last import check (``None`` = it
#: imported). Filled by the availability checks below and read by
#: :func:`engine_unavailable_reasons` for the Settings card.
_UNAVAILABLE_REASON: dict[str, Optional[str]] = {}

#: ``(engine, reason)`` pairs already written to the LOG. The capability check
#: runs on every Settings poll and every conversion; the LOG gets each reason
#: once per process.
_WARNED_UNAVAILABLE: set[tuple[str, str]] = set()


def _import_problem(module: str) -> Optional[str]:
    """``None`` when ``module`` imports, else what stopped it: the module
    that is missing, or the import error itself."""
    try:
        importlib.import_module(module)
        return None
    except ModuleNotFoundError as e:
        return f"missing module: {e.name or e}"
    except ImportError as e:
        return f"import failed: {e}"


def _note_availability(engine: str, problem: Optional[str], effect: str) -> bool:
    """Record ``engine``'s import check; on a failure, say once in the LOG
    which module is missing and what that does to a conversion."""
    _UNAVAILABLE_REASON[engine] = problem
    if problem is None:
        return True
    if (engine, problem) not in _WARNED_UNAVAILABLE:
        _WARNED_UNAVAILABLE.add((engine, problem))
        log.warning(
            "midi.engine: %s is unavailable (%s); %s",
            PACKAGE_FOR_ENGINE[engine],
            problem,
            effect,
        )
    return False


def _basic_pitch_available() -> bool:
    with _quiet_basic_pitch_import():
        problem = _import_problem("basic_pitch")
    # Recorded outside the quiet block, which holds the root level at ERROR.
    return _note_availability(
        "basic_pitch", problem, "full tracks and pitched stems cannot use it"
    )


def _piano_transcription_available() -> bool:
    return _note_availability(
        "piano_transcription_inference",
        _import_problem("piano_transcription_inference"),
        "piano stems are converted with basic-pitch",
    )


def engine_unavailable_reasons() -> dict[str, str]:
    """Engine -> why its last import check failed, for the engines that did
    not import. Call after :func:`engine_capabilities`, which runs the checks."""
    return {name: why for name, why in _UNAVAILABLE_REASON.items() if why}


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
    role: Optional[str] = None,
) -> dict:
    """Convert ``audio_path`` to a MIDI file at ``output_path``.

    If neither pitched engine is installed and ``auto_install`` is True,
    this transparently runs ``pip install basic-pitch`` and retries. Set
    ``auto_install=False`` to keep the historical fail-fast behavior.

    ``role`` is the stem's instrument (:func:`role_for_stem`; ``None`` for
    the full track). A percussive role always goes to the drum engine, a kit
    part on its own voice; basic-pitch runs with the role's settings and
    writes the role's program.

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

    if role in PERCUSSIVE_ROLES:
        hint = "drums"
    engine = _route(hint)
    if engine == DRUM_ENGINE:
        part = role if role in DRUM_PARTS else None
        try:
            return _run_drum_onsets(p, output_path, bpm=bpm, beats=beats, part=part)
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
            result = _run_basic_pitch(p, output_path, role=role)
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
    part: Optional[str] = None,
) -> dict:
    """Model-free drum transcription (see :mod:`.drums`). The result dict
    carries ``engine == "drum-onsets"`` — that string lands in the ``midis``
    row so the notation layer can recognise a drum MIDI. ``part`` names the
    kit piece a LARSNET part stem holds; ``None`` is the whole kit."""
    from .drums import transcribe_drums

    return transcribe_drums(audio_path, output_path, bpm=bpm, beats=beats, part=part)


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


#: Onsets this close (seconds) were struck together; a one-note line keeps
#: one of them.
MONO_ONSET_WINDOW_SEC = 0.05

#: Of two bass notes struck together, the lower one is the note while it is
#: at least this loud against the higher: basic-pitch reports a bass note's
#: octave and twelfth as notes of their own, quieter than the fundamental.
MONO_LOWER_WINS_RATIO = 0.6

#: A note that starts under a sounding one and is quieter than this fraction
#: of it is an overtone or a breath, not the next note of the line.
MONO_GHOST_RATIO = 0.8

#: Semitones above a sung note where its overtones sit: octave, twelfth,
#: double octave, major seventeenth, nineteenth, triple octave.
_OVERTONE_INTERVALS = frozenset({12, 19, 24, 28, 31, 36})

#: basic-pitch reads a note's bend in contour bins (a third of a semitone)
#: and its contour wobbles by one bin on a steady tone. A note's bend is
#: written when, centred on the note, it moves at least this many bins.
MIN_BEND_BINS = 2

#: Two wheel events closer than this (seconds) can land on one MIDI tick at
#: the resolution the file is written at; they merge into one event at the
#: earlier time carrying the later value.
_SAME_TICK_SEC = 0.003

#: ``(start_s, end_s, midi_pitch, amplitude 0-1, bends in contour bins)``,
#: the note events ``basic_pitch.inference.predict`` returns.
NoteEvent = tuple[float, float, int, float, Optional[list[int]]]


def _as_event(note: Sequence) -> NoteEvent:
    """One predict() note event with plain Python numbers (it hands back
    numpy scalars) and an empty bend list read as none."""
    start, end, pitch, amp, bends = note
    bent = [int(b) for b in bends] if bends is not None else []
    return (float(start), float(end), int(pitch), float(amp), bent or None)


def _trim(note: NoteEvent, end: float) -> NoteEvent:
    """``note`` ending at ``end``, its bend curve cut to the part it keeps
    (the curve is spread evenly over the note's frames)."""
    start, old_end, pitch, amp, bends = note
    if bends and old_end > start:
        keep = int(round(len(bends) * (end - start) / (old_end - start)))
        bends = bends[: max(0, keep)] or None
    return (start, end, pitch, amp, bends)


def _at_overtone(low: NoteEvent, high: NoteEvent, pick: MonophonicPick) -> bool:
    """Whether ``high`` sits at one of ``low``'s overtones
    (:data:`_OVERTONE_INTERVALS`). basic-pitch places a bass note's
    overtones up to a semitone off their true interval (a C2's twelfth comes
    out as F#3), so on a bass line (``pick="lowest"``) a semitone either side
    counts."""
    interval = high[2] - low[2]
    slack = 1 if pick == "lowest" else 0
    return any(abs(interval - o) <= slack for o in _OVERTONE_INTERVALS)


def _later_wins(cur: NoteEvent, new: NoteEvent, pick: MonophonicPick) -> bool:
    """Of two notes struck together, whether ``new`` (the later onset) is
    the one the line keeps.

    On a bass line the lower note wins over its own overtone. Two notes that
    are not a note and its overtone are two notes of the line: basic-pitch
    re-strikes the ringing note a few milliseconds before the next note's
    onset, and the note that sounds on past the other is the one played."""
    if pick == "lowest":
        new_is_lower = new[2] < cur[2]
        lower, higher = (new, cur) if new_is_lower else (cur, new)
        if not _at_overtone(lower, higher, pick):
            return new[1] > cur[1]
        if lower[3] >= MONO_LOWER_WINS_RATIO * higher[3]:
            return new_is_lower
        return new[3] > cur[3]
    if new[3] != cur[3]:
        return new[3] > cur[3]
    return new[2] < cur[2]


def _is_overtone(cur: NoteEvent, new: NoteEvent, pick: MonophonicPick) -> bool:
    """Whether ``new``, starting while ``cur`` sounds, belongs to ``cur``
    (an overtone, a breath) and is not the next note of the line: it is
    quieter, and it either ends inside ``cur`` or sits at one of its
    overtones. A quieter note that rings on past ``cur`` at any other
    interval is the next note played softly (on a bass line, any lower note
    is). On a bass line a note that starts and ends inside ``cur`` at one of
    its overtones is that overtone however loud basic-pitch reads it."""
    if pick == "lowest":
        if new[2] < cur[2]:
            return False
        if new[1] <= cur[1] and _at_overtone(cur, new, pick):
            return True
    if new[3] >= MONO_GHOST_RATIO * cur[3]:
        return False
    return new[1] <= cur[1] or _at_overtone(cur, new, pick)


def monophonic_line(
    notes: Sequence[Sequence], *, pick: MonophonicPick, min_len: float
) -> list[NoteEvent]:
    """Reduce note events to a line of one note at a time.

    Notes struck together (onsets within :data:`MONO_ONSET_WINDOW_SEC`) keep
    one: the lowest, unless it is much quieter (``pick="lowest"``, a bass),
    or the loudest (``pick="loudest"``, a sung melody). A note that starts
    under a sounding one is dropped when it is an overtone or breath of it
    (:func:`_is_overtone`); otherwise it is the next note, and the sounding
    note ends where it starts. A note left shorter than half ``min_len``
    (seconds) by that cut is dropped. The result is sorted and no two notes
    overlap.
    """
    ordered = sorted((_as_event(n) for n in notes), key=lambda n: (n[0], n[2]))
    line: list[NoteEvent] = []

    def emit(note: NoteEvent) -> None:
        if note[1] - note[0] >= min_len / 2.0:
            line.append(note)

    cur: Optional[NoteEvent] = None
    for new in ordered:
        if new[1] <= new[0]:
            continue
        if cur is None:
            cur = new
        elif new[0] >= cur[1]:
            emit(cur)
            cur = new
        elif new[2] == cur[2]:
            # The same pitch detected twice over itself: one note.
            cur = (cur[0], max(cur[1], new[1]), cur[2], max(cur[3], new[3]), cur[4])
        elif new[0] - cur[0] <= MONO_ONSET_WINDOW_SEC:
            if _later_wins(cur, new, pick):
                cur = new
        elif not _is_overtone(cur, new, pick):
            emit(_trim(cur, new[0]))
            cur = new
    if cur is not None:
        emit(cur)
    return line


def _mono_pitch_bends(
    line: Sequence[NoteEvent], bins_per_semitone: int
) -> list[tuple[float, int]]:
    """``(time_s, wheel value)`` events for a one-note-at-a-time line.

    Each note's curve is centred on its own median, so the wheel carries the
    note's movement (a scoop, a slide, vibrato) and not basic-pitch's
    estimate of its tuning, which on a steady tone sits a bin sharp. A note
    whose curve moves less than :data:`MIN_BEND_BINS` gets no bend. The wheel
    returns to centre when a bent note ends, so the next note starts
    unbent. Values assume the General MIDI bend range of 2 semitones.
    """
    import numpy as np

    events: list[tuple[float, int]] = []
    per_semitone = 4096.0 / float(bins_per_semitone)
    for start, end, _pitch, _amp, bends in line:
        if not bends:
            continue
        values = np.asarray(bends, dtype=np.float64)
        moved = values - float(np.median(values))
        if float(np.max(np.abs(moved))) < MIN_BEND_BINS:
            continue
        step = (end - start) / moved.size
        last = 0
        for i, v in enumerate(moved):
            wheel = max(-8192, min(8191, int(round(float(v) * per_semitone))))
            if wheel != last:
                events.append((start + i * step, wheel))
                last = wheel
        if last != 0:
            events.append((end, 0))
    out: list[tuple[float, int]] = []
    for when, value in events:
        if out and when - out[-1][0] < _SAME_TICK_SEC:
            out[-1] = (out[-1][0], value)
        else:
            out.append((when, value))
    return out


def _write_note_events(
    note_events: Sequence[Sequence],
    output_path: Path,
    settings: BasicPitchSettings,
    *,
    bins_per_semitone: int,
) -> int:
    """Write basic-pitch note events as a MIDI file for ``settings``' role.

    One instrument on the role's General MIDI program and name, on a melodic
    channel. A monophonic role is reduced to one note at a time and keeps
    each note's bend (:func:`_mono_pitch_bends`); a polyphonic role gets no
    pitch wheel, which would bend every note of a chord together. The file
    is written beside ``output_path`` and moved over it. Returns the number
    of notes written.
    """
    import pretty_midi

    events = [_as_event(n) for n in note_events]
    if settings.monophonic:
        events = monophonic_line(
            events,
            pick=settings.monophonic,
            min_len=settings.minimum_note_length_ms / 1000.0,
        )
    midi = pretty_midi.PrettyMIDI(initial_tempo=120.0)
    inst = pretty_midi.Instrument(program=settings.program, name=settings.name)
    for start, end, pitch, amp, _bends in events:
        inst.notes.append(
            pretty_midi.Note(
                velocity=max(1, min(127, int(round(127 * amp)))),
                pitch=pitch,
                start=start,
                end=end,
            )
        )
    if settings.monophonic:
        for when, value in _mono_pitch_bends(events, bins_per_semitone):
            inst.pitch_bends.append(pretty_midi.PitchBend(value, when))
    midi.instruments.append(inst)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(suffix=".mid", dir=str(output_path.parent))
    os.close(fd)
    tmp = Path(tmp_name)
    try:
        midi.write(str(tmp))
        os.replace(tmp, output_path)
    finally:
        with contextlib.suppress(OSError):
            tmp.unlink()
    return len(inst.notes)


def _run_basic_pitch(
    audio_path: Path, output_path: Path, *, role: Optional[str] = None
) -> dict:
    """Transcribe with basic-pitch using the settings of the stem's ``role``
    (:func:`basic_pitch_settings`; the full-mix settings for ``None``) and
    write the notes as that role's instrument (:func:`_write_note_events`)."""
    # The model load logs before it imports basic_pitch.inference (the slow
    # import), so it runs first.
    model = _load_basic_pitch_model()
    with _quiet_basic_pitch_import():
        from basic_pitch.constants import CONTOURS_BINS_PER_SEMITONE
        from basic_pitch.inference import predict

    settings = basic_pitch_settings(role)
    # basic-pitch prints status with emoji. On Windows the
    # console/log stream is often a legacy code page (cp1252), so the
    # library's own print() raises UnicodeEncodeError ('charmap' codec
    # can't encode '\U0001f6a8') and kills a conversion that would
    # otherwise succeed. Capture its stdout/stderr into a str buffer —
    # StringIO holds text, never encodes, so it cannot crash — then log
    # the (now harmless) chatter at debug level.
    chatter = io.StringIO()
    with contextlib.redirect_stdout(chatter), contextlib.redirect_stderr(chatter):
        _output, _midi, note_events = predict(
            audio_path,
            model,
            onset_threshold=settings.onset_threshold,
            frame_threshold=settings.frame_threshold,
            minimum_note_length=settings.minimum_note_length_ms,
            minimum_frequency=settings.minimum_frequency,
            maximum_frequency=settings.maximum_frequency,
            multiple_pitch_bends=False,
            melodia_trick=True,
        )
    captured = chatter.getvalue().strip()
    if captured:
        log.debug("basic_pitch output: %s", captured)

    notes_count = _write_note_events(
        note_events,
        output_path,
        settings,
        bins_per_semitone=int(CONTOURS_BINS_PER_SEMITONE),
    )
    return {
        "ok": True,
        "engine": "basic_pitch",
        "engine_version": _module_version("basic_pitch"),
        "notes_count": notes_count,
        "role": settings.role,
        "program": settings.program,
        "monophonic": bool(settings.monophonic),
        "device": "cuda"
        if _basic_pitch_providers[:1] == ["CUDAExecutionProvider"]
        else "cpu",
    }


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


def _load_mono(audio_path: Path, sample_rate: int):
    """``audio_path`` as a mono float32 signal at ``sample_rate``, decoded by
    the app's loader (libsndfile; the ffmpeg CLI for what it cannot open).

    The piano package's own ``load_audio`` decodes every file, WAV included,
    by running ffmpeg through audioread."""
    import librosa
    import numpy as np

    from backend.lib.audio_io import load_audio_array

    data, sr = load_audio_array(audio_path)
    mono = data.mean(axis=0) if data.shape[0] > 1 else data[0]
    if sr != sample_rate:
        mono = librosa.resample(mono, orig_sr=sr, target_sr=sample_rate)
    return np.ascontiguousarray(mono, dtype=np.float32)


def _run_piano_transcription(audio_path: Path, output_path: Path) -> dict:
    from piano_transcription_inference import PianoTranscription, sample_rate

    checkpoint_path = _ensure_piano_checkpoint()
    audio = _load_mono(audio_path, int(sample_rate))
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


def hint_for_stem(stem_name: Optional[str]) -> MidiHint:
    """Stem-aware routing by the stem's role (:func:`role_for_stem`): the
    whole kit and every LARSNET kit part go to the model-free drum engine,
    piano-transcription-inference takes a piano stem, everything else
    routes to basic-pitch."""
    role = role_for_stem(stem_name)
    if role in PERCUSSIVE_ROLES:
        return "drums"
    if role == "piano":
        return "piano"
    return "generic"
