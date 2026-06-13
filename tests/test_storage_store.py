import json
import os

from backend.modules.storage.store import CheckpointRegistry


def test_checkpoint_registry_defaults_local_only_on_for_fresh_installs(
    tmp_path, monkeypatch
):
    monkeypatch.delenv("SA3_LOCAL_ONLY", raising=False)

    registry = CheckpointRegistry(tmp_path / "local_checkpoints.json")

    assert registry.local_only() is True
    assert registry.list_checkpoints() == []
    assert registry.path.exists() is False
    assert os.environ["SA3_LOCAL_ONLY"] == "1"


def test_checkpoint_registry_defaults_local_only_on_when_key_is_missing(
    tmp_path, monkeypatch
):
    monkeypatch.delenv("SA3_LOCAL_ONLY", raising=False)
    path = tmp_path / "local_checkpoints.json"
    path.write_text(json.dumps({"checkpoints": []}), encoding="utf-8")

    registry = CheckpointRegistry(path)

    assert registry.local_only() is True
    assert os.environ["SA3_LOCAL_ONLY"] == "1"


def test_checkpoint_registry_preserves_explicit_local_only_false(tmp_path, monkeypatch):
    monkeypatch.delenv("SA3_LOCAL_ONLY", raising=False)
    path = tmp_path / "local_checkpoints.json"
    path.write_text(
        json.dumps({"local_only": False, "checkpoints": []}), encoding="utf-8"
    )

    registry = CheckpointRegistry(path)

    assert registry.local_only() is False
    assert os.environ["SA3_LOCAL_ONLY"] == "0"

    assert registry.set_local_only(True) is True
    assert os.environ["SA3_LOCAL_ONLY"] == "1"
