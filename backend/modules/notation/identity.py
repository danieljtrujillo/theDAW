"""Artist / song identity for notation.

Imported music arrives as a FILENAME, not as tagged metadata, so a sheet
engraved from "04 - JERU THE DAMAJA - LORD LYRICAL.mp3" was titled with the
whole string and credited to the global GANTASMO name. Both halves were wrong:
the artist is JERU THE DAMAJA and the song is LORD LYRICAL.

This module answers one question -- given whatever name an entry carries, what
is the ARTIST and what is the SONG -- and it answers "I do not know" rather
than guessing, because a sheet credited to the wrong artist is worse than a
sheet with no artist at all. When the split is not confident the caller gets an
empty artist and falls back to the configured composer credit
(:func:`backend.modules.notation.engine.artist_name`).

THE SPLIT RULE
--------------
A hyphen is only a separator when it stands ALONE between whitespace: ``" - "``,
``" -- "``, ``" -- "`` with en/em dashes, or the underscore-padded ``"_-_"`` that
download tools produce. A hyphen glued to its neighbours is part of a name, which
is what keeps "Jay-Z", "24-7" and "Blade-Runner" whole. Beyond that separator,
the split is only accepted when BOTH sides carry a letter and the artist side is
plausibly short -- so "Blade Runner - 2049" (year on the right) and an
overlong left side stay unsplit. The FIRST separator wins, because the filename
convention is artist-first; "Artist - Song - Live" is therefore artist "Artist"
and song "Song - Live", never artist "Artist - Song".

Overrides beat all of it. :func:`resolve_identity` reads the per-entry
``notation_artist`` / ``notation_title`` the user typed in the inspector before
it parses anything.
"""

from __future__ import annotations

import json
import re
from typing import Any, Mapping, Optional

from .engine import _MEDIA_EXTENSIONS, strip_track_prefix

# Entry metadata keys holding the user's explicit corrections. They live in the
# entry's metadata.json (library USER_MUTABLE_FIELDS), not in a table of their
# own, so they travel with the entry directory like every other user edit.
OVERRIDE_ARTIST_KEY = "notation_artist"
OVERRIDE_TITLE_KEY = "notation_title"

# Name fields to parse when no override is stored, best first.
_NAME_KEYS = ("title", "filename", "audio_filename", "media_filename")

# Separator candidates, always whitespace-delimited on BOTH sides: ASCII hyphen
# runs plus en dash / em dash / horizontal bar / minus sign. Whitespace-delimited
# is the whole trick -- "Jay-Z" and "Sunn O)))" carry no such separator, so they
# never split.
_SEPARATOR_RE = re.compile(r"\s+(?:-{1,3}|[–—―−])\s+")

# "Artist_-_Title" from downloaders: underscores stand in for the spaces, so
# normalize them to a plain " - " before looking for the separator. Only an
# underscore-padded DASH is rewritten; a bare underscore is left alone because
# "Artist_Title" carries no evidence of where the artist ends.
_UNDERSCORE_SEPARATOR_RE = re.compile(r"_+\s*(?:-{1,3}|[–—―−])\s*_+")

# A Unicode letter (neither digit nor underscore). Both sides of a split must
# contain one, which is what rejects "Blade Runner - 2049".
_HAS_LETTER_RE = re.compile(r"[^\W\d_]")

# Whitespace and dash characters clinging to either end of a split half, e.g.
# the trailing dash left by "Artist - Title -".
_EDGE_TRIM_RE = re.compile(r"^[\s\-–—―−]+|[\s\-–—―−]+$")

# A trailing bracketed group and the junk that may sit inside one.
_TRAILING_BRACKET_RE = re.compile(r"\s*[([{]([^()\[\]{}]*)[)\]}]\s*$")
_JUNK_INNER_RE = re.compile(
    r"^(?:"
    r"official(?:\s+\w+){0,2}\s*(?:video|audio|visual(?:i[sz]er)?|version)"
    r"|(?:music|lyrics?)\s*video"
    r"|(?:with\s+)?lyrics?"
    r"|audio|video|visual(?:i[sz]er)?"
    r"|h[dq]|[48]k|(?:1080|720|480)p?|full\s*hd"
    r"|explicit|clean|uncensored"
    r"|free\s*download|download|reupload|remaster(?:ed)?"
    r")$",
    re.IGNORECASE,
)

# An artist name longer than this is almost certainly a sentence, a description
# or a title that happens to contain a dash, so the split is refused. Real names
# ("Earth, Wind & Fire", "Nick Cave and the Bad Seeds") sit well inside it.
_MAX_ARTIST_CHARS = 64


def _strip_media_extension(name: str) -> str:
    """Drop ONE trailing media/symbolic extension, using the engine's list so
    the two never disagree about what counts as a media file."""
    low = name.lower()
    for ext in _MEDIA_EXTENSIONS:
        if low.endswith(ext):
            return name[: -len(ext)].rstrip()
    return name


def strip_junk_suffixes(name: str) -> str:
    """Drop trailing "(Official Video)" / "[HQ]" / "(Lyrics)" style noise.

    Only bracketed groups whose whole content is junk are removed, and they are
    removed repeatedly so "Title (Official Video) [HQ]" ends at "Title". A group
    that carries real information -- "[Remix]", "(Live at Montreux)", "(feat. X)"
    -- is left in the title, because that IS part of the song's name.
    """
    text = (name or "").strip()
    while True:
        match = _TRAILING_BRACKET_RE.search(text)
        if match is None:
            return text
        inner = match.group(1).strip()
        if not inner or not _JUNK_INNER_RE.match(inner):
            return text
        text = text[: match.start()].rstrip()


def _tidy(part: str) -> str:
    """Collapse the leftovers of a filename into a readable name: underscores
    to spaces, runs of whitespace to one space, stray separators trimmed."""
    text = part.replace("_", " ")
    text = re.sub(r"\s+", " ", text).strip()
    return _EDGE_TRIM_RE.sub("", text)


def _is_confident(artist: str, title: str) -> bool:
    """Whether a candidate split is trustworthy enough to publish.

    Every rule here exists to REFUSE a split, because the caller degrades
    gracefully on an empty artist and cannot recover from a wrong one.
    """
    if not artist or not title:
        return False
    # "Blade Runner - 2049": a side with no letters is a year, a track count or
    # a disc number, never an artist and never a song name.
    if not _HAS_LETTER_RE.search(artist) or not _HAS_LETTER_RE.search(title):
        return False
    if len(artist) > _MAX_ARTIST_CHARS:
        return False
    return True


def split_artist_title(raw: str) -> tuple[str, str]:
    """Split a track name into ``(artist, title)``.

    The title is always cleaned (extension, track number and junk suffixes
    dropped). The artist is ``""`` whenever no confident separator is found, so
    a caller can fall back to its own credit rather than stamping a guess on a
    sheet. See the module docstring for the rule.
    """
    name = (raw or "").strip()
    if not name:
        return "", ""

    name = _strip_media_extension(name)
    name = strip_junk_suffixes(name)
    # Track numbers are stripped AFTER the extension so "04 - Song.mp3" reduces
    # to "Song", and BEFORE the split so "04 - Artist - Title" does not offer
    # "04" as the artist.
    name = strip_track_prefix(name)
    name = _UNDERSCORE_SEPARATOR_RE.sub(" - ", name)

    match = _SEPARATOR_RE.search(name)
    if match is None:
        return "", _tidy(name)

    # First separator wins: filenames are artist-first, so any later dash
    # belongs to the song ("Artist - Song - Live").
    artist = _tidy(name[: match.start()])
    title = _tidy(name[match.end() :])
    if not _is_confident(artist, title):
        return "", _tidy(name)
    return artist, title


def _lookup(entry: Any, key: str) -> str:
    """Read one string field off an entry, whatever shape it arrives in.

    Callers hold a ``LibraryRecord`` (attributes), a metadata.json payload
    (mapping) or a DB row (mapping whose ``metadata_json`` is a JSON string), so
    all three are probed before giving up.
    """
    if entry is None:
        return ""
    value: Any = None
    if isinstance(entry, Mapping):
        value = entry.get(key)
    else:
        value = getattr(entry, key, None)
    if value:
        return str(value).strip()

    nested: Optional[Mapping[str, Any]] = None
    raw_meta: Any = (
        entry.get("metadata_json")
        if isinstance(entry, Mapping)
        else getattr(entry, "metadata_json", None)
    )
    if isinstance(raw_meta, str) and raw_meta.strip():
        try:
            parsed = json.loads(raw_meta)
        except ValueError:
            parsed = None
        if isinstance(parsed, Mapping):
            nested = parsed
    elif isinstance(raw_meta, Mapping):
        nested = raw_meta
    if nested is not None and nested.get(key):
        return str(nested[key]).strip()
    return ""


def resolve_identity(entry: Any) -> tuple[str, str]:
    """Final ``(artist, title)`` for an entry's notation.

    An explicit override always wins; anything the user did not correct is
    parsed from the entry's name. The artist may still be ``""`` (no override,
    no confident split), which the caller answers with its configured composer
    credit.
    """
    artist = _lookup(entry, OVERRIDE_ARTIST_KEY)
    title = _lookup(entry, OVERRIDE_TITLE_KEY)
    if artist and title:
        return artist, title

    raw = ""
    for key in _NAME_KEYS:
        raw = _lookup(entry, key)
        if raw:
            break
    parsed_artist, parsed_title = split_artist_title(raw)
    return artist or parsed_artist, title or parsed_title
