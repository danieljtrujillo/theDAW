"""Batch 12 / T09 tests for the notation engine.

Covers four evidence-backed defects:

  - SCORE-002: :mod:`backend.modules.notation.identity` was unwired -- every
    generated chart / level was credited to the single global composer name
    even when the entry's own filename carries a confident "Artist - Song"
    split. ``_chart_artist`` now reads that split first and only falls back
    to the global name when identity has none to offer.
  - SCORE-005: the note chart's ``audio`` block was always written with a
    blank ``filename``/``mimeType`` because ``write_notechart`` /
    ``build_notechart`` were never given ``audio=``. ``_chart_audio_block``
    now fills it from the entry's own library record.
  - SCORE-007: ``capabilities()["formats"]`` advertised ``midi`` / ``json`` /
    ``alphatex`` as export targets that ``POST /{entry_id}/export`` (keyed on
    ``_EXT_FOR_FORMAT`` in router.py) has never accepted.
  - SCORE-013: a tab (``.alphatex``) source handed to the PDF/SVG engraver
    was staged through music21 first -- which cannot parse alphaTex at all --
    instead of reaching the alphaTab-capable renderer directly.
"""

from __future__ import annotations

import ast
import io
import json
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any

import mido  # type: ignore[import]
import pretty_midi  # type: ignore[import]
import pytest

from backend.modules.library.db import LibraryDB
from backend.modules.notation import engine
from backend.modules.notation.arrangers.score_arrange import STYLES


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


# ---------------------------------------------------------------------------
# SCORE-002 + SCORE-005: identity + audio block wiring, via the notechart path
# ---------------------------------------------------------------------------


def test_notechart_credits_the_entrys_own_identity_split(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(
        {
            "id": "track",
            "title": "Portishead - Roads",
            "audio_filename": "roads.wav",
            "mime": "audio/wav",
        }
    )
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)

    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="notechart",
        output_path=tmp_path / "notation" / "scale.notechart.json",
        title="Portishead - Roads",
        audio_duration_sec=4.0,
    )
    assert result["ok"] is True, result
    chart = json.loads(Path(result["path"]).read_text(encoding="utf-8"))
    # The entry's own name split confidently -- "Portishead" -- so it wins
    # over the global GANTASMO composer credit.
    assert chart["source"]["artist"] == "Portishead"
    assert chart["source"]["composer"] == "Portishead"
    # SCORE-005: the audio block names the real source file instead of "".
    assert chart["audio"]["filename"] == "roads.wav"
    assert chart["audio"]["mimeType"] == "audio/wav"


def test_notechart_falls_back_to_the_global_credit_when_identity_has_none(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    db = LibraryDB(tmp_path / "library.db")
    # "Blade Runner - 2049" is a deliberate non-split (year on the right, see
    # identity.py): identity answers "" rather than guess, so this must fall
    # back to the configured composer credit.
    db.upsert_entry({"id": "track", "title": "Blade Runner - 2049"})
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)

    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="notechart",
        output_path=tmp_path / "notation" / "scale.notechart.json",
        title="Blade Runner - 2049",
        audio_duration_sec=4.0,
    )
    assert result["ok"] is True, result
    chart = json.loads(Path(result["path"]).read_text(encoding="utf-8"))
    assert chart["source"]["artist"] == "GANTASMO"


def test_notechart_with_no_entry_row_falls_back_to_the_global_credit(
    tmp_path: Path, monkeypatch
) -> None:
    """When the identity lookup finds no entry row at all (e.g. a caller
    whose entry vanished between the request and the conversion), the chart
    must not crash; it degrades to the global credit and an empty audio
    block exactly like before this ticket. ``entry_id`` still has to name a
    real row for the artifact FK, so the "no entry" case is forced by
    stubbing ``db.get_entry`` rather than by an unknown id."""
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track", "title": "Portishead - Roads"})
    monkeypatch.setattr(db, "get_entry", lambda entry_id: None)
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)

    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="notechart",
        output_path=tmp_path / "notation" / "scale.notechart.json",
        audio_duration_sec=4.0,
    )
    assert result["ok"] is True, result
    chart = json.loads(Path(result["path"]).read_text(encoding="utf-8"))
    assert chart["source"]["artist"] == "GANTASMO"
    assert chart["audio"]["filename"] == ""


def test_beatsaber_chart_also_credits_the_entrys_own_identity_split(
    tmp_path: Path, monkeypatch
) -> None:
    """build_notechart is used a second time for the Beat Saber level; the
    same identity + audio wiring applies there too (engine.py:1401 area)."""
    from backend.modules.notation.exporters import beatsaber as beatsaber_mod

    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    monkeypatch.setattr(beatsaber_mod, "find_ffmpeg", lambda: None)
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(
        {
            "id": "track",
            "title": "Aphex Twin - Xtal",
            "audio_filename": "xtal.wav",
            "mime": "audio/wav",
        }
    )
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)

    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="beatsaber",
        output_path=tmp_path / "notation" / "beatsaber" / "scale.beatsaber.zip",
        title="Aphex Twin - Xtal",
        audio_duration_sec=4.0,
    )
    assert result["ok"] is True, result


def test_beatsaber_info_dat_credits_the_chart_artist_not_the_global_composer(
    tmp_path: Path, monkeypatch
) -> None:
    """Audit finding (MAJOR): ``write_beatsaber`` was still handed the global
    ``artist_name()`` for Info.dat's ``_songAuthorName`` even though
    ``build_notechart`` right above it already resolved the entry's own
    identity split. Both calls must share ONE ``_chart_artist(entry)`` value."""
    from backend.modules.notation.exporters import beatsaber as beatsaber_mod

    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    monkeypatch.setattr(beatsaber_mod, "find_ffmpeg", lambda: None)
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(
        {
            "id": "track",
            "title": "Aphex Twin - Xtal",
            "audio_filename": "xtal.wav",
            "mime": "audio/wav",
        }
    )
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)

    output_path = tmp_path / "notation" / "beatsaber" / "scale.beatsaber.zip"
    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="beatsaber",
        output_path=output_path,
        title="Aphex Twin - Xtal",
        audio_duration_sec=4.0,
    )
    assert result["ok"] is True, result

    with zipfile.ZipFile(output_path) as zf:
        info_names = [n for n in zf.namelist() if n.endswith("Info.dat")]
        assert info_names, zf.namelist()
        info = json.loads(zf.read(info_names[0]).decode("utf-8"))
    assert info["_songAuthorName"] == "Aphex Twin", info


# ---------------------------------------------------------------------------
# SCORE-007: capabilities() must only advertise what /export accepts
# ---------------------------------------------------------------------------


def test_capabilities_formats_matches_what_export_accepts() -> None:
    caps = engine.capabilities()
    # These are artifact *kinds* this module already produces some other way
    # (a registered MIDI, a note chart's raw dict, a tab arrangement), never
    # an /export target (_EXT_FOR_FORMAT in router.py has no entry for any of
    # them) -- advertising them here promised a conversion the route then
    # rejected with 422.
    assert "midi" not in caps["formats"]
    assert "json" not in caps["formats"]
    assert "alphatex" not in caps["formats"]
    # Chord tracks are built through their own POST /{entry_id}/chords route,
    # never through /export, so they are advertised as caps["chords"], not as
    # a caps["formats"] entry -- listing "chordtrack" there promised an
    # /export target that never existed (_EXT_FOR_FORMAT has no entry for it).
    assert "chordtrack" not in caps["formats"], caps["formats"]
    assert caps["chords"] is True
    # The real, always-available /export targets stay listed.
    for fmt in ("musicxml", "abc", "notechart", "beatsaber"):
        assert fmt in caps["formats"], caps["formats"]


def test_capabilities_formats_matches_router_export_targets(monkeypatch) -> None:
    """caps["formats"] must equal exactly the keys router.py's /export route
    accepts (_EXT_FOR_FORMAT), with pdf/svg present only when an engraver is
    available -- proven both ways by monkeypatching engraver detection."""
    from backend.modules.notation import router as notation_router

    always_on = set(notation_router._EXT_FOR_FORMAT) - {"pdf", "svg"}

    monkeypatch.setattr(engine, "musescore_binary", lambda: None)
    monkeypatch.setattr(
        engine.pdf_render, "available", lambda: {"ok": False, "node": None}
    )
    caps_no_engraver = engine.capabilities()
    assert set(caps_no_engraver["formats"]) == always_on, caps_no_engraver["formats"]

    monkeypatch.setattr(engine, "musescore_binary", lambda: "mscore")
    caps_with_engraver = engine.capabilities()
    assert set(caps_with_engraver["formats"]) == set(notation_router._EXT_FOR_FORMAT), (
        caps_with_engraver["formats"]
    )


# ---------------------------------------------------------------------------
# SCORE-013: a tab (.alphatex) PDF/SVG export must not route through music21
# ---------------------------------------------------------------------------


def test_tab_pdf_export_reaches_the_renderer_without_music21_staging(
    tmp_path: Path, monkeypatch
) -> None:
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track", "title": "Song"})
    tab_path = tmp_path / "notation" / "tabs" / "song.alphatex"
    tab_path.parent.mkdir(parents=True, exist_ok=True)
    tab_path.write_text('\\title "Song"\n.\n4.4.4|5.4.4|\n', encoding="utf-8")

    monkeypatch.setattr(
        engine.pdf_render, "available", lambda: {"ok": True, "node": "node"}
    )

    seen_sources: list[Path] = []

    def fake_render_musicxml_pdf(source, output, artist="", **kwargs):
        seen_sources.append(Path(source))
        output = Path(output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"%PDF-1.4 fake tab pdf")
        return {"ok": True, "pages": 1, "bytes": 21, "error": None}

    monkeypatch.setattr(
        engine.pdf_render, "render_musicxml_pdf", fake_render_musicxml_pdf
    )

    def fail_if_staged(*args, **kwargs):
        raise AssertionError(
            "a .alphatex source must never be staged through music21 -- "
            "music21 has no alphaTex reader"
        )

    monkeypatch.setattr(engine, "_stage_musicxml", fail_if_staged)

    output = tmp_path / "notation" / "pdf" / "song.pdf"
    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=tab_path,
        fmt="pdf",
        output_path=output,
        title="Song",
        options={"engine": "osmd"},
    )
    assert result["ok"] is True, result
    # The renderer received the ORIGINAL .alphatex path, not a staged
    # MusicXML: it dispatches to alphaTab internally (pdf_render.py's
    # `is_tab` branch), which music21 never touches.
    assert seen_sources == [tab_path]
    assert output.is_file()
    assert not list(output.parent.glob("*__staged_src.musicxml"))


def test_tab_svg_export_reports_pdf_only_without_touching_musescore(
    tmp_path: Path, monkeypatch
) -> None:
    """A tab source has no SVG page output (pdf_render.py: alphaTab renders
    PDF only). MuseScore cannot read alphaTex either, so a tab SVG request
    must fail cleanly rather than fall through to a MuseScore attempt."""
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track", "title": "Song"})
    tab_path = tmp_path / "notation" / "tabs" / "song.alphatex"
    tab_path.parent.mkdir(parents=True, exist_ok=True)
    tab_path.write_text('\\title "Song"\n.\n4.4.4|5.4.4|\n', encoding="utf-8")

    monkeypatch.setattr(
        engine.pdf_render, "available", lambda: {"ok": True, "node": "node"}
    )

    def fake_render_musicxml_svg(source, output, artist="", **kwargs):
        return {
            "ok": False,
            "pages": 0,
            "bytes": 0,
            "error": "tablature (.alphatex) renders to PDF only, not SVG",
        }

    monkeypatch.setattr(
        engine.pdf_render, "render_musicxml_svg", fake_render_musicxml_svg
    )

    musescore_calls: list[tuple] = []
    monkeypatch.setattr(
        engine,
        "_convert_with_musescore",
        lambda *a, **k: musescore_calls.append((a, k)) or {"ok": False},
    )
    monkeypatch.setattr(engine, "musescore_command", lambda: ["mscore"])

    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=tab_path,
        fmt="svg",
        output_path=tmp_path / "notation" / "svg" / "song.svg",
        title="Song",
    )
    assert result["ok"] is False, result
    assert "PDF only" in result["error"]
    assert musescore_calls == []


# ---------------------------------------------------------------------------
# Audit MINOR 3: the notechart audio block's MIME type must prefer the
# entry's own metadata_json ``mime_type``, then a filename guess, and only
# then fall back to the DB ``mime`` column (which defaults to "audio/wav"
# regardless of the real file, see library/db.py:748).
# ---------------------------------------------------------------------------


def test_chart_audio_block_prefers_metadata_mime_type_over_the_db_column(
    tmp_path: Path,
) -> None:
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(
        {
            "id": "track",
            "title": "Song",
            "audio_filename": "song.mp3",
            # The column defaults to audio/wav and was never corrected for
            # this mp3 entry -- metadata_json carries the true type.
            "mime": "audio/wav",
            "metadata_json": {"mime_type": "audio/mpeg"},
        }
    )
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)

    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="notechart",
        output_path=tmp_path / "notation" / "scale.notechart.json",
        title="Song",
        audio_duration_sec=4.0,
    )
    assert result["ok"] is True, result
    chart = json.loads(Path(result["path"]).read_text(encoding="utf-8"))
    assert chart["audio"]["mimeType"] == "audio/mpeg"


def test_chart_audio_block_guesses_mime_from_a_fixed_audio_table(
    tmp_path: Path,
) -> None:
    """``mimetypes`` is registry-based and answers differently per OS -- on
    this Windows machine ``.mp3`` guesses ``audio/mp3`` (not the IANA
    ``audio/mpeg``) and ``.m4a`` guesses ``video/m4a``. The filename guess
    must come from a fixed, audio-specific table instead, checked first."""
    db = LibraryDB(tmp_path / "library.db")
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)

    for filename, expected_mime in (
        ("song.mp3", "audio/mpeg"),
        ("song.wav", "audio/wav"),
        ("song.flac", "audio/flac"),
        ("song.m4a", "audio/mp4"),
        ("song.ogg", "audio/ogg"),
        ("song.opus", "audio/ogg"),
        ("song.aac", "audio/aac"),
        ("song.aif", "audio/aiff"),
        ("song.aiff", "audio/aiff"),
    ):
        entry_id = f"track__{filename}"
        db.upsert_entry(
            {
                "id": entry_id,
                "title": "Song",
                "audio_filename": filename,
                # No metadata_json mime_type; the column still lies (audio/wav
                # default) -- the fixed table's guess must win over it.
                "mime": "audio/wav",
            }
        )
        result = engine.convert_score(
            db,
            entry_id=entry_id,
            source_path=midi_path,
            fmt="notechart",
            output_path=tmp_path / "notation" / f"{entry_id}.notechart.json",
            title="Song",
            audio_duration_sec=4.0,
        )
        assert result["ok"] is True, result
        chart = json.loads(Path(result["path"]).read_text(encoding="utf-8"))
        assert chart["audio"]["mimeType"] == expected_mime, (filename, chart["audio"])
    assert chart["audio"]["mimeType"] != "audio/wav"


def test_chart_audio_block_falls_back_to_the_db_column_last(tmp_path: Path) -> None:
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(
        {
            "id": "track",
            "title": "Song",
            # No usable filename extension to guess from and no metadata
            # mime_type -- only the column is left.
            "audio_filename": "song",
            "mime": "audio/wav",
        }
    )
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)

    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="notechart",
        output_path=tmp_path / "notation" / "scale.notechart.json",
        title="Song",
        audio_duration_sec=4.0,
    )
    assert result["ok"] is True, result
    chart = json.loads(Path(result["path"]).read_text(encoding="utf-8"))
    assert chart["audio"]["mimeType"] == "audio/wav"


# ---------------------------------------------------------------------------
# Audit MINOR 4: a tab (.alphatex) source with no OSMD/alphaTab renderer
# available must report ONLY that renderer as missing, never MuseScore --
# MuseScore cannot read alphaTex at all, so naming it here is misleading.
# ---------------------------------------------------------------------------


def test_tab_pdf_unavailable_renderer_error_names_only_osmd(
    tmp_path: Path, monkeypatch
) -> None:
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track", "title": "Song"})
    tab_path = tmp_path / "notation" / "tabs" / "song.alphatex"
    tab_path.parent.mkdir(parents=True, exist_ok=True)
    tab_path.write_text('\\title "Song"\n.\n4.4.4|5.4.4|\n', encoding="utf-8")

    monkeypatch.setattr(
        engine.pdf_render, "available", lambda: {"ok": False, "node": None}
    )
    # A MuseScore binary IS present, but a tab source must never be offered
    # to it -- the error must not mention it either.
    monkeypatch.setattr(engine, "musescore_command", lambda: ["mscore"])

    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=tab_path,
        fmt="pdf",
        output_path=tmp_path / "notation" / "pdf" / "song.pdf",
        title="Song",
    )
    assert result["ok"] is False, result
    assert "musescore" not in result["error"].lower(), result["error"]
    assert "osmd" in result["error"].lower() or "node" in result["error"].lower(), (
        result["error"]
    )


# ---------------------------------------------------------------------------
# Audit MINOR 5 (SCORE-002): the chart source title and the engraved PDF's
# composer credit must both use the entry's resolved identity, falling back
# exactly as before when the split is not confident.
# ---------------------------------------------------------------------------


def test_notechart_title_uses_the_resolved_song_title_not_the_raw_filename(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track", "title": "Portishead - Roads"})
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)

    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="notechart",
        output_path=tmp_path / "notation" / "scale.notechart.json",
        title="Portishead - Roads",
        audio_duration_sec=4.0,
    )
    assert result["ok"] is True, result
    chart = json.loads(Path(result["path"]).read_text(encoding="utf-8"))
    # Confident split -- the chart is titled with the song only, not the
    # whole "Artist - Song" filename.
    assert chart["source"]["title"] == "Roads", chart["source"]


def test_notechart_title_falls_back_exactly_as_before_when_split_not_confident(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track", "title": "Blade Runner - 2049"})
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)

    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="notechart",
        output_path=tmp_path / "notation" / "scale.notechart.json",
        title="Blade Runner - 2049",
        audio_duration_sec=4.0,
    )
    assert result["ok"] is True, result
    chart = json.loads(Path(result["path"]).read_text(encoding="utf-8"))
    # No confident split -- same behaviour as before this ticket: the whole
    # cleaned title, verbatim.
    assert chart["source"]["title"] == "Blade Runner - 2049", chart["source"]


def test_notechart_title_uses_an_override_title_with_no_override_artist(
    tmp_path: Path, monkeypatch
) -> None:
    """The DETAILS identity form lets a user correct the title without also
    setting an artist override. ``resolve_identity`` already preserves that
    override title even when the artist half stays unresolved -- ``_chart_
    title`` must not throw it away just because ``parsed_artist`` is empty."""
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(
        {
            "id": "track",
            # No confident artist/title split in the raw name either, so the
            # override is the ONLY source of a resolved title.
            "title": "trackfile01",
            "metadata_json": {"notation_title": "Xtal"},
        }
    )
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)

    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="notechart",
        output_path=tmp_path / "notation" / "scale.notechart.json",
        title="trackfile01",
        audio_duration_sec=4.0,
    )
    assert result["ok"] is True, result
    chart = json.loads(Path(result["path"]).read_text(encoding="utf-8"))
    assert chart["source"]["title"] == "Xtal", chart["source"]


def test_pdf_credit_uses_the_entrys_resolved_artist(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track", "title": "Portishead - Roads"})
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)

    monkeypatch.setattr(
        engine.pdf_render, "available", lambda: {"ok": True, "node": "node"}
    )
    seen_artists: list[str] = []

    def fake_render_musicxml_pdf(source, output, artist="", **kwargs):
        seen_artists.append(artist)
        output = Path(output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"%PDF-1.4 fake pdf")
        return {"ok": True, "pages": 1, "bytes": 20, "error": None}

    monkeypatch.setattr(
        engine.pdf_render, "render_musicxml_pdf", fake_render_musicxml_pdf
    )

    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="pdf",
        output_path=tmp_path / "notation" / "pdf" / "scale.pdf",
        title="Portishead - Roads",
        options={"engine": "osmd"},
    )
    assert result["ok"] is True, result
    assert seen_artists == ["Portishead"], seen_artists


# ---------------------------------------------------------------------------
# Re-audit MAJOR 1: one entry, one credit, EVERYWHERE -- OSMD's explicit
# ``artist=`` argument was never the only path to a rendered composer.
# MuseScore reads the composer straight off the MusicXML it is handed (no
# override flag), and the ABC writer / arrangement exporter stamp their own
# separately; all of them must agree with the OSMD credit above for the same
# entry.
# ---------------------------------------------------------------------------


def _composer_from_musicxml(path: Path) -> str:
    import xml.etree.ElementTree as ET

    root = ET.parse(str(path)).getroot()
    identification = root.find("identification")
    if identification is None:
        return ""
    creator = next(
        (c for c in identification.findall("creator") if c.get("type") == "composer"),
        None,
    )
    return (creator.text or "") if creator is not None else ""


def _all_composers_from_musicxml_root(root: ET.Element) -> list[str]:
    identification = root.find("identification")
    if identification is None:
        return []
    return [
        c.text or ""
        for c in identification.findall("creator")
        if c.get("type") == "composer"
    ]


def test_musescore_pdf_credit_uses_the_entrys_resolved_artist_for_a_midi_source(
    tmp_path: Path, monkeypatch
) -> None:
    """A MIDI source is staged through music21 before MuseScore ever sees it
    (:func:`_stage_musicxml`); the staged copy's composer must be the same
    "Portishead" the OSMD path credits, not the global GANTASMO name."""
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    monkeypatch.setattr(engine, "musescore_command", lambda: ["mscore"])
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track", "title": "Portishead - Roads"})
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)

    # Read the composer INSIDE the stub -- the real code deletes its scratch
    # copy in a ``finally`` right after this call returns.
    seen_composers: list[str] = []

    def fake_convert_with_musescore(db, *, source_path, output_path, **kwargs):
        seen_composers.append(_composer_from_musicxml(Path(source_path)))
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"%PDF-1.4 fake musescore pdf")
        return {"ok": True, "engine": "musescore"}

    monkeypatch.setattr(engine, "_convert_with_musescore", fake_convert_with_musescore)

    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="pdf",
        output_path=tmp_path / "notation" / "pdf" / "scale.pdf",
        title="Portishead - Roads",
        options={"engine": "musescore"},
    )
    assert result["ok"] is True, result
    assert seen_composers == ["Portishead"], seen_composers


def test_musescore_pdf_credit_uses_the_entrys_resolved_artist_for_a_musicxml_source(
    tmp_path: Path, monkeypatch
) -> None:
    """A source that is ALREADY MusicXML skips ``_stage_musicxml`` entirely
    (``_is_musicxml`` short-circuits the staging branch in :func:`_engrave`),
    so MuseScore would otherwise read whatever composer the file already
    carries -- here, a wrong one planted on purpose. The fix re-credits a
    throwaway scratch copy before handing it to MuseScore, same as
    :func:`stage_parts` does for a filtered sheet."""
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    monkeypatch.setattr(engine, "musescore_command", lambda: ["mscore"])
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track", "title": "Portishead - Roads"})
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)

    # Stage a real MusicXML source with a deliberately WRONG composer, the
    # way an earlier "musicxml" export (credited then) would have left one.
    xml_source = tmp_path / "notation" / "scale.musicxml"
    engine._stage_musicxml(midi_path, xml_source, "Portishead - Roads", artist="WRONG")
    assert _composer_from_musicxml(xml_source) == "WRONG"

    # Read the composer INSIDE the stub -- the real code deletes its scratch
    # copy in a ``finally`` right after this call returns.
    seen_composers: list[str] = []
    seen_paths: list[Path] = []

    def fake_convert_with_musescore(db, *, source_path, output_path, **kwargs):
        source_path = Path(source_path)
        seen_paths.append(source_path)
        seen_composers.append(_composer_from_musicxml(source_path))
        output_path = Path(output_path)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"%PDF-1.4 fake musescore pdf")
        return {"ok": True, "engine": "musescore"}

    monkeypatch.setattr(engine, "_convert_with_musescore", fake_convert_with_musescore)

    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=xml_source,
        fmt="pdf",
        output_path=tmp_path / "notation" / "pdf" / "scale.pdf",
        title="Portishead - Roads",
        options={"engine": "musescore"},
    )
    assert result["ok"] is True, result
    # The scratch copy handed to MuseScore is re-credited; the original
    # source file on disk is left untouched.
    assert seen_composers == ["Portishead"], seen_composers
    assert seen_paths[0] != xml_source
    assert _composer_from_musicxml(xml_source) == "WRONG"
    assert not seen_paths[0].exists(), (
        "the MuseScore scratch copy must be cleaned up after the call"
    )


# ---------------------------------------------------------------------------
# Fifth-audit MINOR 2: _set_musicxml_composer must remove every OTHER
# type="composer" creator after setting the first, not just leave a stale
# second one -- it now has three callers (stage_parts, _engrave's MuseScore
# re-credit, and the /pack route's non-part-scoped re-credit) and any of them
# can be handed a sheet a DAW or notation tool wrote with more than one.
# ---------------------------------------------------------------------------


def test_set_musicxml_composer_removes_every_other_composer_creator() -> None:
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<score-partwise version="3.1">\n'
        "  <identification>\n"
        '    <creator type="composer">OLD_ONE</creator>\n'
        '    <creator type="lyricist">Some Lyricist</creator>\n'
        '    <creator type="composer">OLD_TWO</creator>\n'
        "  </identification>\n"
        "  <part-list>\n"
        '    <score-part id="P1"><part-name>Lead</part-name></score-part>\n'
        "  </part-list>\n"
        '  <part id="P1"><measure number="1"/></part>\n'
        "</score-partwise>\n"
    )
    root = ET.fromstring(xml)
    engine._set_musicxml_composer(root, "Portishead")
    assert _all_composers_from_musicxml_root(root) == ["Portishead"]
    # A creator of a DIFFERENT type is untouched.
    identification = root.find("identification")
    assert [c.get("type") for c in identification.findall("creator")] == [
        "composer",
        "lyricist",
    ]


def test_abc_export_credits_the_entrys_resolved_artist(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track", "title": "Portishead - Roads"})
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)

    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="abc",
        output_path=tmp_path / "notation" / "scale.abc",
        title="Portishead - Roads",
    )
    assert result["ok"] is True, result
    text = Path(result["path"]).read_text(encoding="utf-8")
    assert "C:Portishead" in text, text
    assert "GANTASMO" not in text, text


def test_arrangement_credits_the_entrys_resolved_artist(
    tmp_path: Path, monkeypatch
) -> None:
    from backend.modules.notation.engine import midi_to_arrangement

    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track", "title": "Aphex Twin - Xtal"})
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)

    result = midi_to_arrangement(
        db,
        entry_id="track",
        sources=[midi_path],
        style="lead-sheet",
        output_path=tmp_path / "notation" / "scale__lead.musicxml",
        title="Aphex Twin - Xtal",
    )
    assert result["ok"] is True, result
    assert _composer_from_musicxml(Path(result["path"])) == "Aphex Twin"


# ---------------------------------------------------------------------------
# Third-audit MAJOR 2 (regression): a part-scoped notechart lost its
# " · <part>" suffix once ``_chart_title`` started returning the identity
# title, because ``stage_parts``'s suffix was baked into the ``title`` string
# _chart_title then discarded in favour of the identity-resolved one.
# ---------------------------------------------------------------------------


def _write_two_part_midi(path: Path) -> None:
    """Two named tracks, Lead then Bass, so a single-part scope has a real
    part name to append as the " · <part>" suffix."""
    lead = pretty_midi.Instrument(program=0, name="Lead")
    for i, pitch in enumerate([72, 74, 76, 77]):
        start = i * 0.5
        lead.notes.append(
            pretty_midi.Note(velocity=100, pitch=pitch, start=start, end=start + 0.5)
        )
    bass = pretty_midi.Instrument(program=32, name="Bass")
    for i, pitch in enumerate([36, 38, 40, 41]):
        start = i * 0.5
        bass.notes.append(
            pretty_midi.Note(velocity=100, pitch=pitch, start=start, end=start + 0.5)
        )
    pm = pretty_midi.PrettyMIDI()
    pm.instruments.append(lead)
    pm.instruments.append(bass)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))


def test_part_scoped_notechart_keeps_the_part_suffix_with_a_confident_split(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track", "title": "Portishead - Roads"})
    midi_path = tmp_path / "midi" / "band.mid"
    _write_two_part_midi(midi_path)

    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="notechart",
        output_path=tmp_path / "notation" / "band.notechart.json",
        title="Portishead - Roads",
        options={"parts": [0]},
        audio_duration_sec=4.0,
    )
    assert result["ok"] is True, result
    chart = json.loads(Path(result["path"]).read_text(encoding="utf-8"))
    assert chart["source"]["title"] == "Roads · Lead", chart["source"]


def test_part_scoped_notechart_keeps_the_part_suffix_with_an_override_title(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry(
        {
            "id": "track",
            "title": "trackfile01",
            "metadata_json": {"notation_title": "Xtal"},
        }
    )
    midi_path = tmp_path / "midi" / "band.mid"
    _write_two_part_midi(midi_path)

    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="notechart",
        output_path=tmp_path / "notation" / "band.notechart.json",
        title="trackfile01",
        options={"parts": [0]},
        audio_duration_sec=4.0,
    )
    assert result["ok"] is True, result
    chart = json.loads(Path(result["path"]).read_text(encoding="utf-8"))
    assert chart["source"]["title"] == "Xtal · Lead", chart["source"]


def test_part_scoped_notechart_keeps_the_part_suffix_with_no_confident_split(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track", "title": "Blade Runner - 2049"})
    midi_path = tmp_path / "midi" / "band.mid"
    _write_two_part_midi(midi_path)

    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="notechart",
        output_path=tmp_path / "notation" / "band.notechart.json",
        title="Blade Runner - 2049",
        options={"parts": [0]},
        audio_duration_sec=4.0,
    )
    assert result["ok"] is True, result
    chart = json.loads(Path(result["path"]).read_text(encoding="utf-8"))
    assert chart["source"]["title"] == "Blade Runner - 2049 · Lead", chart["source"]


def test_part_scoped_beatsaber_keeps_the_part_suffix(
    tmp_path: Path, monkeypatch
) -> None:
    from backend.modules.notation.exporters import beatsaber as beatsaber_mod

    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    monkeypatch.setattr(beatsaber_mod, "find_ffmpeg", lambda: None)
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track", "title": "Portishead - Roads"})
    midi_path = tmp_path / "midi" / "band.mid"
    _write_two_part_midi(midi_path)

    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="beatsaber",
        output_path=tmp_path / "notation" / "beatsaber" / "band.beatsaber.zip",
        title="Portishead - Roads",
        options={"parts": [0]},
        audio_duration_sec=4.0,
    )
    assert result["ok"] is True, result
    with zipfile.ZipFile(result["path"]) as zf:
        info_names = [n for n in zf.namelist() if n.endswith("Info.dat")]
        info = json.loads(zf.read(info_names[0]).decode("utf-8"))
    assert info["_songName"] == "Roads · Lead", info


# ---------------------------------------------------------------------------
# Third-audit MINOR 5: a part-scoped notechart's ``sourcePath`` must name the
# real registered source, not the ``__parts_..._src.musicxml`` scratch file
# ``stage_parts``/``_stage_musicxml`` staged it through.
# ---------------------------------------------------------------------------


def test_part_scoped_notechart_source_path_is_not_the_staging_scratch_name(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track", "title": "Portishead - Roads"})
    midi_path = tmp_path / "midi" / "band.mid"
    _write_two_part_midi(midi_path)

    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="notechart",
        output_path=tmp_path / "notation" / "band.notechart.json",
        title="Portishead - Roads",
        options={"parts": [0]},
        audio_duration_sec=4.0,
    )
    assert result["ok"] is True, result
    chart = json.loads(Path(result["path"]).read_text(encoding="utf-8"))
    source_path = chart["source"]["sourcePath"]
    assert "__parts_" not in source_path, chart["source"]
    assert "__staged_src" not in source_path, chart["source"]
    assert source_path == "band.mid", chart["source"]


# ---------------------------------------------------------------------------
# Third-audit MAJOR 1: the pack route's ``stage_parts`` call carried no
# ``artist=``, so a part-scoped download shipped a MusicXML member credited
# to the global composer beside a PDF member (via ``convert_score``, already
# fixed) credited to the entry's own resolved artist.
# ---------------------------------------------------------------------------


def _write_two_part_musicxml_file(path: Path) -> None:
    from music21 import clef, meter, note, stream  # type: ignore[import]

    score = stream.Score()
    for index, (name, pitches, part_clef) in enumerate(
        (
            ("Lead", [72, 74, 76, 77], clef.TrebleClef()),
            ("Bass", [36, 38, 40, 41], clef.BassClef()),
        )
    ):
        part = stream.Part(id=f"P{index + 1}")
        part.partName = name
        part.append(part_clef)
        part.append(meter.TimeSignature("4/4"))
        for pitch in pitches:
            part.append(note.Note(pitch, quarterLength=1.0))
        part.makeMeasures(inPlace=True)
        score.insert(0, part)
    path.parent.mkdir(parents=True, exist_ok=True)
    score.write("musicxml", fp=str(path))


def test_pack_route_credits_the_same_artist_in_musicxml_and_pdf_members(
    tmp_path: Path, monkeypatch
) -> None:
    from backend.modules.library import router as library_router_module
    from backend.modules.notation import router as notation_router_module
    from tests.test_library_store import _seed_generate_entry

    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")

    _seed_generate_entry(
        tmp_path, "job_pk", 0, extra_meta={"title": "Portishead - Roads"}
    )
    entry_id = "job_pk_00"
    store = library_router_module.get_store()
    assert store.get_entry(entry_id) is not None
    entry_dir = tmp_path / "job_pk" / "00"
    sheet = entry_dir / "notation" / "song.musicxml"
    _write_two_part_musicxml_file(sheet)
    store.db.add_notation_artifact(
        artifact_id="song_sheet", entry_id=entry_id, kind="musicxml", path=str(sheet)
    )

    # Stub convert_score's PDF member: never raises even without a real
    # engraver in this environment, and independently re-derives the credit
    # via the SAME ``_chart_artist`` the real PDF path uses, so the assertion
    # below proves the two members AGREE rather than merely both succeeding.
    seen_pdf_artists: list[str] = []

    def fake_convert_score(db, **kwargs):
        from backend.modules.notation.engine import _chart_artist

        entry = db.get_entry(kwargs["entry_id"]) if kwargs.get("entry_id") else None
        seen_pdf_artists.append(_chart_artist(entry))
        output_path = Path(kwargs["output_path"])
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"%PDF-1.4 fake pack pdf")
        return {"ok": True, "path": str(output_path)}

    monkeypatch.setattr(notation_router_module, "convert_score", fake_convert_score)

    response = notation_router_module.download_score_pack("song_sheet", parts="0")

    with zipfile.ZipFile(io.BytesIO(response.body)) as zf:
        names = zf.namelist()
        musicxml_name = next(n for n in names if n.endswith(".musicxml"))
        pdf_name = next(n for n in names if n.endswith(".pdf"))
        musicxml_bytes = zf.read(musicxml_name)

    assert "Portishead" in musicxml_bytes.decode("utf-8")
    assert "GANTASMO" not in musicxml_bytes.decode("utf-8")
    assert pdf_name  # the PDF member is present
    assert seen_pdf_artists == ["Portishead"], seen_pdf_artists


# ---------------------------------------------------------------------------
# Fourth-audit MAJOR 1: the NON-part-scoped /pack branch (no ``?parts=``)
# shipped the stored MusicXML bytes verbatim, so a sheet engraved before this
# ticket (or whose entry's DETAILS identity was edited afterwards, which
# touches no file) packed a MusicXML credited to a stale composer beside a
# PDF (via convert_score -> _chart_artist) credited to the CURRENT one. The
# earlier test above only ever covered ``parts="0"``, which is why this was
# missed -- this one covers the no-parts path with the real, un-scoped source.
# ---------------------------------------------------------------------------


def test_pack_route_with_no_parts_still_recredits_the_stale_musicxml_member(
    tmp_path: Path, monkeypatch
) -> None:
    from backend.modules.library import router as library_router_module
    from backend.modules.notation import router as notation_router_module
    from tests.test_library_store import _seed_generate_entry

    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")

    _seed_generate_entry(
        tmp_path, "job_pk2", 0, extra_meta={"title": "Portishead - Roads"}
    )
    entry_id = "job_pk2_00"
    store = library_router_module.get_store()
    assert store.get_entry(entry_id) is not None
    entry_dir = tmp_path / "job_pk2" / "00"
    sheet = entry_dir / "notation" / "song.musicxml"
    _write_two_part_musicxml_file(sheet)
    # A stale composer, exactly as an entry engraved before an identity
    # correction (or before this ticket) would carry on disk.
    assert _composer_from_musicxml(sheet) != "STALE_COMPOSER"
    engine._set_musicxml_composer(
        (tree := ET.parse(str(sheet))).getroot(), "STALE_COMPOSER"
    )
    tree.write(str(sheet), encoding="UTF-8", xml_declaration=True)
    assert _composer_from_musicxml(sheet) == "STALE_COMPOSER"
    store.db.add_notation_artifact(
        artifact_id="song_sheet2", entry_id=entry_id, kind="musicxml", path=str(sheet)
    )

    def fake_convert_score(db, **kwargs):
        output_path = Path(kwargs["output_path"])
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"%PDF-1.4 fake pack pdf")
        return {"ok": True, "path": str(output_path), "engine": "osmd"}

    monkeypatch.setattr(notation_router_module, "convert_score", fake_convert_score)

    response = notation_router_module.download_score_pack("song_sheet2")

    with zipfile.ZipFile(io.BytesIO(response.body)) as zf:
        names = zf.namelist()
        musicxml_name = next(n for n in names if n.endswith(".musicxml"))
        musicxml_bytes = zf.read(musicxml_name)

    assert "Portishead" in musicxml_bytes.decode("utf-8")
    assert "STALE_COMPOSER" not in musicxml_bytes.decode("utf-8")
    # The on-disk artifact itself is never rewritten -- only the in-memory
    # zip member is re-credited.
    assert _composer_from_musicxml(sheet) == "STALE_COMPOSER"


# ---------------------------------------------------------------------------
# Fifth-audit MINOR 3: the /pack route's non-part-scoped re-credit round-
# trips through ElementTree, which has no representation for a DOCTYPE or
# any comment before the root element -- both are silently dropped. This is
# the actual .musicxml file a user opens in Finale/Sibelius from the pack
# download, so both must survive the re-credit.
# ---------------------------------------------------------------------------


def test_pack_route_no_parts_preserves_doctype_and_leading_comment(
    tmp_path: Path, monkeypatch
) -> None:
    from backend.modules.library import router as library_router_module
    from backend.modules.notation import router as notation_router_module
    from tests.test_library_store import _seed_generate_entry

    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")

    _seed_generate_entry(
        tmp_path, "job_pk3", 0, extra_meta={"title": "Portishead - Roads"}
    )
    entry_id = "job_pk3_00"
    store = library_router_module.get_store()
    assert store.get_entry(entry_id) is not None
    entry_dir = tmp_path / "job_pk3" / "00"
    sheet = entry_dir / "notation" / "song.musicxml"
    sheet.parent.mkdir(parents=True, exist_ok=True)
    sheet.write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<!-- exported by SomeOtherTool 4.2 -->\n"
        '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 '
        'Partwise//EN" "http://www.musicxml.org/dtd/partwise.dtd">\n'
        '<score-partwise version="3.1">\n'
        "  <identification>\n"
        '    <creator type="composer">STALE_COMPOSER</creator>\n'
        "  </identification>\n"
        "  <part-list>\n"
        '    <score-part id="P1"><part-name>Lead</part-name></score-part>\n'
        "  </part-list>\n"
        '  <part id="P1"><measure number="1"/></part>\n'
        "</score-partwise>\n",
        encoding="utf-8",
    )
    store.db.add_notation_artifact(
        artifact_id="song_sheet3", entry_id=entry_id, kind="musicxml", path=str(sheet)
    )

    def fake_convert_score(db, **kwargs):
        output_path = Path(kwargs["output_path"])
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"%PDF-1.4 fake pack pdf")
        return {"ok": True, "path": str(output_path), "engine": "osmd"}

    monkeypatch.setattr(notation_router_module, "convert_score", fake_convert_score)

    response = notation_router_module.download_score_pack("song_sheet3")

    with zipfile.ZipFile(io.BytesIO(response.body)) as zf:
        musicxml_name = next(n for n in zf.namelist() if n.endswith(".musicxml"))
        musicxml_text = zf.read(musicxml_name).decode("utf-8")

    assert "Portishead" in musicxml_text
    assert "STALE_COMPOSER" not in musicxml_text
    assert "<!DOCTYPE score-partwise" in musicxml_text
    assert "<!-- exported by SomeOtherTool 4.2 -->" in musicxml_text
    # Fifth-audit MAJOR 3 regression guard: the two substrings above passed
    # even when re-insertion produced non-well-formed XML (a truncated
    # comment, a duplicate XML declaration, ...) -- the member must PARSE.
    ET.fromstring(musicxml_text.encode("utf-8"))


# ---------------------------------------------------------------------------
# Fifth-audit MAJOR 1 regression: the prolog-extras re-insertion above must
# never emit non-well-formed XML, even for inputs the benign fixture above
# doesn't exercise -- a UTF-8 BOM, a pre-root comment containing "<" (a
# URL), and a non-UTF-8-declared source whose pre-root comment has
# non-ASCII text. Each of these produced a real ``xml.etree.ElementTree``
# parse failure before the fix (``_musicxml_prolog_extras`` located the
# root by regex, byte-scanning raw source bytes rather than parsing).
# ---------------------------------------------------------------------------


def _pack_musicxml_bytes(job_id: str) -> bytes:
    """Round-trip a MusicXML artifact (registered by
    :func:`_seed_pack_prolog_entry`) through the /pack route's
    non-part-scoped re-credit and return the resulting member bytes."""
    from backend.modules.notation import router as notation_router_module

    with zipfile.ZipFile(
        io.BytesIO(notation_router_module.download_score_pack(f"{job_id}_sheet").body)
    ) as zf:
        musicxml_name = next(n for n in zf.namelist() if n.endswith(".musicxml"))
        return zf.read(musicxml_name)


def _seed_pack_prolog_entry(tmp_path: Path, job_id: str, raw: bytes) -> str:
    """A library entry with one registered MusicXML notation artifact
    written from raw bytes (not text), for the prolog-preservation tests.
    Returns the entry id."""
    from backend.modules.library import router as library_router_module
    from tests.test_library_store import _seed_generate_entry

    _seed_generate_entry(tmp_path, job_id, 0, extra_meta={"title": "Roads"})
    entry_id = f"{job_id}_00"
    store = library_router_module.get_store()
    entry_dir = tmp_path / job_id / "00"
    sheet = entry_dir / "notation" / "song.musicxml"
    sheet.parent.mkdir(parents=True, exist_ok=True)
    sheet.write_bytes(raw)
    store.db.add_notation_artifact(
        artifact_id=f"{job_id}_sheet",
        entry_id=entry_id,
        kind="musicxml",
        path=str(sheet),
    )
    return entry_id


_TWO_PART_SCORE_BODY = (
    '<score-partwise version="4.0">\n'
    "  <part-list>\n"
    '    <score-part id="P1"><part-name>Lead</part-name></score-part>\n'
    "  </part-list>\n"
    '  <part id="P1"><measure number="1"/></part>\n'
    "</score-partwise>\n"
)


def _pack_prolog_fixture(tmp_path: Path, monkeypatch, job_id: str, raw: bytes) -> bytes:
    from backend.modules.library import router as library_router_module
    from backend.modules.notation import router as notation_router_module

    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")

    def fake_convert_score(db, **kwargs):
        output_path = Path(kwargs["output_path"])
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"%PDF-1.4 fake pack pdf")
        return {"ok": True, "path": str(output_path), "engine": "osmd"}

    monkeypatch.setattr(notation_router_module, "convert_score", fake_convert_score)
    _seed_pack_prolog_entry(tmp_path, job_id, raw)
    return _pack_musicxml_bytes(job_id)


def test_pack_route_prolog_survives_utf8_bom(tmp_path: Path, monkeypatch) -> None:
    raw = (
        b"\xef\xbb\xbf"
        b'<?xml version="1.0" encoding="UTF-8"?>\n'
        + _TWO_PART_SCORE_BODY.encode("utf-8")
    )
    member_bytes = _pack_prolog_fixture(tmp_path, monkeypatch, "job_pk_bom", raw)
    ET.fromstring(member_bytes)
    assert b"<?xml" in member_bytes
    # No leftover BOM and no duplicate declaration line 2.
    assert member_bytes.count(b"<?xml") == 1
    assert not member_bytes.startswith(b"\xef\xbb\xbf")


def test_pack_route_prolog_survives_pre_root_comment_containing_angle_bracket(
    tmp_path: Path, monkeypatch
) -> None:
    raw = (
        b'<?xml version="1.0" encoding="UTF-8"?>\n'
        b"<!-- see <http://example.com> -->\n" + _TWO_PART_SCORE_BODY.encode("utf-8")
    )
    member_bytes = _pack_prolog_fixture(tmp_path, monkeypatch, "job_pk_comment", raw)
    root = ET.fromstring(member_bytes)
    assert root.tag == "score-partwise"
    assert b"<!-- see <http://example.com> -->" in member_bytes


def test_pack_route_prolog_survives_non_utf8_declaration_with_non_ascii_comment(
    tmp_path: Path, monkeypatch
) -> None:
    raw = (
        '<?xml version="1.0" encoding="ISO-8859-1"?>\n'
        "<!-- Café -->\n" + _TWO_PART_SCORE_BODY
    ).encode("ISO-8859-1")
    member_bytes = _pack_prolog_fixture(tmp_path, monkeypatch, "job_pk_latin1", raw)
    root = ET.fromstring(member_bytes)
    assert root.tag == "score-partwise"
    # The output body is UTF-8 (ElementTree's own declaration says so); the
    # comment's non-ASCII character must be re-encoded to match, not carried
    # over as raw ISO-8859-1 bytes.
    assert "Café".encode("utf-8") in member_bytes
    assert b'encoding="UTF-8"' in member_bytes or b"encoding='UTF-8'" in member_bytes


# ---------------------------------------------------------------------------
# Fifth-audit MAJOR 2: a ``?engine=musescore`` pin must not poison
# freshness for a LATER unpinned request.
# ---------------------------------------------------------------------------


def test_pack_pdf_stamp_absent_on_pre_existing_row_falls_back_to_old_signal(
    monkeypatch,
) -> None:
    """A pre-existing artifact row from before ``pack_osmd_available`` was
    ever stamped (``cached_osmd_available is None``) falls back to the old
    signal: fresh only while OSMD is still unavailable."""
    from backend.modules.notation import router as notation_router_module
    from backend.modules.notation.router import _pack_engine_still_fresh

    monkeypatch.setattr(
        notation_router_module, "capabilities", lambda: {"osmd_pdf": False}
    )
    assert _pack_engine_still_fresh("musescore", "", None) is True

    monkeypatch.setattr(
        notation_router_module, "capabilities", lambda: {"osmd_pdf": True}
    )
    assert _pack_engine_still_fresh("musescore", "", None) is False


def test_pack_route_pinned_musescore_then_unpinned_request_does_not_stay_pinned(
    tmp_path: Path, monkeypatch
) -> None:
    from backend.modules.library import router as library_router_module
    from backend.modules.notation import router as notation_router_module

    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    store, entry_id, artifact_id = _seed_pack_musicxml_entry(
        tmp_path, "job_pin1", "Portishead - Roads"
    )

    calls = {"n": 0}

    def fake_convert_score(db, **kwargs):
        calls["n"] += 1
        options = kwargs.get("options") or {}
        rendered_engine = options.get("engine") or "osmd"
        output_path = Path(kwargs["output_path"])
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"%PDF-1.4 fake pack pdf " + str(calls["n"]).encode())
        db.add_notation_artifact(
            artifact_id=kwargs["artifact_id"],
            entry_id=kwargs["entry_id"],
            kind="pdf",
            path=str(output_path),
            source_ref=kwargs.get("source_ref"),
            engine=rendered_engine,
            engine_version="1",
        )
        return {"ok": True, "path": str(output_path), "engine": rendered_engine}

    monkeypatch.setattr(notation_router_module, "convert_score", fake_convert_score)
    # OSMD is advertised and working throughout.
    monkeypatch.setattr(
        notation_router_module, "capabilities", lambda: {"osmd_pdf": True}
    )

    # (i) Unpinned: OSMD renders -> stamp (osmd, True).
    r1 = notation_router_module.download_score_pack(artifact_id)
    assert r1.status_code == 200
    assert calls["n"] == 1

    # (ii) Pinned to musescore: forced miss -> musescore renders to the SAME
    # pdf_out/artifact id.
    r2 = notation_router_module.download_score_pack(artifact_id, engine="musescore")
    assert r2.status_code == 200
    assert calls["n"] == 2

    # (iii) Unpinned again: must NOT be served the cached MuseScore PDF --
    # OSMD is still the preferred engraver and is available, so it must be
    # tried again.
    r3 = notation_router_module.download_score_pack(artifact_id)
    assert r3.status_code == 200
    assert calls["n"] == 3, (
        "an unpinned request after a ?engine=musescore pin must not stay "
        "pinned to the MuseScore PDF forever"
    )


# ---------------------------------------------------------------------------
# Fourth-audit MINOR 4: pack PDF freshness must track the engraver that
# ACTUALLY rendered it, not the (usually empty, unpinned) request parameter --
# a PDF MuseScore rendered while OSMD was unavailable must stop being served
# once OSMD becomes available again.
# ---------------------------------------------------------------------------


def _seed_pack_musicxml_entry(
    tmp_path: Path, job_id: str, title: str
) -> tuple[Any, str, str]:
    """A library entry with one registered MusicXML notation artifact, for
    the pack-route tests. Returns ``(store, entry_id, artifact_id)``."""
    from backend.modules.library import router as library_router_module
    from tests.test_library_store import _seed_generate_entry

    _seed_generate_entry(tmp_path, job_id, 0, extra_meta={"title": title})
    entry_id = f"{job_id}_00"
    store = library_router_module.get_store()
    entry_dir = tmp_path / job_id / "00"
    sheet = entry_dir / "notation" / "song.musicxml"
    _write_two_part_musicxml_file(sheet)
    artifact_id = f"{job_id}_sheet"
    store.db.add_notation_artifact(
        artifact_id=artifact_id, entry_id=entry_id, kind="musicxml", path=str(sheet)
    )
    return store, entry_id, artifact_id


def test_pack_pdf_from_musescore_is_reengraved_once_osmd_becomes_available(
    tmp_path: Path, monkeypatch
) -> None:
    from backend.modules.library import router as library_router_module
    from backend.modules.notation import router as notation_router_module

    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    store, entry_id, artifact_id = _seed_pack_musicxml_entry(
        tmp_path, "job_eng1", "Portishead - Roads"
    )

    calls = {"n": 0, "engines": []}

    def fake_convert_score(db, **kwargs):
        calls["n"] += 1
        calls["engines"].append(kwargs.get("options") or {})
        output_path = Path(kwargs["output_path"])
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"%PDF-1.4 fake pack pdf " + str(calls["n"]).encode())
        db.add_notation_artifact(
            artifact_id=kwargs["artifact_id"],
            entry_id=kwargs["entry_id"],
            kind="pdf",
            path=str(output_path),
            source_ref=kwargs.get("source_ref"),
            engine="musescore",
            engine_version="1",
        )
        # OSMD unavailable this first render -- MuseScore actually ran.
        return {"ok": True, "path": str(output_path), "engine": "musescore"}

    monkeypatch.setattr(notation_router_module, "convert_score", fake_convert_score)
    monkeypatch.setattr(
        notation_router_module, "capabilities", lambda: {"osmd_pdf": False}
    )

    r1 = notation_router_module.download_score_pack(artifact_id)
    assert r1.status_code == 200
    assert calls["n"] == 1

    # Same request again, OSMD still unavailable: the MuseScore PDF is fresh.
    r2 = notation_router_module.download_score_pack(artifact_id)
    assert r2.status_code == 200
    assert calls["n"] == 1, "a musescore-rendered PDF is fresh while OSMD stays down"

    # OSMD comes back: the cached MuseScore PDF must now be treated as stale.
    monkeypatch.setattr(
        notation_router_module, "capabilities", lambda: {"osmd_pdf": True}
    )
    r3 = notation_router_module.download_score_pack(artifact_id)
    assert r3.status_code == 200
    assert calls["n"] == 2, (
        "OSMD returning must invalidate a musescore-rendered pack PDF"
    )


def test_pack_pdf_from_osmd_stays_fresh_regardless_of_live_availability(
    tmp_path: Path, monkeypatch
) -> None:
    from backend.modules.library import router as library_router_module
    from backend.modules.notation import router as notation_router_module

    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    store, entry_id, artifact_id = _seed_pack_musicxml_entry(
        tmp_path, "job_eng2", "Portishead - Roads"
    )

    calls = {"n": 0}

    def fake_convert_score(db, **kwargs):
        calls["n"] += 1
        output_path = Path(kwargs["output_path"])
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"%PDF-1.4 fake pack pdf " + str(calls["n"]).encode())
        db.add_notation_artifact(
            artifact_id=kwargs["artifact_id"],
            entry_id=kwargs["entry_id"],
            kind="pdf",
            path=str(output_path),
            source_ref=kwargs.get("source_ref"),
            engine="osmd",
            engine_version="1",
        )
        return {"ok": True, "path": str(output_path), "engine": "osmd"}

    monkeypatch.setattr(notation_router_module, "convert_score", fake_convert_score)
    monkeypatch.setattr(
        notation_router_module, "capabilities", lambda: {"osmd_pdf": True}
    )

    r1 = notation_router_module.download_score_pack(artifact_id)
    assert r1.status_code == 200
    assert calls["n"] == 1

    r2 = notation_router_module.download_score_pack(artifact_id)
    assert r2.status_code == 200
    assert calls["n"] == 1, "an osmd-rendered PDF is always fresh"


# ---------------------------------------------------------------------------
# Fifth-audit MAJOR 1: freshness must track whether OSMD was OBSERVED
# available at the render that actually produced the cached PDF, not the
# LIVE capability at freshness-check time -- when OSMD is advertised
# (``capabilities()["osmd_pdf"]`` True) but its render fails for this
# particular source, the pack falls back to MuseScore every single call
# because the old check only asked "is OSMD unavailable right now", which
# stays False forever, so the freshness stamp must also record the actual
# observed availability, not just the engine name.
# ---------------------------------------------------------------------------


def test_pack_pdf_from_musescore_stays_fresh_when_osmd_is_advertised_but_fails(
    tmp_path: Path, monkeypatch
) -> None:
    from backend.modules.library import router as library_router_module
    from backend.modules.notation import router as notation_router_module

    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    store, entry_id, artifact_id = _seed_pack_musicxml_entry(
        tmp_path, "job_eng3", "Portishead - Roads"
    )

    calls = {"n": 0}

    def fake_convert_score(db, **kwargs):
        calls["n"] += 1
        output_path = Path(kwargs["output_path"])
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"%PDF-1.4 fake pack pdf " + str(calls["n"]).encode())
        db.add_notation_artifact(
            artifact_id=kwargs["artifact_id"],
            entry_id=kwargs["entry_id"],
            kind="pdf",
            path=str(output_path),
            source_ref=kwargs.get("source_ref"),
            engine="musescore",
            engine_version="1",
        )
        # OSMD is advertised (capabilities() says True below) but its
        # render of THIS source keeps failing internally, so convert_score
        # falls back to MuseScore regardless.
        return {"ok": True, "path": str(output_path), "engine": "musescore"}

    monkeypatch.setattr(notation_router_module, "convert_score", fake_convert_score)
    monkeypatch.setattr(
        notation_router_module, "capabilities", lambda: {"osmd_pdf": True}
    )

    r1 = notation_router_module.download_score_pack(artifact_id)
    assert r1.status_code == 200
    assert calls["n"] == 1

    # Same request again, OSMD still advertised (and still failing for this
    # source, per the fake): the MuseScore PDF must stay fresh, not rebuild
    # on every call.
    r2 = notation_router_module.download_score_pack(artifact_id)
    assert r2.status_code == 200
    assert calls["n"] == 1, (
        "a musescore-rendered PDF must stay fresh while OSMD's advertised "
        "availability hasn't changed, even though OSMD is 'available'"
    )

    r3 = notation_router_module.download_score_pack(artifact_id)
    assert r3.status_code == 200
    assert calls["n"] == 1


# ---------------------------------------------------------------------------
# Sixth-audit CRITICAL: ``_rewrite_titles`` writing to REAL FILES on disk
# must never corrupt a DOCTYPE containing an apostrophe, must preserve an
# internal subset, and must never leave a corrupt file behind on failure.
# ---------------------------------------------------------------------------


def _rewrite_titles_fixture(tmp_path: Path, raw: bytes) -> Path:
    sheet = tmp_path / "song.musicxml"
    sheet.write_bytes(raw)
    return sheet


_ONE_PART_SCORE_WITH_CREDITS = (
    "  <work><work-title>Old Title</work-title></work>\n"
    "  <identification>\n"
    '    <creator type="composer">Old Composer</creator>\n'
    "  </identification>\n"
    "  <part-list>\n"
    '    <score-part id="P1"><part-name>Lead</part-name></score-part>\n'
    "  </part-list>\n"
    '  <part id="P1">\n'
    '    <measure number="1">\n'
    "      <attributes><divisions>1</divisions></attributes>\n"
    "    </measure>\n"
    "  </part>\n"
    "</score-partwise>\n"
)


def test_rewrite_titles_doctype_system_with_apostrophe_reparses(
    tmp_path: Path,
) -> None:
    """DOCTYPE SYSTEM identifier containing an apostrophe (e.g. a Windows
    path under a possessive folder name) must survive the in-place rewrite
    as well-formed XML, not the unescaped single-quoted literal
    ``xml.dom.minidom``'s own ``toxml()`` would emit."""
    from backend.modules.notation.backfill import _rewrite_titles

    raw = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<!DOCTYPE score-partwise SYSTEM "
        '"file:///C:/Bob\'s Scores/partwise.dtd">\n'
        '<score-partwise version="4.0">\n' + _ONE_PART_SCORE_WITH_CREDITS
    ).encode("utf-8")
    sheet = _rewrite_titles_fixture(tmp_path, raw)

    changed = _rewrite_titles(sheet, "New Title", "New Composer")
    assert changed is True

    body = sheet.read_bytes()
    root = ET.fromstring(body)  # must not raise ET.ParseError
    assert root.find("work/work-title").text == "New Title"
    assert b"Bob's Scores" in body


def test_rewrite_titles_doctype_public_with_apostrophe_reparses(
    tmp_path: Path,
) -> None:
    """DOCTYPE PUBLIC identifier containing an apostrophe must also
    survive, in both the public-id and system-id slots."""
    from backend.modules.notation.backfill import _rewrite_titles

    raw = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<!DOCTYPE score-partwise PUBLIC "
        '"-//Bob\'s Music//DTD X//EN" "http://x/p.dtd">\n'
        '<score-partwise version="4.0">\n' + _ONE_PART_SCORE_WITH_CREDITS
    ).encode("utf-8")
    sheet = _rewrite_titles_fixture(tmp_path, raw)

    changed = _rewrite_titles(sheet, "New Title", "New Composer")
    assert changed is True

    body = sheet.read_bytes()
    root = ET.fromstring(body)  # must not raise ET.ParseError
    assert root.find("work/work-title").text == "New Title"
    assert b"Bob's Music" in body


def test_rewrite_titles_doctype_internal_subset_survives(tmp_path: Path) -> None:
    """A DOCTYPE with an internal subset (``[ ... ]``) must be preserved
    through the in-place rewrite and remain well-formed."""
    from backend.modules.notation.backfill import _rewrite_titles

    raw = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<!DOCTYPE score-partwise ["
        "<!ENTITY dash '&#8212;'>"
        "]>\n"
        '<score-partwise version="4.0">\n' + _ONE_PART_SCORE_WITH_CREDITS
    ).encode("utf-8")
    sheet = _rewrite_titles_fixture(tmp_path, raw)

    changed = _rewrite_titles(sheet, "New Title", "New Composer")
    assert changed is True

    body = sheet.read_bytes()
    root = ET.fromstring(body)  # must not raise ET.ParseError
    assert root.find("work/work-title").text == "New Title"
    assert b"<!ENTITY dash" in body


def test_rewrite_titles_leaves_original_byte_identical_on_write_failure(
    tmp_path: Path, monkeypatch
) -> None:
    """When the write path fails after the splice, the file on disk must be
    left byte-identical to before -- never a partial or corrupt write."""
    from backend.modules.notation import backfill as backfill_module
    from backend.modules.notation.backfill import _rewrite_titles

    raw = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<score-partwise version="4.0">\n' + _ONE_PART_SCORE_WITH_CREDITS
    ).encode("utf-8")
    sheet = _rewrite_titles_fixture(tmp_path, raw)
    original = sheet.read_bytes()

    def boom(*args, **kwargs):
        raise OSError("simulated disk failure")

    monkeypatch.setattr(backfill_module.Path, "write_bytes", boom, raising=True)

    changed = _rewrite_titles(sheet, "New Title", "New Composer")
    assert changed is False
    assert sheet.read_bytes() == original


def test_rewrite_titles_composer_type_normalized_variants_converge(
    tmp_path: Path,
) -> None:
    """A ``creator`` element whose ``type`` attribute differs only by case
    or surrounding whitespace (e.g. ``"Composer"``, ``" composer "``) must
    still be recognized and patched, matching ``_set_musicxml_composer``'s
    normalization in ``engine.py``. Also covers the exact-match
    ``type="composer"`` case and a ``creator`` with no ``type`` attribute at
    all, which ``(el.get("type") or "composer")`` treats as composer."""
    from backend.modules.notation.backfill import _rewrite_titles

    for type_attr in ("Composer", " composer ", "composer", None):
        creator_tag = (
            "<creator>Stale Composer</creator>"
            if type_attr is None
            else f'<creator type="{type_attr}">Stale Composer</creator>'
        )
        body = (
            "  <work><work-title>Correct Title</work-title></work>\n"
            "  <identification>\n"
            f"    {creator_tag}\n"
            "  </identification>\n"
            "  <part-list>\n"
            '    <score-part id="P1"><part-name>Lead</part-name></score-part>\n'
            "  </part-list>\n"
            '  <part id="P1"><measure number="1"/></part>\n'
            "</score-partwise>\n"
        )
        raw = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<score-partwise version="4.0">\n' + body
        ).encode("utf-8")
        sheet = _rewrite_titles_fixture(tmp_path, raw)

        changed = _rewrite_titles(sheet, "Correct Title", "New Composer")
        assert changed is True, type_attr

        root = ET.fromstring(sheet.read_bytes())
        creator = root.find("identification/creator")
        assert creator.text == "New Composer", type_attr


# ---------------------------------------------------------------------------
# Seventh-audit CRITICAL (item 1): the fallback in ``_rewrite_titles`` must
# validate the bytes it falls back to. A control character injected into the
# title/composer (e.g. via a filename or a Settings -> notation.artist value
# that reaches ``_rewrite_titles`` directly, bypassing ``clean_title`` /
# ``artist_name``'s own stripping) must never be written over the user's
# only copy of the sheet.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("bad_char", ["\x00", "\x01", "\x0b", "\x0c", "\x1f"])
def test_rewrite_titles_control_char_in_title_leaves_file_untouched(
    tmp_path: Path, bad_char: str
) -> None:
    from backend.modules.notation.backfill import _rewrite_titles

    raw = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<score-partwise version="4.0">\n' + _ONE_PART_SCORE_WITH_CREDITS
    ).encode("utf-8")
    sheet = _rewrite_titles_fixture(tmp_path, raw)
    original = sheet.read_bytes()

    changed = _rewrite_titles(sheet, f"Bad{bad_char}Title", "")
    assert changed is False, repr(bad_char)
    assert sheet.read_bytes() == original, repr(bad_char)
    ET.fromstring(sheet.read_bytes())  # still parses


@pytest.mark.parametrize("bad_char", ["\x00", "\x01", "\x0b", "\x0c", "\x1f"])
def test_rewrite_titles_control_char_in_composer_leaves_file_untouched(
    tmp_path: Path, bad_char: str
) -> None:
    from backend.modules.notation.backfill import _rewrite_titles

    raw = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<score-partwise version="4.0">\n' + _ONE_PART_SCORE_WITH_CREDITS
    ).encode("utf-8")
    sheet = _rewrite_titles_fixture(tmp_path, raw)
    original = sheet.read_bytes()

    changed = _rewrite_titles(sheet, "", f"Bad{bad_char}Composer")
    assert changed is False, repr(bad_char)
    assert sheet.read_bytes() == original, repr(bad_char)
    ET.fromstring(sheet.read_bytes())  # still parses


def test_rewrite_titles_lone_surrogate_in_title_leaves_file_untouched(
    tmp_path: Path,
) -> None:
    """A lone UTF-16 surrogate (unrepresentable in UTF-8 at all) must also
    never reach disk -- covered by the outer ``except Exception`` around the
    ``tree.write`` encode step, not the two-stage ET.fromstring guard, since
    ``str.encode("utf-8")`` raises before any bytes are produced."""
    from backend.modules.notation.backfill import _rewrite_titles

    raw = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<score-partwise version="4.0">\n' + _ONE_PART_SCORE_WITH_CREDITS
    ).encode("utf-8")
    sheet = _rewrite_titles_fixture(tmp_path, raw)
    original = sheet.read_bytes()

    changed = _rewrite_titles(sheet, "Bad\ud800Title", "")
    assert changed is False
    assert sheet.read_bytes() == original
    ET.fromstring(sheet.read_bytes())  # still parses


# ---------------------------------------------------------------------------
# Seventh-audit MAJOR (item 2): ``_rewrite_titles`` must write through
# ``atomic_write`` (temp-sibling + retrying ``os.replace``), not a bare
# ``Path.write_bytes``. This proves the replace step itself -- not just an
# earlier write -- is where a failure is tolerated without corrupting the
# destination, which the pre-existing ``Path.write_bytes``-monkeypatch test
# above does not: that one fails BEFORE any bytes land anywhere.
# ---------------------------------------------------------------------------


def test_rewrite_titles_atomic_replace_failure_leaves_original_untouched_and_no_leftover_temp(
    tmp_path: Path, monkeypatch
) -> None:
    from backend.lib import atomic as atomic_module
    from backend.modules.notation.backfill import _rewrite_titles

    raw = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<score-partwise version="4.0">\n' + _ONE_PART_SCORE_WITH_CREDITS
    ).encode("utf-8")
    sheet = _rewrite_titles_fixture(tmp_path, raw)
    original = sheet.read_bytes()

    def boom(src, dest):
        raise OSError("simulated contended-destination failure")

    monkeypatch.setattr(atomic_module, "atomic_replace", boom, raising=True)

    changed = _rewrite_titles(sheet, "New Title", "New Composer")
    assert changed is False
    # The destination is exactly the pre-write bytes -- the temp file (which
    # DID get written) never replaced it.
    assert sheet.read_bytes() == original
    # atomic_write's failure path unlinks its temp sibling; nothing named
    # like it should remain beside the sheet.
    leftovers = [p for p in tmp_path.iterdir() if p != sheet]
    assert leftovers == [], leftovers


# ---------------------------------------------------------------------------
# Seventh-audit MAJOR (item 3): the /pack route's non-part-scoped re-credit
# has the same two-stage fallback bug as ``_rewrite_titles``: a control
# character in the credited artist must never make it into the shipped zip
# member, whether via the prolog-splice fallback or the plain-ET fallback.
# ---------------------------------------------------------------------------


def test_pack_route_control_char_in_credited_artist_falls_back_to_original_bytes(
    tmp_path: Path, monkeypatch
) -> None:
    from backend.modules.library import router as library_router_module
    from backend.modules.notation import router as notation_router_module
    from tests.test_library_store import _seed_generate_entry

    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")

    _seed_generate_entry(
        tmp_path, "job_pk3", 0, extra_meta={"title": "Portishead - Roads"}
    )
    entry_id = "job_pk3_00"
    store = library_router_module.get_store()
    assert store.get_entry(entry_id) is not None
    entry_dir = tmp_path / "job_pk3" / "00"
    sheet = entry_dir / "notation" / "song.musicxml"
    _write_two_part_musicxml_file(sheet)
    original_bytes = sheet.read_bytes()
    store.db.add_notation_artifact(
        artifact_id="song_sheet3", entry_id=entry_id, kind="musicxml", path=str(sheet)
    )

    # Force the credited artist to carry a control character that
    # ElementTree happily serializes without raising, but no XML parser
    # accepts -- the exact reproduction the audit gave for item 1/3.
    monkeypatch.setattr(
        notation_router_module, "_chart_artist", lambda entry: "Bad\x0bArtist"
    )

    def fake_convert_score(db, **kwargs):
        output_path = Path(kwargs["output_path"])
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(b"%PDF-1.4 fake pack pdf")
        return {"ok": True, "path": str(output_path), "engine": "osmd"}

    monkeypatch.setattr(notation_router_module, "convert_score", fake_convert_score)

    response = notation_router_module.download_score_pack("song_sheet3")

    with zipfile.ZipFile(io.BytesIO(response.body)) as zf:
        names = zf.namelist()
        musicxml_name = next(n for n in names if n.endswith(".musicxml"))
        musicxml_bytes = zf.read(musicxml_name)

    # The zip member falls back to the pristine original bytes: well-formed,
    # and never carrying the injected control character.
    assert musicxml_bytes == original_bytes
    ET.fromstring(musicxml_bytes)  # must not raise
    # The on-disk artifact is untouched either way -- the /pack route never
    # writes back to it.
    assert sheet.read_bytes() == original_bytes


# ---------------------------------------------------------------------------
# Eighth-audit MAJOR (item 2 + item 5): the PART-SCOPED siblings of the two
# branches guarded last round had no guard of their own. ``stage_parts``
# itself must now refuse to hand back a ``StagedParts`` whose staged file
# failed to parse, and both part-scoped consumers (``/pack?parts=`` and
# ``convert_score`` with ``options={"parts": [...]}``) must surface that as
# a clean failure rather than shipping/moving/registering corrupt XML.
# ---------------------------------------------------------------------------


def test_stage_parts_raises_when_the_staged_file_fails_to_parse(
    tmp_path: Path, monkeypatch
) -> None:
    from backend.modules.notation.engine import stage_parts

    source = tmp_path / "source.musicxml"
    _write_two_part_musicxml_file(source)
    output_path = tmp_path / "out" / "scoped.musicxml"

    with pytest.raises(ValueError):
        stage_parts(
            source,
            [0],
            "Song",
            output_path=output_path,
            artist="Bad\x00Artist",
        )

    # No leftover scratch file trusted by a caller.
    scratch = output_path.with_name(f"{output_path.stem}__parts_src.musicxml")
    assert not scratch.exists()


def test_pack_route_part_scoped_control_char_in_credited_artist_fails_clean(
    tmp_path: Path, monkeypatch
) -> None:
    from fastapi import HTTPException

    from backend.modules.library import router as library_router_module
    from backend.modules.notation import router as notation_router_module
    from tests.test_library_store import _seed_generate_entry

    monkeypatch.setattr(library_router_module, "_store", None)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(tmp_path))
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")

    _seed_generate_entry(
        tmp_path, "job_pk4", 0, extra_meta={"title": "Portishead - Roads"}
    )
    entry_id = "job_pk4_00"
    store = library_router_module.get_store()
    assert store.get_entry(entry_id) is not None
    entry_dir = tmp_path / "job_pk4" / "00"
    sheet = entry_dir / "notation" / "song.musicxml"
    _write_two_part_musicxml_file(sheet)
    original_bytes = sheet.read_bytes()
    store.db.add_notation_artifact(
        artifact_id="song_sheet4", entry_id=entry_id, kind="musicxml", path=str(sheet)
    )

    # Bypass the chokepoint strip (item 1) to prove ``stage_parts``'s own
    # guard (item 2) independently catches the same shape of defect.
    monkeypatch.setattr(
        notation_router_module, "_chart_artist", lambda entry: "Bad\x0bArtist"
    )

    with pytest.raises(HTTPException) as exc_info:
        notation_router_module.download_score_pack("song_sheet4", parts="0")

    assert exc_info.value.status_code == 422
    # The on-disk artifact is untouched -- no half-written scoped file left
    # beside it that a retry or a directory listing would trip over.
    assert sheet.read_bytes() == original_bytes
    leftovers = [p for p in (entry_dir / "notation").iterdir() if p != sheet]
    assert leftovers == [], leftovers


def test_convert_score_part_scoped_control_char_in_credited_artist_never_moves_or_registers(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(engine, "_chart_artist", lambda entry: "Bad\x0bArtist")
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track", "title": "Portishead - Roads"})
    source = tmp_path / "source.musicxml"
    _write_two_part_musicxml_file(source)
    output_path = tmp_path / "notation" / "scoped.musicxml"

    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=source,
        fmt="musicxml",
        output_path=output_path,
        title="Portishead - Roads",
        options={"parts": [0]},
    )

    assert result["ok"] is False, result
    # Nothing moved onto the output path -- a previously-good part-scoped
    # export at that path must survive a failed re-export untouched.
    assert not output_path.exists()
    assert db.list_notation_artifacts("track") == []


# ---------------------------------------------------------------------------
# Ninth-audit CRITICAL (item 1): a source-derived part/instrument name (a
# MIDI track-name meta event) reached music21's MusicXML writer unstripped,
# so an unpitched control character in a track name corrupted the whole-sheet
# export and got registered as a valid artifact. Only the part-scoped path
# (stage_parts) rejected this; the non-part-scoped music21 writer and the
# arrangement writer did not.
# ---------------------------------------------------------------------------


def _write_midi_with_bad_track_name(path: Path) -> None:
    """A single instrument whose name carries a raw control character -- the
    exact reproduction the ninth audit gave (``b"Gui\x01tar"``)."""
    inst = pretty_midi.Instrument(program=24, name="Gui\x01tar")
    for i, pitch in enumerate([60, 62, 64, 65, 67, 69, 71, 72]):
        start = i * 0.5
        inst.notes.append(
            pretty_midi.Note(velocity=100, pitch=pitch, start=start, end=start + 0.5)
        )
    pm = pretty_midi.PrettyMIDI()
    pm.instruments.append(inst)
    path.parent.mkdir(parents=True, exist_ok=True)
    pm.write(str(path))


def test_convert_score_whole_sheet_strips_control_char_in_source_part_name(
    tmp_path: Path, monkeypatch
) -> None:
    """The non-part-scoped MusicXML export (no ``options["parts"]``) of a MIDI
    whose track-name meta event carries a control character must still write
    a well-formed file and register it -- or, if it somehow still fails to
    parse, must never register a corrupt artifact."""
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track", "title": "Song"})
    midi_path = tmp_path / "midi" / "bad_name.mid"
    _write_midi_with_bad_track_name(midi_path)
    output_path = tmp_path / "notation" / "song.musicxml"

    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="musicxml",
        output_path=output_path,
        title="Song",
    )

    if result["ok"]:
        written = output_path.read_bytes()
        ET.fromstring(written)  # must not raise
        assert b"\x01" not in written
        assert db.list_notation_artifacts("track") != []
    else:
        # Never register a corrupt artifact.
        assert db.list_notation_artifacts("track") == []


def test_convert_with_arrangement_strips_control_char_in_source_part_name(
    tmp_path: Path, monkeypatch
) -> None:
    """The arrangement writer (:func:`midi_to_arrangement`) uses the same
    music21 writer as the whole-sheet export and needs the same treatment for
    a source-derived part name."""
    from backend.modules.notation.engine import midi_to_arrangement

    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track", "title": "Song"})
    midi_path = tmp_path / "midi" / "bad_name.mid"
    _write_midi_with_bad_track_name(midi_path)
    output_path = tmp_path / "notation" / "song__lead.musicxml"

    result = midi_to_arrangement(
        db,
        entry_id="track",
        sources=[midi_path],
        style="lead-sheet",
        output_path=output_path,
        title="Song",
    )

    if result["ok"]:
        written = output_path.read_bytes()
        ET.fromstring(written)  # must not raise
        assert b"\x01" not in written
        assert db.list_notation_artifacts("track") != []
    else:
        assert db.list_notation_artifacts("track") == []


# ---------------------------------------------------------------------------
# Ninth-audit MAJOR (item 2): backfill's composer must be resolved PER ENTRY
# via ``_chart_artist``, matching every export path, not the global
# ``artist_name()`` resolved once outside the loop -- otherwise an entry
# whose title splits confidently into artist/track never converges and is
# regenerated (or title-patched back to the wrong credit) on every launch.
# ---------------------------------------------------------------------------


def test_backfill_composer_convergence_uses_the_entrys_resolved_artist(
    tmp_path: Path, monkeypatch
) -> None:
    from backend.modules.library.store import LibraryStore
    from backend.modules.notation.backfill import backfill_scores
    from backend.modules.notation.engine import midi_to_musicxml, sheet_output_path
    from tests.test_notation_misc_b12 import _seed_entry

    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")

    entry_id = "track"
    _seed_entry(tmp_path, entry_id, "Portishead - Roads")
    store = LibraryStore(tmp_path)
    assert store.db is not None

    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)
    store.db.add_midi(
        midi_id="midi1",
        entry_id=entry_id,
        source="full",
        midi_path=str(midi_path),
        engine="basic_pitch",
        engine_version="0.4.0",
        notes_count=8,
    )

    out = sheet_output_path(store, entry_id, "midi1")
    assert out is not None
    result = midi_to_musicxml(
        store.db,
        entry_id=entry_id,
        midi_path=midi_path,
        output_path=out,
        source_ref="midi1",
        artifact_id="midi1__musicxml",
        title="Portishead - Roads",
    )
    assert result["ok"] is True, result
    # The entry's own name splits confidently -- credited to "Portishead",
    # never the unrelated global artist name.
    assert _composer_from_musicxml(Path(result["path"])) == "Portishead"

    res = backfill_scores(store)
    assert res["errors"] == 0, res
    # Already correctly credited via the entry's own identity split: must
    # converge immediately, not be regenerated (or title-patched) just
    # because it disagrees with the global artist name.
    assert res["fixed"] == 0, res
    assert res["generated"] == 0, res

    sheets_after = store.db.list_notation_artifacts(entry_id, kind="musicxml")
    assert len(sheets_after) == 1, sheets_after
    assert _composer_from_musicxml(Path(sheets_after[0]["path"])) == "Portishead"


# ---------------------------------------------------------------------------
# Tenth audit (structural fix): a control character in a MIDI track-name
# meta event, or in a MIDI lyric meta event, corrupted a part-scoped or
# PDF/SVG-engraved export because both go through :func:`_stage_musicxml`,
# which ran neither the strip nor the validate that the whole-sheet music21
# writer already had. The fix introduces :func:`_write_musicxml` as the one
# place in this module allowed to call ``score.write("musicxml", ...)``, and
# every writer -- including staging -- now goes through it.
# ---------------------------------------------------------------------------


def _write_midi_with_lyric_control_char(path: Path) -> None:
    """A single instrument whose first note carries a lyric meta event with
    a raw control character (``b"La\\x06la"``) IN THE SAME TRACK as the
    notes -- music21 only attaches a lyric to a note when both share a
    track, which is why the lyric meta event is spliced into the notes
    track with ``mido`` rather than left on ``pretty_midi``'s own (separate)
    tempo/meta track."""
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

    mid = mido.MidiFile(str(path))
    notes_track = mid.tracks[-1]
    notes_track.insert(0, mido.MetaMessage("lyrics", text="La\x06la", time=0))
    mid.save(str(path))


def test_convert_score_part_scoped_strips_control_char_in_source_track_name(
    tmp_path: Path, monkeypatch
) -> None:
    """A part-scoped MusicXML export of a MIDI whose track-name meta event
    carries a control character goes through ``stage_parts`` ->
    ``_stage_musicxml``, which the tenth audit found ran neither the strip
    nor the validate -- unlike the whole-sheet export above."""
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track", "title": "Song"})
    midi_path = tmp_path / "midi" / "bad_name.mid"
    _write_midi_with_bad_track_name(midi_path)
    output_path = tmp_path / "notation" / "song__parts.musicxml"

    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="musicxml",
        output_path=output_path,
        title="Song",
        options={"parts": [0]},
    )

    assert result["ok"] is True, result
    written = output_path.read_bytes()
    ET.fromstring(written)  # must not raise
    assert b"\x01" not in written


def test_convert_score_pdf_export_strips_control_char_in_source_track_name(
    tmp_path: Path, monkeypatch
) -> None:
    """The PDF export of a MIDI whose track-name meta event carries a
    control character also stages through ``_stage_musicxml`` (inside
    ``_engrave``), one level further out than the part-scoped case above --
    the fourth call site the tenth audit found unguarded."""
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track", "title": "Song"})
    midi_path = tmp_path / "midi" / "bad_name.mid"
    _write_midi_with_bad_track_name(midi_path)

    monkeypatch.setattr(
        engine.pdf_render, "available", lambda: {"ok": True, "node": "node"}
    )
    staged_bytes: list[bytes] = []

    def fake_render_musicxml_pdf(source, output, artist="", **kwargs):
        staged_bytes.append(Path(source).read_bytes())
        output = Path(output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"%PDF-1.4 fake pdf")
        return {"ok": True, "pages": 1, "bytes": 20, "error": None}

    monkeypatch.setattr(
        engine.pdf_render, "render_musicxml_pdf", fake_render_musicxml_pdf
    )

    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="pdf",
        output_path=tmp_path / "notation" / "pdf" / "song.pdf",
        title="Song",
        options={"engine": "osmd"},
    )

    assert result["ok"] is True, result
    assert len(staged_bytes) == 1
    ET.fromstring(staged_bytes[0])  # the staged musicxml handed to OSMD must parse
    assert b"\x01" not in staged_bytes[0]


def test_lyric_bearing_midi_strips_control_char_whole_sheet_export(
    tmp_path: Path, monkeypatch
) -> None:
    """A lyric meta event with a control character (standard in karaoke
    MIDIs) reaches ``<lyric><text>`` raw unless stripped -- the second gap
    the tenth audit found, in the whole-sheet export."""
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track", "title": "Song"})
    midi_path = tmp_path / "midi" / "lyric.mid"
    _write_midi_with_lyric_control_char(midi_path)
    output_path = tmp_path / "notation" / "song.musicxml"

    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="musicxml",
        output_path=output_path,
        title="Song",
    )

    assert result["ok"] is True, result
    written = output_path.read_bytes()
    ET.fromstring(written)  # must not raise
    assert b"\x06" not in written
    assert b"Lala" in written


def test_lyric_bearing_midi_strips_control_char_part_scoped_export(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track", "title": "Song"})
    midi_path = tmp_path / "midi" / "lyric.mid"
    _write_midi_with_lyric_control_char(midi_path)
    output_path = tmp_path / "notation" / "song__parts.musicxml"

    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="musicxml",
        output_path=output_path,
        title="Song",
        options={"parts": [0]},
    )

    assert result["ok"] is True, result
    written = output_path.read_bytes()
    ET.fromstring(written)  # must not raise
    assert b"\x06" not in written


def test_lyric_bearing_midi_strips_control_char_pdf_export(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track", "title": "Song"})
    midi_path = tmp_path / "midi" / "lyric.mid"
    _write_midi_with_lyric_control_char(midi_path)

    monkeypatch.setattr(
        engine.pdf_render, "available", lambda: {"ok": True, "node": "node"}
    )
    staged_bytes: list[bytes] = []

    def fake_render_musicxml_pdf(source, output, artist="", **kwargs):
        staged_bytes.append(Path(source).read_bytes())
        output = Path(output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(b"%PDF-1.4 fake pdf")
        return {"ok": True, "pages": 1, "bytes": 20, "error": None}

    monkeypatch.setattr(
        engine.pdf_render, "render_musicxml_pdf", fake_render_musicxml_pdf
    )

    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="pdf",
        output_path=tmp_path / "notation" / "pdf" / "song.pdf",
        title="Song",
        options={"engine": "osmd"},
    )

    assert result["ok"] is True, result
    assert len(staged_bytes) == 1
    ET.fromstring(staged_bytes[0])
    assert b"\x06" not in staged_bytes[0]


def test_write_musicxml_failure_leaves_no_corrupt_file_whole_sheet_export(
    tmp_path: Path, monkeypatch
) -> None:
    """When ``_validate_written_musicxml`` rejects the file music21 just
    wrote, the tenth audit found the corrupt file was left on disk at the
    artifact output path for the whole-sheet music21 writer and the
    arrangement writer (unlike ``stage_parts``, which already unlinked its
    scratch file on failure). ``_write_musicxml`` now does the cleanup once,
    for every caller."""
    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    monkeypatch.setattr(
        engine,
        "_validate_written_musicxml",
        lambda path: (_ for _ in ()).throw(ValueError("forced validation failure")),
    )
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track", "title": "Song"})
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)
    output_path = tmp_path / "notation" / "song.musicxml"

    result = engine.convert_score(
        db,
        entry_id="track",
        source_path=midi_path,
        fmt="musicxml",
        output_path=output_path,
        title="Song",
    )

    assert result["ok"] is False, result
    assert not output_path.exists()
    assert db.list_notation_artifacts("track") == []


def test_write_musicxml_failure_leaves_no_corrupt_file_arrangement_export(
    tmp_path: Path, monkeypatch
) -> None:
    from backend.modules.notation.engine import midi_to_arrangement

    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    monkeypatch.setattr(
        engine,
        "_validate_written_musicxml",
        lambda path: (_ for _ in ()).throw(ValueError("forced validation failure")),
    )
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track", "title": "Song"})
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)
    output_path = tmp_path / "notation" / "song__lead.musicxml"

    result = midi_to_arrangement(
        db,
        entry_id="track",
        sources=[midi_path],
        style="lead-sheet",
        output_path=output_path,
        title="Song",
    )

    assert result["ok"] is False, result
    assert not output_path.exists()
    assert db.list_notation_artifacts("track") == []


_UNGUARDED_WRITER_ATTRS = (
    "write",
    "show",
    "write_bytes",
    "write_text",
    "move",
    "copy",
    "copyfile",
    "copy2",
)


def _scan_unguarded_writer_calls(
    package_dir: Path,
    allowlist: dict[tuple[str, int, str, str], str],
    *,
    guarded_rel: str = "engine.py",
    guarded_func: str = "_write_musicxml",
) -> tuple[list[str], set[tuple[str, int, str, str]]]:
    """Walk every ``*.py`` file under ``package_dir`` for an ``Attribute``
    call named one of :data:`_UNGUARDED_WRITER_ATTRS`. A call is fine when it
    is lexically inside ``guarded_func`` in ``guarded_rel``, or when its
    ``(relative path, lineno, receiver-expression-text, attribute name)`` is
    a key in ``allowlist``; anything else is a violation. Returns
    ``(violations, seen_allowlist_keys)`` so a caller can additionally assert
    every allow-list entry was actually matched (no stale entries).

    Factored out of :func:`test_only_write_musicxml_calls_the_music21_musicxml_writer`
    so a regression test can point the same mechanism at a synthetic
    directory and prove it actually flags an escape, rather than only ever
    running against the real package (where, by definition, it currently
    finds nothing to flag)."""
    seen_allowlist_keys: set[tuple[str, int, str, str]] = set()
    violations: list[str] = []

    for path in sorted(package_dir.rglob("*.py")):
        rel = path.relative_to(package_dir).as_posix()
        source = path.read_text(encoding="utf-8")
        tree = ast.parse(source, filename=str(path))
        func_stack: list[str] = []

        class _Visitor(ast.NodeVisitor):
            def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
                func_stack.append(node.name)
                self.generic_visit(node)
                func_stack.pop()

            def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
                func_stack.append(node.name)
                self.generic_visit(node)
                func_stack.pop()

            def visit_Call(self, node: ast.Call) -> None:
                if (
                    isinstance(node.func, ast.Attribute)
                    and node.func.attr in _UNGUARDED_WRITER_ATTRS
                ):
                    receiver = ast.unparse(node.func.value)
                    key = (rel, node.lineno, receiver, node.func.attr)
                    enclosing = func_stack[-1] if func_stack else None
                    if rel == guarded_rel and enclosing == guarded_func:
                        pass
                    elif key in allowlist:
                        seen_allowlist_keys.add(key)
                    else:
                        violations.append(
                            f"{rel}:{node.lineno} calls {receiver}.{node.func.attr}"
                            f"(...) in {enclosing or '<module scope>'}, outside "
                            f"{guarded_func} and not on the allow-list"
                        )
                self.generic_visit(node)

        _Visitor().visit(tree)

    return violations, seen_allowlist_keys


def test_only_write_musicxml_calls_the_music21_musicxml_writer() -> None:
    """The mechanical guard for the tenth/eleventh/twelfth-audit structural
    fix: nothing anywhere in the notation package may call a music21
    Score/Stream's ``.write(...)``/``.show(...)``, or a ``Path``'s
    ``.write_bytes(...)``/``.write_text(...)``, except
    :func:`engine._write_musicxml` itself. A per-line regex on one file only
    caught the exact one-line ``score.write("musicxml", ...)`` call this
    module happened to have -- it missed a multi-line wrapped call (what
    ruff-format produces for a long call), ``write(fmt=...)``, ``show(...)``,
    an aliased writer, and any write added under ``arrangers/`` or
    ``exporters/``. The twelfth audit then found the AST walk itself was
    blind to ``Path.write_bytes``/``Path.write_text`` -- music21's
    ``GeneralObjectExporter().parse(score)`` hands back serialized bytes a
    caller can drop straight past the guard with ``output_path.write_bytes(...)``
    -- so those two attrs are now covered too. This walks the real AST of
    every file in the package: any ``Attribute`` call named ``write``,
    ``show``, ``write_bytes``, or ``write_text`` must either be enclosed by
    ``engine.py``'s ``_write_musicxml``, or be on the explicit allow-list
    below of non-music21 writers the audits already accounted for (exact
    file:line *and* receiver-expression text, not a name/substring match,
    so a new write has to be reviewed and added by hand rather than
    silently matching a stale pattern).

    Known, deliberately-not-closed escapes (twelfth audit, item 4): a
    receiver reached via ``getattr(score, "write")(...)``, an aliased
    ``w = score.write; w(...)``, a bare imported ``write(...)`` (no
    ``Attribute`` node at all), and ``shutil.copy``/``shutil.copyfile`` of an
    already-written, unvalidated file are all invisible to an AST walk keyed
    on ``ast.Attribute`` call sites -- closing them needs either a runtime
    guard on the writer itself or a broader taint-tracking analysis, neither
    of which this test attempts. Reviewers scanning a diff for a new writer
    should grep for these forms by hand; this guard is a floor, not a
    ceiling.

    Scope (twelfth audit, item 5): this walk covers only
    ``backend/modules/notation/`` (``package_dir`` below). ``music21`` is
    also imported by ``backend/modules/sheetimport/{parser,router,__init__}.py``,
    ``backend/modules/library/store.py``, and ``backend/modules/midi/runner.py``;
    none of those currently write MusicXML (``sheetimport`` only calls
    ``converter.parse`` and writes raw upload bytes via
    ``NamedTemporaryFile``, confirmed by reading all three sheetimport files
    at the time of this audit), so widening the walk today would add scope
    without catching a live defect. Left as a documented boundary rather
    than widened: if ``sheetimport`` ever grows an "export the imported
    sheet" path, whoever adds it must also add a MusicXML writer there
    through :func:`engine._write_musicxml` (or extend this test's
    ``package_dir`` to include it) -- there is no guard here that would
    catch a new writer landing outside ``backend/modules/notation/``."""
    package_dir = Path(engine.__file__).parent

    # Keyed on (path, lineno, receiver-expression-text, attribute name)
    # rather than just (path, lineno): a bare (path, lineno) key sanctions
    # EVERY call on that line regardless of which object it is called on or
    # which attribute is invoked (two `.write(...)` calls on DIFFERENT
    # receivers, chained/juxtaposed on one line, would both pass under a
    # single entry -- e.g. `a.write(...); b.write(...)` on one line), and
    # silently re-targets itself onto whatever new call happens to land on
    # that line number after an edit shifts the real sanctioned call down --
    # the receiver text pins the entry to the specific call it was written
    # for, so either of those turns into a normal violation (the new call
    # doesn't match the recorded receiver) plus a normal staleness failure
    # (the real call moved to a line this entry no longer names) instead of
    # a silent pass-through. The attribute name closes the sibling escape
    # where two calls target the SAME receiver on one line with different
    # attributes (`x.write_text(...) or x.write_bytes(...)`) -- without it
    # in the key, the first matched attribute's entry would silently cover
    # the second call too.
    allowlist = {
        (
            "arrangers/score_arrange.py",
            750,
            "out",
            "write",
        ): "pretty_midi.write (MIDI, not MusicXML)",
        (
            "backfill.py",
            371,
            "tree",
            "write",
        ): "xml.etree.ElementTree.write (title/composer backfill patch)",
        (
            "engine.py",
            1450,
            "tree",
            "write",
        ): "xml.etree.ElementTree.write (stage_parts scratch file)",
        (
            "engine.py",
            1871,
            "tree",
            "write",
        ): "xml.etree.ElementTree.write (MuseScore re-credit scratch file)",
        (
            "engine.py",
            1551,
            "shutil",
            "move",
        ): (
            "shutil.move (stage_parts already validated the staged "
            "MusicXML before this moves it onto the export destination)"
        ),
        (
            "engine.py",
            2232,
            "output_path",
            "write_text",
        ): "Path.write_text (ABC export, plain text -- not MusicXML)",
        (
            "engine.py",
            2534,
            "output_path",
            "write_text",
        ): "Path.write_text (alphaTex export, plain text -- not MusicXML)",
        (
            "exporters/beatsaber.py",
            328,
            "path",
            "write_text",
        ): "Path.write_text (Beat Saber Info.dat/note-JSON, not MusicXML)",
        (
            "exporters/beatsaber.py",
            417,
            "folder / README_NAME",
            "write_text",
        ): "Path.write_text (Beat Saber README, not MusicXML)",
        (
            "exporters/beatsaber.py",
            442,
            "zf",
            "write",
        ): "zipfile.ZipFile.write (packaging the .zip level)",
        (
            "exporters/chordtrack.py",
            225,
            "output_path",
            "write_text",
        ): "Path.write_text (chord-track JSON export, not MusicXML)",
        (
            "exporters/chordtrack.py",
            616,
            "log_emission[0]",
            "copy",
        ): (
            "numpy ndarray.copy (Viterbi decoder score vector, not a file "
            "writer -- caught only because adding shutil's move/copy/"
            "copyfile/copy2 to the guarded attribute set also matches "
            "ndarray/list/dict .copy())"
        ),
        (
            "exporters/notechart.py",
            1672,
            "output_path",
            "write_text",
        ): "Path.write_text (note-chart JSON export, not MusicXML)",
        (
            "router.py",
            1045,
            "tree",
            "write",
        ): "xml.etree.ElementTree.write (chords route XML patch)",
    }
    violations, seen_allowlist_keys = _scan_unguarded_writer_calls(
        package_dir, allowlist
    )

    assert not violations, "unguarded music21 writer call(s) found:\n" + "\n".join(
        violations
    )
    stale = set(allowlist) - seen_allowlist_keys
    assert not stale, (
        f"allow-list entries no longer match any call site: {sorted(stale)}"
    )


# ---------------------------------------------------------------------------
# Thirteenth audit MAJOR 1/2: the allow-list key omitted ``node.func.attr``,
# so a sanctioned ``(file, lineno, receiver)`` sanctioned ANY writer
# attribute called on that line/receiver -- swapping a real call for a
# different writer attribute at the same spot passed silently. The key is
# now ``(file, lineno, receiver, attr)`` and ``shutil.move``/``copy``/
# ``copyfile``/``copy2`` were added to the guarded attribute set.
# ---------------------------------------------------------------------------


def test_scan_flags_attribute_swap_not_covered_by_allowlist(tmp_path: Path) -> None:
    """An allow-list entry keyed on ``(file, lineno, receiver)`` alone (the
    twelfth-audit shape) sanctions every writer attribute called at that
    exact spot -- so swapping ``output_path.write_text(...)`` for
    ``output_path.write_bytes(...)`` on the SAME line, against the SAME
    receiver, must still be reported as a violation once the entry is keyed
    on ``(file, lineno, receiver, attr)`` and the allow-list only names
    ``write_text``."""
    pkg = tmp_path / "pkg"
    pkg.mkdir()
    (pkg / "engine.py").write_text(
        "def _write_musicxml():\n"
        "    pass\n"
        "\n"
        "def export(output_path, text):\n"
        "    output_path.write_bytes(text.encode())\n",
        encoding="utf-8",
    )
    allowlist = {
        ("engine.py", 5, "output_path", "write_text"): "was write_text",
    }
    violations, seen = _scan_unguarded_writer_calls(pkg, allowlist)
    assert violations, "attribute swap at the allow-listed spot must be flagged"
    assert "write_bytes" in violations[0]
    assert seen == set(), "the write_text entry must not match a write_bytes call"


def test_scan_flags_two_calls_on_one_line_same_receiver(tmp_path: Path) -> None:
    """Two writer calls chained on ONE line against the SAME receiver but
    with DIFFERENT attributes -- ``output_path.write_text(a) or
    output_path.write_bytes(b)`` -- must both be individually checked
    against the allow-list: allow-listing ``write_text`` at that line must
    not also sanction the ``write_bytes`` call juxtaposed on it, now that
    the attribute name is part of the key."""
    pkg = tmp_path / "pkg"
    pkg.mkdir()
    (pkg / "engine.py").write_text(
        "def _write_musicxml():\n"
        "    pass\n"
        "\n"
        "def export(output_path, a, b):\n"
        "    _ = output_path.write_text(a) or output_path.write_bytes(b)\n",
        encoding="utf-8",
    )
    allowlist = {
        ("engine.py", 5, "output_path", "write_text"): "the write_text half",
    }
    violations, seen = _scan_unguarded_writer_calls(pkg, allowlist)
    assert len(violations) == 1
    assert "write_bytes" in violations[0]
    assert ("engine.py", 5, "output_path", "write_text") in seen


def test_scan_flags_unguarded_shutil_move_but_allows_listed_one(
    tmp_path: Path,
) -> None:
    """``shutil.move``/``copy``/``copyfile``/``copy2`` are now in
    ``_UNGUARDED_WRITER_ATTRS``: an unreviewed ``shutil.move`` of a file that
    was never validated as MusicXML must be flagged, while the real,
    allow-listed ``engine.py`` call -- ``stage_parts``'s already-validated
    staged file being moved onto the export destination -- stays clean."""
    assert {"move", "copy", "copyfile", "copy2"} <= set(_UNGUARDED_WRITER_ATTRS)

    pkg = tmp_path / "pkg"
    pkg.mkdir()
    (pkg / "engine.py").write_text(
        "def _write_musicxml():\n"
        "    pass\n"
        "\n"
        "def export(staged_path, output_path):\n"
        "    shutil.move(str(staged_path), str(output_path))\n",
        encoding="utf-8",
    )
    allowlist: dict[tuple[str, int, str, str], str] = {}
    violations, seen = _scan_unguarded_writer_calls(pkg, allowlist)
    assert violations and "shutil" in violations[0] and "move" in violations[0]

    real_allowlist = {
        ("engine.py", 1551, "shutil", "move"): "allowed stage_parts move",
    }
    real_violations, real_seen = _scan_unguarded_writer_calls(
        Path(engine.__file__).parent, real_allowlist
    )
    assert not any(v.startswith("engine.py:1551") for v in real_violations), (
        real_violations
    )
    assert ("engine.py", 1551, "shutil", "move") in real_seen


# ---------------------------------------------------------------------------
# Eleventh audit MAJOR 1: score.metadata text fields (title, movementName,
# movementNumber, composer, lyricist, copyright) were never routed through
# _strip_invalid_xml_chars the way part/instrument names and lyrics are.
# _new_score stamps the RAW title into score.metadata.title before
# midi_to_arrangement's own `if clean: md.title = clean` gate runs, and
# clean_title("\x01.wav") == "" -- so a title that reduces to empty leaves
# the raw dirty value sitting in metadata, unstripped, all the way to the
# writer. _write_musicxml now strips every metadata text field itself.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("style", STYLES)
def test_arrangement_dirty_title_exports_successfully_with_cleaned_title(
    tmp_path: Path, monkeypatch, style: str
) -> None:
    """A title that reduces to "" under ``clean_title`` (``"\x01.wav"``)
    used to leave ``_new_score``'s raw, unstripped stamp in
    ``score.metadata.title`` because ``midi_to_arrangement``'s
    ``if clean: md.title = clean`` never fires for an empty ``clean`` --
    the control character then reached the writer and the export failed
    outright. It must now succeed, with the control character stripped from
    the written title, for every arrangement style."""
    from backend.modules.notation.engine import midi_to_arrangement

    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track", "title": "\x01.wav"})
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)
    output_path = tmp_path / "notation" / f"song__{style}.musicxml"

    result = midi_to_arrangement(
        db,
        entry_id="track",
        sources=[midi_path],
        style=style,
        output_path=output_path,
        title="\x01.wav",
    )

    assert result["ok"] is True, result
    written = output_path.read_bytes()
    ET.fromstring(written)  # must not raise
    assert b"\x01" not in written
    assert db.list_notation_artifacts("track") != []


def test_strip_score_metadata_cleans_every_text_field_before_writing(
    tmp_path: Path,
) -> None:
    """Unit-level coverage of :func:`engine._strip_score_metadata` for the
    fields the eleventh audit flagged -- title, movementName,
    movementNumber, composer, lyricist, copyright -- exercised through the
    real chokepoint (:func:`engine._write_musicxml`), since no current
    caller stamps movementName/movementNumber/lyricist/copyright itself
    (only title/composer are ever set); the audit set them directly on
    ``score.metadata`` to verify the strip covers the whole field set."""
    import music21  # type: ignore[import]
    from music21.metadata import Metadata  # type: ignore[import]

    score = music21.stream.Score()
    part = music21.stream.Part()
    part.append(music21.note.Note("C4"))
    score.insert(0, part)
    md = Metadata()
    score.insert(0, md)
    md.title = "Ti\x01tle"
    md.movementName = "Mv\x02Name"
    md.movementNumber = "N\x03o1"
    md.composer = "Comp\x04oser"
    md.lyricist = "Lyr\x05icist"
    md.copyright = "Copy\x06right"

    output_path = tmp_path / "notation" / "metadata.musicxml"
    final_path = engine._write_musicxml(score, output_path, what="metadata test")

    written = final_path.read_bytes()
    ET.fromstring(written)  # must not raise
    for bad in (b"\x01", b"\x02", b"\x03", b"\x04", b"\x05", b"\x06"):
        assert bad not in written
    assert b"Title" in written
    assert b"MvName" in written
    assert b"No1" in written
    assert b"Composer" in written
    assert b"Lyricist" in written
    assert b"Copyright" in written


# ---------------------------------------------------------------------------
# Eleventh audit MAJOR 2: _write_musicxml used to write into the caller's
# LIVE artifact path and unlink it on validation failure, so a failed
# re-export destroyed the previous good artifact and left a dangling DB row.
# Re-export onto a deterministic artifact_id/output_path is the NORMAL case
# (router.py builds both deterministically), not an edge case.
# ---------------------------------------------------------------------------


def test_arrangement_reexport_failure_leaves_previous_artifact_untouched(
    tmp_path: Path, monkeypatch
) -> None:
    """A failed re-export onto the same artifact_id/output_path must leave
    the previously registered artifact byte-identical on disk, with the DB
    row still resolving to an existing file -- not truncate the live
    artifact and unlink the remains."""
    from backend.modules.notation.engine import midi_to_arrangement

    monkeypatch.setattr(engine, "artist_name", lambda: "GANTASMO")
    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "track", "title": "Song"})
    midi_path = tmp_path / "midi" / "scale.mid"
    _write_scale_midi(midi_path)
    output_path = tmp_path / "notation" / "song__piano-reduction.musicxml"
    artifact_id = "track__song__piano-reduction__musicxml"

    good = midi_to_arrangement(
        db,
        entry_id="track",
        sources=[midi_path],
        style="piano-reduction",
        output_path=output_path,
        artifact_id=artifact_id,
        title="Song",
    )
    assert good["ok"] is True, good
    assert output_path.exists()
    good_bytes = output_path.read_bytes()
    good_artifact = db.get_notation_artifact(artifact_id)
    assert good_artifact is not None
    assert Path(good_artifact["path"]).exists()

    monkeypatch.setattr(
        engine,
        "_validate_written_musicxml",
        lambda path: (_ for _ in ()).throw(ValueError("forced validation failure")),
    )

    bad = midi_to_arrangement(
        db,
        entry_id="track",
        sources=[midi_path],
        style="piano-reduction",
        output_path=output_path,
        artifact_id=artifact_id,
        title="Song",
    )

    assert bad["ok"] is False, bad
    assert output_path.exists()
    assert output_path.read_bytes() == good_bytes
    still_registered = db.get_notation_artifact(artifact_id)
    assert still_registered is not None
    assert Path(still_registered["path"]).exists()
    assert Path(still_registered["path"]).read_bytes() == good_bytes


# ---------------------------------------------------------------------------
# Twelfth audit MAJOR 1: ``score.write`` and ``atomic_replace`` inside
# ``_write_musicxml`` used to sit OUTSIDE the ``try`` that cleans up the
# uuid-suffixed temp file, so a failure in either step (``atomic_replace``
# exhausting its retries against a contended/held destination, or
# ``score.write`` raising mid-write) leaked a ``.<stem>.<uuid>.musicxml``
# file beside the real artifact forever. Nothing ever swept it, and
# ``_kind_and_stem_for_file`` classified it as a real ``musicxml`` artifact
# the next time ``register_on_disk_artifacts`` scanned the directory.
# ---------------------------------------------------------------------------


def test_write_musicxml_atomic_replace_failure_leaves_no_leaked_temp(
    tmp_path: Path, monkeypatch
) -> None:
    """A forced ``atomic_replace`` failure inside ``_write_musicxml`` must
    leave the artifact directory with NO file at all (no destination, since
    none existed yet, and no leftover ``.<uuid>.musicxml`` temp) -- not a
    leaked temp that a later scan could pick up as a real artifact."""
    import music21  # type: ignore[import]

    score = music21.stream.Score()
    part = music21.stream.Part()
    part.append(music21.note.Note("C4"))
    score.insert(0, part)

    output_dir = tmp_path / "notation"
    output_path = output_dir / "song.musicxml"

    def boom(src, dest):
        raise OSError("simulated contended-destination failure")

    monkeypatch.setattr(engine, "atomic_replace", boom, raising=True)

    with pytest.raises(OSError):
        engine._write_musicxml(score, output_path, what="forced replace failure")

    assert not output_dir.exists() or list(output_dir.iterdir()) == []


def test_write_musicxml_score_write_failure_leaves_no_leaked_temp(
    tmp_path: Path, monkeypatch
) -> None:
    """Same as above, for the other now-guarded step: ``score.write`` itself
    raising must not leave a leaked temp file (there is nothing to unlink
    from music21's own writer in this case, but the guard must not choke
    when ``written_path`` was never reassigned from ``tmp``)."""
    import music21  # type: ignore[import]

    score = music21.stream.Score()
    part = music21.stream.Part()
    part.append(music21.note.Note("C4"))
    score.insert(0, part)

    output_dir = tmp_path / "notation"
    output_path = output_dir / "song.musicxml"

    def boom(self, fmt, fp=None, **kwargs):
        # music21 has already created the parent dir and may have started
        # writing to fp by the time it raises; simulate that partial state.
        Path(fp).write_bytes(b"<partial>")
        raise RuntimeError("simulated music21 writer crash")

    monkeypatch.setattr(music21.stream.Score, "write", boom, raising=True)

    with pytest.raises(RuntimeError):
        engine._write_musicxml(score, output_path, what="forced writer crash")

    assert output_dir.is_dir()
    assert list(output_dir.iterdir()) == []


def test_write_musicxml_leaked_temp_not_registered_as_artifact(
    tmp_path: Path,
) -> None:
    """Belt-and-suspenders for the hard-crash case no ``try`` can cover (the
    process dying mid-write): a leading-dot file matching
    ``_write_musicxml``'s own temp-naming scheme must never be classified as
    a real notation artifact by :func:`engine._kind_and_stem_for_file`, so
    :func:`engine.register_on_disk_artifacts` can never register it."""
    entry_dir = tmp_path / "entry"
    notation_dir = entry_dir / "notation"
    notation_dir.mkdir(parents=True)
    leaked = notation_dir / f".song.{'a1b2c3d4' * 4}.musicxml"
    leaked.write_bytes(b"<partial-and-corrupt>")

    kind, stem = engine._kind_and_stem_for_file(leaked)
    assert kind is None

    db = LibraryDB(tmp_path / "library.db")
    db.upsert_entry({"id": "entry", "title": "Song"})
    recovered = engine.register_on_disk_artifacts(db, entry_dir, "entry")
    assert recovered == []
    assert db.list_notation_artifacts("entry") == []


# ---------------------------------------------------------------------------
# Twelfth audit MAJOR 2: the AST guard's attr tuple was ``("write", "show")``
# only, so ``Path.write_bytes``/``Path.write_text`` -- exactly what
# ``output_path.write_bytes(GeneralObjectExporter().parse(score))`` would
# use to drop a MusicXML export straight past the guard -- went unseen.
# ---------------------------------------------------------------------------


def test_write_musicxml_guard_catches_write_bytes_escape(tmp_path: Path) -> None:
    """A hand-written module using ``Path.write_bytes`` to dump music21's
    serialized MusicXML bytes, bypassing ``_write_musicxml`` entirely, must
    be caught by :func:`test_only_write_musicxml_calls_the_music21_musicxml_writer`
    -- reproduced here in isolation against a throwaway file so the failure
    mode itself (the previous guard reporting zero violations for a real
    ``write_bytes`` escape) is pinned down independent of the full package
    walk. This test does not touch the notation package's write surface --
    it proves the AST-matching mechanism handles the attr before trusting
    the packagewide walk to use it."""
    source = (
        "from pathlib import Path\n"
        "def dump(output_path: Path, data: bytes) -> None:\n"
        "    output_path.write_bytes(data)\n"
    )
    tree = ast.parse(source, filename="synthetic.py")
    attrs_seen = {
        node.func.attr
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
    }
    assert "write_bytes" in attrs_seen
    # The guard's own attr tuple must include it -- this is what the
    # eleventh-audit version of the guard did NOT do.
    guard_attrs = ("write", "show", "write_bytes", "write_text")
    assert "write_bytes" in guard_attrs and "write_text" in guard_attrs
