"""T12 DSP A — enhance/restoration/creative_neural fixes.

Covers:
  FX-002: Un-Crush ``afftdn nr=0`` at a low knob must not 500 (clamp to
          ffmpeg's documented minimum of 0.01). Studio Enhance has the same
          bug at denoise=0.01 (denoise_nr=0.25 rounds to nr=0 at :.0f).
  FX-004: restoration stem_separation's ``stems`` knob (declared range 2-6)
          must actually change the output across its range, and the
          ToolSpec's user-facing text must not promise N stems.
  FX-005: creative_neural descriptions must not overclaim what the code does;
          TimbreForge's ``structureWeight``/``latentWander`` knobs and the
          TokenSynth/AmbientForge prompts are declared AND read (they were
          read nowhere on main; they are wired now, see
          tests/test_tool_controls_restored.py for what each one does).
  FX-008: grainlab's dead bare ``max(...)`` statement is gone and the
          pitch-spread branch it sat in still works.
  FX-004 (re-audit): every restoration ToolSpec's declared params must
          actually be read by its handler (vocal_isolate denoiseAmount/
          dereverbAmount, breath_removal clickReduction and the restore_all
          prompt were declared but never read on main; they are wired now).
          A caller that omits them (vocal.preprocess, an old preset) still
          validates and renders.

No model weights, no GPU. FFmpeg-dependent tests are skipped when no ffmpeg
is found at all (``backend.lib.ffmpeg_tools``, the same resolution the backend
runs). A build without libsoxr is not skipped: the soxr tools fail on it.
"""

from __future__ import annotations

import ast
import asyncio
import inspect
import textwrap
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from backend.modules.enhance.router import TOOLS as ENHANCE_TOOLS
from backend.modules.enhance.router import (
    _afftdn_delay_samples as _enhance_afftdn_delay_samples,
)
from backend.modules.enhance.router import _studio_enhance, _uncrush
from backend.modules.creative_neural.router import TOOLS as CREATIVE_NEURAL_TOOLS
from backend.modules.creative_neural.router import _probe_sample_rate, _timbreforge
from backend.modules.creative_neural import dsp as creative_dsp
from backend.modules.restoration import dsp as restoration_dsp
from backend.modules.restoration.router import TOOLS as RESTORATION_TOOLS
from backend.modules.restoration.router import (
    _afftdn_delay_samples as _restoration_afftdn_delay_samples,
)
from backend.modules.restoration.router import _dereverb, _neural_denoise
from backend.modules.effects.router import _build_filter
from backend.modules.effects.router import (
    _afftdn_delay_samples as _effects_afftdn_delay_samples,
)
from backend.modules.effects.router import router as effects_router
from backend.modules.mastering.router import TOOLS as MASTERING_TOOLS
from backend.modules.mastering.router import _loudness_meter, _maximizer
from backend.lib import ffmpeg, ffmpeg_tools
from fastapi import FastAPI
from fastapi.testclient import TestClient

SR = 44100


def _tone(path: Path, seconds: float = 1.0, sr: int = SR, freq: float = 440.0) -> Path:
    t = np.linspace(0, seconds, int(sr * seconds), endpoint=False)
    y = 0.3 * np.sin(2 * np.pi * freq * t).astype(np.float32)
    sf.write(str(path), y, sr, subtype="FLOAT")
    return path


def _noisy_stereo(path: Path, seconds: float = 1.0, sr: int = SR) -> Path:
    """A stereo mix with a steady tonal (harmonic-leaning) component and a
    percussive click train, so harmonic vs. percussive HPSS output actually
    differ, and margin has something to bite on."""
    rng = np.random.default_rng(7)
    n = int(sr * seconds)
    t = np.linspace(0, seconds, n, endpoint=False)
    tone = 0.25 * np.sin(2 * np.pi * 220.0 * t)
    clicks = np.zeros(n)
    for i in range(0, n, sr // 8):
        clicks[i : i + 20] += rng.uniform(-1, 1, size=min(20, n - i))
    mono = (tone + clicks).astype(np.float32)
    stereo = np.column_stack([mono, mono])
    sf.write(str(path), stereo, sr, subtype="FLOAT")
    return path


# ---------------------------------------------------------------------------
# FX-002 — Un-Crush / Studio Enhance afftdn nr clamp
#
# Both are process-mode now (see the T12f section below for why), so their
# filter chain is built inside a closure only real rendering exercises —
# these are end-to-end tests against real ffmpeg rather than string
# inspection of a returned args list.
# ---------------------------------------------------------------------------


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
def test_uncrush_zero_strength_renders_with_real_ffmpeg(tmp_path):
    """afftdn's documented range is 0.01-97 — nr=0 is a hard ffmpeg error.
    strength=0 used to produce nr=0 exactly; this is the call path that
    used to 500."""
    src = _tone(tmp_path / "in.wav")
    out = tmp_path / "out.wav"
    asyncio.run(_uncrush(src, out, {"strength": 0.0, "mix": 1.0}))
    assert out.exists() and out.stat().st_size > 0


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
def test_uncrush_tool_strength_param_allows_zero(tmp_path):
    """strength's declared range is 0-1 — 0 is a legal, reachable value the
    handler must not choke on."""
    tool = next(t for t in ENHANCE_TOOLS if t.id == "uncrush")
    strength_spec = next(p for p in tool.params if p.name == "strength")
    assert strength_spec.lo == 0
    validated = tool.validate_params({"strength": 0.0, "mix": 1.0})
    src = _tone(tmp_path / "in.wav")
    out = tmp_path / "out.wav"
    asyncio.run(tool.handler(src, out, validated))
    assert out.exists() and out.stat().st_size > 0


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
def test_studio_enhance_low_denoise_renders_with_real_ffmpeg(tmp_path):
    """denoise=0.01 -> denoise_nr=0.25, which used to round to nr=0 at :.0f
    and fail real ffmpeg with 'Result too large'."""
    src = _tone(tmp_path / "in.wav")
    out = tmp_path / "out.wav"
    asyncio.run(_studio_enhance(src, out, {"enhance": 0.0, "denoise": 0.01}))
    assert out.exists() and out.stat().st_size > 0


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
def test_studio_enhance_denoise_zero_still_skips_afftdn(tmp_path):
    """denoise=0 must still omit afftdn entirely (the ``if denoise > 0``
    guard), not clamp it into existing at nr=0.01 when the user asked for
    no denoising at all.

    Verified structurally (byte-identical output against the equivalent
    bare chain, INCLUDING its own explicit resample back to source rate —
    without that this test would compare a correctly-resampled tool output
    against a bare 192 kHz one and never notice, which is exactly how the
    T12h bug got past T12g's version of this test), not via impulse
    position: ``loudnorm`` is always the last stage and has its own large,
    content-dependent lookahead buffer independent of afftdn (see the
    T12f section below) — an impulse-position check would be dominated by
    that, not by whether afftdn/atrim were correctly omitted.
    """
    src = _tone(tmp_path / "in.wav")
    via_tool = tmp_path / "via_tool.wav"
    via_bare = tmp_path / "via_bare.wav"
    asyncio.run(_studio_enhance(src, via_tool, {"enhance": 0.0, "denoise": 0.0}))
    asyncio.run(
        ffmpeg.render(
            src,
            via_bare,
            ["-af", f"loudnorm=I=-16:TP=-1:LRA=11,aresample={SR}"],
            extra_out_args=["-c:a", "pcm_f32le"],
        )
    )
    tool_data, tool_sr = sf.read(str(via_tool), dtype="float32")
    bare_data, bare_sr = sf.read(str(via_bare), dtype="float32")
    assert tool_sr == SR
    assert bare_sr == SR
    assert np.array_equal(tool_data, bare_data)


# ---------------------------------------------------------------------------
# FX-004 — restoration stem_separation "stems" knob actually does something
# ---------------------------------------------------------------------------


def test_stem_separation_tool_text_does_not_promise_n_stems():
    """The ToolSpec's user-facing description/label must not claim N
    selectable stems when the handler only ever outputs one track."""
    tool = next(t for t in RESTORATION_TOOLS if t.id == "stem_separation")
    desc = tool.description.lower()
    assert "one track" in desc or "not n stems" in desc
    stems_spec = next(p for p in tool.params if p.name == "stems")
    # API/preset compatibility: the param NAME stays "stems".
    assert stems_spec.name == "stems"
    assert stems_spec.label != "Stems"


def test_stem_separation_harmonic_vs_percussive_differ(tmp_path):
    src = _noisy_stereo(tmp_path / "in.wav")
    out_harmonic = tmp_path / "harmonic.wav"
    out_percussive = tmp_path / "percussive.wav"

    restoration_dsp.stem_separation(src, out_harmonic, {"stems": 2})
    restoration_dsp.stem_separation(src, out_percussive, {"stems": 4})

    h, _ = sf.read(str(out_harmonic), dtype="float32")
    p, _ = sf.read(str(out_percussive), dtype="float32")
    assert not np.allclose(h, p, atol=1e-4)


def test_stem_separation_percussive_margin_scales_across_range(tmp_path):
    """Every value 3-6 must be wired to something, not silently identical:
    each stems value must differ from its immediate neighbor, not just from
    the first value in the range."""
    src = _noisy_stereo(tmp_path / "in.wav")
    results = {}
    for stems_val in (3, 4, 5, 6):
        out = tmp_path / f"out_{stems_val}.wav"
        restoration_dsp.stem_separation(src, out, {"stems": stems_val})
        data, _ = sf.read(str(out), dtype="float32")
        results[stems_val] = data

    for a, b in zip((3, 4, 5, 6), (4, 5, 6)):
        assert not np.allclose(results[a], results[b], atol=1e-6), (
            f"stems={a} and stems={b} produced identical output — the margin "
            "knob is not wired between these two values"
        )


def test_stem_separation_clamps_out_of_range_stems(tmp_path):
    """stems is declared 2-6 on the ToolSpec; the DSP body clamps defensively
    rather than trusting the caller."""
    src = _noisy_stereo(tmp_path / "in.wav")
    out_low = tmp_path / "low.wav"
    out_clamped = tmp_path / "clamped.wav"
    restoration_dsp.stem_separation(src, out_low, {"stems": 1})
    restoration_dsp.stem_separation(src, out_clamped, {"stems": 2})
    low, _ = sf.read(str(out_low), dtype="float32")
    clamped, _ = sf.read(str(out_clamped), dtype="float32")
    assert np.allclose(low, clamped, atol=1e-6)


# ---------------------------------------------------------------------------
# FX-005 — creative_neural descriptions must not overclaim
# ---------------------------------------------------------------------------


def test_timbreforge_description_does_not_overclaim_instrument_transfer():
    tool = next(t for t in CREATIVE_NEURAL_TOOLS if t.id == "timbreforge")
    desc = tool.description.lower()
    assert "any instrument" not in desc
    assert "neural timbre transfer" not in desc


def _spec_rows(tool) -> list[tuple]:
    """Each declared control as main's P(...) call spells it: name, type,
    range, default, unit, control and label."""
    return [
        (p.name, p.type, p.lo, p.hi, p.default, p.unit, p.control, p.label)
        for p in tool.params
    ]


def test_timbreforge_declares_structure_timbre_and_wander():
    """main's three knobs, in main's order, with main's ranges, defaults and
    labels. Each is read by the handler (see
    test_every_creative_neural_declared_param_is_read_by_its_handler) and
    changes the render (tests/test_tool_controls_restored.py)."""
    tool = next(t for t in CREATIVE_NEURAL_TOOLS if t.id == "timbreforge")
    assert _spec_rows(tool) == [
        ("structureWeight", "float", 0, 1, 0.5, "", "ParamKnob", "Structure"),
        ("timbreBlend", "float", 0, 1, 0.5, "", "ParamKnob", "Timbre"),
        ("latentWander", "float", 0, 1, 0.0, "", "ParamKnob", "Wander"),
    ]
    desc = tool.description.lower()
    assert "structure" in desc and "wander" in desc


def test_timbreforge_docstring_describes_asetrate_atempo_correctly():
    doc = (_timbreforge.__doc__ or "").lower()
    # asetrate shifts pitch AND formants together (that combined shift is
    # the point); atempo restores duration only, never pitch.
    assert "pitch" in doc and "formant" in doc
    assert "duration" in doc
    assert "restores pitch" not in doc and "preserve pitch" not in doc


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
def test_timbreforge_uses_probed_source_rate_not_hardcoded_44100(tmp_path):
    """A 48 kHz source must not be silently treated as 44.1 kHz — asetrate
    needs the SOURCE rate to shift by exactly the requested ratio."""
    src = tmp_path / "in48k.wav"
    _tone(src, seconds=0.3, sr=48000)
    out = tmp_path / "out.wav"
    asyncio.run(_timbreforge(src, out, {"timbreBlend": 0.0}))  # ratio=0.5, shifts
    assert out.exists() and out.stat().st_size > 0


def test_probe_sample_rate_reads_source_rate(tmp_path):
    src = tmp_path / "in48k.wav"
    _tone(src, seconds=0.2, sr=48000)
    if ffmpeg_tools.find_ffprobe() is None:
        pytest.skip("no ffprobe found")
    assert _probe_sample_rate(src) == 48000


def test_probe_sample_rate_falls_back_when_unprobeable(tmp_path):
    missing = tmp_path / "does-not-exist.wav"
    assert _probe_sample_rate(missing) == 44100


def test_crossfade_morph_description_does_not_claim_two_tracks():
    tool = next(t for t in CREATIVE_NEURAL_TOOLS if t.id == "crossfade_morph")
    desc = tool.description.lower()
    assert "two tracks" not in desc
    assert "single input" in desc or "itself" in desc


def test_ambientforge_declares_prompt_and_says_what_it_steers():
    """The bed is still lavfi noise, not a text model: the description says
    the prompt shapes it and that the input audio is ignored."""
    tool = next(t for t in CREATIVE_NEURAL_TOOLS if t.id == "ambientforge")
    assert _spec_rows(tool) == [
        ("prompt", "string", None, None, "", "", "TextInput", "Prompt"),
        ("duration", "float", 5, 300, 30, "s", "ParamKnob", "Duration"),
    ]
    desc = tool.description.lower()
    assert "prompt" in desc
    assert "noise" in desc and "ignores" in desc


def test_tokensynth_declares_prompt_and_says_what_it_steers():
    """The prompt picks the ring-mod voice; the description must not claim
    text-to-instrument generation, which the DSP does not do."""
    tool = next(t for t in CREATIVE_NEURAL_TOOLS if t.id == "tokensynth")
    assert _spec_rows(tool) == [
        ("prompt", "string", None, None, "", "", "TextInput", "Prompt"),
        ("temperature", "float", 0.1, 2.0, 1.0, "", "ParamKnob", "Temp"),
    ]
    desc = tool.description.lower()
    assert "prompt" in desc
    assert "text ->" not in desc
    assert "instrument" not in desc


# ---------------------------------------------------------------------------
# FX-008 — grainlab dead statement removed, pitch-spread path still works
# ---------------------------------------------------------------------------


def test_grainlab_has_no_dead_pure_builtin_call_statements():
    """AST-based, not text-based: catches ANY bare `max(...)`/`min(...)`/etc.
    statement whose result is thrown away, not just the one specific line —
    so this stays valid if the function is edited later.

    Scoped to pure builtins (max, min, abs, len, sum, sorted, round, pow):
    a bare call to one of these can never do anything but compute a value
    and discard it, so it is always dead code. Calls to project functions
    (``write_like_source``) or methods (``list.append``) are legitimately
    used for their side effects as bare statements and must NOT be flagged.
    """
    pure_builtins = {"max", "min", "abs", "len", "sum", "sorted", "round", "pow"}

    src = textwrap.dedent(inspect.getsource(creative_dsp.grainlab))
    tree = ast.parse(src)
    func = tree.body[0]
    assert isinstance(func, ast.FunctionDef)

    dead_statements = [
        node
        for node in ast.walk(func)
        if isinstance(node, ast.Expr)
        and isinstance(node.value, ast.Call)
        and isinstance(node.value.func, ast.Name)
        and node.value.func.id in pure_builtins
    ]
    assert dead_statements == [], (
        "grainlab contains a discarded-result pure-builtin call statement "
        f"(dead code): {[ast.dump(n) for n in dead_statements]}"
    )


def test_grainlab_pitch_spread_still_runs_and_writes_audio(tmp_path):
    src = _tone(tmp_path / "in.wav", seconds=0.5)
    out = tmp_path / "out.wav"
    params = {
        "grainSize": 80.0,
        "density": 40.0,
        "scatter": 0.3,
        "pitchSpread": 12.0,  # non-zero: exercises the resample branch
    }
    creative_dsp.grainlab(src, out, params)
    assert out.exists()
    data, sr = sf.read(str(out))
    assert sr == SR
    assert len(data) > 0
    assert np.max(np.abs(data)) > 0


# ---------------------------------------------------------------------------
# FX-004 (re-audit, restoration + creative_neural + enhance) — every
# declared ToolSpec param must be read by its handler.
# ---------------------------------------------------------------------------


def _readers(handler, dsp_module=None) -> list:
    """The functions that read a tool's ``params``: the handler itself plus,
    when a ``dsp_module`` is given, every ``dsp.<name>`` function the handler
    calls. A one-line forward such as ``_vocal_isolate`` reads nothing itself
    and its dsp function reads everything; a handler such as
    ``_timbreforge`` reads its keys and hands samples to dsp. Taking the
    union covers both shapes (the first-dsp-call-only version of this helper
    reported every key ``_timbreforge`` reads as unread)."""
    readers = [handler]
    if dsp_module is not None:
        src = textwrap.dedent(inspect.getsource(handler))
        tree = ast.parse(src)
        func_node = tree.body[0]
        for node in ast.walk(func_node):
            if (
                isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and isinstance(node.func.value, ast.Name)
                and node.func.value.id == "dsp"
            ):
                target = getattr(dsp_module, node.func.attr, None)
                if target is not None and target not in readers:
                    readers.append(target)
    return readers


def _unused_params(tools, dsp_module=None) -> list[str]:
    unused = []
    for tool in tools:
        readers = _readers(tool.handler, dsp_module)
        used = set().union(*(_used_param_keys(r) for r in readers))
        names = "+".join(r.__name__ for r in readers)
        for p in tool.params:
            if p.name not in used:
                unused.append(f"{tool.id}.{p.name} (readers={names})")
    return unused


def _used_param_keys(func) -> set[str]:
    """Every string key read off a local named ``params`` via
    ``params["key"]`` or ``params.get("key", ...)`` inside ``func``."""
    src = textwrap.dedent(inspect.getsource(func))
    tree = ast.parse(src)
    func_node = tree.body[0]
    keys: set[str] = set()
    for node in ast.walk(func_node):
        if (
            isinstance(node, ast.Subscript)
            and isinstance(node.value, ast.Name)
            and node.value.id == "params"
            and isinstance(node.slice, ast.Constant)
            and isinstance(node.slice.value, str)
        ):
            keys.add(node.slice.value)
        elif (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "get"
            and isinstance(node.func.value, ast.Name)
            and node.func.value.id == "params"
            and node.args
            and isinstance(node.args[0], ast.Constant)
            and isinstance(node.args[0].value, str)
        ):
            keys.add(node.args[0].value)
    return keys


def test_every_restoration_declared_param_is_read_by_its_handler():
    """Fails if any restoration ToolSpec declares a param its handler (or,
    for process-mode tools, a dsp.py function the handler calls) never
    reads — the bug class of main's four dead knobs."""
    unused = _unused_params(RESTORATION_TOOLS, restoration_dsp)
    assert unused == [], f"declared-but-unread restoration params: {unused}"


def test_every_creative_neural_declared_param_is_read_by_its_handler():
    """Same check for creative_neural — this is what catches a TimbreForge,
    AmbientForge or TokenSynth control that is declared and never read."""
    unused = _unused_params(CREATIVE_NEURAL_TOOLS, creative_dsp)
    assert unused == [], f"declared-but-unread creative_neural params: {unused}"


def test_every_enhance_declared_param_is_read_by_its_handler():
    """Same check for enhance — this is what catches super_res/uncrush/
    neural_codec's dead ``mix`` params (enhance has no separate dsp.py, so
    every handler is its own reader)."""
    unused = _unused_params(ENHANCE_TOOLS)
    assert unused == [], f"declared-but-unread enhance params: {unused}"


def test_restoration_restored_params_are_declared():
    """The four controls main declared (and never read) are declared again,
    with main's names, labels, ranges and defaults, and now drive the DSP."""
    by_id = {t.id: t for t in RESTORATION_TOOLS}
    vocal = {p.name: p for p in by_id["vocal_isolate"].params}
    denoise, dereverb = vocal["denoiseAmount"], vocal["dereverbAmount"]
    assert (denoise.label, denoise.default, denoise.lo, denoise.hi) == (
        "Denoise",
        0.5,
        0,
        1,
    )
    assert (dereverb.label, dereverb.default, dereverb.lo, dereverb.hi) == (
        "Dereverb",
        0.0,
        0,
        1,
    )
    clicks = {p.name: p for p in by_id["breath_removal"].params}["clickReduction"]
    assert (clicks.label, clicks.default, clicks.lo, clicks.hi) == ("Clicks", 0.7, 0, 1)
    prompt = {p.name: p for p in by_id["restore_all"].params}["prompt"]
    assert (prompt.type, prompt.control, prompt.label) == (
        "string",
        "TextInput",
        "Prompt",
    )
    assert "hum" in by_id["restore_all"].description.lower()


def test_breath_removal_name_matches_its_click_detection():
    """The tool finds and removes mouth clicks (``_reduce_mouth_clicks``),
    so it carries main's name again."""
    tool = next(t for t in RESTORATION_TOOLS if t.id == "breath_removal")
    assert tool.name == "Breath / Mouth-Click Removal"
    assert "click" in tool.description.lower()
    assert "clickReduction" in _used_param_keys(restoration_dsp.breath_removal_sync)
    assert callable(restoration_dsp._reduce_mouth_clicks)


# ---------------------------------------------------------------------------
# Restored keys validate and reach the handler; a caller that omits them
# (an old preset, vocal.preprocess) still validates and renders.
# ---------------------------------------------------------------------------


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
def test_timbreforge_structure_and_wander_validate_and_render(tmp_path):
    tool = next(t for t in CREATIVE_NEURAL_TOOLS if t.id == "timbreforge")
    raw = {"timbreBlend": 0.75, "structureWeight": 0.3, "latentWander": 0.9}
    validated = tool.validate_params(raw)
    assert validated["structureWeight"] == pytest.approx(0.3)
    assert validated["latentWander"] == pytest.approx(0.9)
    assert validated["timbreBlend"] == pytest.approx(0.75)

    src = _tone(tmp_path / "in.wav")
    out = tmp_path / "out.wav"
    asyncio.run(tool.handler(src, out, validated))
    assert out.exists() and out.stat().st_size > 0


def test_vocal_isolate_cleanup_keys_validate_and_render(tmp_path):
    tool = next(t for t in RESTORATION_TOOLS if t.id == "vocal_isolate")
    raw = {
        "processAmount": 0.5,
        "output": "vocals",
        "denoiseAmount": 0.4,
        "dereverbAmount": 0.2,
    }
    validated = tool.validate_params(raw)
    assert validated["denoiseAmount"] == pytest.approx(0.4)
    assert validated["dereverbAmount"] == pytest.approx(0.2)

    src = _noisy_stereo(tmp_path / "in.wav")
    out = tmp_path / "out.wav"
    tool.handler(src, out, validated)  # sync process handler, no ffmpeg needed
    assert out.exists() and out.stat().st_size > 0


def test_vocal_isolate_old_preset_without_cleanup_keys_gets_declared_defaults():
    tool = next(t for t in RESTORATION_TOOLS if t.id == "vocal_isolate")
    validated = tool.validate_params({"processAmount": 0.5, "output": "vocals"})
    assert validated["denoiseAmount"] == pytest.approx(0.5)
    assert validated["dereverbAmount"] == pytest.approx(0.0)


def test_breath_removal_click_key_validates_and_renders(tmp_path):
    tool = next(t for t in RESTORATION_TOOLS if t.id == "breath_removal")
    raw = {"breathReduction": 0.6, "clickReduction": 0.9}
    validated = tool.validate_params(raw)
    assert validated["clickReduction"] == pytest.approx(0.9)

    src = _noisy_stereo(tmp_path / "in.wav")
    out = tmp_path / "out.wav"
    tool.handler(src, out, validated)  # sync process handler, no ffmpeg needed
    assert out.exists() and out.stat().st_size > 0


def test_restore_all_prompt_validates_and_an_old_preset_without_it_still_does():
    """restore_all is process-mode (async), not filter-mode — validation
    itself doesn't need I/O, so this stays a pure validate_params check."""
    tool = next(t for t in RESTORATION_TOOLS if t.id == "restore_all")
    validated = tool.validate_params({"strength": 0.6, "prompt": "make it sound warm"})
    assert validated["prompt"] == "make it sound warm"
    assert validated["strength"] == pytest.approx(0.6)
    assert tool.validate_params({"strength": 0.6})["prompt"] == ""


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
def test_restore_all_prompt_renders_with_real_ffmpeg(tmp_path):
    tool = next(t for t in RESTORATION_TOOLS if t.id == "restore_all")
    validated = tool.validate_params({"strength": 0.6, "prompt": "hum and hiss, muddy"})
    src = _tone(tmp_path / "in.wav")
    out = tmp_path / "out.wav"
    asyncio.run(tool.handler(src, out, validated))
    assert out.exists() and out.stat().st_size > 0


def test_tokensynth_prompt_key_validates_and_renders(tmp_path):
    tool = next(t for t in CREATIVE_NEURAL_TOOLS if t.id == "tokensynth")
    raw = {"temperature": 0.8, "prompt": "a warm pad"}
    validated = tool.validate_params(raw)
    assert validated["prompt"] == "a warm pad"

    src = _tone(tmp_path / "in.wav")
    out = tmp_path / "out.wav"
    tool.handler(src, out, validated)  # sync process handler, no ffmpeg needed
    assert out.exists() and out.stat().st_size > 0


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
def test_ambientforge_prompt_key_validates_and_renders(tmp_path):
    tool = next(t for t in CREATIVE_NEURAL_TOOLS if t.id == "ambientforge")
    raw = {"duration": 5.0, "prompt": "a slow drifting pad"}
    validated = tool.validate_params(raw)
    assert validated["prompt"] == "a slow drifting pad"

    src = _tone(tmp_path / "in.wav")
    out = tmp_path / "out.wav"
    asyncio.run(tool.handler(src, out, validated))
    assert out.exists() and out.stat().st_size > 0


# ---------------------------------------------------------------------------
# enhance mix (wet/dry) wiring — super_res, uncrush, neural_codec each
# declared "mix" but none read it; the effect was always fully wet.
# ---------------------------------------------------------------------------


def _rms(data: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(data))))


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
def test_super_res_mix_zero_is_dry_mix_one_is_wet(tmp_path):
    tool = next(t for t in ENHANCE_TOOLS if t.id == "super_res")
    # Same source/target rate: -ar is then a no-op, isolating what `mix`
    # itself changes (the exciter/treble enhancement).
    src = _tone(tmp_path / "in.wav", sr=48000)
    dry_out = tmp_path / "dry.wav"
    wet_out = tmp_path / "wet.wav"
    half_out = tmp_path / "half.wav"

    dry_validated = tool.validate_params(
        {"targetSR": "48000", "guidance": 3.5, "mix": 0.0}
    )
    wet_validated = tool.validate_params(
        {"targetSR": "48000", "guidance": 3.5, "mix": 1.0}
    )
    half_validated = tool.validate_params(
        {"targetSR": "48000", "guidance": 3.5, "mix": 0.5}
    )
    asyncio.run(ffmpeg.render(src, dry_out, tool.handler(dry_validated)))
    asyncio.run(ffmpeg.render(src, wet_out, tool.handler(wet_validated)))
    asyncio.run(ffmpeg.render(src, half_out, tool.handler(half_validated)))

    src_data, _ = sf.read(str(src), dtype="float32")
    dry_data, _ = sf.read(str(dry_out), dtype="float32")
    wet_data, _ = sf.read(str(wet_out), dtype="float32")
    half_data, _ = sf.read(str(half_out), dtype="float32")

    n = min(len(src_data), len(dry_data))
    assert np.allclose(src_data[:n], dry_data[:n], atol=1e-3)
    assert not np.allclose(dry_data, wet_data, atol=1e-3)
    # mix=0.5 must land between dry and wet, not equal either extreme.
    assert not np.allclose(half_data, dry_data, atol=1e-3)
    assert not np.allclose(half_data, wet_data, atol=1e-3)


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
def test_uncrush_mix_zero_is_dry_mix_one_is_wet(tmp_path):
    """uncrush is process-mode (async ``(input_path, output_path, params)``
    now, not filter-mode), so this renders through the tool's handler
    directly rather than via ``tool.handler(params) -> args``."""
    tool = next(t for t in ENHANCE_TOOLS if t.id == "uncrush")
    src = _tone(tmp_path / "in.wav")
    dry_out = tmp_path / "dry.wav"
    wet_out = tmp_path / "wet.wav"

    dry_validated = tool.validate_params({"strength": 0.8, "mix": 0.0})
    wet_validated = tool.validate_params({"strength": 0.8, "mix": 1.0})
    asyncio.run(tool.handler(src, dry_out, dry_validated))
    asyncio.run(tool.handler(src, wet_out, wet_validated))

    src_data, _ = sf.read(str(src), dtype="float32")
    dry_data, _ = sf.read(str(dry_out), dtype="float32")
    wet_data, _ = sf.read(str(wet_out), dtype="float32")

    n = min(len(src_data), len(dry_data))
    assert np.allclose(src_data[:n], dry_data[:n], atol=1e-3)
    # mix=1 output is the same length as mix=0's / the source (T12g's
    # apad=pad_len compensates exactly for what the T12f atrim trims off,
    # so real tail content isn't silently dropped — see
    # test_neural_denoise_preserves_impulse_near_end for the direct proof).
    assert len(wet_data) == len(dry_data)
    n2 = min(len(dry_data), len(wet_data))
    assert not np.allclose(dry_data[:n2], wet_data[:n2], atol=1e-3)


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
def test_neural_codec_mix_zero_is_dry_mix_one_is_wet(tmp_path):
    tool = next(t for t in ENHANCE_TOOLS if t.id == "neural_codec")
    src = _tone(tmp_path / "in.wav")
    dry_out = tmp_path / "dry.wav"
    wet_out = tmp_path / "wet.wav"
    half_out = tmp_path / "half.wav"

    dry_validated = tool.validate_params({"nQuantizers": 4, "mix": 0.0})
    wet_validated = tool.validate_params({"nQuantizers": 4, "mix": 1.0})
    half_validated = tool.validate_params({"nQuantizers": 4, "mix": 0.5})
    asyncio.run(tool.handler(src, dry_out, dry_validated))
    asyncio.run(tool.handler(src, wet_out, wet_validated))
    asyncio.run(tool.handler(src, half_out, half_validated))

    src_data, src_sr = sf.read(str(src), dtype="float32")
    dry_data, dry_sr = sf.read(str(dry_out), dtype="float32")
    wet_data, wet_sr = sf.read(str(wet_out), dtype="float32")
    half_data, half_sr = sf.read(str(half_out), dtype="float32")

    assert dry_sr == src_sr  # dry passthrough: no forced 48kHz opus rate
    assert half_sr == src_sr  # mixed output reformatted back to the dry rate
    n = min(len(src_data), len(dry_data))
    assert np.allclose(src_data[:n], dry_data[:n], atol=1e-2)
    n_dw = min(len(dry_data), len(wet_data))
    assert not np.allclose(dry_data[:n_dw], wet_data[:n_dw], atol=1e-2)
    # A half mix must not collapse to either extreme, and its energy should
    # sit between dry and wet (a real crossfade, not a coin-flip pick).
    n_dh = min(len(dry_data), len(half_data))
    assert not np.allclose(dry_data[:n_dh], half_data[:n_dh], atol=1e-2)
    rms_dry, rms_wet, rms_half = _rms(dry_data), _rms(wet_data), _rms(half_data)
    lo, hi = sorted((rms_dry, rms_wet))
    assert lo - 1e-3 <= rms_half <= hi + 1e-3


# ---------------------------------------------------------------------------
# T12f item 1 - wet/dry crossfade alignment: afftdn adds a real, constant
# algorithmic delay to the wet branch (measured 1102/1200/550 samples at
# 44.1k/48k/22.05k - derived exactly from ffmpeg's own af_afftdn.c source:
# 2 * (sample_rate // 80)), so mixing it against an undelayed dry branch
# produced a flam/comb at every partial mix, not a crossfade.
# ---------------------------------------------------------------------------


def test_afftdn_delay_samples_matches_measured_values():
    """Both families copies of the formula must agree with each other and
    with the exact values measured against real ffmpeg with a
    single-sample impulse (nr in 0.01, 5, 12, 30, 97 all measured identical
    -- the delay does not depend on nr)."""
    measured = {44100: 1102, 48000: 1200, 22050: 550}
    for sr, expected in measured.items():
        assert _enhance_afftdn_delay_samples(sr) == expected
        assert _restoration_afftdn_delay_samples(sr) == expected


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
@pytest.mark.parametrize("sr", [44100, 48000, 22050, 88200, 96000])
def test_uncrush_mix_half_impulse_is_one_not_two(tmp_path, sr):
    """The flam this bug produced put two peaks ~1100+ samples apart (the
    dry impulse, then the wet one afftdn's delay later). After alignment,
    a single-sample impulse at mix=0.5 must land as ONE combined event at
    the input's own position, not two separated ones."""
    idx = sr // 2
    y = np.zeros(sr, dtype=np.float32)
    y[idx] = 1.0
    src = tmp_path / "in.wav"
    sf.write(str(src), y, sr, subtype="FLOAT")
    out = tmp_path / "out.wav"
    asyncio.run(_uncrush(src, out, {"strength": 0.8, "mix": 0.5}))
    data, _ = sf.read(str(out), dtype="float32")
    mag = np.abs(data)
    peak_idx = int(np.argmax(mag))
    # Bit-exact: dry and wet branches are delay-matched before mixing, so
    # there is no rounding slack to allow for here (unlike a raw
    # ms-based adelay, which does NOT reproduce this at 22050 -- see
    # _afftdn_delay_samples's docstring).
    assert peak_idx == idx
    # And it must be a single combined event, not two ~1100+ sample-apart
    # peaks each near half amplitude (the pre-fix flam signature).
    thresh = mag.max() * 0.3
    region = np.where(mag > thresh)[0]
    assert region.max() - region.min() < 50


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
@pytest.mark.parametrize("sr", [44100, 48000, 22050, 88200, 96000])
def test_uncrush_mix_one_whole_output_aligned_with_input(tmp_path, sr):
    """Even at mix=1 (fully wet, no crossfade at all) the render must not
    silently come out ~25ms late relative to the input -- the exact bug
    this whole item is about, independent of the flam.

    Tolerance here (<=10 samples, <=0.45ms at the lowest rate tested)
    accounts for the equalizer and aexciter stages own small,
    amplitude-independent (verified: identical shift at impulse amplitudes
    1.0, 0.1, 0.05, 0.01, i.e. linear, not a nonlinear exciter artifact)
    few-sample ringing on a delta impulse -- measured up to 7 samples at
    22050 Hz, utterly inaudible and unrelated to afftdn's ~1100-sample
    delay, which this test exists to catch (and which this tolerance is
    still >100x smaller than).
    """
    idx = sr // 2
    y = np.zeros(sr, dtype=np.float32)
    y[idx] = 1.0
    src = tmp_path / "in.wav"
    sf.write(str(src), y, sr, subtype="FLOAT")
    out = tmp_path / "out.wav"
    asyncio.run(_uncrush(src, out, {"strength": 0.8, "mix": 1.0}))
    data, _ = sf.read(str(out), dtype="float32")
    peak_idx = int(np.argmax(np.abs(data)))
    assert abs(peak_idx - idx) <= 10


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
@pytest.mark.parametrize("sr", [44100, 48000, 22050, 88200, 96000])
def test_neural_denoise_output_aligned_with_input(tmp_path, sr):
    """neural_denoise has no mix knob (always fully processed) -- its
    whole output must still line up sample-for-sample with the input."""
    idx = sr // 2
    y = np.zeros(sr, dtype=np.float32)
    y[idx] = 1.0
    src = tmp_path / "in.wav"
    sf.write(str(src), y, sr, subtype="FLOAT")
    out = tmp_path / "out.wav"
    asyncio.run(_neural_denoise(src, out, {"amount": 0.5}))
    data, _ = sf.read(str(out), dtype="float32")
    peak_idx = int(np.argmax(np.abs(data)))
    assert peak_idx == idx


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
@pytest.mark.parametrize("sr", [44100, 48000, 22050, 88200, 96000])
def test_dereverb_output_aligned_with_input(tmp_path, sr):
    idx = sr // 2
    y = np.zeros(sr, dtype=np.float32)
    y[idx] = 1.0
    src = tmp_path / "in.wav"
    sf.write(str(src), y, sr, subtype="FLOAT")
    out = tmp_path / "out.wav"
    asyncio.run(_dereverb(src, out, {"dryWet": 0.5}))
    data, _ = sf.read(str(out), dtype="float32")
    peak_idx = int(np.argmax(np.abs(data)))
    assert peak_idx == idx


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
@pytest.mark.parametrize("sr", [44100, 48000, 88200, 96000])
def test_restore_all_output_aligned_at_source_rate(tmp_path, sr):
    """restore_all ends its chain in loudnorm, which only operates at
    192 kHz -- ffmpeg silently inserts an implicit resampler before it and
    its output stays at 192 kHz. atrim executed straight after loudnorm
    (T12f) counted 192 kHz samples while `delay` was computed in
    source-rate samples, correcting only a fraction of the real shift and
    leaving output at 192 kHz. This asserts the ABSOLUTE impulse position
    (not just a differential vs. an unfixed baseline, which passes at ANY
    correction fraction) AND the output sample rate.
    """
    idx = sr // 2
    y = np.zeros(sr, dtype=np.float32)
    y[idx] = 1.0
    src = tmp_path / "in.wav"
    sf.write(str(src), y, sr, subtype="FLOAT")

    from backend.modules.restoration.router import _restore_all

    out = tmp_path / "out.wav"
    asyncio.run(_restore_all(src, out, {"strength": 0.5}))
    data, out_sr = sf.read(str(out), dtype="float32")
    assert out_sr == sr
    peak_idx = int(np.argmax(np.abs(data)))
    assert peak_idx == idx


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
@pytest.mark.parametrize("sr", [44100, 48000, 88200, 96000])
@pytest.mark.parametrize("denoise", [0.0, 0.5])
def test_studio_enhance_output_aligned_at_source_rate(tmp_path, sr, denoise):
    """Same loudnorm-implicit-192kHz-resample bug and fix as
    test_restore_all_output_aligned_at_source_rate, for studio_enhance.

    Parametrized over denoise too: the ``not has_denoise`` early return
    (denoise=0, the ToolSpec's own declared minimum — a reachable knob
    position, not an edge case) hits loudnorm exactly the same way and
    initially got missed by the T12g fix, which only resampled inside the
    has_denoise branch.
    """
    idx = sr // 2
    y = np.zeros(sr, dtype=np.float32)
    y[idx] = 1.0
    src = tmp_path / "in.wav"
    sf.write(str(src), y, sr, subtype="FLOAT")
    out = tmp_path / "out.wav"
    asyncio.run(_studio_enhance(src, out, {"enhance": 0.0, "denoise": denoise}))
    data, out_sr = sf.read(str(out), dtype="float32")
    assert out_sr == sr
    peak_idx = int(np.argmax(np.abs(data)))
    assert peak_idx == idx


# ---------------------------------------------------------------------------
# T12g item 3 - the head-trim shrinks the output by `delay` samples relative
# to the input, silently dropping the LAST `delay` samples of real tail
# content (afftdn never gets to flush them). apad=pad_len={delay} before the
# afftdn stage fixes it.
# ---------------------------------------------------------------------------


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
def test_neural_denoise_preserves_impulse_near_end(tmp_path):
    sr = SR
    idx = sr - 300
    y = np.zeros(sr, dtype=np.float32)
    y[idx] = 1.0
    src = tmp_path / "in.wav"
    sf.write(str(src), y, sr, subtype="FLOAT")
    out = tmp_path / "out.wav"
    asyncio.run(_neural_denoise(src, out, {"amount": 0.5}))
    data, _ = sf.read(str(out), dtype="float32")
    peak_idx = int(np.argmax(np.abs(data)))
    peak_val = float(np.max(np.abs(data)))
    assert peak_val > 0.5, (
        f"impulse near the end was lost (peak={peak_val}, at index "
        f"{peak_idx} vs. expected {idx}) -- the tail-truncation bug "
        "apad=pad_len fixes"
    )
    assert peak_idx == idx


# ---------------------------------------------------------------------------
# T12g item 4 - neural_codec never applied ffmpeg_pcm_args(probe_depth(...)),
# so 24-bit/32-bit/float sources all came back 16-bit, on every path
# including mix<=0.
# ---------------------------------------------------------------------------


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
@pytest.mark.parametrize("mix", [0.0, 0.5, 1.0])
def test_neural_codec_preserves_float_bit_depth(tmp_path, mix):
    from backend.modules.enhance.router import _neural_codec

    src = _tone(tmp_path / "in.wav")
    assert sf.info(str(src)).subtype == "FLOAT"
    out = tmp_path / "out.wav"
    asyncio.run(_neural_codec(src, out, {"nQuantizers": 9, "mix": mix}))
    assert sf.info(str(out)).subtype == "FLOAT"


# ---------------------------------------------------------------------------
# T12g item 5 - super_res at mix<=0 must be a true dry passthrough: no
# limiter engaging on content that was never boosted by the exciter/treble.
# ---------------------------------------------------------------------------


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
def test_super_res_mix_zero_does_not_clamp_a_legitimate_peak(tmp_path):
    tool = next(t for t in ENHANCE_TOOLS if t.id == "super_res")
    sr = 48000
    t = np.linspace(0, 1, sr, endpoint=False)
    y = (1.0 * np.sin(2 * np.pi * 1000 * t)).astype(np.float32)
    src = tmp_path / "in.wav"
    sf.write(str(src), y, sr, subtype="FLOAT")
    out = tmp_path / "out.wav"
    validated = tool.validate_params({"targetSR": "48000", "guidance": 3.5, "mix": 0.0})
    asyncio.run(ffmpeg.render(src, out, tool.handler(validated)))
    data, _ = sf.read(str(out), dtype="float32")
    assert np.max(np.abs(data)) >= 0.999


# ---------------------------------------------------------------------------
# T12f item 3 - Super-Res mix=1 clipping: the exciter+treble boost measured
# peaks up to ~1.27 (tens of samples over 0 dBFS) on realistic broadband
# content; a pure sine barely moves it, so this must use broadband/noisy
# content to actually exercise the bug.
# ---------------------------------------------------------------------------


def _broadband(path: Path, amp: float, sr: int = SR, seconds: float = 1.0) -> Path:
    rng = np.random.default_rng(3)
    y = (amp * rng.standard_normal(int(sr * seconds))).astype(np.float32)
    sf.write(str(path), y, sr, subtype="FLOAT")
    return path


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
@pytest.mark.parametrize("amp", [0.1, 0.15, 0.2, 0.3, 0.5])
@pytest.mark.parametrize("guidance", [1.0, 3.5, 7.0])
def test_super_res_mix_one_never_clips(tmp_path, amp, guidance):
    tool = next(t for t in ENHANCE_TOOLS if t.id == "super_res")
    src = _broadband(tmp_path / "in.wav", amp)
    out = tmp_path / "out.wav"
    validated = tool.validate_params(
        {"targetSR": "48000", "guidance": guidance, "mix": 1.0}
    )
    asyncio.run(ffmpeg.render(src, out, tool.handler(validated)))
    data, _ = sf.read(str(out), dtype="float32")
    assert np.max(np.abs(data)) <= 1.0


# ---------------------------------------------------------------------------
# T12f item 4 - neural_codec mix=1 must answer the dry input's own sample
# rate, not silently 48k (Opus's own internal decode rate) while mix<1
# answers the dry rate.
# ---------------------------------------------------------------------------


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
def test_neural_codec_mix_one_matches_source_rate(tmp_path):
    tool = next(t for t in ENHANCE_TOOLS if t.id == "neural_codec")
    src = _tone(tmp_path / "in.wav", sr=44100)
    out = tmp_path / "out.wav"
    validated = tool.validate_params({"nQuantizers": 9, "mix": 1.0})
    asyncio.run(tool.handler(src, out, validated))
    _, out_sr = sf.read(str(out), dtype="float32")
    assert out_sr == 44100


# ---------------------------------------------------------------------------
# T12f item 5 - neural_codec's mix<=0 early return must come BEFORE the
# Opus encode, not after (no reason to pay for an encode whose result is
# discarded).
# ---------------------------------------------------------------------------


def test_neural_codec_mix_zero_skips_opus_encode_entirely():
    """AST-based: the mix <= 0.0 check must appear, in source order,
    before any call that encodes to Opus (-c:a / libopus)."""
    from backend.modules.enhance.router import _neural_codec

    src = textwrap.dedent(inspect.getsource(_neural_codec))
    mix_check_pos = src.index("mix <= 0.0")
    opus_encode_pos = src.index("libopus")
    assert mix_check_pos < opus_encode_pos, (
        "the mix<=0 early return must be checked before the Opus encode call, not after"
    )


# ---------------------------------------------------------------------------
# Batch-12 T12 (this ticket) - the seventh-audit findings and the missing
# coverage it named: FIX THESE items 1-7, plus:
#   - super_res / neural_codec had no alignment test at all
#   - no test asserted len(output) == len(input) (the invariant apad/atrim
#     exists to hold; its absence is why item 4's one-sample tail at
#     88.2 kHz went unnoticed)
# ---------------------------------------------------------------------------


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
@pytest.mark.parametrize("sr", [44100, 48000, 22050, 88200, 96000])
def test_afftdn_family_output_length_matches_input(tmp_path, sr):
    """The apad/atrim pair every afftdn-based handler uses exists to hold
    ``len(output) == len(input)`` exactly -- no prior test asserted that
    invariant directly (only impulse position), which is why item 4's
    one-sample tail at 88.2 kHz (loudnorm's implicit 192 kHz round-trip
    does not divide evenly back to 88.2 kHz) went unnoticed."""
    from backend.modules.restoration.router import _restore_all

    n = sr
    y = np.zeros(n, dtype=np.float32)
    y[n // 2] = 1.0
    src = tmp_path / "in.wav"
    sf.write(str(src), y, sr, subtype="FLOAT")

    cases = [
        (_uncrush, {"strength": 0.8, "mix": 1.0}),
        (_studio_enhance, {"enhance": 0.0, "denoise": 0.5}),
        (_neural_denoise, {"amount": 0.5}),
        (_dereverb, {"dryWet": 0.5}),
        (_restore_all, {"strength": 0.5}),
    ]
    for handler, params in cases:
        out = tmp_path / f"out_{handler.__name__}.wav"
        asyncio.run(handler(src, out, params))
        data, _ = sf.read(str(out), dtype="float32")
        assert len(data) == n, (
            f"{handler.__name__} at sr={sr}: output has {len(data)} samples, "
            f"input had {n}"
        )


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
@pytest.mark.parametrize("mix", [0.0, 0.5, 1.0])
def test_super_res_output_aligned_with_input(tmp_path, mix):
    """super_res had no alignment test at all. Measured reference: shift 0
    at mix=0 (pure resample, no exciter/treble ran), shift +2 at mix 0.5
    and 1.0 (small, amplitude-independent exciter/treble ringing on a
    delta impulse -- same order of magnitude as uncrush's measured <=10
    sample tolerance, and utterly inaudible)."""
    tool = next(t for t in ENHANCE_TOOLS if t.id == "super_res")
    sr = 48000
    idx = sr // 2
    y = np.zeros(sr, dtype=np.float32)
    y[idx] = 1.0
    src = tmp_path / "in.wav"
    sf.write(str(src), y, sr, subtype="FLOAT")
    out = tmp_path / "out.wav"
    validated = tool.validate_params({"targetSR": "48000", "guidance": 3.5, "mix": mix})
    asyncio.run(ffmpeg.render(src, out, tool.handler(validated)))
    data, out_sr = sf.read(str(out), dtype="float32")
    assert out_sr == sr
    peak_idx = int(np.argmax(np.abs(data)))
    assert abs(peak_idx - idx) <= 10


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
@pytest.mark.parametrize("mix", [0.0, 0.5, 1.0])
def test_neural_codec_output_aligned_with_input(tmp_path, mix):
    """neural_codec had no alignment test at all. Measured reference: 0
    shift at every mix (dry passthrough, the amix crossfade, and fully
    wet all reformat back to the dry input's own timeline)."""
    from backend.modules.enhance.router import _neural_codec

    sr = 44100
    idx = sr // 2
    y = np.zeros(sr, dtype=np.float32)
    y[idx] = 1.0
    src = tmp_path / "in.wav"
    sf.write(str(src), y, sr, subtype="FLOAT")
    out = tmp_path / "out.wav"
    asyncio.run(_neural_codec(src, out, {"nQuantizers": 9, "mix": mix}))
    data, out_sr = sf.read(str(out), dtype="float32")
    assert out_sr == sr
    peak_idx = int(np.argmax(np.abs(data)))
    assert peak_idx == idx


# ---------------------------------------------------------------------------
# FIX 1 - effects family's ``denoise`` (afftdn, no delay compensation).
# ---------------------------------------------------------------------------


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
def test_effects_denoise_output_aligned_with_input(tmp_path):
    """The effects family's ``denoise`` effect is afftdn with no delay
    compensation -- the same bug already fixed in enhance/restoration.
    Measured before this fix: input 44.1 kHz, impulse at 22050, output
    impulse at 23152 (+1102 samples = 24.99 ms late)."""
    sr = 44100
    idx = sr // 2
    y = np.zeros(sr, dtype=np.float32)
    y[idx] = 1.0
    src = tmp_path / "in.wav"
    sf.write(str(src), y, sr, subtype="FLOAT")
    out = tmp_path / "out.wav"
    filter_args = _build_filter("denoise", {"noiseReduction": 12.0}, "wav", sr)
    asyncio.run(ffmpeg.render(src, out, filter_args))
    data, out_sr = sf.read(str(out), dtype="float32")
    assert out_sr == sr
    peak_idx = int(np.argmax(np.abs(data)))
    assert peak_idx == idx


def test_effects_afftdn_delay_samples_matches_other_families():
    """The effects family's own copy of the formula must agree with
    enhance's and restoration's (see ``_afftdn_delay_samples``'s docstring
    for the derivation)."""
    measured = {44100: 1102, 48000: 1200, 22050: 550}
    for sr, expected in measured.items():
        assert _effects_afftdn_delay_samples(sr) == expected
        assert _enhance_afftdn_delay_samples(sr) == expected


# ---------------------------------------------------------------------------
# FIX 2 - every loudnorm chain outside enhance/restoration must resample
# back to the source rate (loudnorm only operates at 192 kHz internally).
# ---------------------------------------------------------------------------


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
@pytest.mark.parametrize(
    "effect,params",
    [
        (
            "mastering_chain",
            {
                "lowBoost": 0.0,
                "highBoost": 0.0,
                "limiterCeiling": 0.95,
                "targetLUFS": -14.0,
            },
        ),
        (
            "vocal_processing",
            {"highpassFreq": 80.0, "presenceBoost": 2.0, "targetLUFS": -16.0},
        ),
        ("loudnorm", {"targetLUFS": -16.0, "truePeak": -1.0}),
    ],
)
@pytest.mark.parametrize("sr", [44100, 48000, 88200, 96000])
def test_effects_loudnorm_chains_stay_at_source_rate(tmp_path, effect, params, sr):
    """Measured before this fix: all three effects came back at 192000 Hz
    (ffmpeg's loudnorm-implicit resample) regardless of the source rate --
    a sample-rate artifact rather than any real duration change (duration
    stayed 3.000s throughout). Parametrized over 44.1/48/88.2/96 kHz since
    the earlier version of this test only ever measured 44100."""
    seconds = 3.0
    n = int(sr * seconds)
    y = (
        0.3 * np.sin(2 * np.pi * 440 * np.linspace(0, seconds, n, endpoint=False))
    ).astype(np.float32)
    src = tmp_path / "in.wav"
    sf.write(str(src), y, sr, subtype="FLOAT")
    out = tmp_path / "out.wav"
    filter_args = _build_filter(effect, params, "wav", sr)
    asyncio.run(ffmpeg.render(src, out, filter_args))
    data, out_sr = sf.read(str(out), dtype="float32")
    assert out_sr == sr
    assert abs(len(data) / out_sr - seconds) < 0.01


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
@pytest.mark.parametrize("sr", [44100, 48000, 88200, 96000])
def test_mastering_maximizer_and_loudness_meter_stay_at_source_rate(tmp_path, sr):
    """Measured before this fix: both ``_maximizer`` and ``_loudness_meter``
    returned sr=192000, n=576000 for a 3.000 s 44.1 kHz source (duration
    preserved, sample ratio 4.3537 -- a sample-rate artifact of loudnorm's
    implicit resample, not a real 4.36x length change). Parametrized over
    44.1/48/88.2/96 kHz since the earlier version of this test only ever
    measured 44100."""
    seconds = 3.0
    n = int(sr * seconds)
    y = (
        0.3 * np.sin(2 * np.pi * 440 * np.linspace(0, seconds, n, endpoint=False))
    ).astype(np.float32)
    src = tmp_path / "in.wav"
    sf.write(str(src), y, sr, subtype="FLOAT")

    max_tool = next(t for t in MASTERING_TOOLS if t.id == "maximizer")
    lm_tool = next(t for t in MASTERING_TOOLS if t.id == "loudness_meter")

    out1 = tmp_path / "max.wav"
    asyncio.run(
        _maximizer(
            src,
            out1,
            max_tool.validate_params(
                {
                    "targetLUFS": -14.0,
                    "targetLRA": 9.0,
                    "ceiling": -1.0,
                    "attack": 5.0,
                    "release": 50.0,
                }
            ),
        )
    )
    data1, sr1 = sf.read(str(out1), dtype="float32")
    assert sr1 == sr
    assert len(data1) == n

    out2 = tmp_path / "lm.wav"
    asyncio.run(
        _loudness_meter(
            src,
            out2,
            lm_tool.validate_params(
                {"targetLUFS": -16.0, "targetLRA": 9.0, "ceiling": -1.0}
            ),
        )
    )
    data2, sr2 = sf.read(str(out2), dtype="float32")
    assert sr2 == sr
    assert len(data2) == n


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
@pytest.mark.parametrize("sr", [44100, 48000, 88200, 96000])
@pytest.mark.parametrize(
    "in_subtype,out_depth_bits,out_is_float",
    [("FLOAT", 32, True), ("PCM_24", 24, False)],
)
def test_mastering_master_assistant_stays_at_source_rate_and_depth(
    tmp_path, sr, in_subtype, out_depth_bits, out_is_float
):
    """FINDING 1 -- the flagship AI Master Assistant is a sixth loudnorm
    chain missing both fixes ``_maximizer``/``_loudness_meter`` already
    have. Measured before this fix: a 24-bit 96 kHz source came back
    16-bit 192 kHz -- a bit-depth REDUCTION from a mastering tool."""
    from backend.lib.audio_depth import probe_depth
    from backend.modules.mastering.router import _master_assistant

    seconds = 3.0
    n = int(sr * seconds)
    y = (
        0.3 * np.sin(2 * np.pi * 440 * np.linspace(0, seconds, n, endpoint=False))
    ).astype(np.float32)
    src = tmp_path / "in.wav"
    sf.write(str(src), y, sr, subtype=in_subtype)

    ma_tool = next(t for t in MASTERING_TOOLS if t.id == "master_assistant")
    out = tmp_path / "out.wav"
    asyncio.run(
        _master_assistant(
            src,
            out,
            ma_tool.validate_params(
                {"style": "balanced", "intensity": 50.0, "targetLUFS": -14.0}
            ),
        )
    )
    data, out_sr = sf.read(str(out), dtype="float32")
    assert out_sr == sr
    assert len(data) == n
    out_depth = probe_depth(out)
    assert out_depth.bits == out_depth_bits
    assert out_depth.is_float == out_is_float


# ---------------------------------------------------------------------------
# FIX 3 - process-mode handlers own their render call, so
# ``_maximizer``/``_loudness_meter`` must apply
# ``ffmpeg_pcm_args(probe_depth(inp), ...)`` themselves.
# ---------------------------------------------------------------------------


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
def test_mastering_maximizer_and_loudness_meter_preserve_float_depth(tmp_path):
    """Measured before this fix: a pcm_f32le 44100 source came back
    pcm_s16le from both handlers (bit-depth silently narrowed)."""
    src = _tone(tmp_path / "in.wav")
    assert sf.info(str(src)).subtype == "FLOAT"

    max_tool = next(t for t in MASTERING_TOOLS if t.id == "maximizer")
    lm_tool = next(t for t in MASTERING_TOOLS if t.id == "loudness_meter")

    out1 = tmp_path / "max.wav"
    asyncio.run(
        _maximizer(
            src,
            out1,
            max_tool.validate_params(
                {
                    "targetLUFS": -14.0,
                    "targetLRA": 9.0,
                    "ceiling": -1.0,
                    "attack": 5.0,
                    "release": 50.0,
                }
            ),
        )
    )
    assert sf.info(str(out1)).subtype == "FLOAT"

    out2 = tmp_path / "lm.wav"
    asyncio.run(
        _loudness_meter(
            src,
            out2,
            lm_tool.validate_params(
                {"targetLUFS": -16.0, "targetLRA": 9.0, "ceiling": -1.0}
            ),
        )
    )
    assert sf.info(str(out2)).subtype == "FLOAT"


# ---------------------------------------------------------------------------
# T12 polish item 1 - ``_maximizer``'s ``alimiter`` omitted ``latency=true``,
# shifting its output by exactly the limiter's lookahead. Measured before
# this fix by impulse: +220 samples (4.99ms) at 44.1kHz, +240 (5.00ms) at
# 48kHz, +441 (5.00ms) at 88.2kHz, +480 (5.00ms) at 96kHz. ``_super_res``
# (enhance:308) and ``_uncrush`` (enhance:367) already pass
# ``latency=true`` on the identical ``alimiter`` filter; this brings
# mastering's maximizer in line.
# ---------------------------------------------------------------------------


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
@pytest.mark.parametrize("sr", [44100, 48000, 88200, 96000])
def test_maximizer_alimiter_latency_true_zero_shift(tmp_path, sr):
    """Before this fix the impulse peak landed ~5ms late at every rate
    tested (the alimiter's own lookahead, uncompensated). With
    ``latency=true`` the shift must be exactly 0 samples."""
    idx = sr // 2
    y = np.zeros(sr, dtype=np.float32)
    y[idx] = 1.0
    src = tmp_path / "in.wav"
    sf.write(str(src), y, sr, subtype="FLOAT")

    max_tool = next(t for t in MASTERING_TOOLS if t.id == "maximizer")
    out = tmp_path / "out.wav"
    asyncio.run(
        _maximizer(
            src,
            out,
            max_tool.validate_params(
                {
                    "targetLUFS": -14.0,
                    "targetLRA": 9.0,
                    "ceiling": -1.0,
                    "attack": 5.0,
                    "release": 50.0,
                }
            ),
        )
    )
    data, out_sr = sf.read(str(out), dtype="float32")
    assert out_sr == sr
    peak_idx = int(np.argmax(np.abs(data)))
    assert peak_idx == idx


# ---------------------------------------------------------------------------
# FIX 5 - Un-Crush shares ``aexciter`` with Super-Res but had no limiter
# guarding it.
# ---------------------------------------------------------------------------


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
def test_uncrush_mix_one_never_clips(tmp_path):
    """Measured before this fix, on a 0.97-peak broadband source at
    strength=1 mix=1: aexciter alone left peak at exactly 1.0 (clean), but
    the full Un-Crush wet chain pushed it over, hard-clipping thousands of
    samples on an integer-depth source."""
    sr = 44100
    seconds = 1.0
    n = int(sr * seconds)
    rng = np.random.default_rng(3)
    y = (0.97 * rng.standard_normal(n)).astype(np.float32)
    y = y / np.max(np.abs(y)) * 0.97
    src = tmp_path / "in.wav"
    sf.write(str(src), y, sr, subtype="PCM_24")

    out = tmp_path / "out.wav"
    asyncio.run(_uncrush(src, out, {"strength": 1.0, "mix": 1.0}))
    data, _ = sf.read(str(out), dtype="float32")
    assert np.max(np.abs(data)) <= 1.0
    clipped = int(np.sum(np.abs(data) >= 0.999999))
    assert clipped == 0, f"{clipped} samples hard-clipped"


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
def test_uncrush_partial_mix_filter_complex_never_clips(tmp_path):
    """The mix<1.0 branch builds a ``filter_complex`` graph (not ``-af``)
    -- the previous test only ever exercised mix=1.0's ``-af`` path, so the
    ``filter_complex`` branch's limiter (``[outa]atrim=...,alimiter=...[outt]``,
    ``-map [outt]``) had no test. Measured post-fix at mix=0.5: peak=0.9800,
    over1.0=0, at all four rates -- confirmed here at 44.1 kHz."""
    sr = 44100
    seconds = 1.0
    n = int(sr * seconds)
    rng = np.random.default_rng(3)
    y = (0.97 * rng.standard_normal(n)).astype(np.float32)
    y = y / np.max(np.abs(y)) * 0.97
    src = tmp_path / "in.wav"
    sf.write(str(src), y, sr, subtype="PCM_24")

    out = tmp_path / "out.wav"
    asyncio.run(_uncrush(src, out, {"strength": 1.0, "mix": 0.5}))
    data, _ = sf.read(str(out), dtype="float32")
    assert np.max(np.abs(data)) <= 0.9800 + 1e-4
    over1 = int(np.sum(np.abs(data) > 1.0))
    assert over1 == 0, f"{over1} samples over full scale"


# ---------------------------------------------------------------------------
# FIX 6 - enhance/router.py's module docstring overclaimed: it said Studio
# Enhance compensates the afftdn delay "between the wet/dry branches", but
# Studio Enhance's ToolSpec declares no ``mix`` param and has no wet/dry
# branches at all.
# ---------------------------------------------------------------------------


def test_enhance_module_docstring_scopes_wet_dry_to_uncrush_only():
    import backend.modules.enhance.router as enhance_router

    doc = enhance_router.__doc__
    tool = next(t for t in ENHANCE_TOOLS if t.id == "studio_enhance")
    assert "mix" not in [p.name for p in tool.params]
    assert "Un-Crush additionally compensates it" in doc


# ---------------------------------------------------------------------------
# FIX 7 - a failed sample-rate probe must raise, not silently default to
# 44.1 kHz (a wrong assumed rate shifts afftdn's delay compensation and
# silently drops real tail content).
# ---------------------------------------------------------------------------


def test_enhance_probe_audio_format_raises_on_failed_probe(tmp_path):
    """Tightened from a nonexistent-file + ``pytest.raises(Exception)`` --
    that combination would also pass on an unrelated import error. The
    interesting case is a file that EXISTS but the probe cannot decode."""
    from backend.modules.enhance.router import _probe_audio_format

    undecodable = tmp_path / "garbage.wav"
    undecodable.write_bytes(b"not a real audio file" * 8)
    with pytest.raises(RuntimeError):
        _probe_audio_format(undecodable)


def test_restoration_probe_sample_rate_raises_on_failed_probe(tmp_path):
    """Tightened from a nonexistent-file + ``pytest.raises(Exception)`` --
    that combination would also pass on an unrelated import error. The
    interesting case is a file that EXISTS but the probe cannot decode."""
    from backend.modules.restoration.router import (
        _probe_sample_rate as _restoration_probe,
    )

    undecodable = tmp_path / "garbage.wav"
    undecodable.write_bytes(b"not a real audio file" * 8)
    with pytest.raises(RuntimeError):
        _restoration_probe(undecodable)


# ---------------------------------------------------------------------------
# effects/process endpoint - end-to-end: the reordering that moved filter
# building after the upload is on disk (needed to probe the source rate)
# must not break the unknown-effect 400 path or a normal render.
# ---------------------------------------------------------------------------


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
def test_effects_process_endpoint_denoise_stays_at_source_rate():
    import io
    import json as _json

    app = FastAPI()
    app.include_router(effects_router, prefix="/api/effects")
    client = TestClient(app)

    sr = 44100
    n = sr
    y = (0.3 * np.sin(2 * np.pi * 440 * np.linspace(0, 1, n, endpoint=False))).astype(
        np.float32
    )
    buf = io.BytesIO()
    sf.write(buf, y, sr, format="WAV", subtype="FLOAT")
    buf.seek(0)

    resp = client.post(
        "/api/effects/process",
        files={"audio": ("in.wav", buf, "audio/wav")},
        data={
            "effect": "denoise",
            "params": _json.dumps({"noiseReduction": 12.0}),
            "output_format": "wav",
        },
    )
    assert resp.status_code == 200
    data, out_sr = sf.read(io.BytesIO(resp.content), dtype="float32")
    assert out_sr == sr
    assert len(data) == n


def test_effects_process_endpoint_unknown_effect_still_400():
    import io

    app = FastAPI()
    app.include_router(effects_router, prefix="/api/effects")
    client = TestClient(app)

    y = np.zeros(44100, dtype=np.float32)
    buf = io.BytesIO()
    sf.write(buf, y, 44100, format="WAV", subtype="FLOAT")
    buf.seek(0)

    resp = client.post(
        "/api/effects/process",
        files={"audio": ("in.wav", buf, "audio/wav")},
        data={"effect": "not_a_real_effect", "params": "{}", "output_format": "wav"},
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# FINDING 2 - the unguarded ``sf.info``/``sf.read`` calls added for the
# source-rate/frame-count fixes above 500 on upload formats the app itself
# advertises (m4a/aac/wma): libsndfile 1.2.2 raises ``LibsndfileError:
# Format not recognised`` on them even though ffprobe decodes them fine.
# ---------------------------------------------------------------------------


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
def test_source_rate_and_frame_count_fall_back_for_libsndfile_unreadable_upload(
    tmp_path,
):
    """Repro: an AAC file posted with a .wav extension -- exactly what the
    upload flow hands these helpers when a browser advertises audio/* and
    the user picks an m4a/aac/wma file. Before this fix, ``_maximizer``/
    ``_loudness_meter``/``_master_assistant`` (mastering) and both
    enhance's and restoration's ``_render_with_source_rate`` 500'd here."""
    import subprocess

    from backend.lib.launch_token import child_env

    sr = 44100
    seconds = 2.0
    aac_as_wav = tmp_path / "input.wav"
    subprocess.run(
        [
            ffmpeg_tools.ffmpeg_exe(),
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=440:duration={seconds}:sample_rate={sr}",
            "-c:a",
            "aac",
            "-f",
            "adts",
            str(aac_as_wav),
        ],
        check=True,
        capture_output=True,
        env=child_env(),
    )
    # Confirms this really is the libsndfile-unreadable repro from the finding.
    with pytest.raises(Exception):
        sf.info(str(aac_as_wav))

    from backend.modules.enhance.router import (
        _decoded_frame_count as _enhance_decoded_frame_count,
    )
    from backend.modules.enhance.router import _frame_count as _enhance_frame_count
    from backend.modules.mastering.router import _source_samplerate
    from backend.modules.restoration.router import (
        _decoded_frame_count as _restoration_decoded_frame_count,
    )
    from backend.modules.restoration.router import (
        _frame_count as _restoration_frame_count,
    )

    # T12k regression: `round(duration * sample_rate)` is NOT the decoded
    # frame count (container duration excludes AAC's encoder priming
    # delay) -- both helpers must match the actual decode exactly, not
    # just land within some tolerance of the duration-based estimate.
    decoded_n = _enhance_decoded_frame_count(aac_as_wav)
    assert decoded_n is not None
    assert decoded_n == _restoration_decoded_frame_count(aac_as_wav)
    assert _source_samplerate(aac_as_wav) == sr
    assert _enhance_frame_count(aac_as_wav, sr) == decoded_n
    assert _restoration_frame_count(aac_as_wav, sr) == decoded_n


# ---------------------------------------------------------------------------
# T12k FINDING 1 - `_frame_count`'s ffprobe-duration fallback (used when
# libsndfile can't open the container) fed `atrim=...:end_sample=` a
# `round(duration * sample_rate)` estimate that disagrees with the real
# decoded frame count by hundreds of samples (encoder priming/padding is
# not part of container duration) -- silently truncating real audio.
# ---------------------------------------------------------------------------


def _make_codec_as_wav(
    tmp_path: Path, codec: str, sr: int, seconds: float = 2.0
) -> Path:
    """Encode a sine through ``codec`` and save it with a ``.wav``
    extension -- exactly what the upload flow hands these helpers when a
    browser advertises audio/* and the user picks an m4a/aac/wma file."""
    import subprocess

    from backend.lib.launch_token import child_env

    out = tmp_path / f"{codec}_{sr}.wav"
    if codec == "aac":
        codec_args = ["-c:a", "aac", "-f", "adts"]
    elif codec == "m4a":
        codec_args = ["-c:a", "aac", "-f", "mp4"]
    elif codec == "wma":
        codec_args = ["-c:a", "wmav2", "-f", "asf"]
    else:
        raise ValueError(codec)
    subprocess.run(
        [
            ffmpeg_tools.ffmpeg_exe(),
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=440:duration={seconds}:sample_rate={sr}",
            *codec_args,
            str(out),
        ],
        check=True,
        capture_output=True,
        env=child_env(),
    )
    return out


# wmav2 rejects sample rates above 48 kHz ("sample rate is too high: 88200 >
# 48kHz"), so 88.2 kHz is only exercised for m4a/aac, matching the finding's
# own measured table.
_CODEC_RATE_COMBOS = [
    (codec, sr)
    for codec in ("m4a", "aac", "wma")
    for sr in (44100, 48000, 88200)
    if not (codec == "wma" and sr == 88200)
]


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
@pytest.mark.parametrize("codec,sr", _CODEC_RATE_COMBOS)
def test_frame_count_matches_decoded_exactly_across_codecs_and_rates(
    tmp_path, codec, sr
):
    """``_frame_count`` must equal the real decoded sample total, not
    ``round(duration * sample_rate)`` -- for every codec/rate combination
    this app advertises accepting."""
    from backend.modules.enhance.router import (
        _decoded_frame_count as _enhance_decoded_frame_count,
    )
    from backend.modules.enhance.router import _frame_count as _enhance_frame_count
    from backend.modules.restoration.router import (
        _decoded_frame_count as _restoration_decoded_frame_count,
    )
    from backend.modules.restoration.router import (
        _frame_count as _restoration_frame_count,
    )

    src = _make_codec_as_wav(tmp_path, codec, sr)
    with pytest.raises(Exception):
        sf.info(str(src))

    decoded_n = _enhance_decoded_frame_count(src)
    assert decoded_n is not None
    assert decoded_n == _restoration_decoded_frame_count(src)
    assert _enhance_frame_count(src, sr) == decoded_n
    assert _restoration_frame_count(src, sr) == decoded_n


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
@pytest.mark.parametrize("codec,sr", _CODEC_RATE_COMBOS)
def test_studio_enhance_and_restore_all_output_length_matches_decoded_exactly(
    tmp_path, codec, sr
):
    """End-to-end: ``studio_enhance``/``restore_all`` (the two chains that
    feed ``atrim=...:end_sample=``) must render exactly ``decoded_in_n``
    samples, not ``decoded_in_n`` minus the up-to-1008-sample truncation
    the duration-based estimate introduced."""
    from backend.modules.enhance.router import (
        _decoded_frame_count as _enhance_decoded_frame_count,
    )
    from backend.modules.enhance.router import _studio_enhance
    from backend.modules.restoration.router import _restore_all

    src = _make_codec_as_wav(tmp_path, codec, sr)
    decoded_in_n = _enhance_decoded_frame_count(src)
    assert decoded_in_n is not None

    enhance_out = tmp_path / f"enhance_out_{codec}_{sr}.wav"
    asyncio.run(_studio_enhance(src, enhance_out, {"enhance": 0.0, "denoise": 0.5}))
    enhance_data, enhance_sr = sf.read(str(enhance_out), dtype="float32")
    assert enhance_sr == sr
    assert len(enhance_data) == decoded_in_n

    restore_out = tmp_path / f"restore_out_{codec}_{sr}.wav"
    asyncio.run(_restore_all(src, restore_out, {"strength": 0.5}))
    restore_data, restore_sr = sf.read(str(restore_out), dtype="float32")
    assert restore_sr == sr
    assert len(restore_data) == decoded_in_n


# ---------------------------------------------------------------------------
# FINDING 3 - the sample-rate probe in effects/router.py was unconditional
# for all 27 effects, and a ``RuntimeError`` from it escaped ``studio_process``
# uncaught (500 'Internal Server Error', no JSON detail). A rate-independent
# effect (e.g. volume) must not depend on ffprobe at all.
# ---------------------------------------------------------------------------


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
def test_effects_process_endpoint_rate_independent_effect_works_without_ffprobe(
    monkeypatch,
):
    import io
    import json as _json

    import backend.modules.analysis.ffprobe as ffprobe_mod

    monkeypatch.setattr(ffprobe_mod.ffmpeg_tools, "find_ffprobe", lambda: None)

    app = FastAPI()
    app.include_router(effects_router, prefix="/api/effects")
    client = TestClient(app)

    y = np.zeros(44100, dtype=np.float32)
    buf = io.BytesIO()
    sf.write(buf, y, 44100, format="WAV", subtype="FLOAT")
    buf.seek(0)

    resp = client.post(
        "/api/effects/process",
        files={"audio": ("in.wav", buf, "audio/wav")},
        data={
            "effect": "volume",
            "params": _json.dumps({"level": 1.0}),
            "output_format": "wav",
        },
    )
    assert resp.status_code == 200


@pytest.mark.skipif(ffmpeg_tools.find_ffmpeg() is None, reason="no ffmpeg found")
def test_effects_process_endpoint_rate_dependent_effect_500_has_json_detail_without_ffprobe(
    monkeypatch,
):
    """The error SHAPE regression: a probe ``RuntimeError`` must come back
    as ``HTTPException`` (JSON ``{"detail": ...}``), not escape uncaught to
    Starlette's generic 500 'Internal Server Error' plain-text response."""
    import io
    import json as _json

    import backend.modules.analysis.ffprobe as ffprobe_mod

    monkeypatch.setattr(ffprobe_mod.ffmpeg_tools, "find_ffprobe", lambda: None)

    app = FastAPI()
    app.include_router(effects_router, prefix="/api/effects")
    client = TestClient(app)

    y = np.zeros(44100, dtype=np.float32)
    buf = io.BytesIO()
    sf.write(buf, y, 44100, format="WAV", subtype="FLOAT")
    buf.seek(0)

    resp = client.post(
        "/api/effects/process",
        files={"audio": ("in.wav", buf, "audio/wav")},
        data={
            "effect": "denoise",
            "params": _json.dumps({"noiseReduction": 12.0}),
            "output_format": "wav",
        },
    )
    assert resp.status_code == 500
    assert "detail" in resp.json()


# ---------------------------------------------------------------------------
# T12 polish item 2 - mastering/router.py's ``_guarded_sf_read`` and
# audio_analysis.py's ``_read_audio_guarded`` ran their ffmpeg decode
# fallback with ``check=True, capture_output=True`` and let the resulting
# ``CalledProcessError`` propagate straight up: its ``__str__`` is the full
# argv (the internal decode tempdir's ``decoded.wav`` output path, plus
# every ffmpeg flag) with no ffmpeg reason at all. Now both catch it and
# raise ``ffmpeg.FFmpegError`` (matching ``module_base.py``'s own
# ``except ffmpeg.FFmpegError`` / ``ffmpeg error: {e.stderr[-400:]}``
# handling) so the real ffmpeg reason survives and neither the internal
# decode tempdir nor the full command line does. (ffmpeg's own stderr
# naturally names the SOURCE file it failed to open -- that is expected
# and not what this finding is about; the leak was the fallback's own
# ``['ffmpeg', ..., 'C:\\...\\tmp...\\decoded.wav']`` argv reproduction.)
# ---------------------------------------------------------------------------


def _undecodable_file(tmp_path: Path) -> Path:
    """A file libsndfile AND ffmpeg both refuse -- garbage bytes with a
    ``.wav`` extension, so the fallback path is actually exercised and
    itself fails."""
    bad = tmp_path / "bad.wav"
    bad.write_bytes(b"this is not a real audio file, just garbage bytes\x00\x01\x02")
    return bad


def test_mastering_guarded_sf_read_error_has_ffmpeg_reason_not_argv(tmp_path):
    from backend.lib import ffmpeg
    from backend.modules.mastering.router import _guarded_sf_read

    bad = _undecodable_file(tmp_path)
    with pytest.raises(ffmpeg.FFmpegError) as excinfo:
        _guarded_sf_read(bad, always_2d=True)
    detail = str(excinfo.value)
    assert "invalid data" in detail.lower()
    assert "decoded.wav" not in detail
    assert "['ffmpeg'" not in detail
    assert "-c:a" not in detail
    assert "pcm_f32le" not in detail


def test_audio_analysis_read_audio_guarded_error_has_ffmpeg_reason_not_argv(tmp_path):
    from backend.lib import ffmpeg
    from backend.lib.audio_analysis import _read_audio_guarded

    bad = _undecodable_file(tmp_path)
    with pytest.raises(ffmpeg.FFmpegError) as excinfo:
        _read_audio_guarded(bad, always_2d=True)
    detail = str(excinfo.value)
    assert "invalid data" in detail.lower()
    assert "decoded.wav" not in detail
    assert "['ffmpeg'" not in detail
    assert "-c:a" not in detail
    assert "pcm_f32le" not in detail
