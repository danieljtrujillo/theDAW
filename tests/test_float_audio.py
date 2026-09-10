"""32-bit float audio, end to end.

Every fixture here is a ramp from -1.5 to +1.5, so a path that quietly
requantizes or clamps says so out loud: a 16-bit write pins the peak at ±1.0,
and a float write does not. The assertions are all "did the over survive",
because that is the one property the whole float-intake question turns on.

No model weights and no GPU — this runs anywhere the backend imports.
"""

from __future__ import annotations

import asyncio
import io
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from backend.lib.audio_depth import (
    UNKNOWN_DEPTH,
    PcmDepth,
    browser_can_decode,
    browser_pcm_args,
    ffmpeg_pcm_args,
    probe_depth,
    sf_subtype,
    widest,
    write_like_source,
)

PEAK = 1.5
SR = 44100


def _ramp(frames: int = 4096, channels: int = 2) -> np.ndarray:
    """A -1.5 → +1.5 ramp. Endpoints are exact in float32 and float64."""
    one = np.linspace(-PEAK, PEAK, frames, dtype=np.float64)
    return np.column_stack([one] * channels) if channels > 1 else one


def _write_fixture(path: Path, subtype: str, channels: int = 2) -> Path:
    sf.write(str(path), _ramp(channels=channels), SR, subtype=subtype)
    return path


def _peak_of(path: Path) -> float:
    data, _ = sf.read(str(path), always_2d=True, dtype="float64")
    return float(np.max(np.abs(data)))


# ---------------------------------------------------------------------------
# The premises this whole module rests on
# ---------------------------------------------------------------------------


def test_soundfile_wav_default_is_still_pcm16():
    """The reason backend/lib/audio_depth.py exists.

    If libsndfile ever changes this default, the explicit subtypes scattered
    across the write sites become belt-and-braces rather than load-bearing —
    worth knowing rather than discovering.
    """
    assert sf.default_subtype("WAV") == "PCM_16"


def test_pcm16_write_destroys_the_over(tmp_path: Path):
    p = _write_fixture(tmp_path / "flat.wav", "PCM_16")
    assert sf.info(str(p)).subtype == "PCM_16"
    assert _peak_of(p) <= 1.0


def test_float_write_keeps_the_over(tmp_path: Path):
    p = _write_fixture(tmp_path / "wide.wav", "FLOAT")
    assert sf.info(str(p)).subtype == "FLOAT"
    assert _peak_of(p) == pytest.approx(PEAK, abs=1e-6)


# ---------------------------------------------------------------------------
# probe_depth
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("subtype", "bits", "is_float"),
    [
        ("FLOAT", 32, True),
        ("DOUBLE", 64, True),
        ("PCM_24", 24, False),
        ("PCM_16", 16, False),
        ("PCM_32", 32, False),
    ],
)
def test_probe_depth_roundtrip(tmp_path: Path, subtype: str, bits: int, is_float: bool):
    p = _write_fixture(tmp_path / f"{subtype.lower()}.wav", subtype)
    depth = probe_depth(p)
    assert (depth.bits, depth.is_float) == (bits, is_float)
    assert depth.known


def test_probe_depth_on_a_missing_file_is_unknown(tmp_path: Path):
    assert probe_depth(tmp_path / "nope.wav") == UNKNOWN_DEPTH


def test_unknown_depth_labels_itself_honestly():
    assert UNKNOWN_DEPTH.label == "unknown"
    assert not UNKNOWN_DEPTH.known
    assert PcmDepth(32, True).label == "32-bit float"
    assert PcmDepth(24, False).label == "24-bit"


# ---------------------------------------------------------------------------
# sf_subtype
# ---------------------------------------------------------------------------


def test_sf_subtype_preserves_wav_depths():
    assert sf_subtype(PcmDepth(32, True), "WAV") == "FLOAT"
    assert sf_subtype(PcmDepth(64, True), "WAV") == "DOUBLE"
    assert sf_subtype(PcmDepth(24, False), "WAV") == "PCM_24"
    assert sf_subtype(PcmDepth(16, False), "WAV") == "PCM_16"
    # 8-bit widens rather than round-tripping the signed/unsigned question.
    assert sf_subtype(PcmDepth(8, False), "WAV") == "PCM_16"


def test_sf_subtype_unknown_source_stays_on_the_old_default():
    assert sf_subtype(UNKNOWN_DEPTH, "WAV") == "PCM_16"


def test_sf_subtype_flac_steps_down_from_float():
    """FLAC cannot carry float. Stepping down beats raising."""
    assert sf.check_format("FLAC", "FLOAT") is False
    assert sf.check_format("FLAC", "PCM_24") is True
    assert sf_subtype(PcmDepth(32, True), "FLAC") == "PCM_24"


def test_sf_subtype_is_none_when_the_container_has_no_pcm_subtype():
    # OGG is Vorbis or Opus and nothing else, so there is nothing to choose.
    assert sf_subtype(PcmDepth(32, True), "OGG") is None


def test_sf_subtype_accepts_an_extension(tmp_path: Path):
    assert sf_subtype(PcmDepth(32, True), ".wav") == "FLOAT"
    assert sf_subtype(PcmDepth(32, True), ".aif") == "FLOAT"


# ---------------------------------------------------------------------------
# the two ffmpeg mappers
# ---------------------------------------------------------------------------


def test_ffmpeg_pcm_args_preserves_the_source():
    assert ffmpeg_pcm_args(PcmDepth(32, True), "wav") == ["-c:a", "pcm_f32le"]
    assert ffmpeg_pcm_args(PcmDepth(64, True), "wav") == ["-c:a", "pcm_f64le"]
    assert ffmpeg_pcm_args(PcmDepth(24, False), "wav") == ["-c:a", "pcm_s24le"]
    assert ffmpeg_pcm_args(PcmDepth(32, False), "wav") == ["-c:a", "pcm_s32le"]
    assert ffmpeg_pcm_args(PcmDepth(16, False), ".wav") == ["-c:a", "pcm_s16le"]


def test_ffmpeg_pcm_args_stays_out_of_the_way():
    # Compressed containers pick their own encoder…
    assert ffmpeg_pcm_args(PcmDepth(32, True), "flac") == []
    assert ffmpeg_pcm_args(PcmDepth(32, True), "mp3") == []
    # …and an unidentified source leaves ffmpeg's own default in place, which
    # is exactly what these call sites did before.
    assert ffmpeg_pcm_args(UNKNOWN_DEPTH, "wav") == []


def test_browser_mapper_caps_at_32_bit_float():
    """Chromium has no pcm_f64le decoder, so the browser leg must not emit one."""
    assert browser_pcm_args(PcmDepth(64, True)) == ["-c:a", "pcm_f32le"]
    assert browser_pcm_args(PcmDepth(32, True)) == ["-c:a", "pcm_f32le"]
    assert browser_pcm_args(PcmDepth(32, False)) == ["-c:a", "pcm_f32le"]
    assert browser_pcm_args(PcmDepth(24, False)) == ["-c:a", "pcm_s24le"]
    assert browser_pcm_args(UNKNOWN_DEPTH) == ["-c:a", "pcm_s16le"]


def test_browser_can_decode_matches_the_mapper():
    assert browser_can_decode(PcmDepth(32, True))
    assert browser_can_decode(PcmDepth(24, False))
    assert browser_can_decode(PcmDepth(16, False))
    assert not browser_can_decode(PcmDepth(64, True))
    assert not browser_can_decode(PcmDepth(32, False))
    # Nothing measured means nothing to act on — serve it and let the browser try.
    assert browser_can_decode(UNKNOWN_DEPTH)


def test_widest_prefers_float_over_an_int_of_the_same_width():
    assert widest(PcmDepth(32, True), PcmDepth(32, False)) == PcmDepth(32, True)
    assert widest(PcmDepth(16, False), PcmDepth(24, False)) == PcmDepth(24, False)
    assert widest(UNKNOWN_DEPTH, PcmDepth(24, False)) == PcmDepth(24, False)


# ---------------------------------------------------------------------------
# write_like_source — the shape every process-mode tool uses
# ---------------------------------------------------------------------------


def test_write_like_source_carries_the_over_through_a_float_source(tmp_path: Path):
    src = _write_fixture(tmp_path / "src.wav", "FLOAT")
    out = tmp_path / "out.wav"
    data, sr = sf.read(str(src), dtype="float32", always_2d=True)
    assert write_like_source(out, data, sr, src) == "FLOAT"
    assert sf.info(str(out)).subtype == "FLOAT"
    assert _peak_of(out) == pytest.approx(PEAK, abs=1e-6)


def test_write_like_source_still_clips_for_an_int_target(tmp_path: Path):
    src = _write_fixture(tmp_path / "src24.wav", "PCM_24")
    out = tmp_path / "out.wav"
    assert write_like_source(out, _ramp(), SR, src) == "PCM_24"
    assert sf.info(str(out)).subtype == "PCM_24"
    assert _peak_of(out) <= 1.0


def test_write_like_source_min_depth_is_a_floor_not_a_target(tmp_path: Path):
    floor = PcmDepth(24, False)
    flat = _write_fixture(tmp_path / "flat.wav", "PCM_16")
    wide = _write_fixture(tmp_path / "wide.wav", "FLOAT")
    assert write_like_source(
        tmp_path / "a.wav", _ramp(), SR, flat, min_depth=floor
    ) == ("PCM_24")
    assert write_like_source(
        tmp_path / "b.wav", _ramp(), SR, wide, min_depth=floor
    ) == ("FLOAT")


# ---------------------------------------------------------------------------
# intake: the decode path the generation endpoints use
# ---------------------------------------------------------------------------


def _decode(audio_bytes: bytes):
    from backend.server import _decode_audio_bytes

    return asyncio.run(_decode_audio_bytes(audio_bytes))


def _fixture_bytes(subtype: str) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, _ramp(), SR, format="WAV", subtype=subtype)
    return buf.getvalue()


@pytest.mark.parametrize("subtype", ["FLOAT", "DOUBLE"])
def test_decode_audio_bytes_preserves_float_overs(subtype: str):
    waveform, sr = _decode(_fixture_bytes(subtype))
    assert sr == SR
    assert waveform.dtype == np.float32
    assert waveform.shape[0] == 2
    assert float(np.max(np.abs(waveform))) == pytest.approx(PEAK, abs=1e-6)


def test_decode_audio_bytes_pcm16_is_already_flat():
    waveform, _ = _decode(_fixture_bytes("PCM_16"))
    assert float(np.max(np.abs(waveform))) <= 1.0


def test_decode_audio_bytes_ffmpeg_fallback_preserves_float_overs(monkeypatch):
    """Force the second branch: libsndfile is tried first, the ffmpeg CLI
    catches — decoding to pcm_f32le, which keeps a true peak above 0 dBFS."""

    def _boom(*_a, **_k):
        raise RuntimeError("soundfile is out of the picture for this test")

    monkeypatch.setattr(sf, "read", _boom)
    waveform, sr = _decode(_fixture_bytes("FLOAT"))
    assert sr == SR
    assert float(np.max(np.abs(waveform))) == pytest.approx(PEAK, abs=1e-6)


# ---------------------------------------------------------------------------
# generated output: PCM_16 by default, float on request
# ---------------------------------------------------------------------------


def test_audio_save_subtype_defaults_to_pcm16():
    from backend.server import _audio_save_subtype

    assert _audio_save_subtype("wav", "16") == "PCM_16"
    # Anything unrecognised means 16 — the documented default never moves.
    assert _audio_save_subtype("wav", "") == "PCM_16"
    assert _audio_save_subtype("wav", "float") == "PCM_16"


def test_audio_save_subtype_maps_the_wider_depths():
    from backend.server import _audio_save_subtype

    assert _audio_save_subtype("wav", "32f") == "FLOAT"
    assert _audio_save_subtype("wav", "24") == "PCM_24"
    # FLAC is lossless but never float, so a wide request lands at 24 there.
    assert _audio_save_subtype("flac", "32f") == "PCM_24"
    assert _audio_save_subtype("flac", "16") == "PCM_16"
    # OGG is Vorbis: no PCM word length at all.
    assert _audio_save_subtype("ogg", "32f") == "VORBIS"


def test_clamp_for_output_only_spares_a_float_wav():
    import torch

    from backend.server import _clamp_for_output

    audio = torch.tensor([[-PEAK, PEAK]], dtype=torch.float32)
    assert float(_clamp_for_output(audio, "wav", "32f").abs().max()) == pytest.approx(
        PEAK
    )
    assert float(_clamp_for_output(audio, "wav", "16").abs().max()) == 1.0
    assert float(_clamp_for_output(audio, "flac", "32f").abs().max()) == 1.0


def test_float_export_survives_the_save_roundtrip():
    """torchaudio.save used to write these; from torchaudio 2.9 it goes through
    torchcodec, which ignores encoding/bits_per_sample and needs FFmpeg's shared
    libraries that no ordinary Windows install has. save_audio writes through
    libsndfile: the float request comes back FLOAT with its overs intact, the
    default comes back PCM_16 clipped."""
    import torch

    from backend.lib.audio_io import save_audio
    from backend.server import _audio_save_subtype

    audio = torch.from_numpy(_ramp(channels=1).astype(np.float32)).unsqueeze(0)

    wide = io.BytesIO()
    save_audio(wide, audio, SR, format="wav", subtype=_audio_save_subtype("wav", "32f"))
    wide.seek(0)
    assert sf.info(wide).subtype == "FLOAT"
    wide.seek(0)
    assert float(np.max(np.abs(sf.read(wide)[0]))) == pytest.approx(PEAK, abs=1e-6)

    flat = io.BytesIO()
    save_audio(flat, audio, SR, format="wav", subtype=_audio_save_subtype("wav", "16"))
    flat.seek(0)
    assert sf.info(flat).subtype == "PCM_16"
    flat.seek(0)
    assert float(np.max(np.abs(sf.read(flat)[0]))) <= 1.0


def test_save_audio_writes_flac_and_ogg_from_a_tensor():
    import torch

    from backend.lib.audio_io import save_audio
    from backend.server import _audio_save_subtype

    audio = torch.from_numpy(_ramp(channels=2).astype(np.float32).T)
    for fmt in ("flac", "ogg"):
        buf = io.BytesIO()
        save_audio(buf, audio, SR, format=fmt, subtype=_audio_save_subtype(fmt, "32f"))
        buf.seek(0)
        info = sf.info(buf)
        assert info.channels == 2 and info.samplerate == SR
    assert sf.info(io.BytesIO(buf.getvalue())).format == "OGG"


# ---------------------------------------------------------------------------
# the render paths, run for real
# ---------------------------------------------------------------------------


def _needs_ffmpeg():
    import shutil

    if shutil.which("ffmpeg") is None:
        pytest.skip("ffmpeg not on PATH")


def test_filter_mode_render_keeps_the_source_depth(tmp_path: Path):
    """An Edit tool asked to filter a float file must not also requantize it.

    ffmpeg's WAV default is pcm_s16le, so before the codec flag reached
    ffmpeg.render every filter-mode tool in the enhance and restoration
    families answered 16-bit whatever it was handed.
    """
    _needs_ffmpeg()
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend.core.module_base import build_router
    from backend.lib.params import ToolSpec

    tool = ToolSpec(
        id="passthrough",
        name="Passthrough",
        family="test",
        mode="filter",
        handler=lambda _params: ["-af", "anull"],
    )
    app = FastAPI()
    app.include_router(build_router("test", [tool]))

    src = _write_fixture(tmp_path / "wide.wav", "FLOAT")
    with TestClient(app) as client:
        res = client.post(
            "/process",
            data={"effect": "passthrough", "output_format": "wav"},
            files={"audio": ("wide.wav", src.read_bytes(), "audio/wav")},
        )
    assert res.status_code == 200, res.text

    out = tmp_path / "rendered.wav"
    out.write_bytes(res.content)
    assert sf.info(str(out)).subtype == "FLOAT"
    assert _peak_of(out) == pytest.approx(PEAK, abs=1e-4)


def test_filter_mode_render_leaves_a_16_bit_source_alone(tmp_path: Path):
    """The other half of the same promise: preserve, never inflate."""
    _needs_ffmpeg()
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend.core.module_base import build_router
    from backend.lib.params import ToolSpec

    tool = ToolSpec(
        id="passthrough",
        name="Passthrough",
        family="test",
        mode="filter",
        handler=lambda _params: ["-af", "anull"],
    )
    app = FastAPI()
    app.include_router(build_router("test", [tool]))

    src = _write_fixture(tmp_path / "flat.wav", "PCM_16")
    with TestClient(app) as client:
        res = client.post(
            "/process",
            data={"effect": "passthrough", "output_format": "wav"},
            files={"audio": ("flat.wav", src.read_bytes(), "audio/wav")},
        )
    assert res.status_code == 200, res.text

    out = tmp_path / "rendered16.wav"
    out.write_bytes(res.content)
    assert sf.info(str(out)).subtype == "PCM_16"


def test_project_transcode_keeps_float_and_caps_at_32(tmp_path: Path):
    """The path a DAW project's linked samples take to reach the timeline.

    It used to hard-code pcm_s16le. Now a float CAF arrives as float — but a
    64-bit source still steps down, because Chromium cannot decode pcm_f64le
    and an undecodable clip is worse than a narrower one.
    """
    _needs_ffmpeg()
    from backend.modules.project.router import _transcode_to_wav

    src = tmp_path / "wide.caf"
    sf.write(str(src), _ramp(), SR, format="CAF", subtype="FLOAT")
    out = asyncio.run(_transcode_to_wav(src))
    assert sf.info(str(out)).subtype == "FLOAT"
    assert _peak_of(out) == pytest.approx(PEAK, abs=1e-4)

    wide = tmp_path / "double.caf"
    sf.write(str(wide), _ramp(), SR, format="CAF", subtype="DOUBLE")
    out64 = asyncio.run(_transcode_to_wav(wide))
    assert sf.info(str(out64)).subtype == "FLOAT"
    assert _peak_of(out64) == pytest.approx(PEAK, abs=1e-4)


def test_restoration_passthrough_no_longer_flattens_a_float_file(tmp_path: Path):
    """The most pointed of the eleven no-subtype writes: a mono file through
    vocal isolation is copied unchanged, and used to come back at 16 bits for
    exactly nothing."""
    from backend.modules.restoration.dsp import vocal_isolate_sync

    src = _write_fixture(tmp_path / "mono.wav", "FLOAT", channels=1)
    out = tmp_path / "out.wav"
    vocal_isolate_sync(src, out, {})
    assert sf.info(str(out)).subtype == "FLOAT"
    assert _peak_of(out) == pytest.approx(PEAK, abs=1e-6)


def test_convert_catalog_offers_a_float_target():
    from backend.modules.convert.router import FORMATS

    assert FORMATS["wav32f"]["args"][-1] == "pcm_f32le"
    # The 16- and 24-bit targets are untouched.
    assert FORMATS["wav"]["args"][-1] == "pcm_s16le"
    assert FORMATS["wav24"]["args"][-1] == "pcm_s24le"


def test_clip_audio_extension_sets_agree_with_the_depth_check():
    from backend.modules.project.router import (
        _AUDIO_EXTS,
        _BROWSER_OK_EXTS,
        _DEPTH_SENSITIVE_EXTS,
        _TRANSCODE_EXTS,
    )

    # W64 and RF64 are what 32-bit float material spills into past the 4 GB
    # RIFF cap; libsndfile reads both, Chromium reads neither.
    assert {".w64", ".rf64"} <= _TRANSCODE_EXTS
    # Every depth-sensitive extension is one we would otherwise serve raw.
    assert _DEPTH_SENSITIVE_EXTS <= _BROWSER_OK_EXTS
    assert _DEPTH_SENSITIVE_EXTS <= _AUDIO_EXTS
    assert not (_BROWSER_OK_EXTS & _TRANSCODE_EXTS)


def _effects_client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend.modules.effects.router import router

    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def test_studio_effect_keeps_the_source_depth(tmp_path: Path):
    """The MIX-chain FX endpoint builds its own ffmpeg command rather than
    going through module_base, so it needed the same codec flag: every effect
    but the mastering chain used to answer 16-bit."""
    _needs_ffmpeg()
    src = _write_fixture(tmp_path / "wide.wav", "FLOAT")
    with _effects_client() as client:
        res = client.post(
            "/process",
            data={
                "effect": "volume",
                "params": '{"level": 1.0}',
                "output_format": "wav",
            },
            files={"audio": ("wide.wav", src.read_bytes(), "audio/wav")},
        )
    assert res.status_code == 200, res.text
    out = tmp_path / "fx.wav"
    out.write_bytes(res.content)
    assert sf.info(str(out)).subtype == "FLOAT"
    assert _peak_of(out) == pytest.approx(PEAK, abs=1e-4)


def test_mastering_chain_keeps_24_bit_as_a_floor(tmp_path: Path):
    """It wrote pcm_s24le unconditionally before. 24-bit is still the floor —
    a mastered render is a delivery file — but it is a floor, not a ceiling."""
    _needs_ffmpeg()
    from backend.modules.effects.router import MASTERING_FLOOR

    params = (
        '{"lowBoost": 0, "highBoost": 0, "limiterCeiling": 0.99, "targetLUFS": -14}'
    )
    src = _write_fixture(tmp_path / "flat.wav", "PCM_16")
    with _effects_client() as client:
        res = client.post(
            "/process",
            data={
                "effect": "mastering_chain",
                "params": params,
                "output_format": "wav",
            },
            files={"audio": ("flat.wav", src.read_bytes(), "audio/wav")},
        )
    assert res.status_code == 200, res.text
    out = tmp_path / "mastered.wav"
    out.write_bytes(res.content)
    assert sf.info(str(out)).subtype == "PCM_24"
    assert MASTERING_FLOOR == PcmDepth(24, False)
