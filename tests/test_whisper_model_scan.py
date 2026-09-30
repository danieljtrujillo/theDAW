"""Whisper model resolution scans the HF cache AND settings.models.extra_folders.

No network, no venv, no real caches, no writes to the user's settings.json: every
candidate lives under ``tmp_path`` and the settings store is a stub. Covers the
CTranslate2 local-dir layout (model.bin + config.json + a whisper marker), the
HF-cache layout inside an extra folder, per-revision cache sizing, defensive
handling of a missing/invalid setting, resolve_config precedence (env > best
cached on cuda > device default; CPU default untouched), and the worker's
id-shape-agnostic large-model downgrade.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.modules.vocal.transcription import sidecar, worker


def _write(path: Path, size: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\0" * size)


def _make_ct2_model(folder: Path, bin_size: int, *, tokenizer: bool = True) -> Path:
    """A CTranslate2 faster-whisper model dir: model.bin + config.json, plus the
    tokenizer.json whisper marker unless the caller wants a non-whisper CT2 dir.
    Total size with the marker is ``bin_size + 48``."""
    folder.mkdir(parents=True, exist_ok=True)
    _write(folder / "model.bin", bin_size)
    _write(folder / "config.json", 32)
    if tokenizer:
        _write(folder / "tokenizer.json", 16)
    return folder


def _make_hf_layout(root: Path, org: str, name: str, bin_size: int) -> Path:
    """A HuggingFace-cache layout dir ``models--org--name/snapshots/rev/...``.
    Returns the REVISION dir (its model dir is ``rev.parent.parent``)."""
    d = root / f"models--{org}--{name}"
    snap = d / "snapshots" / "deadbeef"
    _write(snap / "model.bin", bin_size)
    _write(snap / "config.json", 32)
    return snap


def _set_store(monkeypatch, payload) -> None:
    """Install an already-initialized settings store stub. Pass an Exception to
    make get_all() raise."""
    import backend.modules.settings.router as router_mod

    class _Store:
        def get_all(self):
            if isinstance(payload, Exception):
                raise payload
            return payload

    monkeypatch.setattr(router_mod, "_store", _Store())


# --------------------------------------------------------------------------- #
# reading the setting is defensive AND read-only


def test_extra_model_folders_empty_when_store_not_initialized(monkeypatch):
    """No store yet (tests, CLI) -> no extra folders, and nothing is created."""
    import backend.modules.settings.router as router_mod

    monkeypatch.setattr(router_mod, "_store", None)
    assert sidecar._extra_model_folders() == []


def test_extra_model_folders_never_constructs_the_store(monkeypatch, tmp_path):
    """get_store() mkdirs and writes/migrates the real settings.json. Resolving a
    model must never write, so only an already-initialized store may be read."""
    import backend.modules.settings.router as router_mod

    def boom():
        raise AssertionError("get_store() must not be called: it writes settings.json")

    monkeypatch.setattr(router_mod, "get_store", boom)
    _set_store(monkeypatch, {"models": {"extra_folders": [str(tmp_path)]}})
    assert sidecar._extra_model_folders() == [tmp_path]


def test_extra_model_folders_tolerates_get_all_raising(monkeypatch):
    _set_store(monkeypatch, RuntimeError("settings unreadable"))
    assert sidecar._extra_model_folders() == []


def test_extra_model_folders_tolerates_non_dict_models(monkeypatch):
    _set_store(monkeypatch, {"models": "not-a-dict"})
    assert sidecar._extra_model_folders() == []


def test_extra_model_folders_tolerates_non_list_and_missing_key(monkeypatch):
    _set_store(monkeypatch, {"models": {"extra_folders": "x"}})
    assert sidecar._extra_model_folders() == []
    _set_store(monkeypatch, {})
    assert sidecar._extra_model_folders() == []


def test_extra_model_folders_parses_string_paths(monkeypatch, tmp_path):
    a = tmp_path / "a"
    b = tmp_path / "b"
    _set_store(
        monkeypatch, {"models": {"extra_folders": [str(a), str(b), "", 5, None]}}
    )
    assert sidecar._extra_model_folders() == [a, b]


# --------------------------------------------------------------------------- #
# scanning a single extra folder


def test_scan_extra_folder_detects_root_ct2_layout(tmp_path):
    root = _make_ct2_model(tmp_path / "mymodel", bin_size=1000)
    assert sidecar._scan_extra_folder(root) == [(str(root.resolve()), 1000 + 48)]


def test_scan_extra_folder_detects_ct2_subfolders_and_hf_layout(tmp_path):
    root = tmp_path / "models"
    root.mkdir()
    ct2 = _make_ct2_model(root / "faster-whisper-huge", bin_size=2000)
    rev = _make_hf_layout(root, "Systran", "faster-whisper-large-v3", bin_size=500)
    idents = {ident for ident, _ in sidecar._scan_extra_folder(root)}
    assert str(ct2.resolve()) in idents
    # A relocated hub tree is identified by its revision DIR, not the repo id.
    assert str(rev.resolve()) in idents
    assert "Systran/faster-whisper-large-v3" not in idents


def test_scan_extra_folder_hf_layout_returns_local_revision_path(tmp_path):
    """A copied hub tree under an extra folder must load off disk. Returning the
    bare repo id would miss the real HF_HUB_CACHE and download the model."""
    root = tmp_path / "models"
    root.mkdir()
    rev = _make_hf_layout(root, "Systran", "faster-whisper-large-v3", bin_size=1234)
    found = sidecar._scan_extra_folder(root)
    assert found == [(str(rev.resolve()), 1234 + 32)]
    ident = Path(found[0][0])
    # It is the snapshots/<revision> dir, and it lives inside the extra folder.
    assert ident.parent.name == "snapshots"
    assert ident.is_dir() and (ident / "model.bin").is_file()
    assert root.resolve() in ident.parents


def test_hf_layout_revision_picks_the_largest_revision(tmp_path):
    d = tmp_path / "models--Systran--faster-whisper-large-v3"
    _write(d / "snapshots" / "old" / "model.bin", 300)
    _write(d / "snapshots" / "new" / "model.bin", 900)
    rev, size = sidecar._hf_layout_revision(d)
    assert rev.name == "new" and size == 900


def test_hf_layout_revision_ignores_empty_snapshots(tmp_path):
    d = tmp_path / "models--Systran--faster-whisper-large-v3"
    (d / "snapshots").mkdir(parents=True)
    assert sidecar._hf_layout_revision(d) is None


def test_scan_extra_folder_ignores_incomplete_and_nonexistent(tmp_path):
    # config.json only, no model.bin -> not a model
    partial = tmp_path / "partial"
    partial.mkdir()
    (partial / "config.json").write_text("{}")
    assert sidecar._scan_extra_folder(partial) == []
    assert sidecar._scan_extra_folder(tmp_path / "does-not-exist") == []


def test_scan_extra_folder_ignores_non_whisper_ct2_model(tmp_path):
    """A CTranslate2 dir with no whisper marker (no tokenizer.json, no 'whisper'
    in the name) is some other CT2 model; WhisperModel would fail to load it."""
    root = tmp_path / "models"
    root.mkdir()
    _make_ct2_model(root / "opus-mt-en-de", bin_size=9_999, tokenizer=False)
    assert sidecar._scan_extra_folder(root) == []


def test_scan_extra_folder_accepts_whisper_named_ct2_without_tokenizer(tmp_path):
    root = tmp_path / "models"
    root.mkdir()
    m = _make_ct2_model(root / "faster-whisper-large-v3", bin_size=100, tokenizer=False)
    idents = {ident for ident, _ in sidecar._scan_extra_folder(root)}
    assert str(m.resolve()) in idents


# --------------------------------------------------------------------------- #
# HF-cache sizing counts ONE revision, not every revision


def test_hf_cache_size_is_largest_single_revision(tmp_path):
    d = tmp_path / "models--Systran--faster-whisper-tiny"
    _write(d / "snapshots" / "rev1" / "model.bin", 700)
    _write(d / "snapshots" / "rev2" / "model.bin", 500)
    # Not 1200: revisions link the same blobs, so summing them double-counts.
    assert sidecar._hf_cache_model(d) == ("Systran/faster-whisper-tiny", 700)


def test_multi_revision_small_model_does_not_outrank_bigger_one(monkeypatch, tmp_path):
    root = tmp_path / "hub"
    small = root / "models--Systran--faster-whisper-tiny"
    for rev in ("r1", "r2", "r3"):
        _write(small / "snapshots" / rev / "model.bin", 400)
    big = root / "models--Systran--faster-whisper-large-v3"
    _write(big / "snapshots" / "r1" / "model.bin", 900)
    monkeypatch.setattr(sidecar, "_extra_model_folders", lambda: [root])
    monkeypatch.setattr(sidecar, "_scan_hf_cache", lambda: [])
    # 3x400 must not beat 900; extra-folder hub trees resolve to a revision path.
    assert sidecar._best_cached_whisper_model() == str(
        (big / "snapshots" / "r1").resolve()
    )


# --------------------------------------------------------------------------- #
# ranking: largest wins


def test_best_cached_returns_none_when_no_sources(monkeypatch):
    monkeypatch.setattr(sidecar, "_scan_hf_cache", lambda: [])
    monkeypatch.setattr(sidecar, "_extra_model_folders", lambda: [])
    assert sidecar._best_cached_whisper_model() is None


def test_extra_folder_ct2_beats_smaller_hf_cache(monkeypatch, tmp_path):
    big = _make_ct2_model(tmp_path / "big-model", bin_size=10_000)
    monkeypatch.setattr(
        sidecar, "_scan_hf_cache", lambda: [("Systran/faster-whisper-small", 1000)]
    )
    monkeypatch.setattr(sidecar, "_extra_model_folders", lambda: [big])
    assert sidecar._best_cached_whisper_model() == str(big.resolve())


def test_hf_cache_beats_smaller_extra_folder(monkeypatch, tmp_path):
    small = _make_ct2_model(tmp_path / "small-model", bin_size=100)
    monkeypatch.setattr(
        sidecar, "_scan_hf_cache", lambda: [("Systran/faster-whisper-large-v3", 50_000)]
    )
    monkeypatch.setattr(sidecar, "_extra_model_folders", lambda: [small])
    assert sidecar._best_cached_whisper_model() == "Systran/faster-whisper-large-v3"


# --------------------------------------------------------------------------- #
# resolve_config precedence unchanged


def test_resolve_config_env_overrides_everything(monkeypatch):
    monkeypatch.setattr(sidecar, "cuda_available", lambda: True)
    monkeypatch.setattr(
        sidecar, "_best_cached_whisper_model", lambda: "some/cached-model"
    )
    monkeypatch.setenv("theDAW_WHISPER_MODEL", "env-forced-model")
    for var in ("theDAW_WHISPER_DEVICE", "theDAW_WHISPER_COMPUTE"):
        monkeypatch.delenv(var, raising=False)
    assert sidecar.resolve_config().model == "env-forced-model"


def test_resolve_config_cpu_default_does_not_consult_cache(monkeypatch):
    monkeypatch.setattr(sidecar, "cuda_available", lambda: False)

    def _fail():
        raise AssertionError("cache must not be consulted on the CPU path")

    monkeypatch.setattr(sidecar, "_best_cached_whisper_model", _fail)
    for var in (
        "theDAW_WHISPER_MODEL",
        "theDAW_WHISPER_DEVICE",
        "theDAW_WHISPER_COMPUTE",
    ):
        monkeypatch.delenv(var, raising=False)
    cfg = sidecar.resolve_config()
    assert cfg.device == "cpu"
    assert cfg.model == sidecar._CPU_DEFAULTS["model"]


def test_resolve_config_cuda_uses_real_extra_folder_candidate(monkeypatch, tmp_path):
    """End-to-end through the real scan: a CTranslate2 model in an extra folder
    becomes the model resolve_config() hands the worker on the GPU path."""
    model_dir = _make_ct2_model(tmp_path / "local-whisper", bin_size=8_000)
    monkeypatch.setattr(sidecar, "_scan_hf_cache", lambda: [])
    monkeypatch.setattr(sidecar, "_extra_model_folders", lambda: [tmp_path])
    monkeypatch.setattr(sidecar, "cuda_available", lambda: True)
    for var in (
        "theDAW_WHISPER_MODEL",
        "theDAW_WHISPER_DEVICE",
        "theDAW_WHISPER_COMPUTE",
    ):
        monkeypatch.delenv(var, raising=False)
    cfg = sidecar.resolve_config()
    assert cfg.device == "cuda"
    assert cfg.model == str(model_dir.resolve())


def test_resolve_config_cuda_uses_best_cached_when_no_env(monkeypatch):
    monkeypatch.setattr(sidecar, "cuda_available", lambda: True)
    monkeypatch.setattr(
        sidecar, "_best_cached_whisper_model", lambda: "Systran/faster-whisper-large-v3"
    )
    for var in (
        "theDAW_WHISPER_MODEL",
        "theDAW_WHISPER_DEVICE",
        "theDAW_WHISPER_COMPUTE",
    ):
        monkeypatch.delenv(var, raising=False)
    assert sidecar.resolve_config().model == "Systran/faster-whisper-large-v3"


# --------------------------------------------------------------------------- #
# the worker's CPU-fallback downgrade works on every model-id shape


@pytest.mark.parametrize(
    "model_id, is_large",
    [
        ("large-v3", True),
        ("Systran/faster-whisper-large-v3", True),
        ("D:/models/faster-whisper-large-v3", True),
        ("/mnt/models/faster-whisper-large-v2", True),
        ("/mnt/models/faster-whisper-large-v3/", True),  # trailing slash
        ("small", False),
        ("Systran/faster-whisper-small", False),
        ("D:/models/faster-whisper-medium", False),
        # The regression this heuristic exists for: "large" in a PARENT folder
        # must not downgrade an already-small model.
        ("D:/models/large-models/faster-whisper-small", False),
    ],
)
def test_worker_large_model_heuristic_is_id_shape_agnostic(model_id, is_large):
    """On CUDA failure the worker downgrades a GPU-sized model to 'small'. The id
    may be a bare name, a repo id or a local dir, so the check must look at the
    last path segment, not the start of the string."""
    assert worker._is_large_model(model_id) is is_large
