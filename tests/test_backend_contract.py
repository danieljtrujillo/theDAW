import base64
import json

from stable_audio_3 import AutoencoderModel, StableAudioModel
from backend.server import (
    GENERATION_MODELS,
    SPECTROGRAM_TYPES,
    _coerce_form_bool,
    _condense_filename_text,
    _extract_lora_form_slots,
    _get_generation_artifacts_root,
    _make_generation_filename,
    _safe_filename,
    _normalize_init_audio_type,
    _normalize_generation_model,
    _save_generation_artifacts,
    _validate_init_audio_mode,
)
from fastapi import HTTPException
import pytest


class _FakeUpload:
    def __init__(self, filename: str):
        self.filename = filename


class _FakeForm:
    def __init__(self, values):
        self._values = values

    def multi_items(self):
        return self._values.items()

    def get(self, key, default=None):
        return self._values.get(key, default)


def test_public_model_exports_are_available():
    assert hasattr(StableAudioModel, "from_pretrained")
    assert hasattr(AutoencoderModel, "from_pretrained")


def test_generation_model_normalization():
    assert "small" in GENERATION_MODELS
    assert "medium-rf" in GENERATION_MODELS
    assert _normalize_generation_model("small") == "small"
    assert _normalize_generation_model("SMALL-RF") == "small-rf"
    assert _normalize_generation_model("") == "medium"
    assert _normalize_generation_model("same-l") == "medium"


def test_lora_form_slots_are_ordered_and_weighted():
    form = _FakeForm(
        {
            "lora_file_1": _FakeUpload("detail.safetensors"),
            "lora_weight_1": "0.25",
            "lora_file_0": _FakeUpload("style.safetensors"),
            "lora_weight_0": "0.75",
            "lora_file_bad": _FakeUpload("ignored.safetensors"),
        }
    )

    slots = _extract_lora_form_slots(form)

    assert [(slot.index, slot.upload.filename, slot.weight) for slot in slots] == [
        (0, "style.safetensors", 0.75),
        (1, "detail.safetensors", 0.25),
    ]


def test_bool_form_coercion():
    assert _coerce_form_bool("true") is True
    assert _coerce_form_bool("1") is True
    assert _coerce_form_bool("yes") is True
    assert _coerce_form_bool("false") is False
    assert _coerce_form_bool("0") is False
    assert _coerce_form_bool(False) is False


def test_rf_inversion_is_reported_as_unsupported_until_pipeline_support_exists():
    assert _normalize_init_audio_type("RF-Inv") == "RF-Inversion"
    with pytest.raises(HTTPException) as exc:
        _validate_init_audio_mode("RF-Inversion", has_init_audio=True)

    assert exc.value.status_code == 501
    assert "RF-Inversion" in exc.value.detail


def test_generation_filename_modes_are_sanitized():
    assert (
        _make_generation_filename("abc12345", 0, "wav", "seed", "bad/name", "neg", 123)
        == "seed_123_0.wav"
    )
    assert (
        _make_generation_filename(
            "abc12345", 1, "flac", "prompt", "bad/name", "neg", -1
        )
        == "bad-name_1.flac"
    )
    verbose = _make_generation_filename(
        "abc12345", 0, "ogg", "verbose", "kick: loop", "vocals", 42
    )
    assert verbose == "kick- loop.neg-vocals.42_0.ogg"


def test_generation_filename_strips_control_characters_and_reserved_names():
    raw_prompt = "{\r\n -action- -create-,\r\n -genre- -[trap-"
    filename = _make_generation_filename(
        "abc12345", 0, "wav", "prompt", raw_prompt, None, -1
    )

    assert "\r" not in filename
    assert "\n" not in filename
    assert filename == "action- -create- -genre- -trap_0.wav"
    assert _condense_filename_text("CON") == "CON_"
    assert _safe_filename("bad\r\nname.wav") == "bad-name.wav"


def test_generation_artifacts_save_audio_spectrograms_and_metadata(
    tmp_path, monkeypatch
):
    monkeypatch.setenv("STABLEDAW_GENERATIONS_DIR", str(tmp_path))
    png_payload = base64.b64encode(b"fake-png-bytes").decode("ascii")

    saved = _save_generation_artifacts(
        job_id="job-123",
        index=2,
        audio_bytes=b"fake-audio-bytes",
        audio_filename="bad/name.wav",
        mime_type="audio/wav",
        spectrograms={name: png_payload for name in SPECTROGRAM_TYPES},
        metadata={"seed": 123, "prompt": "kick loop"},
    )

    root = _get_generation_artifacts_root()
    assert root == tmp_path
    assert saved["artifact_dir"] == str(tmp_path / "job-123" / "02")
    assert (
        tmp_path / "job-123" / "02" / "bad-name.wav"
    ).read_bytes() == b"fake-audio-bytes"

    for name in SPECTROGRAM_TYPES:
        spec_path = tmp_path / "job-123" / "02" / f"spectrogram_{name}.png"
        assert spec_path.read_bytes() == b"fake-png-bytes"
        assert saved["spectrogram_paths"][name] == str(spec_path)

    metadata = json.loads((tmp_path / "job-123" / "02" / "metadata.json").read_text())
    assert metadata["job_id"] == "job-123"
    assert metadata["index"] == 2
    assert metadata["filename"] == "bad-name.wav"
    assert metadata["seed"] == 123
    assert metadata["prompt"] == "kick loop"
