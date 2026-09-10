"""The T5Gemma cache probe (stable_audio_3.models.conditioners._cached_hub_file).

The hub cache keys files by their path inside the repo. The medium checkpoint
bundles its text encoder in a subfolder, and the old probe asked for the ROOT
config.json — which that repo does not have — so every backend boot logged
"not in the HF cache -> downloading 2 GB now" for files that were on disk.
This lays the cache out exactly as huggingface_hub does and replays both
probes against it: the root one misses, the subfolder one hits.
"""

from pathlib import Path

import huggingface_hub.constants as hf_constants

from stable_audio_3.models.conditioners import _cached_hub_file

REPO = "stabilityai/stable-audio-3-medium"


def _lay_out_cache(root: Path) -> Path:
    repo_dir = root / "models--stabilityai--stable-audio-3-medium"
    snap = repo_dir / "snapshots" / "27b5a21b791b1b033d193a9e1e3ce78493f102f9"
    (snap / "t5gemma-b-b-ul2").mkdir(parents=True)
    (snap / "t5gemma-b-b-ul2" / "config.json").write_text("{}", encoding="utf-8")
    (snap / "model_config.json").write_text("{}", encoding="utf-8")
    (repo_dir / "refs").mkdir()
    (repo_dir / "refs" / "main").write_text(snap.name, encoding="utf-8")
    return snap


def test_the_subfolder_probe_finds_what_the_root_probe_missed(
    tmp_path: Path, monkeypatch
):
    snap = _lay_out_cache(tmp_path)
    monkeypatch.setattr(hf_constants, "HF_HUB_CACHE", str(tmp_path))

    root_probe = _cached_hub_file(REPO, None, "config.json")
    assert not isinstance(root_probe, str), (
        "the medium repo has no root config.json — this is the old miss"
    )

    hit = _cached_hub_file(REPO, "t5gemma-b-b-ul2", "config.json")
    assert isinstance(hit, str)
    assert Path(hit).resolve() == (snap / "t5gemma-b-b-ul2" / "config.json").resolve()
    # The conditioner loads from the PARENT of the hit, which must be the
    # subfolder directory itself — that is what makes hf_kwargs = {} correct.
    assert Path(hit).parent.name == "t5gemma-b-b-ul2"


def test_a_root_level_encoder_still_resolves_without_a_subfolder(
    tmp_path: Path, monkeypatch
):
    # The google mirror carries the encoder at its root; no subfolder involved.
    repo_dir = tmp_path / "models--google--t5gemma-b-b-ul2"
    snap = repo_dir / "snapshots" / "abc"
    snap.mkdir(parents=True)
    (snap / "config.json").write_text("{}", encoding="utf-8")
    (repo_dir / "refs").mkdir()
    (repo_dir / "refs" / "main").write_text("abc", encoding="utf-8")
    monkeypatch.setattr(hf_constants, "HF_HUB_CACHE", str(tmp_path))

    hit = _cached_hub_file("google/t5gemma-b-b-ul2", None, "config.json")
    assert isinstance(hit, str) and Path(hit).name == "config.json"
