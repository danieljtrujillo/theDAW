"""App-wide feature settings persisted to ``data/settings.json``.

This is the source of truth for background workflows (auto-analysis,
auto-stems, auto-midi, shards, lyrics) and the app-wide choices that go with
them: device slots, model and media folders, the assistant's Claude setup.
Heavy workflows (stems, midi) default OFF and run only once the user enables
them; cheap local ones (analysis, shards, lyric timing) default ON. Each
default below says why.

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
from backend.lib import lan_https, paths
from backend.lib.atomic import atomic_write

log = logging.getLogger(__name__)


SCHEMA_VERSION = 12


DEFAULT_SETTINGS: dict[str, Any] = {
    "schema_version": SCHEMA_VERSION,
    "app": {
        # How theDAW opens on the next launch (read by theDAW.bat before it
        # starts anything): "web" = backend + Vite + browser (current default),
        # "desktop" = the Electron shell. Both share the same backend + DB.
        "launch_mode": "web",
    },
    "lan": {
        # Whether the launchers start the LAN HTTPS listener, the same app
        # over TLS so a second device gets a secure context. Read from the raw
        # file by backend/lib/lan_https.py before the backend exists. A section
        # of its own: an older build keeps a whole section it does not know but
        # drops unknown keys inside `app`, which is where schema 10 kept this
        # switch (see the v11 -> v12 migration below).
        "https": True,
    },
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
        # 'cuda' | 'cpu' | 'auto'. The integration-package's sidecar
        # respects this query param. Default cuda because demucs on cpu
        # is multiple-minutes-per-track even on fast hosts.
        "device": "cuda",
        # 'fast' | 'balanced' | 'hq'. Forwarded to the sidecar's `quality`
        # query param. Default 'balanced' because the integration-package's
        # 'hq' preset (overlap=0.9, shifts=10) commonly takes 10+ minutes
        # per track on a 6 GB GPU and frequently hangs at single percent
        # points while it grinds through individual shifts.
        "quality": "balanced",
    },
    "midi": {
        # Requires basic-pitch / piano-transcription-inference. Opt-in.
        "auto_on_import": False,
        "auto_on_generate": False,
        "from_stems": True,
    },
    "shards": {
        # The Shard Index (LOOM, DJ shard pads, PERFORM shard slots). One STFT
        # per source on the CPU — cheap next to stems — so it is default-ON;
        # an entry is re-cut automatically when its stems land.
        "auto_on_import": True,
        "auto_on_generate": True,
    },
    "lyrics": {
        # After an import with lyric text (Suno, embedded tags, notes), time
        # the words against the vocal stem so SING is ready without a click.
        # Whisper runs on the GPU when there is one; default-ON because the
        # job is idle-gated and skipped when a timed document exists.
        "auto_on_import": True,
        "auto_on_generate": False,
        # An entry with no lyric text is transcribed instead (whisper writes
        # the words). Off: the user's own words are the truth for SING.
        "auto_transcribe": False,
        # Whisper language for the auto jobs: 'auto' detects.
        "language": "auto",
        # How ALIGN times the words. 'mms' = forced alignment of the user's
        # own words with torchaudio's MMS aligner (every word gets a time,
        # no transcription involved); 'whisper' = match whisper's transcript
        # to the words (the old way); 'auto' = mms when torchaudio has it.
        "aligner": "auto",
        # After a forced alignment, let whisper listen too and underline the
        # words it heard differently (the review pass; costs a transcription).
        "review": True,
    },
    "idle": {
        "min_idle_seconds": 30,
        "respect_vram_pressure": True,
    },
    "vj": {
        # Root folder for VJ recording exports. A relative path resolves
        # against the project root; an absolute path is used verbatim.
        # Each take also lands in a per-export subfolder named in the VJ
        # record bar, so the final file is <export_root>/<subfolder>/…
        "export_root": "exports/vj",
    },
    "notation": {
        # Global artist/composer name. Stamped as the composer credit on every
        # generated sheet (and appended to song titles). Defaults to GANTASMO;
        # editable in Settings. The engine falls back to GANTASMO even if this
        # is blanked, so a sheet is never credited to "Music21".
        "artist": "GANTASMO",
        # Path to the MuseScore executable the user picked (Settings → artist
        # popover → MuseScore, or the SCORE tab's LOCATE MUSESCORE…). Empty =
        # auto-detect (PATH, then the standard install locations). MuseScore
        # stands in for the headless OSMD renderer for PDF/SVG when node or the
        # frontend dependencies are missing. `patch` only accepts keys listed
        # here, so this default is what lets the PATCH land.
        "musescore_path": "",
    },
    "io": {
        # Global input/output device choices, plus per-surface overrides.
        #
        # Every slot stores BOTH the browser deviceId and the label the device
        # had when it was chosen. deviceIds are salted per-origin and rotate
        # when site data is cleared, so the id alone is not portable between
        # the browser build (:5173) and the desktop app (app://) that the same
        # user switches between with app.launch_mode. The label is the recovery
        # key: the frontend resolves by id, then by label, then falls back to
        # the system default WITH a visible notice — never silently.
        #
        # Empty id AND empty label = "use the system default".
        "audio_output": {"id": "", "label": ""},  # main mix
        "cue_output": {"id": "", "label": ""},  # DJ headphone pre-listen
        "audio_input": {"id": "", "label": ""},  # microphone
        # 'all' (every port, including one plugged in later) | 'some' (ports).
        "midi_inputs": {"mode": "all", "ports": []},
        "midi_output": {"id": "", "label": ""},  # MIDI thru; '' = send nothing
        "visual_display": {"id": "", "label": ""},  # Electron display for pop-outs
        # Per-surface overrides keyed by surface id (see frontend
        # state/ioSurfaces.ts), each value a {id,label} ref. A surface with NO
        # entry follows the global slot; an entry of {"id":"","label":""} means
        # "the OS default, ignoring the global".
        #
        # NOTE: `patch()` assigns a dict-valued key WHOLESALE — it does not
        # deep-merge — so a caller must always PATCH the complete object for
        # `overrides` (and for every slot above), never a fragment.
        "overrides": {},
    },
    "library": {
        # Folders (absolute paths) holding the user's own copies of library
        # media, named after the entry they belong to -- either the full id or
        # the "[xxxxxxxx]" short tag. The library resolves an entry with no
        # file of its own from these before it asks any remote source. Read by
        # backend/modules/library/media_roots.py, which also honours the
        # theDAW_MEDIA_ROOTS env var (env wins). Same persistence + hygiene
        # rules as models.extra_folders below: str-only, stripped, de-duped.
        "media_roots": [],
    },
    "models": {
        # Extra folders (absolute paths) the app scans for ML models, on top
        # of its built-in locations. Unlimited length; the user adds as many
        # as they like in Settings. This store only owns persistence + hygiene
        # (str-only, stripped, de-duped) — a consumer that scans checks that a
        # folder actually exists. See _normalize_extra_folders / patch().
        "extra_folders": [],
    },
    "assistant": {
        # "Use my Claude settings and MCP servers" (the assistant panel, Claude
        # Code provider). True: the in-app Claude session loads the user's own
        # Claude setup -- ~/.claude/settings.json, ~/.claude/CLAUDE.md, their
        # skills, commands and agents (the CLI's `user` setting source) and
        # every MCP server they configured -- next to theDAW's relay, as it did
        # before the permission modes arrived; the user's own allow rules then
        # approve what they match in Accept-edits and Trusted, ask first in Ask
        # unless marked in always_allow_rules, and never apply in Read-only or
        # to edits of the assistant's own code (claude_session.permission_rules). False:
        # only this project's settings and theDAW's own MCP servers. Read by
        # backend/assistant_routes.py on every turn; see
        # claude_session.build_base_args. PATCH is loopback/launch-token only
        # (settings/router.py), a phone on the LAN cannot flip it.
        "use_user_claude_config": True,
        # Allow rules from the loaded Claude settings files that keep running
        # without a prompt in Ask mode. Every other loaded allow rule is sent to
        # theDAW's permission check in Ask mode, which asks the user
        # (claude_session.permission_rules). Exact rule strings as they appear
        # in the settings file. PATCH is loopback/launch-token only.
        "always_allow_rules": [],
    },
}


def _normalize_extra_folders(value: Any) -> list[str]:
    """Clean a ``models.extra_folders`` payload: keep only non-empty string
    items, strip surrounding whitespace, drop blanks, and de-duplicate while
    preserving first-seen order. No cap on length.

    Self-guarding: any non-list input (a hand-edited string, null, an object)
    normalises to [], so a second caller can never trigger a TypeError inside
    the store lock.
    """
    if not isinstance(value, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, str):
            continue
        folder = item.strip()
        if not folder or folder in seen:
            continue
        seen.add(folder)
        out.append(folder)
    return out


_ABSENT = object()


def _legacy_lan_value(payload: Any) -> Any:
    """What ``payload`` holds at the schema-10 ``app.lan_https``, or
    ``_ABSENT``."""
    if not isinstance(payload, dict):
        return _ABSENT
    app = payload.get(lan_https.LEGACY_SETTING_SECTION)
    if not isinstance(app, dict):
        return _ABSENT
    return app.get(lan_https.LEGACY_SETTING_KEY, _ABSENT)


def _mirror_lan_off(settings: dict[str, Any]) -> None:
    """Write an off at ``lan.https`` to ``app.lan_https`` as well, and drop
    the old key otherwise.

    The schema-10 build (8039b45) reads the switch only at ``app.lan_https``,
    so without the copy it turned HTTPS back on after this build had switched
    it off. main drops the copy when it saves, and keeps ``lan`` whole, so
    ``lan.https`` stays the switch this build reads. An on is never copied:
    an off left at the old key would win over it (``stored_off_key``), and
    the user could not switch the listener back on.
    """
    app = settings.get(lan_https.LEGACY_SETTING_SECTION)
    if not isinstance(app, dict):
        return
    lan = {lan_https.SETTING_SECTION: settings.get(lan_https.SETTING_SECTION)}
    if lan_https.stored_off_key(lan) is not None:
        app[lan_https.LEGACY_SETTING_KEY] = False
    else:
        app.pop(lan_https.LEGACY_SETTING_KEY, None)


def default_settings_path() -> Path:
    """Resolve the settings file path. ``theDAW_SETTINGS_PATH`` wins;
    otherwise it sits at the root of the writable data tree (which is NOT
    the install directory when that is read-only — see
    backend.lib.paths)."""
    configured = os.getenv("theDAW_SETTINGS_PATH")
    if configured:
        return Path(configured).expanduser().resolve()
    return paths.data_path("settings.json")


def _merge_defaults(
    payload: dict[str, Any], lan_record: dict[str, Any] | None = None
) -> dict[str, Any]:
    """Fill missing top-level sections / keys from DEFAULT_SETTINGS without
    overwriting anything the user already set.

    ``lan_record`` is this build's record of how it last wrote the LAN switch
    (``lan_https.read_record``); the switch is settled against it.

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
        if isinstance(merged.get(section), dict):
            if isinstance(value, dict):
                merged[section].update(
                    {k: v for k, v in value.items() if k in merged[section]}
                )
            else:
                # A section this build knows, holding something that is not an
                # object (a hand edit): its defaults stand. Taking the value
                # made the hygiene below, get_value() and patch() raise on it,
                # and every /api/settings call answered 500.
                log.warning(
                    "settings.store: section %r is not an object - using its defaults",
                    section,
                )
        else:
            # A section this build does not know is kept whole, so the
            # settings of a newer build survive a run of this one.
            merged[section] = value

    if old_version < 2:
        # Migration v1 → v2: turn analysis on. Users who had it off can
        # flip it back via Settings → Background features.
        merged["analysis"]["auto_on_import"] = True
        merged["analysis"]["auto_on_generate"] = True
    if old_version < 3:
        # Migration v2 → v3: stems gain an explicit `device` field;
        # default cuda so a user who already enabled stems doesn't
        # silently fall through to cpu.
        merged["stems"]["device"] = "cuda"
    if old_version < 4:
        # Migration v3 → v4: stems gain a `quality` preset (default
        # 'balanced'). hq is the integration-package's old default but
        # it routinely hangs at ~5-10 min per track even on GPU; users
        # who want max quality can opt in via Settings → Stems.
        merged["stems"]["quality"] = "balanced"
    if old_version < 5:
        # Migration v4 → v5: add the `vj` section (export_root). New
        # section, so it's already filled from DEFAULT_SETTINGS above;
        # this branch only exists to re-persist the bumped schema.
        merged.setdefault("vj", deepcopy(DEFAULT_SETTINGS["vj"]))
    if old_version < 6:
        # Migration v5 → v6: add the `app` section (launch_mode). New
        # section, already filled from DEFAULT_SETTINGS above; this branch
        # re-persists the bumped schema with the field present.
        merged.setdefault("app", deepcopy(DEFAULT_SETTINGS["app"]))
    if old_version < 7:
        # Migration v6 → v7: add the `notation` section (artist). New section,
        # already filled from DEFAULT_SETTINGS above; re-persist the bump.
        merged.setdefault("notation", deepcopy(DEFAULT_SETTINGS["notation"]))
    if old_version < 8:
        # Migration v7 → v8: add the `io` section (global device choices +
        # per-surface overrides). New section, already filled from
        # DEFAULT_SETTINGS above; this branch re-persists the bumped schema.
        merged.setdefault("io", deepcopy(DEFAULT_SETTINGS["io"]))
    if old_version < 9:
        # Migration v8 → v9: add the `models` section (extra_folders). New
        # section, already filled from DEFAULT_SETTINGS above; this branch
        # re-persists the bumped schema with the field present.
        merged.setdefault("models", deepcopy(DEFAULT_SETTINGS["models"]))
    if old_version < 10:
        # Migration v9 → v10: add the `library` section (media_roots). New
        # section, already filled from DEFAULT_SETTINGS above; this branch
        # re-persists the bumped schema with the field present.
        merged.setdefault("library", deepcopy(DEFAULT_SETTINGS["library"]))
    if old_version < 11:
        # Migration v10 → v11: add the `assistant` section
        # (use_user_claude_config, default ON: the in-app Claude keeps the
        # user's own settings and MCP servers it always had). New section,
        # already filled from DEFAULT_SETTINGS above; this branch re-persists
        # the bumped schema with the field present.
        merged.setdefault("assistant", deepcopy(DEFAULT_SETTINGS["assistant"]))
    if old_version < 12:
        # Migration v11 -> v12: the LAN HTTPS switch moves from schema 10's
        # app.lan_https to lan.https. New section, already filled from
        # DEFAULT_SETTINGS above; the old key's value is carried over below.
        merged.setdefault("lan", deepcopy(DEFAULT_SETTINGS["lan"]))

    # A hand-edited non-boolean ("no", 0, null) -- or a section that is not an
    # object at all -- is not a choice the user made in the app; it falls back
    # to the default rather than being read as truthy or falsy by whoever looks
    # at it next.
    if not isinstance(merged.get("assistant"), dict):
        merged["assistant"] = deepcopy(DEFAULT_SETTINGS["assistant"])
    if not isinstance(merged["assistant"].get("use_user_claude_config"), bool):
        merged["assistant"]["use_user_claude_config"] = DEFAULT_SETTINGS["assistant"][
            "use_user_claude_config"
        ]

    # The LAN switch is settled on EVERY load, not only below v12: a build that
    # still writes the old app.lan_https may have run since this one. The rule
    # is the one the launcher applies to the raw file (lan_https.reconcile):
    # a value changed since this build's record is the latest choice, a value
    # dropped by a build that does not know it is not a choice, and with no
    # record an off at either key wins. The merge above dropped the old key
    # from `app`; _mirror_lan_off puts it back as False only while lan.https
    # is off.
    merged["lan"]["https"] = lan_https.reconcile(payload, lan_record)
    _mirror_lan_off(merged)

    # Hygiene lives in the store, not only on the PATCH path: a hand-edited,
    # restored, or externally written settings.json gets the same str-only /
    # stripped / de-duped treatment on load. Additive — only blanks, dupes,
    # and non-str items are dropped; a non-list normalises to [].
    merged["models"]["extra_folders"] = _normalize_extra_folders(
        merged["models"].get("extra_folders")
    )
    merged["library"]["media_roots"] = _normalize_extra_folders(
        merged["library"].get("media_roots")
    )
    merged["assistant"]["always_allow_rules"] = _normalize_extra_folders(
        merged["assistant"].get("always_allow_rules")
    )

    merged["schema_version"] = SCHEMA_VERSION
    return merged


class SettingsStore:
    """Thread-safe JSON-file settings store. Loads on init, writes atomically
    on every update via tempfile + replace, and reads the file again when
    something else has rewritten it (see ``_sync_locked``)."""

    def __init__(self, path: Path) -> None:
        self.path = path
        # How this build last wrote the LAN switch (lan_https.RECORD_NAME,
        # beside the settings file). Written after every write of the file.
        self.lan_record_path = lan_https.record_path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        # (mtime_ns, size) of the file as this store last read or wrote it.
        self._seen: tuple[int, int] | None = None
        self._cache: dict[str, Any] = self._load()

    def _stamp(self) -> tuple[int, int] | None:
        try:
            st = self.path.stat()
        except OSError:
            return None
        return (st.st_mtime_ns, st.st_size)

    def _sync_locked(self) -> None:
        """Read the file again when something else has rewritten it.

        A backup restore copies settings.json straight over the file while
        this process holds its own copy, so the settings served after a
        restore, and the file the next patch() wrote, were the ones from
        before it. A file that is missing or does not parse (the restore
        copies in place, so a read can land mid-copy) leaves the cache as it
        is, and the next call looks again. Call under ``self._lock``.
        """
        stamp = self._stamp()
        if stamp is None or stamp == self._seen:
            return
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        self._seen = stamp
        self._cache = _merge_defaults(raw, lan_https.read_record(self.path))

    def _load(self) -> dict[str, Any]:
        # Stamped before the read, so a write landing between the two is read
        # again by the next _sync_locked().
        self._seen = self._stamp()
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
        record = lan_https.read_record(self.path)
        merged = _merge_defaults(raw, record)
        # Persist the post-migration shape so future loads start clean. A file
        # whose LAN switch differs from what this load settled on is rewritten
        # too, even at this schema, and so is one this build holds no record
        # of: the launchers read the raw file and the record.
        prev_version = raw.get("schema_version") if isinstance(raw, dict) else None
        lan_differs = (
            _legacy_lan_value(raw) != _legacy_lan_value(merged)
            or lan_https.record_for(raw if isinstance(raw, dict) else {})
            != lan_https.record_for(merged)
            or record != lan_https.record_for(merged)
        )
        if prev_version != merged.get("schema_version") or lan_differs:
            try:
                self._write(merged)
            except OSError as e:
                log.warning("settings.store: failed to persist migrated schema: %s", e)
        return merged

    def _write(self, payload: dict[str, Any]) -> None:
        atomic_write(self.path, json.dumps(payload, indent=2))
        self._seen = self._stamp()
        # After the settings: a crash between the two leaves the file holding
        # a value the record does not, which the next load reads as the
        # latest choice, and that is the value just written.
        atomic_write(
            self.lan_record_path, json.dumps(lan_https.record_for(payload), indent=2)
        )

    def get_all(self) -> dict[str, Any]:
        with self._lock:
            self._sync_locked()
            return deepcopy(self._cache)

    def get_section(self, section: str) -> dict[str, Any]:
        with self._lock:
            self._sync_locked()
            value = self._cache.get(section, {})
            return deepcopy(value) if isinstance(value, dict) else {}

    def get_value(self, section: str, key: str, default: Any = None) -> Any:
        with self._lock:
            self._sync_locked()
            return self._cache.get(section, {}).get(key, default)

    def patch(self, patch_payload: dict[str, Any]) -> dict[str, Any]:
        """Merge a partial settings payload into the current state and persist.
        Only sections/keys already present in DEFAULT_SETTINGS are accepted —
        unknown keys are silently ignored to keep the on-disk shape stable.
        """
        with self._lock:
            self._sync_locked()
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
                    if (section, k) in (
                        ("models", "extra_folders"),
                        ("library", "media_roots"),
                        ("assistant", "always_allow_rules"),
                    ):
                        # List-valued key: sanitise it (str-only, stripped,
                        # de-duped, no cap). A non-list is malformed and is
                        # ignored so it can't wipe the existing list.
                        if not isinstance(v, list):
                            continue
                        v = _normalize_extra_folders(v)
                    if (section, k) == ("assistant", "use_user_claude_config"):
                        # A switch: anything but a real boolean is malformed
                        # and ignored, so it cannot flip the session setup.
                        if not isinstance(v, bool):
                            continue
                    if (section, k) == ("lan", "https"):
                        # Stored as a real boolean, parsed the way the
                        # launchers parse the file ("off", "0", false...); a
                        # value that says neither is ignored.
                        v = lan_https.parse_flag(v)
                        if v is None:
                            continue
                    target[k] = v
            _mirror_lan_off(self._cache)
            self._cache["schema_version"] = SCHEMA_VERSION
            self._write(self._cache)
            return deepcopy(self._cache)
