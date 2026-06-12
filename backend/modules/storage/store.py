"""Registry for user-added local checkpoints + the local-only switch.

Persisted to ``data/local_checkpoints.json``. Each entry maps a stable id
(``local:<8-hex>``) to a display name and a path the user picked. The ids are
what the Model dropdown submits, so renaming or moving the underlying folder
never breaks generation history — the entry just stops resolving until the
user re-points it.

``local_only`` mirrors the ``SA3_LOCAL_ONLY`` environment switch that
``stable_audio_3.model_configs`` reads on every resolve: when on, model
resolution never touches the network and fails loudly instead of downloading.
The flag is applied to ``os.environ`` at import time so a backend restart
keeps the user's choice.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import threading
import time
from copy import deepcopy
from pathlib import Path
from typing import Any

from stable_audio_3.model_configs import resolve_local_checkpoint

log = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parents[3]
REGISTRY_PATH = PROJECT_ROOT / "data" / "local_checkpoints.json"

_DEFAULT: dict[str, Any] = {"local_only": False, "checkpoints": []}


class CheckpointRegistry:
    """Thread-safe JSON registry, written atomically on every change."""

    def __init__(self, path: Path = REGISTRY_PATH) -> None:
        self.path = path
        self._lock = threading.RLock()
        self._cache: dict[str, Any] = self._load()
        self._apply_local_only_env()

    def _load(self) -> dict[str, Any]:
        if not self.path.is_file():
            return deepcopy(_DEFAULT)
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            log.warning("storage.store: failed to read %s: %s", self.path, e)
            return deepcopy(_DEFAULT)
        if not isinstance(raw, dict):
            return deepcopy(_DEFAULT)
        merged = deepcopy(_DEFAULT)
        merged["local_only"] = bool(raw.get("local_only", False))
        entries = raw.get("checkpoints")
        if isinstance(entries, list):
            merged["checkpoints"] = [
                e
                for e in entries
                if isinstance(e, dict) and e.get("id") and e.get("path")
            ]
        return merged

    def _write(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self._cache, indent=2), encoding="utf-8")
        tmp.replace(self.path)

    def _apply_local_only_env(self) -> None:
        os.environ["SA3_LOCAL_ONLY"] = "1" if self._cache["local_only"] else "0"

    # -- local-only ---------------------------------------------------------

    def local_only(self) -> bool:
        with self._lock:
            return bool(self._cache["local_only"])

    def set_local_only(self, enabled: bool) -> bool:
        with self._lock:
            self._cache["local_only"] = bool(enabled)
            self._apply_local_only_env()
            self._write()
            return self._cache["local_only"]

    # -- checkpoints ---------------------------------------------------------

    def list_checkpoints(self) -> list[dict[str, Any]]:
        """All registered entries, each stamped with whether it still resolves."""
        with self._lock:
            entries = deepcopy(self._cache["checkpoints"])
        for entry in entries:
            resolved = resolve_local_checkpoint(entry["path"], quiet=True)
            entry["resolves"] = resolved is not None
            if resolved:
                entry["config_path"], entry["ckpt_path"] = resolved
        return entries

    def get_path(self, ck_id: str) -> str | None:
        with self._lock:
            for entry in self._cache["checkpoints"]:
                if entry["id"] == ck_id:
                    return entry["path"]
        return None

    def add_checkpoint(self, path: str, name: str | None = None) -> dict[str, Any]:
        """Validate and register a checkpoint folder/file. Raises ValueError
        when the path doesn't resolve to a config + checkpoint pair."""
        resolved = resolve_local_checkpoint(path, quiet=True)
        if resolved is None:
            raise ValueError(
                "No usable checkpoint found there. Point at a folder holding a "
                "model config JSON plus one .safetensors file, or at the "
                ".safetensors file itself with its config alongside."
            )
        config_path, ckpt_path = resolved
        norm = str(Path(path).expanduser().resolve())
        ck_id = "local:" + hashlib.sha1(norm.lower().encode()).hexdigest()[:8]
        display = (name or "").strip() or Path(ckpt_path).parent.name
        entry = {
            "id": ck_id,
            "name": display,
            "path": norm,
            "added_at": int(time.time()),
        }
        with self._lock:
            self._cache["checkpoints"] = [
                e for e in self._cache["checkpoints"] if e["id"] != ck_id
            ] + [entry]
            self._write()
        out = deepcopy(entry)
        out["resolves"] = True
        out["config_path"], out["ckpt_path"] = config_path, ckpt_path
        return out

    def remove_checkpoint(self, ck_id: str) -> bool:
        """Unregister an entry. Never touches the files on disk."""
        with self._lock:
            before = len(self._cache["checkpoints"])
            self._cache["checkpoints"] = [
                e for e in self._cache["checkpoints"] if e["id"] != ck_id
            ]
            changed = len(self._cache["checkpoints"]) != before
            if changed:
                self._write()
            return changed


_registry: CheckpointRegistry | None = None
_registry_lock = threading.Lock()


def get_registry() -> CheckpointRegistry:
    global _registry
    with _registry_lock:
        if _registry is None:
            _registry = CheckpointRegistry()
        return _registry
