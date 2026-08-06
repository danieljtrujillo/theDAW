"""Unit tests for artist / song identity parsing.

Two things are being asserted here, and the second matters more than the first:
that real filename shapes split into the right artist and song, and that an
AMBIGUOUS name refuses to split at all. A sheet credited to the wrong artist is
worse than a sheet with no artist, so every non-split case below is a feature.
"""

from __future__ import annotations

from backend.modules.notation.identity import (
    resolve_identity,
    split_artist_title,
    strip_junk_suffixes,
)


# ---- Confident splits -------------------------------------------------------


def test_the_reported_case_splits_artist_from_song() -> None:
    assert split_artist_title("04 - JERU THE DAMAJA - LORD LYRICAL.mp3") == (
        "JERU THE DAMAJA",
        "LORD LYRICAL",
    )


def test_plain_artist_title() -> None:
    assert split_artist_title("Portishead - Roads") == ("Portishead", "Roads")


def test_double_hyphen_separator() -> None:
    assert split_artist_title("Boards of Canada -- Roygbiv") == (
        "Boards of Canada",
        "Roygbiv",
    )


def test_underscore_padded_separator() -> None:
    assert split_artist_title("Aphex_Twin_-_Xtal") == ("Aphex Twin", "Xtal")


def test_underscore_padded_separator_with_track_number() -> None:
    assert split_artist_title("04_-_Aphex_Twin_-_Xtal.flac") == ("Aphex Twin", "Xtal")


def test_en_dash_separator() -> None:
    assert split_artist_title("Massive Attack – Teardrop") == (
        "Massive Attack",
        "Teardrop",
    )


def test_track_number_prefix_is_dropped_before_splitting() -> None:
    assert split_artist_title("07. Nas - N.Y. State of Mind") == (
        "Nas",
        "N.Y. State of Mind",
    )


def test_official_video_suffix_is_dropped() -> None:
    assert split_artist_title("Gorillaz - Clint Eastwood (Official Video)") == (
        "Gorillaz",
        "Clint Eastwood",
    )


def test_official_audio_and_hq_suffixes_are_dropped() -> None:
    assert split_artist_title("Radiohead - Idioteque (Official Audio) [HQ]") == (
        "Radiohead",
        "Idioteque",
    )


def test_lyrics_suffix_is_dropped() -> None:
    assert split_artist_title("Adele - Hello (Lyrics).mp3") == ("Adele", "Hello")


def test_remix_bracket_is_part_of_the_song_not_junk() -> None:
    assert split_artist_title("Fatboy Slim - Praise You [Remix]") == (
        "Fatboy Slim",
        "Praise You [Remix]",
    )


def test_media_extension_alone_is_dropped() -> None:
    assert split_artist_title("Squarepusher - Come On My Selector.wav") == (
        "Squarepusher",
        "Come On My Selector",
    )


def test_artist_with_punctuation_survives() -> None:
    assert split_artist_title("AC/DC - Back in Black") == ("AC/DC", "Back in Black")
    assert split_artist_title("Earth, Wind & Fire - September") == (
        "Earth, Wind & Fire",
        "September",
    )
    assert split_artist_title("Sunn O))) - Aghartha") == ("Sunn O)))", "Aghartha")


def test_first_separator_wins_so_a_dashed_song_keeps_its_dash() -> None:
    # Artist-first is the filename convention, so the extra dash belongs to the
    # song. The artist must never come back as "Artist - Song".
    assert split_artist_title("Fugazi - Waiting Room - Live") == (
        "Fugazi",
        "Waiting Room - Live",
    )


# ---- Deliberate non-splits --------------------------------------------------


def test_year_on_the_right_is_not_a_song() -> None:
    artist, title = split_artist_title("Blade Runner - 2049")
    assert artist == ""
    assert title == "Blade Runner - 2049"


def test_hyphenated_name_is_never_split() -> None:
    assert split_artist_title("Jay-Z") == ("", "Jay-Z")
    assert split_artist_title("Jay-Z.mp3") == ("", "Jay-Z")


def test_bare_name_with_no_separator() -> None:
    assert split_artist_title("Sunn O)))") == ("", "Sunn O)))")
    assert split_artist_title("99 Luftballons") == ("", "99 Luftballons")


def test_all_numeric_sides_do_not_split() -> None:
    assert split_artist_title("1-800-273-8255") == ("", "1-800-273-8255")
    assert split_artist_title("24 - 7") == ("", "24 - 7")


def test_glued_hyphen_is_not_a_separator() -> None:
    assert split_artist_title("Blade-Runner-2049") == ("", "Blade-Runner-2049")


def test_overlong_left_side_refuses_to_become_an_artist() -> None:
    long_left = (
        "a sprawling ambient improvisation recorded one winter morning in a shed"
    )
    artist, title = split_artist_title(f"{long_left} - part two")
    assert artist == ""
    assert title == f"{long_left} - part two"


def test_empty_input() -> None:
    assert split_artist_title("") == ("", "")
    assert split_artist_title("   ") == ("", "")


def test_track_number_only_name_keeps_its_title() -> None:
    assert split_artist_title("04 - Untitled.mp3") == ("", "Untitled")


# ---- Junk suffix stripping --------------------------------------------------


def test_strip_junk_suffixes_is_repeated_and_conservative() -> None:
    assert strip_junk_suffixes("Song (Official Music Video) [4K]") == "Song"
    assert strip_junk_suffixes("Song (Live at Montreux)") == "Song (Live at Montreux)"
    assert strip_junk_suffixes("Song (feat. Someone)") == "Song (feat. Someone)"


# ---- resolve_identity -------------------------------------------------------


def test_resolve_identity_parses_when_no_override_is_stored() -> None:
    entry = {"title": "04 - JERU THE DAMAJA - LORD LYRICAL.mp3"}
    assert resolve_identity(entry) == ("JERU THE DAMAJA", "LORD LYRICAL")


def test_stored_override_beats_the_parse() -> None:
    entry = {
        "title": "04 - JERU THE DAMAJA - LORD LYRICAL.mp3",
        "notation_artist": "Jeru the Damaja",
        "notation_title": "Come Clean",
    }
    assert resolve_identity(entry) == ("Jeru the Damaja", "Come Clean")


def test_partial_override_leaves_the_other_half_parsed() -> None:
    entry = {
        "title": "Jeru The Damaja - Lord Lyrical",
        "notation_artist": "Jeru the Damaja",
    }
    assert resolve_identity(entry) == ("Jeru the Damaja", "Lord Lyrical")


def test_override_rescues_an_ambiguous_name() -> None:
    entry = {"title": "Blade Runner - 2049", "notation_artist": "Hans Zimmer"}
    assert resolve_identity(entry) == ("Hans Zimmer", "Blade Runner - 2049")


def test_override_read_from_a_db_rows_metadata_json() -> None:
    # library.db stores the entry's metadata.json as a JSON string column, so a
    # raw DB row must resolve the same way a metadata dict does.
    row = {
        "title": "Blade Runner - 2049",
        "metadata_json": '{"notation_artist": "Hans Zimmer", "notation_title": "2049"}',
    }
    assert resolve_identity(row) == ("Hans Zimmer", "2049")


def test_resolve_identity_falls_back_to_the_filename_field() -> None:
    entry = {"title": "", "filename": "Portishead - Roads.mp3"}
    assert resolve_identity(entry) == ("Portishead", "Roads")


def test_resolve_identity_reads_attributes_too() -> None:
    class Record:
        title = "Portishead - Roads"

    assert resolve_identity(Record()) == ("Portishead", "Roads")


def test_resolve_identity_of_nothing() -> None:
    assert resolve_identity(None) == ("", "")
    assert resolve_identity({}) == ("", "")


def test_ambiguous_entry_yields_no_artist_rather_than_a_wrong_one() -> None:
    artist, title = resolve_identity({"title": "Blade Runner - 2049.mp3"})
    assert artist == ""
    assert title == "Blade Runner - 2049"
