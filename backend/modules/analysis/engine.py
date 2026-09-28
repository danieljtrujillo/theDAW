"""Orchestrate the analysis steps for a single library entry.

Read settings to decide what to run, run each step (ffprobe, tempo,
key, pitch, bars, rms), then write results to:

  - SQLite ``analysis`` table (one row per entry)
  - metadata.json next to the audio file (durable backup)
  - Update the entry's ``analysis_status`` field on the entries row

This module is callable from sync code; the BackgroundQueue wraps it in
an async shim. We deliberately avoid asyncio inside the engine so it can
also be invoked directly from a manual ``/run`` endpoint.

Analysis is a BACKGROUND writer of an entry's ``metadata.json``, so it
routinely overlaps a user editing the same entry in the UI. That file is the
library's source of truth, which is why :func:`persist_analysis` does its
read-modify-write under the library store's metadata lock and writes through
the store's own atomic writer rather than keeping a second, unsynchronized
copy of that logic here. See :func:`_metadata_guard`.
"""

from __future__ import annotations

import contextlib
import copy
import json
import logging
import os
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Callable, Optional

from backend.modules.library import store as library_store
from backend.modules.library.db import LibraryDB

from .bars import estimate_bars, estimate_loudness_lufs, estimate_rms_db
from .ffprobe import probe_file
from .key import detect_key
from .pitch import detect_pitch_stats

log = logging.getLogger(__name__)

#: Set once this process has written an entry's ``metadata.json`` with no
#: store to lock against (see :func:`_metadata_guard`). One debug line per
#: process, not one per analysis: on a library this size that would be tens
#: of thousands of identical lines.
_logged_unguarded_write = False


# Bump when the analysis pipeline changes in a way that should re-run already-
# analyzed tracks. v2: tempo now falls back to librosa so MP3s actually get a
# BPM (v1 rows persisted bpm=null because aubio can't open MP3). v3: rows now
# record whether the samples are float, which bit_depth alone never said — 32
# means pcm_s32le and pcm_f32le equally. The GET endpoint reports
# version<ANALYSIS_VERSION rows as 'pending' so they re-run.
#
# loudness_lufs is now actually computed (pyloudnorm) instead of always
# persisting null (LIB-003), but this deliberately did NOT bump the version:
# with ~200k library rows, a bump marks every row stale and re-decodes/
# re-analyzes the whole library on idle for one new field. New analyses, and
# any row re-analyzed for its own reasons, get loudness; nothing mass-requeues.
ANALYSIS_VERSION = 3

#: Analysis profiles.
#:
#: ``"full"`` runs every step and is what a catalogue / enrichment pass wants.
#:
#: ``"dj"`` runs ONLY what a DJ deck reads off a track — ffprobe, one shared
#: librosa decode, tempo + beats (and the detector's confidence), key, RMS —
#: and skips the two most expensive steps, neither of which the DJ tab shows:
#:
#:   * ``librosa.pyin`` pitch statistics: 6.5 s of an 11.4 s step budget on a
#:     3–4 minute MP3, i.e. more than half the analysis, for a number no deck
#:     reads.
#:   * integrated loudness: a SECOND full decode at the file's native rate and
#:     channel count, on top of the shared 22.05 kHz mono one (1.6 s).
#:
#: LUFS is deliberately NOT recomputed from the shared mono decode instead of
#: being skipped: BS.1770 weights channels, and a mono sum reads up to ~9.5 dB
#: low on wide stereo (see :func:`~backend.modules.analysis.bars.estimate_loudness_lufs`).
#: Cheap and exact are mutually exclusive here, so a ``dj`` run leaves the
#: field alone for a full run to fill rather than writing a wrong number into
#: a column other code trusts.
PROFILE_FULL = "full"
PROFILE_DJ = "dj"

#: Key stamped into the persisted ffprobe blob by a partial run, so a later
#: enrichment pass can find rows that still need the expensive steps. A full
#: run rewrites that blob wholesale and the key disappears with it, which is
#: what makes "the full run overwrites" true; a row with no key at all is a
#: full row, matching every row written before profiles existed.
PROFILE_MARKER_KEY = "_analysis_profile"


def profile_of_row(row: Optional[dict[str, Any]]) -> str:
    """Which profile wrote this stored analysis row.

    The marker lives inside the persisted ffprobe blob (a full run rewrites
    that blob wholesale, so the marker disappears with it). Every reader of a
    row goes through here rather than reaching into the blob, and a row with
    no marker -- which is every row written before profiles existed -- is a
    full row, not an unknown one.
    """
    if not row:
        return PROFILE_FULL
    blob: Any = row.get("ffprobe_json")
    if isinstance(blob, str):
        try:
            blob = json.loads(blob)
        except (TypeError, ValueError):
            blob = None
    if not isinstance(blob, dict):
        blob = row.get("ffprobe")
    marker = blob.get(PROFILE_MARKER_KEY) if isinstance(blob, dict) else None
    return marker if marker in (PROFILE_FULL, PROFILE_DJ) else PROFILE_FULL


#: How many analyses this PROCESS will run at once.
#:
#: This gate lives on :func:`analyze_and_persist` rather than on the HTTP
#: endpoint because the endpoint is not the only caller: the library store
#: enqueues background analyses through ``asyncio.to_thread(analyze_and_persist,
#: ...)``, and while the cap sat in the router that path walked straight past
#: it -- a background sweep and a deck load could decode the same file at the
#: same moment. One gate, at the one door every caller uses.
#:
#: Two, not one: one decode can be running while another analysis is inside
#: ffprobe or blocked on a lock, so a pair keeps a core busy without letting
#: the decodes pile up. Deliberately a constant rather than a setting -- it is
#: a property of the work (a decode is hundreds of MB and one core), not a
#: preference.
MAX_CONCURRENT_ANALYSES = 2

#: How long one run may hold a slot before the gate takes it back.
#:
#: A run that is still going after this long is either stuck -- the ffmpeg
#: fallback decode in ``backend/lib/audio_io.py`` waits up to 600 s -- or a
#: file long enough that it should not keep every other analysis waiting.
#: The run is not stopped (a thread cannot be); it carries on outside the cap
#: and its slot goes to the next caller. Two such runs used to block every
#: analysis caller in the process for ten minutes.
SLOT_LEASE_S = 120.0

#: How long a caller that joined a run already computing its entry waits for
#: that run before it gives up with :class:`AnalysisBusy`. Longer than the
#: slot lease, so a run that lost its slot still has time to finish.
FOLLOWER_WAIT_S = 180.0


class AnalysisBusy(TimeoutError):
    """The run already computing this entry did not finish within
    :data:`FOLLOWER_WAIT_S`. The caller may retry; nothing was cancelled."""


class _Gate:
    """:data:`MAX_CONCURRENT_ANALYSES` slots, handed out DJ runs first, each
    on a lease of :data:`SLOT_LEASE_S`.

    A plain semaphore served callers in no particular order, so a deck load's
    2-second ``dj`` run could wait behind two 20-second full runs from the
    background queue or the LOOM shard pipeline. Here every caller takes a
    ticket in one of two lines, and the next free slot goes to the head of the
    priority line whenever it has anyone in it.

    A slot whose lease has run out is counted free again, even though the run
    holding it is still going; that run's later :meth:`release` is then a
    no-op. Waiters re-check at the earliest lease deadline, so a stuck run
    frees its slot on time without any timer thread.

    A run that a priority caller joins while it is still waiting for a slot
    moves to the priority line (:meth:`promote`). Without that, a deck load
    that found the background queue's full run of the same track waiting in
    the ordinary line waited behind every full run queued before it.
    """

    def __init__(self, slots: int) -> None:
        self._slots = slots
        self._cond = threading.Condition()
        #: lease ticket -> monotonic deadline
        self._holders: dict[int, float] = {}
        self._lines: tuple[deque[int], deque[int]] = (deque(), deque())
        self._next_ticket = 0

    def _reclaim_expired(self, now: float) -> None:
        for ticket, deadline in list(self._holders.items()):
            if now >= deadline:
                del self._holders[ticket]
                log.warning(
                    "analysis.engine: a run held its slot past %.0f s; the slot "
                    "goes to the next caller and the run finishes outside the cap",
                    SLOT_LEASE_S,
                )

    def _head(self) -> Optional[int]:
        for line in self._lines:
            if line:
                return line[0]
        return None

    def acquire(self, *, priority: bool, run: Optional["_InFlight"] = None) -> int:
        """Wait for a slot and return its lease ticket.

        ``run`` is the single-flight run this caller leads. Its ticket is
        recorded on it, and a run already promoted before it got here queues
        in the priority line, all under the gate's lock so :meth:`promote`
        can never miss it.
        """
        with self._cond:
            self._next_ticket += 1
            ticket = self._next_ticket
            if run is not None:
                priority = priority or run.promoted
                run.ticket = ticket
            self._lines[0 if priority else 1].append(ticket)
            try:
                while True:
                    now = time.monotonic()
                    self._reclaim_expired(now)
                    if self._head() == ticket and len(self._holders) < self._slots:
                        break
                    # Wake at the earliest lease deadline, so an expired slot
                    # is reclaimed without anyone having to release it.
                    timeout = (
                        max(0.0, min(self._holders.values()) - now)
                        if self._holders
                        else None
                    )
                    self._cond.wait(timeout)
            except BaseException:
                for line in self._lines:
                    if ticket in line:
                        line.remove(ticket)
                self._cond.notify_all()
                raise
            for line in self._lines:
                if line and line[0] == ticket:
                    line.popleft()
                    break
            self._holders[ticket] = time.monotonic() + SLOT_LEASE_S
            # The next head may fit in a slot that is still free.
            self._cond.notify_all()
            return ticket

    def release(self, ticket: int) -> None:
        with self._cond:
            if self._holders.pop(ticket, None) is not None:
                self._cond.notify_all()

    def promote(self, run: "_InFlight") -> None:
        """Serve ``run`` from the priority line from now on.

        Marks the run first, so a leader that has not reached :meth:`acquire`
        yet queues in the priority line; a leader already waiting in the
        ordinary line moves to the back of the priority line. A run that
        already holds a slot has nothing left to wait for.
        """
        with self._cond:
            run.promoted = True
            ticket = run.ticket
            ordinary, first = self._lines[1], self._lines[0]
            if ticket is not None and ticket in ordinary:
                ordinary.remove(ticket)
                first.append(ticket)
                self._cond.notify_all()


_gate = _Gate(MAX_CONCURRENT_ANALYSES)


class _InFlight:
    """One running analysis, and the place its result is published.

    Followers wait on ``done`` and read ``payload``/``error``; they hold no
    slot while waiting, which is what keeps single-flight from deadlocking
    against the concurrency cap (a waiter can never be the thing the leader
    is waiting for). ``followers`` is how many callers joined this run
    instead of starting their own; ``profile`` is the profile it computes.
    ``ticket`` is the leader's gate ticket once it has queued, and
    ``promoted`` says a priority caller joined it (see :meth:`_Gate.promote`);
    both are read and written under the gate's lock.
    """

    __slots__ = (
        "done",
        "payload",
        "error",
        "followers",
        "profile",
        "ticket",
        "promoted",
    )

    def __init__(self, profile: str) -> None:
        self.done = threading.Event()
        self.payload: Optional[dict] = None
        self.error: Optional[BaseException] = None
        self.followers = 0
        self.profile = profile
        self.ticket: Optional[int] = None
        self.promoted = False


_inflight_lock = threading.Lock()
#: entry_id -> the run currently analysing that entry. At most ONE run per
#: entry, whatever its profile.
#:
#: This used to be keyed per (entry_id, profile), so a ``dj`` run and a full
#: run of one entry could overlap. Both read the stored row for the
#: carry-forward and both write the whole row, so whichever saved second won:
#: a dj save landing after a full one wrote the full run's pitch and prompt
#: back under the dj label, and a dj run that read the row before the full
#: run saved overwrote the fresh full result with the older values.
_inflight: dict[str, _InFlight] = {}


def _answers(running: str, wanted: str) -> bool:
    """Whether a run of profile ``running`` is a correct answer for a caller
    that asked for ``wanted``. A full run measures everything a dj run does,
    so it answers both; a dj run has no pitch and no LUFS, so joining it would
    hand a full-profile caller a wrong answer."""
    return running == wanted or running == PROFILE_FULL


def _follower_error(err: BaseException) -> BaseException:
    """A per-follower copy of the leader's exception, chained to it.

    Re-raising the one shared object from every follower thread appended each
    thread's frames to its traceback, so it grew with every raise.
    """
    try:
        clone = copy.copy(err)
    except Exception:  # an exception type copy cannot rebuild
        return err
    clone.__traceback__ = None
    clone.__cause__ = err
    return clone


def _single_flight(
    key: tuple[str, str],
    work: Callable[[], dict],
    *,
    priority: Optional[bool] = None,
) -> dict:
    """Run ``work`` under the concurrency cap, one run per entry at a time.

    ``key`` is ``(entry_id, profile)``. A request for an entry whose running
    analysis answers it (the same profile, or a full run for a dj request)
    does not start a second analysis: it waits for that run and returns (a
    copy of) its result, or re-raises (a copy of) its exception. A full
    request that finds a dj run in flight waits for it to finish and then runs
    its own, so two runs of one entry never overlap.

    Waiting is bounded by :data:`FOLLOWER_WAIT_S` (then :class:`AnalysisBusy`);
    the slot a leader holds is bounded by :data:`SLOT_LEASE_S`. ``priority``
    defaults to True for the dj profile: the gate serves DJ runs first, and a
    priority caller that joins a run still waiting for its slot moves that run
    to the priority line.
    """
    entry_id, profile = key
    if priority is None:
        priority = profile == PROFILE_DJ
    deadline = time.monotonic() + FOLLOWER_WAIT_S
    while True:
        with _inflight_lock:
            run = _inflight.get(entry_id)
            if run is None:
                run = _InFlight(profile)
                _inflight[entry_id] = run
                break
            joined = _answers(run.profile, profile)
            if joined:
                run.followers += 1
        if joined:
            log.debug("analysis.engine: joining the run already computing %s", key)
            if priority:
                _gate.promote(run)
        else:
            log.debug(
                "analysis.engine: %s waits for the %s run of the same entry",
                key,
                run.profile,
            )
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not run.done.wait(remaining):
            raise AnalysisBusy(
                f"analysis of {entry_id!r} is still running after "
                f"{FOLLOWER_WAIT_S:.0f} s"
            )
        if joined:
            if run.error is not None:
                raise _follower_error(run.error)
            # A copy per follower: nobody mutates a payload another caller holds.
            return dict(run.payload or {})
        # The run that was in the way has finished: go round again, to lead
        # the next run or join whichever one got there first.

    try:
        ticket = _gate.acquire(priority=priority, run=run)
        try:
            payload = work()
        finally:
            _gate.release(ticket)
        run.payload = payload
        return payload
    except BaseException as e:
        run.error = e
        raise
    finally:
        # Drop the entry BEFORE waking anyone: a request arriving after this
        # point must be able to start a fresh run rather than latch onto a
        # finished one.
        with _inflight_lock:
            if _inflight.get(entry_id) is run:
                del _inflight[entry_id]
        run.done.set()


#: Every scalar the analysis row keeps, in PAYLOAD key spelling.
#:
#: ``upsert_analysis`` writes the WHOLE row, so anything a partial run leaves
#: empty is written as NULL over whatever a previous run measured. The set is
#: deliberately "all of them", not "the ones the dj profile skips": a step can
#: also fail (``analyze_audio`` swallows a tempo failure into bpm=None,
#: beats=[], bpm_confidence=None), and a run that measured nothing must still
#: not destroy a row that did. See :func:`_carry_forward_partial`.
_PARTIAL_PROFILE_FIELDS = (
    "bpm",
    "bpm_confidence",
    "key",
    "scale",
    "pitch_mean_hz",
    "pitch_std_hz",
    "loudness_lufs",
    "rms_db",
    "bars_estimated",
    "genre",
    "genre_confidence",
    "prompt_guess",
    "prompt_confidence",
)


def analyze_audio(
    audio_path: Path,
    *,
    include_key: bool = True,
    include_pitch: bool = True,
    include_genre: bool = False,
    include_prompt: bool = True,
    profile: str = PROFILE_FULL,
) -> dict[str, Any]:
    """Pure analysis call — runs the configured steps, returns a flat
    dict. Idempotent; doesn't touch any persistence.

    ``profile`` selects WHICH steps run; see :data:`PROFILE_DJ`. It overrides
    ``include_pitch`` / ``include_prompt`` rather than being overridden by
    them, so a caller cannot ask for the DJ profile and still pay for pyin."""
    p = Path(audio_path)
    if not p.is_file():
        return {"error": "audio not found"}

    dj = profile == PROFILE_DJ
    if dj:
        # Both are pure cost for a deck: pyin dominates the step budget, and
        # the prompt generator would build a weaker prompt out of the fields
        # this profile deliberately does not measure and persist it over a
        # better one. /api/analysis/{id}/prompt regenerates prompts from the
        # stored row on read, so skipping it here costs no surface anything.
        include_pitch = False
        include_prompt = False

    out: dict[str, Any] = {
        "version": ANALYSIS_VERSION,
        "analyzed_at": time.time(),
        "profile": profile,
    }

    # ffprobe summary (sample rate, bit depth, codec, duration, ...)
    probe = probe_file(p)
    if dj:
        probe[PROFILE_MARKER_KEY] = PROFILE_DJ
    out["ffprobe"] = probe
    summary = probe.get("_summary") or {}
    out["sample_rate"] = summary.get("sample_rate")
    out["channels"] = summary.get("channels")
    out["bit_depth"] = summary.get("bit_depth")
    out["bit_depth_is_float"] = summary.get("bit_depth_is_float")
    out["codec"] = summary.get("codec")
    out["container"] = summary.get("container")
    duration_sec = summary.get("duration_sec")
    if duration_sec is not None:
        out["duration_sec"] = float(duration_sec)

    # Decode ONCE for the librosa-backed steps. Tempo fallback, RMS, key,
    # and pitch all historically called librosa.load(path, sr=22050,
    # mono=True) verbatim, so one shared decode replaces up to four
    # full-file decodes per analysis. On failure each helper falls back to
    # its own load and keeps its own error logging.
    try:
        import librosa

        y_sr: Optional[tuple] = librosa.load(str(p), sr=22050, mono=True)
    except Exception:
        y_sr = None

    # Tempo + beats (reuse chimera detector — it's the single source of
    # truth for BPM in this codebase).
    try:
        from backend.modules.chimera.detect import detect_tempo_and_beats

        tempo = detect_tempo_and_beats(p, y_sr=y_sr)
        out["bpm"] = tempo["bpm"]
        out["beats"] = list(tempo["beats"])
        # The detector has always computed this (aubio averages its per-hop
        # confidence; the librosa path derives one from beat-interval
        # spread) and it was thrown away here. A DJ needs it: a 0.1
        # confidence BPM is a number to show greyed out, not to beatmatch on.
        #
        # Clamped HERE, where it is produced, so the /run response, the
        # metadata.json backup and the stored column all carry the same
        # number: the aubio path averages its per-hop confidences with no
        # bound, and a clamp applied only on the way into the column let the
        # response hand the deck a raw 1.7.
        out["bpm_confidence"] = _unit_or_none(tempo.get("confidence"))
    except Exception as e:
        log.info("analysis.engine: tempo failed for %s: %s", p.name, e)
        out["bpm"] = None
        out["beats"] = []
        out["bpm_confidence"] = None

    out["bars_estimated"] = estimate_bars(out.get("beats") or [])
    out["rms_db"] = estimate_rms_db(p, y_sr=y_sr)
    # Native decode inside estimate_loudness_lufs — NOT the shared y_sr mono
    # decode the steps above use (see estimate_loudness_lufs' docstring), so
    # the dj profile skips it outright rather than paying a second decode.
    out["loudness_lufs"] = None if dj else estimate_loudness_lufs(p)

    if include_key:
        out.update(detect_key(p, y_sr=y_sr))
    if include_pitch:
        out.update(detect_pitch_stats(p, y_sr=y_sr))
    if include_genre:
        # Reserved — see plan §4.1. Heavy HF dep; skipping for now.
        out["genre"] = None
        out["genre_confidence"] = None

    if include_prompt:
        # Deterministic semantic tags + a Stable Audio-style prompt from the
        # numbers above. Cheap and pure; ML genre/mood enrichers (when added)
        # fold in via the ``genre`` field and embedded tags at persist time.
        from .prompt import generate_prompt

        generated = generate_prompt(out)
        out["prompt_guess"] = generated["prompt_guess"]
        out["prompt_confidence"] = generated["prompt_confidence"]
        out["semantic_tags"] = generated["semantic_tags"]

    return out


def _is_within(child: Path, parent: Path) -> bool:
    """Whether ``child`` lies under ``parent``.

    Case-insensitively on Windows, where the same directory reaches us as
    ``C:\\Users\\...`` from one caller and ``c:\\users\\...`` from another.
    Same idiom as ``backend/modules/candidates/store.py``'s ``_is_within``.
    """
    try:
        target = os.path.normcase(str(child.resolve()))
        root = os.path.normcase(str(parent.resolve()))
    except OSError:
        return False
    return target.startswith(root + os.sep)


def _store_guarding(
    metadata_path: Path, store: Optional[library_store.LibraryStore]
) -> Optional[library_store.LibraryStore]:
    """The :class:`~backend.modules.library.store.LibraryStore` that owns
    ``metadata_path``, or None when this process has none.

    A caller that hands us its store is preferred; otherwise we look for the
    app's singleton. It is looked up, never BUILT: constructing a
    ``LibraryStore`` opens the library database and auto-reindexes when that
    database is empty, which on this library means walking 200,000 entries --
    absurd for a writer that only needs a mutex, and it would point at the
    real library from a test or a CLI. So a process that has not already
    built one (a script, a unit test with its own root) simply gets None.

    Either way the store has to actually own the file: its lock only
    serializes writers holding THAT object, so a store rooted somewhere else
    would be a mutex nobody else takes -- the appearance of safety.
    """
    if store is not None and _is_within(metadata_path, Path(store.root)):
        return store
    try:
        from backend.modules.library import router as library_router
    except ImportError:  # pragma: no cover - the library module is always there
        return None
    # The module-level singleton `get_store()` memoizes. Read directly so an
    # absent one stays absent (see above); `get_store()` would create it.
    existing = getattr(library_router, "_store", None)
    if existing is not None and _is_within(metadata_path, Path(existing.root)):
        return existing
    return None


def _metadata_guard(
    metadata_path: Path, store: Optional[library_store.LibraryStore]
) -> contextlib.AbstractContextManager[Any]:
    """The mutex that serializes writes to one entry's ``metadata.json``.

    ``LibraryStore._meta_lock`` when this process has the store that owns the
    file -- the same lock ``update_entry`` takes, which is the whole point:
    analysis runs in the background while the user rates, tags and edits
    lyrics on the very entry being analyzed, and two unsynchronized
    read-modify-writes of one JSON document lose whichever edit was read
    first. On disk, permanently: ``reindex()`` rebuilds the database FROM
    these files, so it would copy the loss rather than repair it.

    Otherwise a null guard. The write itself is still atomic and still uses
    a unique temp file, so an unguarded write can corrupt nothing; what it
    cannot do is stop a concurrent writer's edit from being overwritten.
    """
    owner = _store_guarding(metadata_path, store)
    if owner is not None:
        return owner._meta_lock  # noqa: SLF001 — the documented shared lock
    global _logged_unguarded_write
    if not _logged_unguarded_write:
        _logged_unguarded_write = True
        log.warning(
            "analysis.engine: no library store owns %s — writing it atomically "
            "but unlocked (no store in this process)",
            metadata_path,
        )
    return contextlib.nullcontext()


def _read_entry_metadata(metadata_path: Path) -> Optional[dict[str, Any]]:
    """One entry's ``metadata.json`` as a dict, or None when it is unusable.

    None means DAMAGED -- missing, unreadable, not JSON, or JSON that is not
    an object -- and the caller must then leave the file ALONE. Writing over
    it would replace an entry's whole record (title, tags, rating, notes,
    lyrics, prompt) with a document holding nothing but the analysis we just
    computed, which is worse than the damage and is not repairable from the
    database. Same policy as
    :meth:`~backend.modules.library.store.LibraryStore.record_detected_providers`.

    Called INSIDE :func:`_metadata_guard`'s critical section; a read taken
    before the lock is exactly the stale copy the lock exists to prevent.
    """
    try:
        loaded = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        log.warning(
            "analysis.engine: %s is unreadable (%s) — leaving it untouched",
            metadata_path,
            e,
        )
        return None
    if not isinstance(loaded, dict):
        log.warning(
            "analysis.engine: %s does not hold a JSON object — leaving it untouched",
            metadata_path,
        )
        return None
    return loaded


def _unit_or_none(value: Any) -> Optional[float]:
    """A confidence as a float in [0, 1], or None when there is not one."""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return None
    return min(1.0, max(0.0, float(value)))


def persist_analysis(
    db: LibraryDB,
    entry_id: str,
    payload: dict[str, Any],
    *,
    metadata_path: Optional[Path] = None,
    embedded_tags: Optional[dict[str, Any]] = None,
    store: Optional[library_store.LibraryStore] = None,
) -> None:
    """Write analysis payload to SQLite + (optionally) the per-entry
    metadata.json so the data is portable even if the DB is wiped.

    ``metadata_path`` is an entry's own ``metadata.json``; the entry
    directory it is written back through is its parent.

    ``store`` is the library store that owns that entry, when the caller has
    one — it supplies the lock the file's other writers take. Omitted, the
    app's existing singleton is used if it owns the file; see
    :func:`_metadata_guard` for what happens when neither is available.

    The analysis itself is mirrored to the database by ``upsert_analysis``
    into the ``analysis`` table, which is what every reader of an analysis
    uses (``library/router.py`` builds ``entry["analysis"]`` from that row).
    ``$.analysis`` inside the ``entries.metadata_json`` column is read by
    nothing — no SQL, no Python, no frontend — so this deliberately does not
    mirror the metadata document into that column: it is a durable backup of
    the analysis for a wiped database, not a second source of truth.
    """
    db_payload = {
        "bpm": payload.get("bpm"),
        # Clamped again at the one door into the column: analyze_audio clamps
        # what it measures, but a payload can reach here from elsewhere (a
        # carried-forward row, a script), and a deck renders this as a bar --
        # >1 overflows it, <0 draws backwards.
        "bpm_confidence": _unit_or_none(payload.get("bpm_confidence")),
        "beats": payload.get("beats") or [],
        "key": payload.get("key"),
        "key_confidence": payload.get("confidence")
        if "confidence" in payload and "key" in payload
        else payload.get("key_confidence"),
        "scale": payload.get("scale"),
        "pitch_mean_hz": payload.get("pitch_mean_hz"),
        "pitch_std_hz": payload.get("pitch_std_hz"),
        "loudness_lufs": payload.get("loudness_lufs"),
        "rms_db": payload.get("rms_db"),
        "bars_estimated": payload.get("bars_estimated"),
        "genre": payload.get("genre"),
        "genre_confidence": payload.get("genre_confidence"),
        "prompt_guess": payload.get("prompt_guess"),
        "prompt_confidence": payload.get("prompt_confidence"),
        "semantic_tags": payload.get("semantic_tags") or [],
        "embedded_tags": embedded_tags or {},
        "ffprobe": payload.get("ffprobe") or {},
        "version": payload.get("version") or ANALYSIS_VERSION,
    }
    db.upsert_analysis(entry_id, db_payload)

    if metadata_path is not None and metadata_path.is_file():
        # One writer at a time per entry, across the WHOLE read-modify-write,
        # and the read taken inside it — the store's writers hold this same
        # lock over the same span.
        with _metadata_guard(metadata_path, store):
            meta = _read_entry_metadata(metadata_path)
            if meta is not None:
                meta["analysis"] = {
                    k: v for k, v in payload.items() if k != "ffprobe" and k != "beats"
                }
                meta["analysis"]["beats_count"] = len(payload.get("beats") or [])
                try:
                    # The store's writer, not a second copy of it: a unique
                    # temp file in the entry's own directory, atomically
                    # renamed into place, removed if anything fails. The
                    # fixed ``metadata.json.tmp`` this used to write was
                    # shared with every other writer of the same entry —
                    # their bytes mixed in that one file and the mixture was
                    # renamed over the real document.
                    library_store._write_metadata(metadata_path.parent, meta)  # noqa: SLF001
                except OSError as e:
                    log.warning(
                        "analysis.engine: failed to write metadata.json for %s: %s",
                        entry_id,
                        e,
                    )


def analyze_and_persist(
    db: LibraryDB,
    entry_id: str,
    audio_path: Path,
    *,
    metadata_path: Optional[Path] = None,
    settings: Optional[dict[str, Any]] = None,
    store: Optional[library_store.LibraryStore] = None,
    profile: str = PROFILE_FULL,
) -> dict[str, Any]:
    """Run one analysis for one entry, under the process-wide gate.

    EVERY caller enters here -- the ``/run`` endpoint, the library store's
    background queue, scripts -- so this is where the guarantees live:

      * at most :data:`MAX_CONCURRENT_ANALYSES` analyses hold a slot at once,
        DJ runs first, none for longer than :data:`SLOT_LEASE_S`;
      * at most one run of an entry at a time: a caller whose request the
        running analysis answers shares it instead of decoding the same file
        twice, and any other caller waits for it (see :func:`_single_flight`).

    See :func:`_analyze_and_persist` for what a run actually does.
    """
    return _single_flight(
        (entry_id, profile),
        lambda: _analyze_and_persist(
            db,
            entry_id,
            audio_path,
            metadata_path=metadata_path,
            settings=settings,
            store=store,
            profile=profile,
        ),
    )


def _analyze_and_persist(
    db: LibraryDB,
    entry_id: str,
    audio_path: Path,
    *,
    metadata_path: Optional[Path] = None,
    settings: Optional[dict[str, Any]] = None,
    store: Optional[library_store.LibraryStore] = None,
    profile: str = PROFILE_FULL,
) -> dict[str, Any]:
    """End-to-end: run analysis, persist to DB + metadata.json, update
    the entry's ``analysis_status`` to 'complete'.

    ``profile`` selects which steps run (see :data:`PROFILE_DJ`). A partial
    profile still persists, and still marks the entry 'complete' -- what it
    computed IS complete and correct -- but it never erases what it did not
    compute; see :func:`_carry_forward_partial`.

    ``store`` is passed straight to :func:`persist_analysis`, which needs it
    to take the same metadata lock the store's own writers take.

    Returns the full analysis payload (useful for the manual /run
    endpoint to echo back to the caller)."""
    settings = settings or {}
    include_key = bool(settings.get("include_key", True))
    include_genre = bool(settings.get("include_genre", False))

    # Some library rows are derived/variant entries (e.g. "<id>_00") that are
    # listed but have no row in `entries`; persisting analysis for them violates
    # the analysis→entries foreign key. Detect that up front so we still COMPUTE
    # + return the analysis (the UI gets BPM/key) but skip the DB write instead
    # of raising a 500.
    entry_exists = db.get_entry(entry_id) is not None

    # Mark running so the UI can show a chip. No revision bump: 'running' is
    # a chip that lasts seconds, and every bump of ``library_revision`` makes
    # each connected client refetch the entry list. Bumping here made that
    # TWICE per analysis (once for 'running', once for 'complete') -- across a
    # library-wide sweep, one wasted full list refetch per track.
    if entry_exists:
        _set_status(db, entry_id, "running", bump_revision=False)
    try:
        payload = analyze_audio(
            audio_path,
            include_key=include_key,
            include_pitch=True,
            include_genre=include_genre,
            profile=profile,
        )
        if not entry_exists:
            log.info(
                "analysis.engine: %s has no entries row (derived/variant?) — "
                "computed analysis but not persisting",
                entry_id,
            )
            return payload
        # Pull embedded tags from metadata.json if present so we
        # persist them alongside analysis (keeps everything in one
        # place for downstream lineage / dataset export).
        embedded: dict[str, Any] = {}
        if metadata_path and metadata_path.is_file():
            try:
                m = json.loads(metadata_path.read_text(encoding="utf-8"))
                if isinstance(m.get("embedded_tags"), dict):
                    embedded = m["embedded_tags"]
            except (OSError, json.JSONDecodeError):
                pass

        if profile != PROFILE_FULL:
            prior = _carry_forward_partial(db, entry_id, payload, embedded)
        else:
            prior = _stored_row(db, entry_id)
        _keep_stored_probe(prior, payload)
        if profile != PROFILE_FULL:
            _keep_full_label(prior, payload)

        # Fold any embedded tags into a richer prompt than the analysis-only
        # baseline computed in analyze_audio. AFTER the carry-forward: a dj
        # run measures no pitch and no loudness, and building the prompt from
        # its own payload wrote a prompt with no timbre or energy words over
        # the full run's, every time a tagged track was loaded on a deck.
        # Built from the merged row, it keeps what the full run knew and
        # takes the fresh BPM and key.
        if embedded:
            from .prompt import generate_prompt

            entry_row = db.get_entry(entry_id) or {}
            regenerated = generate_prompt(
                payload,
                embedded_tags=embedded,
                title=str(entry_row.get("title") or ""),
            )
            payload["prompt_guess"] = regenerated["prompt_guess"]
            payload["prompt_confidence"] = regenerated["prompt_confidence"]
            payload["semantic_tags"] = regenerated["semantic_tags"]

        persist_analysis(
            db,
            entry_id,
            payload,
            metadata_path=metadata_path,
            embedded_tags=embedded,
            store=store,
        )
        _set_status(db, entry_id, "complete")
        return payload
    except Exception as e:
        log.warning("analysis.engine: failed for %s: %s", entry_id, e)
        _set_status(db, entry_id, "failed")
        raise


def _loads_list(raw: Any) -> list:
    """Parse a stored JSON array column; anything else reads as empty."""
    if not isinstance(raw, str):
        return []
    try:
        out = json.loads(raw)
    except (TypeError, ValueError):
        return []
    return out if isinstance(out, list) else []


def _stored_row(db: LibraryDB, entry_id: str) -> Optional[dict[str, Any]]:
    """The entry's stored analysis row, or None when there is none (or the
    read fails -- a broken database fails loudly at persist instead)."""
    try:
        return db.get_analysis(entry_id)
    except Exception as e:  # pragma: no cover - a broken DB fails at persist
        log.debug("analysis.engine: no prior row for %s: %s", entry_id, e)
        return None


#: The flat payload fields ``analyze_audio`` copies out of the ffprobe summary.
_PROBE_SUMMARY_FIELDS = (
    "sample_rate",
    "channels",
    "bit_depth",
    "bit_depth_is_float",
    "codec",
    "container",
    "duration_sec",
)


def _keep_stored_probe(
    prior: Optional[dict[str, Any]], payload: dict[str, Any]
) -> None:
    """Keep the stored ffprobe data when this run's ffprobe measured nothing.

    ``probe_file`` returns ``{}`` when ffprobe is missing or times out (20 s,
    a sleeping external drive is enough), and ``upsert_analysis`` writes the
    whole row, so one slow probe used to erase the sample rate, bit depth,
    codec and duration the library and the Details panel read -- in a full
    run and a dj run alike. A probe that did measure (it has a ``_summary``)
    always wins; only an empty one falls back to the stored blob. The profile
    marker is this run's, never the stored one's.
    """
    probe = payload.get("ffprobe")
    probe = probe if isinstance(probe, dict) else {}
    if probe.get("_summary") or not prior:
        return
    try:
        stored = json.loads(prior.get("ffprobe_json") or "{}")
    except (TypeError, ValueError):
        return
    if not isinstance(stored, dict) or not isinstance(stored.get("_summary"), dict):
        return
    kept = {k: v for k, v in stored.items() if k != PROFILE_MARKER_KEY}
    if PROFILE_MARKER_KEY in probe:
        kept[PROFILE_MARKER_KEY] = probe[PROFILE_MARKER_KEY]
    payload["ffprobe"] = kept
    summary = kept["_summary"]
    for field in _PROBE_SUMMARY_FIELDS:
        if payload.get(field) is None and summary.get(field) is not None:
            payload[field] = summary[field]


def _keep_full_label(prior: Optional[dict[str, Any]], payload: dict[str, Any]) -> None:
    """A partial run over a FULL row leaves the row labelled full.

    The carry-forward keeps every field the full run measured (pitch, LUFS,
    the prompt built from them), so what gets saved is full data with a
    fresh BPM, key and RMS on top. Stamping it with the dj marker told every
    reader -- ``GET /api/analysis/{id}``, ``entry.analysis`` -- that a
    complete row was a partial one, and any pass that upgrades dj rows would
    re-analyse it for nothing.

    Only a CURRENT full row keeps the label. A full row from an older
    ``ANALYSIS_VERSION`` is stale -- ``GET /api/analysis/{id}`` reports it
    pending so it gets re-measured -- and its carried pitch, LUFS and prompt
    are old data. Saving that as a current full row hid it from the version
    heal for good, so it is saved as a dj row and a full pass re-measures it.
    """
    if not prior or profile_of_row(prior) != PROFILE_FULL:
        return
    if int(prior.get("version") or 0) < ANALYSIS_VERSION:
        return
    probe = payload.get("ffprobe")
    if isinstance(probe, dict):
        probe.pop(PROFILE_MARKER_KEY, None)
    payload["profile"] = PROFILE_FULL


def _carry_forward_partial(
    db: LibraryDB,
    entry_id: str,
    payload: dict[str, Any],
    embedded: Optional[dict[str, Any]] = None,
) -> Optional[dict[str, Any]]:
    """Keep everything a partial run did not produce, and return the stored
    row it read (None when there was none).

    INVARIANT: a partial (``dj``) analysis never erases a persisted field it
    did not measure -- whether it skipped that step on purpose or the step
    failed.

    ``upsert_analysis`` writes the WHOLE row, so persisting a dj payload
    verbatim nulls out every column the payload left empty: a 3-second run
    destroying the result of a 12-second one, with no way back but re-decoding
    the file. The obvious half is the steps the profile skips (pitch, LUFS,
    the prompt built from them). The other half is failure: ``analyze_audio``
    swallows a tempo failure into ``bpm=None`` / ``beats=[]`` /
    ``bpm_confidence=None``, so one unlucky re-run used to wipe a measured BPM
    and beatgrid. Both are the same bug, so this restores ANY field the
    payload left empty from the stored row.

    Only empty fields are restored, so everything the partial run DID measure
    still wins -- a dj re-run of an old row is an update, not a no-op.

    ``ffprobe`` is not carried forward here: it is the blob the profile
    marker lives in. :func:`_keep_stored_probe` restores it when this run's
    probe measured nothing, and :func:`_keep_full_label` decides the label.
    """
    prior = _stored_row(db, entry_id)
    if not prior:
        return None
    carried: set[str] = set()
    for field in _PARTIAL_PROFILE_FIELDS:
        if payload.get(field) is None and prior.get(field) is not None:
            payload[field] = prior[field]
            carried.add(field)
    if not payload.get("beats"):
        # The row keeps beats as a JSON string; the payload carries a list.
        beats = _loads_list(prior.get("beats_json"))
        if beats:
            payload["beats"] = beats
            if payload.get("bars_estimated") is None:
                payload["bars_estimated"] = prior.get("bars_estimated")
    # key_confidence is spelled ``confidence`` by detect_key and read back out
    # by persist_analysis under that name when it is present, so restoring the
    # stored value means removing the empty one the failed step left behind.
    #
    # It rides with the KEY, not on its own: a confidence measures one specific
    # key, so it may only be restored while the row still names that key --
    # either because the key was carried forward, or because this run measured
    # the very same key again. Restoring it whenever the payload had none
    # pinned the previous key's confidence onto a DIFFERENT, freshly measured
    # key. (Two absent keys are not "the same key": that would attach a
    # confidence to a row that names no key at all.)
    same_key = payload.get("key") is not None and payload.get("key") == prior.get("key")
    if payload.get("confidence") is None and payload.get("key_confidence") is None:
        payload.pop("confidence", None)
        if ("key" in carried or same_key) and prior.get("key_confidence") is not None:
            payload["key_confidence"] = prior["key_confidence"]
    if embedded is not None and not embedded:
        stored = prior.get("embedded_tags_json")
        try:
            tags = json.loads(stored) if isinstance(stored, str) else None
        except (TypeError, ValueError):
            tags = None
        if isinstance(tags, dict) and tags:
            embedded.update(tags)
    if not payload.get("semantic_tags"):
        # Stored as a JSON string; the payload carries a list.
        try:
            tags = json.loads(prior.get("semantic_tags_json") or "[]")
        except (TypeError, ValueError):
            tags = []
        if isinstance(tags, list) and tags:
            payload["semantic_tags"] = tags
    return prior


def _set_status(
    db: LibraryDB, entry_id: str, status: str, *, bump_revision: bool = True
) -> None:
    try:
        # Lightweight UPDATE: we don't go through upsert_entry because
        # we don't want to rewrite every column.
        with db._txn(bump_revision=bump_revision) as cur:  # noqa: SLF001
            cur.execute(
                "UPDATE entries SET analysis_status = ?, updated_at = ? WHERE id = ?",
                (status, time.time(), entry_id),
            )
    except Exception as e:
        log.debug(
            "analysis.engine: status update failed for %s -> %s: %s",
            entry_id,
            status,
            e,
        )
