"""App-wide feature settings persisted to ``data/settings.json``.

This is the source of truth for opt-in background workflows: auto-analysis,
auto-stems, auto-midi. Defaults are OFF for every toggle so that nothing
runs automatically until the user explicitly enables it.

The on-disk schema is versioned (``schema_version``) so we can migrate
fields forward without losing the user's existing choices. Missing keys
are filled from ``DEFAULT_SETTINGS`` on every load — partial files are
fine.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from copy import deepcopy
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)


SCHEMA_VERSION = 2


DEFAULT_SETTINGS: dict[str, Any] = {
    "schema_version": SCHEMA_VERSION,
    "analysis": {
        # Analysis is cheap (local librosa + aubio), so it's default-ON
        # — every imported / generated track gets its bpm/key/pitch/bars
        # written into the DB + Details panel without the user opting in.
        "auto_on_import": True,
        "auto_on_generate": True,
        "include_genre": False,
        "include_key": True,
    },
    "stems": {
        # Heavy; requires the integration-package sidecar. Opt-in.
        "auto_on_import": False,
        "auto_on_generate": False,
        "default_count": 4,
    },
    "midi": {
        # Requires basic-pitch / piano-transcription-inference. Opt-in.
        "auto_on_import": False,
        "auto_on_generate": False,
        "from_stems": True,
    },
    "idle": {
        "min_idle_seconds": 30,
        "respect_vram_pressure": True,
    },
}


def default_settings_path(project_root: Path) -> Path:
    """Resolve the settings file path. Env override wins; otherwise it lives
    next to the library generations directory."""
    configured = os.getenv("STABLEDAW_SETTINGS_PATH")
    if configured:
        return Path(configured).expanduser().resolve()
    return project_root / "data" / "settings.json"


def _merge_defaults(payload: dict[str, Any]) -> dict[str, Any]:
    """Fill missing top-level sections / keys from DEFAULT_SETTINGS without
    overwriting anything the user already set.

    Runs schema migrations on the way through:
      - v1 → v2: analysis.auto_on_import / auto_on_generate become
        default-ON because analysis is local and cheap. Any user who
        opened the app on a v1 build has the legacy off/off state; we
        flip them to on/on once during the upgrade.
    """
    merged = deepcopy(DEFAULT_SETTINGS)
    if not isinstance(payload, dict):
        return merged

    raw_version = payload.get("schema_version")
    try:
        old_version = int(raw_version) if isinstance(raw_version, (int, float)) else 0
    except (TypeError, ValueError):
        old_version = 0

    for section, value in payload.items():
        if section == "schema_version":
            continue
        if isinstance(value, dict) and isinstance(merged.get(section), dict):
            merged[section].update(
                {k: v for k, v in value.items() if k in merged[section]}
            )
        else:
            merged[section] = value

    if old_version < 2:
        # Migration v1 → v2: turn analysis on. Users who had it off can
        # flip it back via Settings → Background features.
        merged["analysis"]["auto_on_import"] = True
        merged["analysis"]["auto_on_generate"] = True

    merged["schema_version"] = SCHEMA_VERSION
    return merged


class SettingsStore:
    """Thread-safe JSON-file settings store. Loads on init, writes atomically
    on every update via tempfile + replace."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._cache: dict[str, Any] = self._load()

    def _load(self) -> dict[str, Any]:
        if not self.path.is_file():
            payload = deepcopy(DEFAULT_SETTINGS)
            self._write(payload)
            return payload
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as e:
            log.warning(
                "settings.store: failed to read %s: %s — using defaults", self.path, e
            )
            return deepcopy(DEFAULT_SETTINGS)
        merged = _merge_defaults(raw)
        # Persist the post-migration shape so future loads start clean.
        prev_version = raw.get("schema_version") if isinstance(raw, dict) else None
        if prev_version != merged.get("schema_version"):
            try:
                self._write(merged)
            except OSError as e:
                log.warning("settings.store: failed to persist migrated schema: %s", e)
        return merged

    def _write(self, payload: dict[str, Any]) -> None:
        tmp = self.path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        tmp.replace(self.path)

    def get_all(self) -> dict[str, Any]:
        with self._lock:
            return deepcopy(self._cache)

    def get_section(self, section: str) -> dict[str, Any]:
        with self._lock:
            value = self._cache.get(section, {})
            return deepcopy(value) if isinstance(value, dict) else {}

    def get_value(self, section: str, key: str, default: Any = None) -> Any:
        with self._lock:
            return self._cache.get(section, {}).get(key, default)

    def patch(self, patch_payload: dict[str, Any]) -> dict[str, Any]:
        """Merge a partial settings payload into the current state and persist.
        Only sections/keys already present in DEFAULT_SETTINGS are accepted —
        unknown keys are silently ignored to keep the on-disk shape stable.
        """
        with self._lock:
            for section, value in patch_payload.items():
                if section == "schema_version":
                    continue
                if section not in DEFAULT_SETTINGS:
                    continue
                target = self._cache.setdefault(section, {})
                if not isinstance(value, dict):
                    continue
                allowed_keys = set(DEFAULT_SETTINGS[section].keys())
                for k, v in value.items():
                    if k not in allowed_keys:
                        continue
                    target[k] = v
            self._cache["schema_version"] = SCHEMA_VERSION
            self._write(self._cache)
            return deepcopy(self._cache)
