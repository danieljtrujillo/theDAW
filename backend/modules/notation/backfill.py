"""Backfill + repair for notation artifacts.

Idempotent, safe to re-run every launch:

  - Generate a MusicXML sheet for every entry that has MIDI but no sheet.
  - Repair sheets that are missing the song title (music21 stamps the
    placeholder "Music21 Fragment" on untitled MIDI) or the artist credit, by
    regenerating them from the source MIDI so they also pick up the current
    engraving. When the source MIDI is gone, the title is patched in place.

Runs in a worker thread off the event loop; the caller enqueues it on the
idle-gated background queue so a large library never blocks a request.
"""

from __future__ import annotations

import io
import json
import logging
import sqlite3
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape as _xml_escape

from backend.lib.atomic import atomic_write

log = logging.getLogger(__name__)

_PLACEHOLDER = "Music21 Fragment"

# ---------------------------------------------------------------------------
# One-time notation-artifacts recovery migration (SCORE-009 follow-up)
# ---------------------------------------------------------------------------
#
# GET /{entry_id}/artifacts used to self-heal on every call: mirroring the
# legacy ``midis`` table into ``notation_artifacts``, and, when the DB had
# nothing at all for an entry, scanning its directories for files whose rows
# were lost. That self-heal is gone (reads must not write); a pre-existing
# library still needs both recoveries an earlier launch would have done, so
# this runs them ONCE, as a background migration, and records completion so
# it never rescans the library again. New MIDI rows no longer depend on the
# mirror half: they are mirrored at the write path that creates them (see
# ``backend.modules.midi.runner``).
#
# NOT DB-only in the strict sense: ``register_existing_midis`` /
# ``register_on_disk_artifacts`` call ``add_notation_artifact``, which is an
# INSERT OR REPLACE that, when a row already existed under the same id
# pointing at a DIFFERENT path, moves the superseded file into a sibling
# ``deprecated/`` folder (``library.db.supersede_artifact_file``). Neither
# function ever touches an AUDIO file or enqueues analysis/stems/midi -- the
# "DB-only" guarantee is about staying off the audio/analysis pipeline, not
# about the filesystem being completely untouched.
#
# The completion marker lives in the library DB's own ``schema_meta`` table
# (``library.db``'s existing one-time-migration convention -- see
# ``_current_schema_version`` / ``_backfill_fts``), not a library-root
# dotfile: a rebuilt/restored DB has no schema_meta rows, so it re-runs the
# migration, exactly like a rebuilt DB re-runs the FTS backfill. This is
# already per-library without extra scoping, because schema_meta lives
# INSIDE the library's own DB file. Written with the SAME locking + direct-
# commit convention ``_backfill_fts`` uses (not ``_txn()``, which bumps
# ``library_revision`` -- a migration marker is not a library mutation).
# ``LibraryDB._conn`` / ``_writelock`` are reached directly (the same
# ``# noqa: SLF001 - module convention`` idiom already used everywhere in
# this router/backfill pair for ``store._dir_for``): nothing here adds a
# public accessor to ``backend/modules/library/db.py``.
_SCHEMA_META_KEY = "notation_legacy_artifacts_migration_v2"
_MIGRATION_BATCH = 500
# A short pause between batches. This does NOT release the DB writelock (it
# is already released between calls -- each register_existing_midis /
# register_on_disk_artifacts call takes and releases it on its own); what it
# actually buys is a brief break in a tight Python loop so a long migration
# doesn't monopolize the GIL and starve other request-handling threads.
_MIGRATION_BATCH_PAUSE_SEC = 0.01
# An id that still fails after this many attempts (across launches, not
# within one run) is abandoned rather than retried forever: a permanently
# broken entry, or a systemic failure that fails every id on the first
# (whole-library) run, would otherwise re-walk an unbounded id set on every
# single launch.
_MAX_ID_ATTEMPTS = 3


def _read_migration_state(db: Any) -> dict[str, Any]:
    conn = getattr(db, "_conn", None)  # noqa: SLF001 - see module docstring
    lock = getattr(db, "_writelock", None)  # noqa: SLF001 - see module docstring
    if conn is None or lock is None:
        return {}
    with lock:
        cur = conn.cursor()
        try:
            row = cur.execute(
                "SELECT value FROM schema_meta WHERE key = ?", (_SCHEMA_META_KEY,)
            ).fetchone()
        except sqlite3.OperationalError:
            # schema_meta not created yet (a DB opened before its own
            # __init__ finished migrating) -- nothing recorded.
            return {}
        finally:
            cur.close()
    if not row:
        return {}
    try:
        parsed = json.loads(row["value"])
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _write_migration_state(db: Any, state: dict[str, Any]) -> None:
    conn = getattr(db, "_conn", None)  # noqa: SLF001 - see module docstring
    lock = getattr(db, "_writelock", None)  # noqa: SLF001 - see module docstring
    if conn is None or lock is None:
        return
    with lock:
        cur = conn.cursor()
        try:
            cur.execute(
                "INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)",
                (_SCHEMA_META_KEY, json.dumps(state)),
            )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            cur.close()


def legacy_midi_mirror_done(store: Any) -> bool:
    """Whether :func:`migrate_legacy_midi_mirror` fully completed for this
    library (no entries still pending a retry)."""
    if store.db is None:
        return False
    return bool(_read_migration_state(store.db).get("done"))


def migrate_legacy_midi_mirror(
    store: Any, *, batch: int = _MIGRATION_BATCH
) -> dict[str, int]:
    """One-time, idempotent recovery of notation artifacts whose DB rows
    never existed or were lost, for this library:

      - mirrors every pre-existing legacy ``midis`` row into
        ``notation_artifacts`` (``register_existing_midis``);
      - recovers any notation file on disk that has no DB row at all
        (``register_on_disk_artifacts``) -- this used to be reachable only
        from the manual ``POST /reindex`` route once the GET self-heal was
        removed, so an entry whose rows were lost but whose files survive
        would otherwise stay empty forever.

    No-ops immediately (one small ``schema_meta`` read, no entry scan) once
    the marker says a prior launch fully completed it. A run that hits
    errors does NOT mark itself done: it records exactly which entry ids
    failed, and the NEXT call retries only those, rather than either
    silently losing them forever or rescanning the whole library again.

    Entries are walked in fixed batches, with a short pause between them, so
    no single pass holds an unbounded amount of work or starves the DB
    writelock. The id list itself is the cheapest one available:
    ``LibraryDB.all_entry_ids()`` (``SELECT id FROM entries``, one column) on
    a first run, or just the pending ids on a retry -- never
    ``list_entries()`` (``SELECT *``, ~24 columns including ``metadata_json``,
    which on a ~200k-entry library is the 0.5-1.5 GB transient read this
    replaces). Touches no audio file and enqueues no analysis, stems, or
    MIDI job.
    """
    res = {"scanned": 0, "mirrored": 0, "disk_recovered": 0, "errors": 0}
    if store.db is None:
        return res

    state = _read_migration_state(store.db)
    if state.get("done"):
        return res

    try:
        from .engine import register_existing_midis, register_on_disk_artifacts
    except Exception:
        return res

    pending = state.get("pending_ids")
    is_retry = isinstance(pending, list) and bool(pending)
    if is_retry:
        target_ids = [str(eid) for eid in pending if eid]
    else:
        try:
            target_ids = [eid for eid in store.db.all_entry_ids() if eid]
        except Exception:
            return res

    failed_ids: list[str] = []
    for start in range(0, len(target_ids), batch):
        chunk = target_ids[start : start + batch]
        for eid in chunk:
            res["scanned"] += 1
            entry_failed = False

            try:
                # "mirrored" is an approximate, upper-bound count, not an
                # exact new-row count: register_existing_midis' return value
                # includes a row it re-affirmed (an already-mirrored id, same
                # content, re-written as a no-op INSERT OR REPLACE) alongside
                # any it truly created, and it has no way to tell those
                # apart itself. An exact count would need a before/after
                # SELECT of this entry's midi-kind artifacts around the call
                # -- two extra indexed queries per entry (~400k at 200k
                # entries) to make a log number exact, which is not worth the
                # cost here: nothing downstream reads "mirrored" for
                # correctness, only the log line and the tests.
                res["mirrored"] += len(register_existing_midis(store.db, eid))
            except Exception as exc:  # noqa: BLE001 - best-effort, keep scanning
                log.debug(
                    "notation backfill: legacy-midi mirror failed for %s: %s",
                    eid,
                    exc,
                )
                entry_failed = True

            try:
                entry_dir = store._dir_for(eid)  # noqa: SLF001 - module convention
                if entry_dir is not None:
                    # register_on_disk_artifacts only inserts (and returns) a
                    # row that did not already exist, so this count needs no
                    # before/after diff of its own.
                    recovered = register_on_disk_artifacts(store.db, entry_dir, eid)
                    res["disk_recovered"] += len(recovered)
            except Exception as exc:  # noqa: BLE001 - best-effort, keep scanning
                log.debug(
                    "notation backfill: on-disk artifact recovery failed for %s: %s",
                    eid,
                    exc,
                )
                entry_failed = True

            if entry_failed:
                res["errors"] += 1
                failed_ids.append(eid)

        if start + batch < len(target_ids):
            time.sleep(_MIGRATION_BATCH_PAUSE_SEC)

    # Attempts are tracked per id so a permanently-failing entry (or a
    # systemic failure that fails every id on the first, full-library run)
    # cannot retry forever: after _MAX_ID_ATTEMPTS, that id is abandoned
    # rather than carried into pending_ids for the next launch. Without this,
    # an all-fail first run pends the WHOLE library, and every later launch
    # re-walks that same whole list again, forever.
    attempts = dict(state.get("attempts") or {})
    abandoned: list[str] = []
    retryable: list[str] = []
    for eid in failed_ids:
        attempts[eid] = int(attempts.get(eid, 0)) + 1
        if attempts[eid] >= _MAX_ID_ATTEMPTS:
            abandoned.append(eid)
        else:
            retryable.append(eid)
    if abandoned:
        log.warning(
            "notation backfill: abandoning %d entry id(s) after %d failed "
            "attempts each (will not be retried again): %s",
            len(abandoned),
            _MAX_ID_ATTEMPTS,
            abandoned,
        )
    # Only ids still eligible for a retry need their count kept around.
    attempts = {eid: attempts[eid] for eid in retryable}

    if not retryable:
        new_state = {
            "done": True,
            "pending_ids": [],
            "attempts": {},
            "completed_at": time.time(),
            **res,
        }
    else:
        # Not done: only the ids still eligible for a retry carry over, so a
        # retry never re-scans entries that already succeeded (or that were
        # just abandoned).
        new_state = {
            "done": False,
            "pending_ids": retryable,
            "attempts": attempts,
            "completed_at": None,
            **res,
        }
    _write_migration_state(store.db, new_state)
    status = "done" if res["errors"] == 0 else f"{len(failed_ids)} id(s) pending retry"
    log.info(
        "notation backfill: legacy-artifacts migration %s: scanned=%d mirrored=%d "
        "disk_recovered=%d errors=%d",
        status,
        res["scanned"],
        res["mirrored"],
        res["disk_recovered"],
        res["errors"],
    )
    return res


def _contains_text(haystack: str, needle: str) -> bool:
    """True if ``needle`` appears in ``haystack`` literally or in its
    XML-escaped form (``&`` -> ``&amp;``, ``<`` -> ``&lt;``, ...).

    MusicXML writers escape reserved characters on write, so comparing only
    the raw form made any title or composer containing one (e.g. "Rock &
    Roll") look permanently missing and regenerate its sheet on every
    launch. See :func:`_needs_fix`.
    """
    if needle in haystack:
        return True
    escaped = _xml_escape(needle)
    return escaped != needle and escaped in haystack


def _rewrite_titles(path: Path, title: str, composer: str) -> bool:
    """Patch the printed title (and an existing composer credit) of a MusicXML
    file in place. Returns True if changed. Best-effort.

    This is the same ``ET.parse`` / ``tree.write`` round trip as the
    ``/pack`` route's non-part-scoped re-credit (fifth-audit MAJOR finding
    3) -- but run IN PLACE OVER THE USER'S REAL MusicXML on disk, from an
    automatic startup background pass, so its DOCTYPE- and comment-dropping
    is destructive rather than a discardable in-memory download. It shares
    that fix's ``.engine`` helpers to preserve both within this same write,
    with no second pass over the library.
    """
    if not title and not composer:
        return False
    from .engine import _musicxml_prolog_extras, _splice_musicxml_prolog_extras

    try:
        raw = path.read_bytes()
    except Exception:
        return False
    try:
        # insert_comments=True: preserves comments INSIDE the root too (not
        # just the pre-root ones ``prolog_extras`` captures) -- music21,
        # the writer used elsewhere in this module, emits interior
        # separator comments even in a trivial fragment.
        comment_parser = ET.XMLParser(target=ET.TreeBuilder(insert_comments=True))
        tree = ET.parse(io.BytesIO(raw), parser=comment_parser)
    except Exception:
        return False
    root = tree.getroot()
    changed = False
    for el in root.iter():
        if not isinstance(el.tag, str):
            continue  # a Comment/PI node inserted by insert_comments=True
        tag = el.tag.rsplit("}", 1)[-1]  # strip any namespace
        if title and tag in ("movement-title", "work-title"):
            if (el.text or "") != title:
                el.text = title
                changed = True
        elif tag == "credit-words" and (el.text or "").strip() == _PLACEHOLDER:
            el.text = title or composer
            changed = True
        elif (
            composer
            and tag == "creator"
            and (el.get("type") or "composer").strip().lower() == "composer"
        ):
            if (el.text or "") != composer:
                el.text = composer
                changed = True
    if changed:
        try:
            prolog_extras = _musicxml_prolog_extras(raw)
            buf = io.BytesIO()
            tree.write(buf, encoding="utf-8", xml_declaration=True)
            body = _splice_musicxml_prolog_extras(buf.getvalue(), prolog_extras)
            try:
                ET.fromstring(body)
            except ET.ParseError:
                # The splice itself failed to parse -- fall back to the
                # ET-only serialization (no DOCTYPE/prolog extras, but always
                # well-formed on its own). Re-validate THAT too: if the
                # failure came from injected text (a control character that
                # slipped past _strip_invalid_xml_chars) rather than the
                # prolog splice, buf.getvalue() is equally unparseable and
                # must never be written over the user's only copy.
                body = buf.getvalue()
                try:
                    ET.fromstring(body)
                except ET.ParseError:
                    return False
            atomic_write(path, body)
        except Exception:
            return False
    return changed


def _keeps_own_credit(sheet: dict[str, Any]) -> bool:
    """True for a sheet the user imported (``POST /api/notation/import`` or a
    corpus piece, see :mod:`.score_import`). Its title and composer are the
    file's own, so the backfill never retitles or re-credits it: the app's
    default artist is not the composer of an imported score."""
    raw = sheet.get("metadata_json") or {}
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            return False
    return isinstance(raw, dict) and bool(raw.get("imported"))


def _needs_fix(path: Path, title: str, composer: str) -> bool:
    """Cheap check (no music21 parse): does this sheet still need a title /
    composer fix?"""
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return False
    # Only flag the placeholder when we have a real title to replace it with;
    # otherwise an untitled entry would regenerate to music21's placeholder on
    # every launch forever.
    if title and _PLACEHOLDER in text:
        return True
    if title and not _contains_text(text, title):
        return True
    if composer and not _contains_text(text, composer):
        return True
    return False


def backfill_scores(store: Any) -> dict[str, int]:
    res = {"scanned": 0, "generated": 0, "fixed": 0, "skipped": 0, "errors": 0}
    if store.db is None:
        return res

    # The one-time legacy-midis mirror rides this same startup-enqueued,
    # idle-gated background pass (server.py enqueues `backfill_scores` at
    # launch); it no-ops immediately once its own marker says it already ran.
    try:
        migrate_legacy_midi_mirror(store)
    except Exception as exc:  # noqa: BLE001 - never let this block the sheet backfill
        log.debug("notation backfill: legacy-midi mirror migration skipped: %s", exc)

    try:
        from .engine import (
            _chart_artist,
            clean_title,
            midi_to_musicxml,
            sheet_output_path,
        )
    except Exception:
        return res

    try:
        entries = store.db.list_entries()
    except Exception:
        return res

    for entry in entries:
        eid = str(entry.get("id") or "")
        if not eid:
            continue
        res["scanned"] += 1
        # Read the title from the entry RECORD, the same source
        # engine.sheet_output_path derives the filename from and the /from-midi
        # route engraves with. Using the entries-table value here instead made
        # this writer stamp different content than that route for the same
        # artifact id, so _needs_fix saw a "wrong" title and regenerated the
        # sheet on every launch.
        record = store.get_entry(eid)
        record_title = (
            str(getattr(record, "title", "") or "") if record is not None else ""
        )
        title = clean_title(record_title)
        # Per-entry, matching every export path (:func:`_chart_artist`), not
        # the bare global name -- resolving the global composer once outside
        # this loop disagreed with the per-entry credit every export writes,
        # so _needs_fix saw a permanently "wrong" composer and regenerated
        # (or, on the fallback path below, overwrote a correct credit with
        # the wrong one) on every launch. Reuses the entry row already read
        # above instead of a second store.get_entry call.
        composer = _chart_artist(record)
        # The legacy-midis mirror is no longer done here per entry, per
        # launch: `migrate_legacy_midi_mirror` above covers every
        # pre-existing row once, and new midi rows are mirrored at the write
        # path that creates them.

        try:
            sheets = store.db.list_notation_artifacts(eid, kind="musicxml")
        except Exception:
            sheets = []

        has_sheet = bool(sheets)

        try:
            midis = store.db.list_midis(eid)
        except Exception:
            midis = []
        midis_by_id = {str(m.get("id") or ""): m for m in midis}

        if not has_sheet:
            # No sheet at all yet: pick any midi on disk to generate the
            # first one from.
            target = None
            for midi in midis:
                mp = midi.get("midi_path") or ""
                if mp and Path(mp).is_file():
                    target = midi
                    break
            if target is None:
                res["skipped"] += 1
                continue
            entry_dir = store._dir_for(eid)  # noqa: SLF001 - module convention
            if entry_dir is None:
                res["errors"] += 1
                continue
            midi_id = str(target.get("id") or "")
            out = sheet_output_path(store, eid, midi_id)
            if out is None:
                res["errors"] += 1
                continue
            try:
                result = midi_to_musicxml(
                    store.db,
                    entry_id=eid,
                    midi_path=Path(target["midi_path"]),
                    output_path=out,
                    source_ref=midi_id,
                    artifact_id=f"{midi_id}__musicxml",
                    # RAW record title, like /from-midi: the engraver cleans it
                    # itself, so passing the pre-cleaned value would diverge.
                    title=record_title,
                )
                if result.get("ok"):
                    res["generated"] += 1
                else:
                    res["errors"] += 1
            except Exception as exc:  # noqa: BLE001 - best-effort
                log.debug("notation backfill: regen failed for %s: %s", eid, exc)
                res["errors"] += 1
            continue

        # Sheets already exist: touch only the ones that actually need a fix.
        # Regenerating (or even title-patching) a sheet that is already
        # correct made this rewrite the already-correct sheet on every
        # launch when the entry has multiple sheets -- one per MIDI -- and
        # never converged on the actually stale ones (regressed SCORE-010).
        stale = [
            s
            for s in sheets
            if not _keeps_own_credit(s)
            and _needs_fix(Path(s.get("path") or ""), title, composer)
        ]
        if not stale:
            res["skipped"] += 1
            continue

        entry_dir = store._dir_for(eid)  # noqa: SLF001 - module convention
        if entry_dir is None:
            res["errors"] += 1
            continue

        fixed_any = False
        had_error = False
        for s in stale:
            # An existing sheet's ``source_ref`` IS the midi id it was
            # engraved from (both this writer and the /from-midi route set
            # it to exactly that, and register the sheet under artifact id
            # ``f"{midi_id}__musicxml"``). Regenerating from a DIFFERENT
            # midi mints a second sheet alongside this one instead of
            # re-pointing it (SCORE-010), so each stale sheet is fixed from
            # its own source_ref midi, never another sheet's.
            candidate = midis_by_id.get(str(s.get("source_ref") or ""))
            cp = candidate.get("midi_path") or "" if candidate is not None else ""
            if candidate is not None and cp and Path(cp).is_file():
                midi_id = str(candidate.get("id") or "")
                # The one path both writers of this sheet agree on (see
                # engine.sheet_output_path): same filename spelling AND the
                # same title source as the /from-midi route, so they cannot
                # ping-pong.
                out = sheet_output_path(store, eid, midi_id)
                if out is None:
                    had_error = True
                    continue
                engraved_ok = False
                try:
                    result = midi_to_musicxml(
                        store.db,
                        entry_id=eid,
                        midi_path=Path(candidate["midi_path"]),
                        output_path=out,
                        source_ref=midi_id,
                        artifact_id=f"{midi_id}__musicxml",
                        title=record_title,
                    )
                    engraved_ok = bool(result.get("ok"))
                except Exception as exc:  # noqa: BLE001 - best-effort
                    log.debug("notation backfill: regen failed for %s: %s", eid, exc)
                    engraved_ok = False
                if engraved_ok:
                    fixed_any = True
                else:
                    had_error = True
                    # Engrave failed: fall back to an in-place title patch so
                    # the sheet does not keep a stale title and get retried
                    # on every launch forever.
                    p = Path(s.get("path") or "")
                    if p.is_file() and _rewrite_titles(p, title, composer):
                        fixed_any = True
            else:
                # Source MIDI is gone: best-effort in-place title patch.
                p = Path(s.get("path") or "")
                if p.is_file() and _rewrite_titles(p, title, composer):
                    fixed_any = True

        # Independent, not elif: one sheet can fix cleanly while a sibling
        # sheet's engrave fails, and both must be visible in the tally
        # instead of the failure being masked by the other's success.
        if fixed_any:
            res["fixed"] += 1
        if had_error:
            res["errors"] += 1
        if not fixed_any and not had_error:
            res["skipped"] += 1

    log.info(
        "notation backfill: scanned=%(scanned)d generated=%(generated)d "
        "fixed=%(fixed)d skipped=%(skipped)d errors=%(errors)d",
        res,
    )
    return res
