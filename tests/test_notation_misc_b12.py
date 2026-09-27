"""Tests for T10 (batch 12): notation backfill target selection + XML-escaped
title matching, tab-PDF artist credit, and PDF-renderable-suffix validation.

SCORE-010: backfill must regenerate the SAME sheet an existing artifact
references (via its ``source_ref``), not blindly the entry's chronologically
first MIDI, or a second orphaned sheet gets minted under a different id.

SCORE-011: ``_needs_fix`` compared a raw title against XML-escaped file
content, so any title with an XML-reserved character (``&``, ``<``, ``>``)
was seen as permanently missing and regenerated every launch.

SCORE-012: the tab-PDF renderer command dropped ``--artist`` for tablature
even though ``renderTabPdf.mjs`` accepts and prints it.

SCORE-016: ``PDF_RENDERABLE_SUFFIXES`` was declared but never consulted, so
an unsupported source suffix fell through to the node renderer instead of
failing with a clear message.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pretty_midi

from backend.modules.library.store import LibraryStore
from backend.modules.notation import engine as _engine
from backend.modules.notation import pdf_render
from backend.modules.notation.backfill import _needs_fix, backfill_scores
from backend.modules.notation.engine import midi_to_musicxml, sheet_output_path


def _write_scale_midi(path: Path) -> None:
    """Write a tiny C-major scale as a Standard MIDI File."""
    pm = pretty_midi.PrettyMIDI()
    inst = pretty_midi.Instrument(program=0)
    for i, pitch in enumerate([60, 62, 64, 65, 67, 69, 71, 72]):
        start = i * 0.5
        inst.notes.append(
            pretty_midi.Note(velocity=100, pitch=pitch, start=start, end=start + 0.5)
        )
    pm.instruments.append(inst)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))


def _seed_entry(root: Path, entry_id: str, title: str) -> Path:
    """The on-disk layout LibraryStore reads a single-file entry from."""
    entry_dir = root / entry_id
    entry_dir.mkdir(parents=True, exist_ok=True)
    (entry_dir / "output.wav").write_bytes(b"RIFF\x00\x00\x00\x00WAVE")
    meta = {
        "job_id": entry_id,
        "index": 0,
        "filename": "output.wav",
        "mime_type": "audio/wav",
        "title": title,
        "prompt": "test prompt",
        "duration": 4.0,
        "model": "medium",
        "steps": 8,
        "cfg": 1.0,
        "seed": 1,
        "favorite": False,
        "rating": None,
        "tags": [],
        "notes": "",
        "source": "generate",
        "saved_at": 1234567890.0,
    }
    (entry_dir / "metadata.json").write_text(json.dumps(meta), encoding="utf-8")
    return entry_dir


def _set_title(store: LibraryStore, entry_id: str, title: str) -> None:
    entry_dir = store._dir_for(entry_id)  # noqa: SLF001 - test convenience
    assert entry_dir is not None
    meta_path = entry_dir / "metadata.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["title"] = title
    meta_path.write_text(json.dumps(meta), encoding="utf-8")


# ---- SCORE-010: backfill target selection --------------------------------


def test_backfill_regenerates_the_midi_an_existing_sheet_references(
    tmp_path: Path,
):
    """Two MIDIs on one entry; an existing sheet was already engraved from
    the SECOND (newer) one via its own ``source_ref``. Ageing the entry title
    makes the sheet need a fix. Backfill must regenerate from that SAME MIDI
    (source_ref) rather than the chronologically-first one, leaving exactly
    one sheet artifact for the entry."""
    entry_id = "track"
    _seed_entry(tmp_path, entry_id, "Original Title")
    store = LibraryStore(tmp_path)
    assert store.db is not None

    old_midi = tmp_path / "midi" / "old.mid"
    new_midi = tmp_path / "midi" / "new.mid"
    _write_scale_midi(old_midi)
    _write_scale_midi(new_midi)

    # Older MIDI, converted first (so a naive "first in list_midis" pick wins).
    store.db.add_midi(
        midi_id="old_midi",
        entry_id=entry_id,
        source="full",
        midi_path=str(old_midi),
        engine="basic_pitch",
        engine_version="0.4.0",
        notes_count=8,
    )
    # Newer MIDI, converted second.
    store.db.add_midi(
        midi_id="new_midi",
        entry_id=entry_id,
        source="full",
        midi_path=str(new_midi),
        engine="basic_pitch",
        engine_version="0.4.0",
        notes_count=8,
    )

    # Mirror what the /from-midi route does: engrave a sheet from the NEWER
    # midi specifically, registered under its own artifact id.
    out = sheet_output_path(store, entry_id, "new_midi")
    assert out is not None
    result = midi_to_musicxml(
        store.db,
        entry_id=entry_id,
        midi_path=new_midi,
        output_path=out,
        source_ref="new_midi",
        artifact_id="new_midi__musicxml",
        title="Original Title",
    )
    assert result["ok"] is True, result
    sheets = store.db.list_notation_artifacts(entry_id, kind="musicxml")
    assert len(sheets) == 1
    assert sheets[0]["id"] == "new_midi__musicxml"

    # Rename the song so the existing sheet's stamped title is now stale.
    _set_title(store, entry_id, "Renamed Title")

    res = backfill_scores(store)
    assert res["errors"] == 0, res

    sheets_after = store.db.list_notation_artifacts(entry_id, kind="musicxml")
    # Exactly one sheet: the fix re-pointed the SAME artifact id/midi rather
    # than minting a second sheet from the older midi.
    assert len(sheets_after) == 1, sheets_after
    assert sheets_after[0]["id"] == "new_midi__musicxml"

    text = Path(sheets_after[0]["path"]).read_text(encoding="utf-8")
    assert "Renamed Title" in text


# ---- SCORE-011: _needs_fix vs XML-escaped content -------------------------


def test_needs_fix_recognizes_xml_escaped_title(tmp_path: Path):
    """A title containing an XML-reserved character is written escaped by
    every real MusicXML writer; _needs_fix must recognize the escaped form
    as present instead of demanding the impossible unescaped one."""
    path = tmp_path / "sheet.musicxml"
    path.write_text(
        "<score-partwise><work><work-title>Rock &amp; Roll</work-title></work>"
        '<identification><creator type="composer">Salt &amp; Pepper</creator>'
        "</identification></score-partwise>",
        encoding="utf-8",
    )

    assert _needs_fix(path, "Rock & Roll", "Salt & Pepper") is False


def test_needs_fix_still_true_when_title_actually_missing(tmp_path: Path):
    path = tmp_path / "sheet.musicxml"
    path.write_text(
        "<score-partwise><work><work-title>Some Other Song</work-title></work>"
        "</score-partwise>",
        encoding="utf-8",
    )

    assert _needs_fix(path, "Rock & Roll", "") is True


def test_needs_fix_still_true_for_placeholder(tmp_path: Path):
    path = tmp_path / "sheet.musicxml"
    path.write_text(
        "<score-partwise><work><work-title>Music21 Fragment</work-title></work>"
        "</score-partwise>",
        encoding="utf-8",
    )

    assert _needs_fix(path, "Real Title", "") is True


# ---- SCORE-012 / SCORE-016: pdf_render ------------------------------------


def test_spawn_renderer_passes_artist_for_tablature(tmp_path: Path, monkeypatch):
    """renderTabPdf.mjs accepts --artist and prints it under the title; the
    dispatcher must not withhold it just because the source is tablature."""
    frontend_dir = tmp_path / "frontend"
    (frontend_dir / "node_modules" / "opensheetmusicdisplay").mkdir(parents=True)
    source = tmp_path / "song.alphatex"
    source.write_text('\\title "Song"\n.\n1.1 1.2 1.3 1.4|', encoding="utf-8")
    output = tmp_path / "song.pdf"

    monkeypatch.setattr(pdf_render, "_frontend_dir", lambda: frontend_dir)
    monkeypatch.setattr(pdf_render, "_node_path", lambda: "node")

    captured: dict[str, Any] = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        return subprocess.CompletedProcess(
            cmd, 0, stdout=json.dumps({"ok": True, "pages": 1, "bytes": 10}), stderr=""
        )

    monkeypatch.setattr(pdf_render.subprocess, "run", fake_run)

    result = pdf_render._spawn_renderer(source, output, artist="The Artist")

    assert result["ok"] is True, result
    cmd = captured["cmd"]
    assert "--artist" in cmd
    assert cmd[cmd.index("--artist") + 1] == "The Artist"


def test_spawn_renderer_rejects_unsupported_source_suffix(tmp_path: Path):
    """The suffix gate must fire before the node/frontend checks (it does not
    monkeypatch either), so PDF_RENDERABLE_SUFFIXES is enforced regardless of
    whether a real renderer is installed in the test environment."""
    source = tmp_path / "not_a_score.mid"
    source.write_bytes(b"MThd")
    output = tmp_path / "out.pdf"

    result = pdf_render._spawn_renderer(source, output, artist="Someone")

    assert result["ok"] is False
    assert "cannot engrave" in result["error"]
    assert ".mid" in result["error"]
    for suffix in sorted(pdf_render.PDF_RENDERABLE_SUFFIXES):
        assert suffix in result["error"]


# ---- audit finding: backfill must only touch sheets that need fixing ------


def _seed_two_sheet_entry(tmp_path: Path, entry_id: str, title: str) -> LibraryStore:
    """Entry with two MIDIs and one sheet engraved from each (mirrors two
    /from-midi calls), so backfill can be exercised per-sheet."""
    _seed_entry(tmp_path, entry_id, title)
    store = LibraryStore(tmp_path)
    assert store.db is not None

    midi_a = tmp_path / "midi" / "a.mid"
    midi_b = tmp_path / "midi" / "b.mid"
    _write_scale_midi(midi_a)
    _write_scale_midi(midi_b)

    store.db.add_midi(
        midi_id="midi_a",
        entry_id=entry_id,
        source="full",
        midi_path=str(midi_a),
        engine="basic_pitch",
        engine_version="0.4.0",
        notes_count=8,
    )
    store.db.add_midi(
        midi_id="midi_b",
        entry_id=entry_id,
        source="full",
        midi_path=str(midi_b),
        engine="basic_pitch",
        engine_version="0.4.0",
        notes_count=8,
    )

    for midi_id in ("midi_a", "midi_b"):
        out = sheet_output_path(store, entry_id, midi_id)
        assert out is not None
        midi_path = midi_a if midi_id == "midi_a" else midi_b
        result = midi_to_musicxml(
            store.db,
            entry_id=entry_id,
            midi_path=midi_path,
            output_path=out,
            source_ref=midi_id,
            artifact_id=f"{midi_id}__musicxml",
            title=title,
        )
        assert result["ok"] is True, result

    sheets = store.db.list_notation_artifacts(entry_id, kind="musicxml")
    assert len(sheets) == 2
    return store


def test_backfill_only_regenerates_stale_sheet_when_one_midi_is_gone(
    tmp_path: Path, monkeypatch
):
    """Two sheets; one MIDI deleted from disk. Run 1 must fix BOTH stale
    sheets (regenerating the one whose MIDI survives, patching the other in
    place) and only invoke the engraver for the sheet with a live MIDI. Run 2
    must find nothing stale, skip the entry, and never call the engraver."""
    entry_id = "track"
    store = _seed_two_sheet_entry(tmp_path, entry_id, "Original Title")

    # midi_b's file is gone; its sheet can only be title-patched in place.
    midi_b_record = store.db.list_midis(entry_id)
    midi_b_path = next(
        Path(m["midi_path"]) for m in midi_b_record if m["id"] == "midi_b"
    )
    midi_b_path.unlink()

    _set_title(store, entry_id, "Renamed Title")

    calls = {"n": 0}
    real_fn = _engine.midi_to_musicxml

    def counting_fn(*args, **kwargs):
        calls["n"] += 1
        return real_fn(*args, **kwargs)

    monkeypatch.setattr(_engine, "midi_to_musicxml", counting_fn)

    res1 = backfill_scores(store)
    assert res1["errors"] == 0, res1
    assert calls["n"] == 1, "engraver must run only for the sheet with a live MIDI"

    sheets_after = {
        s["id"]: Path(s["path"])
        for s in store.db.list_notation_artifacts(entry_id, kind="musicxml")
    }
    assert len(sheets_after) == 2
    for path in sheets_after.values():
        assert "Renamed Title" in path.read_text(encoding="utf-8")

    # Run 2: nothing left to fix, engraver must not run again.
    calls["n"] = 0
    res2 = backfill_scores(store)
    assert res2["errors"] == 0, res2
    assert calls["n"] == 0, "run 2 must not re-engrave already-fixed sheets"
    assert res2["skipped"] == 1
    assert res2["fixed"] == 0


def test_backfill_fixes_both_sheets_in_one_run_when_both_midis_present(
    tmp_path: Path, monkeypatch
):
    """Two sheets, both MIDIs present, entry renamed. A single backfill run
    must regenerate BOTH sheets from their own source_ref MIDI, never
    re-engraving a sheet that was already correct, and never collapsing the
    two artifacts into one."""
    entry_id = "track"
    store = _seed_two_sheet_entry(tmp_path, entry_id, "Original Title")

    _set_title(store, entry_id, "Renamed Title")

    calls: list[str] = []
    real_fn = _engine.midi_to_musicxml

    def counting_fn(*args, **kwargs):
        calls.append(kwargs.get("source_ref") or (args[3] if len(args) > 3 else ""))
        return real_fn(*args, **kwargs)

    monkeypatch.setattr(_engine, "midi_to_musicxml", counting_fn)

    res = backfill_scores(store)
    assert res["errors"] == 0, res
    assert sorted(calls) == ["midi_a", "midi_b"], calls

    sheets_after = store.db.list_notation_artifacts(entry_id, kind="musicxml")
    assert {s["id"] for s in sheets_after} == {"midi_a__musicxml", "midi_b__musicxml"}
    for s in sheets_after:
        text = Path(s["path"]).read_text(encoding="utf-8")
        assert "Renamed Title" in text


# ---- re-audit follow-ups: independent error counting + failed-engrave fallback


def test_backfill_counts_fixed_and_errors_independently(tmp_path: Path, monkeypatch):
    """One sheet fixes cleanly (fixed_any), a sibling sheet's engrave fails
    and its fallback title-patch also can't help (no title elements to
    rewrite). The entry must report BOTH fixed and errors, not let a
    successful sheet mask the other's failure via an elif."""
    entry_id = "track"
    store = _seed_two_sheet_entry(tmp_path, entry_id, "Original Title")

    # Replace sheet_a's content with something _rewrite_titles cannot patch
    # (no movement-title/work-title/credit-words/composer elements) so a
    # failed-engrave fallback patch is a genuine no-op for it.
    sheet_a = next(
        s
        for s in store.db.list_notation_artifacts(entry_id, kind="musicxml")
        if s["id"] == "midi_a__musicxml"
    )
    Path(sheet_a["path"]).write_text(
        "<score-partwise><part id='P1'></part></score-partwise>", encoding="utf-8"
    )

    _set_title(store, entry_id, "Renamed Title")

    real_fn = _engine.midi_to_musicxml

    def selective_fail(*args, **kwargs):
        if kwargs.get("source_ref") == "midi_a":
            return {"ok": False, "error": "forced failure"}
        return real_fn(*args, **kwargs)

    monkeypatch.setattr(_engine, "midi_to_musicxml", selective_fail)

    res = backfill_scores(store)

    assert res["fixed"] == 1, res
    assert res["errors"] == 1, res
    assert res["skipped"] == 0, res


def test_backfill_patches_title_in_place_when_engrave_always_fails(
    tmp_path: Path, monkeypatch
):
    """A sheet whose MIDI exists but whose engrave call always fails must not
    be retried forever with a stale title: run 1 falls back to an in-place
    title patch (and still reports the error), run 2 finds it already
    correct and never calls the engraver."""
    entry_id = "track"
    _seed_entry(tmp_path, entry_id, "Original Title")
    store = LibraryStore(tmp_path)
    assert store.db is not None

    midi_a = tmp_path / "midi" / "a.mid"
    _write_scale_midi(midi_a)
    store.db.add_midi(
        midi_id="midi_a",
        entry_id=entry_id,
        source="full",
        midi_path=str(midi_a),
        engine="basic_pitch",
        engine_version="0.4.0",
        notes_count=8,
    )
    out = sheet_output_path(store, entry_id, "midi_a")
    assert out is not None
    result = midi_to_musicxml(
        store.db,
        entry_id=entry_id,
        midi_path=midi_a,
        output_path=out,
        source_ref="midi_a",
        artifact_id="midi_a__musicxml",
        title="Original Title",
    )
    assert result["ok"] is True, result

    _set_title(store, entry_id, "Renamed Title")

    calls = {"n": 0}

    def always_fail(*args, **kwargs):
        calls["n"] += 1
        return {"ok": False, "error": "forced failure"}

    monkeypatch.setattr(_engine, "midi_to_musicxml", always_fail)

    res1 = backfill_scores(store)
    assert calls["n"] == 1
    assert res1["errors"] == 1, res1

    sheets = store.db.list_notation_artifacts(entry_id, kind="musicxml")
    assert len(sheets) == 1
    text = Path(sheets[0]["path"]).read_text(encoding="utf-8")
    assert "Renamed Title" in text

    calls["n"] = 0
    res2 = backfill_scores(store)
    assert calls["n"] == 0, "run 2 must not call the engraver again"
    assert res2["skipped"] == 1, res2
    assert res2["fixed"] == 0, res2
    assert res2["errors"] == 0, res2
