"""Identify which service a library track came from, and curate its tags.

A file the user drags in often already says where it was made or bought:
a Bandcamp download carries a purchase URL, a DAW bounce carries nothing
but an encoder string. This module turns those signals into one small,
stable answer — :class:`ProviderInfo` — and picks the handful of embedded
fields that describe the SONG out of the much larger pile of frames that
describe how people reacted to it.

Suno files come in two observed shapes:

* **Re-tagged by a harvester** — ``generator=suno``, ``album=Suno AI``, a
  ``TXXX:suno_id`` uuid and hundreds of ``txxx_suno_*`` frames. Any one of
  those three markers identifies the track outright (confidence
  ``"explicit"``, or ``"inferred"`` for the album).
* **A stock download straight from Suno** — exactly five keys, none of them
  Suno-specific by name: ``title``, ``artist`` (the account's display
  name), ``album`` (the same string as the title), ``comment`` (the bare
  track id: a lowercase hyphenated uuid and nothing else) and ``date``.
  Nothing names the service, so this shape is identified by INFERENCE from
  its fingerprint — a bare-uuid comment together with ``album == title``
  (see :attr:`ProviderRule.fingerprint`). It is the weakest signal in the
  module and runs only when every other rule found nothing.

Everything here is pure: dicts in, dicts out. No file reads, no database,
no imports from ``store`` / ``router`` / ``db``. The library holds ~200k
entries and the read path calls :func:`detect_provider` per entry, so the
work stays table lookups over a dict that the caller already has.

Adding a provider is one row in :data:`PROVIDER_RULES`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional

__all__ = [
    "ANALYTICS_KEY_PATTERNS",
    "CURATED_FIELDS",
    "GENERIC_TOOL_MARKERS",
    "FALLBACK_PROVIDER",
    "GENERIC_TOOL_PREFIXES",
    "ORIGIN_TOOL_FRAME",
    "PROVIDER_RULES",
    "PROVIDER_SLUG_MAX",
    "URL_KEY_PRIORITY",
    "ProviderInfo",
    "ProviderRule",
    "curated_fields",
    "detect_provider",
    "detection_outranks",
    "is_analytics_key",
    "provider_wire_fields",
]


@dataclass(frozen=True)
class ProviderInfo:
    """Where a track came from, and how sure we are about it."""

    provider: str
    """Stable lowercase slug: ``"suno"``, ``"udio"``, ``"bandcamp"``, ..."""

    label: str
    """Display name: ``"Suno"``."""

    is_ai: bool
    """True for a generation service, False for a store / host / unknown tool."""

    provider_id: Optional[str]
    """The provider's own track id, when the file carries one."""

    confidence: str
    """``"explicit"`` (a generator or id frame says so) or ``"inferred"``
    (the album, a URL, or the comment says so)."""

    evidence: str
    """The deciding tag, e.g. ``"generator=suno"``."""

    origin: str = ""
    """Which KIND of signal decided this, when a consumer has to rank the
    answer against another one: :data:`ORIGIN_TOOL_FRAME` for a slug MINTED
    from an unrecognised tool/encoder frame, "" for every answer that came
    from a row of :data:`PROVIDER_RULES` (a named service, store or tool) or
    from the entry's own stored label.

    Not a wire field: :func:`provider_wire_fields` does not carry it and no
    metadata stores it. It exists so :func:`detection_outranks` can tell "this
    file names Suno" from "this file names a tool nobody has heard of", which
    are the same ``confidence`` but not the same strength of claim. Last and
    defaulted, so every existing construction of this class is unchanged.
    """


@dataclass(frozen=True)
class ProviderRule:
    """One row of the provider table.

    ``generator_values`` are matched against the value of the generator-ish
    frames (``generator`` / ``encoder`` / ``encoded_by`` / ``software`` /
    ``tool``); ``albums`` against the album frame; ``domains`` against any
    host found in a url-ish frame or the comment. All three are VALUE
    matches, which is all we may do for a provider nobody has a file from.

    ``id_keys`` names actual frames, so a row may only fill it with a key
    someone has observed in a real file. Suno is the only such row.

    ``fingerprint`` is the last resort for a download that names nobody: it
    is handed the whole tag dict and returns ``(provider_id, evidence)``
    when the SHAPE of the tags is that provider's, else None. It is the
    weakest signal in the module — every other rule, explicit or inferred,
    is tried first — so a row may only fill it with a shape someone has
    observed. Suno is the only such row.
    """

    provider: str
    label: str
    is_ai: bool
    generator_values: tuple[str, ...] = ()
    albums: tuple[str, ...] = ()
    domains: tuple[str, ...] = ()
    id_keys: tuple[str, ...] = ()
    fingerprint: Optional[Callable[[Mapping[str, Any]], Optional[tuple[str, str]]]] = (
        None
    )


#: :attr:`ProviderInfo.origin` for a slug minted from a tool/encoder frame no
#: row of :data:`PROVIDER_RULES` claims -- step 4 of :func:`detect_provider`.
ORIGIN_TOOL_FRAME = "tool_frame"

#: The slug the ``(model, source)`` fallback answers for an entry it cannot
#: place: made in theDAW, origin unspecified, not a generator.
#:
#: The canonical definition is ``db.DEFAULT_PROVIDER``. It cannot be imported
#: here -- ``db`` imports THIS module, and this module imports nothing of the
#: package -- so the string is spelled twice, exactly as the ``thedaw`` row of
#: :data:`PROVIDER_RULES` above already spells it. ``test_library_provider.py``
#: asserts the two are the same string, so they cannot drift.
FALLBACK_PROVIDER = "thedaw"


def detection_outranks(info: ProviderInfo, derived: str, derived_is_ai: bool) -> bool:
    """Whether a file's own tags beat the ``(model, source)`` derivation.

    ONE rank rule for both labelers -- the import-time one
    (``store._apply_provider_labels``) and the read-time one
    (``router._derive_provider``) -- so a track cannot be labeled one way when
    it is imported and another way when it is read.

    ``derived`` / ``derived_is_ai`` are the derivation's slug and role, which
    the caller has from ``db.derived_provider_wire`` (or ``db.infer_provider``
    plus ``db.DERIVED_PROVIDERS``). They are passed in rather than computed
    here because that table lives in ``db``, which imports this module.

    A detection wins by default: a file that names Suno, Udio, Riffusion,
    Magenta, Bandcamp -- any row of :data:`PROVIDER_RULES` -- outranks a guess
    made from a model string, which is the whole reason the read path looks at
    embedded tags at all. Two detections lose:

    a. **The fallback slug, against an AI derivation.** ``thedaw`` means "made
       in theDAW, origin unspecified" and is not a generator, while a theDAW
       generator frame is on every file this app writes -- including its own
       Stable Audio generations. Against an AI derivation the frame says
       nothing the columns do not already say better, and letting it win would
       refile a native generation as non-AI. Against any NON-AI derivation it
       wins: "made in theDAW" is more specific than "imported", and neither
       claims a generator.
    b. **A tool frame over an AI derivation.** Step 4 mints a slug from any
       tool/encoder string it does not recognise (:data:`ORIGIN_TOOL_FRAME`),
       and such a string describes what TOUCHED the file, not what made the
       music. An entry the columns call a generation has a better answer
       already, and it is an AI one; a bounce through some mastering tool must
       not turn it into a non-AI provider in the filter, the facet and the
       badge -- nor be persisted there by the read path's write-through.

    Note what is NOT a reason to lose: being non-AI. A Bandcamp or Imported
    answer from a named rule still outranks a generation guess, because it came
    from a signature someone observed rather than from an unknown string.

    ``derived`` is not read by either clause today -- both turn on the
    derivation's ROLE -- and is kept because a rule about a specific pair of
    slugs is the obvious next one, and because the two labelers should be
    handing this function the same two facts about the derivation either way.
    """
    if info.provider == FALLBACK_PROVIDER and derived_is_ai:
        return False
    if info.origin == ORIGIN_TOOL_FRAME and not info.is_ai and derived_is_ai:
        return False
    return True


# A canonical uuid and nothing else: 8-4-4-4-12 hex, any case.
_UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
    re.IGNORECASE,
)


def _suno_stock_fingerprint(
    embedded: Mapping[str, Any],
) -> Optional[tuple[str, str]]:
    """The shape of an untouched Suno download: a bare track id + album==title.

    A stock download carries five keys and names no service (see the module
    docstring). Two of them together are the tell: ``comment`` holding one
    canonical uuid and nothing else, and ``album`` repeating ``title``
    verbatim. Either alone is far too common — plenty of files use the album
    as the title, and a uuid in a comment is any tool's job id — so both are
    required, and the all-zero uuid (a placeholder, never a real track) is
    rejected.
    """
    comment = _lookup(embedded, "comment")
    if not comment or _UUID_RE.fullmatch(comment) is None:
        return None
    if _is_blank(comment):
        return None
    title = _lookup(embedded, "title")
    album = _lookup(embedded, "album")
    if not album or album != title:
        return None
    track_id = comment.lower()
    return track_id, f"comment={track_id} (bare track id, album==title)"


# The only provider whose frame names we have actually observed is Suno
# (the lead sampled 60 harvester-re-tagged files and the user's stock
# downloads); every other row identifies its provider through generic
# signals only — a generator string, the album, or a domain. Do not invent
# frame names for a service nobody has a file from.
#
# Suno therefore has three spellings in this table: the harvester shape's
# `generator=suno` / `album=Suno AI` / `txxx_suno_id` frames, and the stock
# download's `fingerprint`, which infers the provider from the shape of the
# five keys such a file carries. `chirp` is a fourth VALUE, not a fourth
# shape: it is Suno's model family, the string a tool frame carries when it
# names the model instead of the service, and `db.infer_provider` reads it as
# Suno already -- detection and derivation answer with one voice or a file is
# filed twice.
PROVIDER_RULES: tuple[ProviderRule, ...] = (
    ProviderRule(
        provider="suno",
        label="Suno",
        is_ai=True,
        generator_values=("suno", "chirp"),
        albums=("suno ai",),
        domains=("suno.com", "suno.ai"),
        id_keys=("txxx_suno_id",),
        fingerprint=_suno_stock_fingerprint,
    ),
    ProviderRule(
        provider="udio",
        label="Udio",
        is_ai=True,
        generator_values=("udio",),
        domains=("udio.com",),
    ),
    ProviderRule(
        provider="riffusion",
        label="Riffusion",
        is_ai=True,
        generator_values=("riffusion",),
        domains=("riffusion.com",),
    ),
    ProviderRule(
        provider="stability-ai",
        label="Stability AI",
        is_ai=True,
        generator_values=("stability", "stability ai", "stability-ai"),
        domains=("stability.ai",),
    ),
    ProviderRule(
        provider="elevenlabs",
        label="ElevenLabs",
        is_ai=True,
        generator_values=("elevenlabs", "eleven labs"),
        domains=("elevenlabs.io",),
    ),
    ProviderRule(
        provider="musicgen",
        label="MusicGen",
        is_ai=True,
        generator_values=("musicgen", "audiocraft"),
    ),
    # INT-002. theDAW's embedded Lyria 3 Pro sidecar writes no tags of its own
    # -- the audio it hands `library.importer` is whatever Gemini/OpenRouter
    # returned -- so this row is reached through `_legacy_lyria` (the metadata
    # markers the importer stamps), exactly the way a pre-labeling Suno entry
    # is. `generator_values` is the generic generator-frame spelling and
    # nothing invented: a file that names "lyria" as its tool came from here.
    # Label and AI-ness mirror `db.DERIVED_PROVIDERS` and `KNOWN_PROVIDERS` in
    # `frontend/src/catalog/catalogProviders.ts`.
    ProviderRule(
        provider="lyria",
        label="Lyria 3 Pro",
        is_ai=True,
        generator_values=("lyria", "lyria 3 pro"),
    ),
    # theDAW's own exports. Only the explicit Stable Audio spellings name the
    # generator; a frame that says "theDAW" says the file was made IN theDAW
    # and nothing about its origin -- a DJ performance set and a VJ clip carry
    # it too -- so it gets theDAW's own slug, the same one the column
    # fallback's last arm answers (`db.DEFAULT_PROVIDER`), and is not claimed
    # to be a generator. Label and AI-ness mirror `db.DERIVED_PROVIDERS` and
    # `KNOWN_PROVIDERS` in `frontend/src/catalog/catalogProviders.ts`.
    ProviderRule(
        provider="stable-audio",
        label="Stable Audio",
        is_ai=True,
        generator_values=("stable-audio", "stable audio"),
    ),
    ProviderRule(
        provider="thedaw",
        label="theDAW",
        is_ai=False,
        generator_values=("thedaw",),
    ),
    ProviderRule(
        provider="bandcamp",
        label="Bandcamp",
        is_ai=False,
        generator_values=("bandcamp",),
        domains=("bandcamp.com",),
    ),
    ProviderRule(
        provider="soundcloud",
        label="SoundCloud",
        is_ai=False,
        generator_values=("soundcloud",),
        domains=("soundcloud.com",),
    ),
    ProviderRule(
        provider="beatport",
        label="Beatport",
        is_ai=False,
        generator_values=("beatport",),
        domains=("beatport.com",),
    ),
    ProviderRule(
        provider="splice",
        label="Splice",
        is_ai=False,
        generator_values=("splice",),
        domains=("splice.com",),
    ),
    ProviderRule(
        provider="youtube",
        label="YouTube",
        is_ai=False,
        domains=("youtube.com", "youtu.be", "music.youtube.com"),
    ),
    ProviderRule(
        provider="spotify",
        label="Spotify",
        is_ai=False,
        domains=("spotify.com", "open.spotify.com"),
    ),
    ProviderRule(
        provider="apple-music",
        label="Apple Music",
        is_ai=False,
        domains=("music.apple.com",),
    ),
)

_RULES_BY_SLUG: dict[str, ProviderRule] = {r.provider: r for r in PROVIDER_RULES}

# Frames whose value names a tool. The first non-empty one decides.
GENERATOR_KEYS: tuple[str, ...] = (
    "generator",
    "tool",
    "software",
    "encoded_by",
    "encoder",
    "txxx_generator",
    "txxx_tool",
    "txxx_software",
    "itunes_generator",
    "itunes_tool",
)

# Which url-ish frame gets to decide where a track came from, best first.
# WOAS ("source") and WOAF ("file") are the ones that point at the track
# itself; a WXXX or any frame we have no name for is next; the artist's
# home page and the comment are weaker; and the rights/commerce frames go
# last, because a label's WPUB or a processor's WPAY says who gets paid,
# not where the audio was made. ``"*"`` is the slot for every url-ish key
# not named here.
URL_KEY_PRIORITY: tuple[str, ...] = (
    "source_url",
    "file_url",
    "*",
    "artist_url",
    "comment",
    "publisher_url",
    "commercial_url",
    "payment_url",
    "radio_url",
    "copyright_url",
)

_URL_OTHER_RANK = URL_KEY_PRIORITY.index("*")
_URL_RANK: dict[str, int] = {
    key: index for index, key in enumerate(URL_KEY_PRIORITY) if key != "*"
}

# A tool string that says how the bytes were encoded, not where the music
# came from. These never become a provider — an mp3 written by LAME inside
# Ableton is still a file of unknown origin.
#
# Matched on WHOLE tokens, never as substrings: "Sunshine Audio" is not the
# `shine` encoder, "David Synth" is not Avid, and "Treason Records" is not
# Propellerhead Reason. A multi-word marker must appear as a contiguous run
# of tokens ("fl studio" matches "FL Studio 21", not "studio fl").
GENERIC_TOOL_MARKERS: tuple[str, ...] = (
    "libav",
    "ffmpeg",
    "libmp3lame",
    "xing",
    "gstreamer",
    "opusenc",
    "oggenc",
    "vorbis",
    "faac",
    "qaac",
    "nero",
    "winamp",
    "foobar2000",
    "dbpoweramp",
    "exact audio copy",
    "handbrake",
    "mediahuman",
    "itunes",
    "windows media",
    "audacity",
    "reaper",
    "ableton",
    "ableton live",
    "fl studio",
    "image line",
    "logic pro",
    "garageband",
    "pro tools",
    "avid",
    "cubase",
    "nuendo",
    "steinberg",
    "studio one",
    "presonus",
    "bitwig",
    "cakewalk",
    "sonar",
    "samplitude",
    "mixcraft",
    "reason",
    "acid pro",
    "adobe audition",
    "sound forge",
    "wavelab",
    "waveform",
    "traktor",
    "serato",
    "rekordbox",
)

# Encoder names that ship glued to their version as one token
# ("Lavf58.76.100", "LAME3.100"). A bare token equal to the name counts too.
GENERIC_TOOL_PREFIXES: tuple[str, ...] = (
    "lavf",
    "lavc",
    "lame",
    "flac",
    "sox",
    "shine",
    "blade",
    "gogo",
    "x264",
)

# Analytics ABOUT the song (how it performed, who listened) rather than the
# song itself. Never ingested, never curated, never read for detection.
ANALYTICS_KEY_PATTERNS: tuple[str, ...] = (
    r".*_count$",
    r".*_class$",
    r".*_score$",
    r".*_rate$",
    r"^txxx_suno_reaction\b.*",
    r"^txxx_suno_session_.*",
    r"^txxx_suno_cluster_.*",
    r"^txxx_suno_nearest_neighbors$",
    r"^txxx_suno_action_config\b.*",
    r"^txxx_suno_metadata\.model_badges\b.*",
    r".*_image_url$",
    r"^txxx_suno_user_id$",
    r"^txxx_suno_is_following_creator$",
    r"^txxx_suno_days_since_creation$",
    r"^txxx_suno_persona\b.*",
)

_ANALYTICS_RE = re.compile(
    "|".join(f"(?:{p})" for p in ANALYTICS_KEY_PATTERNS), re.IGNORECASE
)

# Ordered source keys per curated field. First non-empty wins, left to right.
# The Suno key names are the lead's observation of real files; the bare names
# (``prompt``, ``artist``, ``bpm``, ...) are what `tags.py` surfaces for
# everything else, so one table covers every provider.
CURATED_FIELDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("provider_id", ("txxx_suno_id",)),
    ("prompt", ("prompt", "txxx_suno_prompt", "txxx_suno_metadata.prompt")),
    (
        "style",
        (
            "txxx_suno_style",
            "txxx_suno_style_prompt",
            "txxx_suno_metadata.tags",
            "style",
            "style_prompt",
        ),
    ),
    (
        "negative_prompt",
        (
            "txxx_suno_negative_tags",
            "txxx_suno_metadata.negative_tags",
            "negative_prompt",
        ),
    ),
    ("lyrics", ("lyrics", "txxx_suno_lyrics_prompt")),
    ("model", ("txxx_suno_model_name", "model")),
    (
        "model_version",
        ("txxx_suno_model_version", "txxx_suno_major_model_version", "model_version"),
    ),
    ("created_at", ("txxx_suno_created_date", "date")),
    ("artist", ("artist", "txxx_suno_handle")),
    ("bpm", ("txxx_suno_bpm", "txxx_suno_tempo", "bpm")),
    ("key", ("txxx_suno_key", "key")),
    ("parent_id", ("txxx_suno_parent_id", "txxx_suno_ancestry.parent_id")),
    (
        "is_instrumental",
        ("txxx_suno_is_instrumental", "txxx_suno_lyrics_is_instrumental"),
    ),
)

_INSTRUMENTAL_KEYS: tuple[str, ...] = (
    "txxx_suno_is_instrumental",
    "txxx_suno_lyrics_is_instrumental",
)

_VERSIONED_TOOL_RE: dict[str, re.Pattern[str]] = {
    prefix: re.compile(re.escape(prefix) + r"[0-9][0-9a-z]*")
    for prefix in GENERIC_TOOL_PREFIXES
}

_ZERO_UUID_RE = re.compile(r"^[0\-]+$")
_HOST_RE = re.compile(r"(?:https?://|www\.)?((?:[a-z0-9][a-z0-9\-]*\.)+[a-z]{2,})")
_TRUE_WORDS = frozenset({"true", "1", "yes", "y", "on"})
_FALSE_WORDS = frozenset({"false", "0", "no", "n", "off"})


def is_analytics_key(key: str) -> bool:
    """True when ``key`` is provider analytics we never ingest."""
    return bool(_ANALYTICS_RE.fullmatch(str(key).strip().lower()))


def _text(value: Any) -> str:
    """A trimmed string for a tag value, or "" for anything unusable.

    ``extract_embedded_tags`` promotes JSON-looking frames to dicts/lists,
    so a container here means "the value lives one level down" — the dotted
    lookup handles that, and stringifying the container would be noise.
    """
    if value is None or isinstance(value, (dict, list, tuple, set)):
        return ""
    if isinstance(value, bool):
        return "True" if value else "False"
    return str(value).strip()


def _is_blank(value: str) -> bool:
    return not value or _ZERO_UUID_RE.match(value) is not None


def _lookup(embedded: Mapping[str, Any], key: str) -> str:
    """Value for ``key``, honouring dotted paths into JSON-valued frames.

    ``txxx_suno_metadata.prompt`` is either a literal flat key or the
    ``prompt`` member of the dict parsed out of ``txxx_suno_metadata``;
    both spellings appear depending on how the frame was written.
    """
    if is_analytics_key(key):
        return ""
    if key in embedded:
        text = _text(embedded[key])
        if text:
            return text
    if "." not in key:
        return ""
    head, _, rest = key.partition(".")
    node: Any = embedded.get(head)
    for part in rest.split("."):
        if not isinstance(node, Mapping):
            return ""
        node = node.get(part)
    return _text(node)


def _first(embedded: Mapping[str, Any], keys: tuple[str, ...]) -> tuple[str, str]:
    """(value, key) for the first key with a usable value, else ("", "")."""
    for key in keys:
        value = _lookup(embedded, key)
        if not _is_blank(value):
            return value, key
    return "", ""


def _parse_bool(value: str) -> Optional[bool]:
    low = value.strip().lower()
    if low in _TRUE_WORDS:
        return True
    if low in _FALSE_WORDS:
        return False
    return None


#: Longest provider slug this module will produce.
#:
#: A slug is not a label: it is an identity that gets stored in every one of
#: an entry's ``metadata.json``, copied into the ``metadata_json`` column,
#: returned on every row of every list response, and compared by SQL. Nothing
#: legitimate needs more than this -- every slug in the provider table is
#: under ten characters. Unbounded, a file whose ``generator`` frame holds a
#: multi-kilobyte blob (a pasted document, a serialized blob, a corrupt
#: frame) turns that blob into the entry's permanent identity and carries it
#: through all four places. 64 leaves room for a genuinely long product name
#: while keeping a row's provider a thing you can read.
PROVIDER_SLUG_MAX = 64


def _slugify(value: str) -> str:
    """``value`` as a stable lowercase slug, bounded by
    :data:`PROVIDER_SLUG_MAX`.

    Truncation trims back off any separator it lands on, so a slug never ends
    in ``-`` and two values differing only past the bound still slugify to a
    readable name rather than to ``...-``. The result is empty only when the
    input had no alphanumerics at all, and empty means NO PROVIDER: both
    callers treat a falsy slug as "this frame identifies nothing".
    """
    slug = re.sub(r"[^a-z0-9]+", "-", value.strip().lower()).strip("-")
    if len(slug) > PROVIDER_SLUG_MAX:
        slug = slug[:PROVIDER_SLUG_MAX].rstrip("-")
    return slug


def _tokens(value: str) -> list[str]:
    """The alphanumeric words of a tool string, lowercased.

    "FL Studio 21" -> ["fl", "studio", "21"]; "Lavf58.76.100" ->
    ["lavf58", "76", "100"] — the version stays glued to the name, which
    is why :data:`GENERIC_TOOL_PREFIXES` exists.
    """
    return re.findall(r"[a-z0-9]+", value.lower())


def _has_token_run(tokens: list[str], needle: str) -> bool:
    """True when ``needle``'s words appear as a contiguous run in ``tokens``."""
    want = _tokens(needle)
    if not want or len(want) > len(tokens):
        return False
    span = len(want)
    return any(tokens[i : i + span] == want for i in range(len(tokens) - span + 1))


def _is_versioned_tool_token(token: str) -> bool:
    return any(
        token == prefix or _VERSIONED_TOOL_RE[prefix].fullmatch(token)
        for prefix in GENERIC_TOOL_PREFIXES
    )


def _is_generic_tool(value: str) -> bool:
    tokens = _tokens(value)
    if not tokens:
        return True
    if any(_is_versioned_tool_token(token) for token in tokens):
        return True
    return any(_has_token_run(tokens, marker) for marker in GENERIC_TOOL_MARKERS)


def _rule_for_tool(value: str) -> Optional[ProviderRule]:
    tokens = _tokens(value)
    if not tokens:
        return None
    for rule in PROVIDER_RULES:
        for candidate in rule.generator_values:
            if candidate and _has_token_run(tokens, candidate):
                return rule
    return None


def _rule_for_album(value: str) -> Optional[ProviderRule]:
    low = value.strip().lower()
    if not low:
        return None
    for rule in PROVIDER_RULES:
        if low in rule.albums:
            return rule
    return None


def _hosts(text: str) -> list[str]:
    return [m.group(1) for m in _HOST_RE.finditer(text.lower())]


def _rule_for_hosts(hosts: list[str]) -> tuple[Optional[ProviderRule], str]:
    for host in hosts:
        for rule in PROVIDER_RULES:
            for domain in rule.domains:
                if host == domain or host.endswith("." + domain):
                    return rule, host
    return None, ""


def _url_key_rank(key: str) -> int:
    """Position of ``key`` in :data:`URL_KEY_PRIORITY`; unnamed keys sit
    in the middle slot reserved for them."""
    if key in _URL_RANK:
        return _URL_RANK[key]
    return _URL_OTHER_RANK


def _url_candidates(embedded: Mapping[str, Any]) -> list[tuple[str, str]]:
    """(key, text) pairs that may contain an origin URL, best key first.

    A track bought on one site can carry the label's ``publisher_url`` and
    a ``payment_url`` for a processor that has nothing to do with where the
    audio came from, so the ranking decides which frame gets to speak.
    """
    out: list[tuple[str, str]] = []
    for key, raw in embedded.items():
        low = str(key).lower()
        if is_analytics_key(low):
            continue
        if low == "comment" or "url" in low or "website" in low or "wxxx" in low:
            text = _text(raw)
            if text:
                out.append((low, text))
    out.sort(key=lambda pair: _url_key_rank(pair[0]))
    return out


def _provider_id_from(
    embedded: Mapping[str, Any],
    meta: Optional[Mapping[str, Any]],
    rule: Optional[ProviderRule],
) -> Optional[str]:
    if rule is not None:
        value, _ = _first(embedded, rule.id_keys)
        if value:
            return value
    if meta is not None and rule is not None and rule.provider == "lyria":
        # INT-002: the sidecar's own generation id, off the importer's tag.
        return _legacy_tag_id(meta, "lyriaid:")
    if meta is not None and (rule is None or rule.provider == "suno"):
        legacy = _text(meta.get("suno_id"))
        if not _is_blank(legacy):
            return legacy
        tagged = _legacy_tag_id(meta)
        if tagged:
            return tagged
    return None


def _meta_tags(meta: Mapping[str, Any]) -> list[str]:
    raw = meta.get("tags")
    if isinstance(raw, str):
        parts = raw.replace(";", ",").split(",")
    elif isinstance(raw, (list, tuple, set)):
        parts = [str(p) for p in raw]
    else:
        return []
    return [p.strip().lower() for p in parts if str(p).strip()]


def _legacy_tag_id(meta: Mapping[str, Any], prefix: str = "sunoid:") -> Optional[str]:
    """The provider's own track id out of a ``<prefix><id>`` tag.

    ``prefix`` defaults to Suno's for every pre-existing caller; INT-002 passes
    ``lyriaid:``, which the Lyria importer stamps for the same two reasons Suno
    stamps its own -- the badge's ``provider_id`` and resolving a parent when a
    derived track is registered later.
    """
    for tag in _meta_tags(meta):
        if tag.startswith(prefix):
            value = tag.split(":", 1)[1].strip()
            if not _is_blank(value):
                return value
    return None


def _legacy_suno(meta: Mapping[str, Any]) -> Optional[str]:
    """The legacy evidence that this entry is a Suno track, if any.

    Entries imported before provider labeling existed were marked with a
    ``source`` of "suno", a ``suno_id`` field, or a ``suno`` / ``sunoid:<id>``
    tag. The read path relies on this so the ~200k entries already in the
    library get labeled without touching a single audio file.
    """
    if _text(meta.get("source")).lower() == "suno":
        return "meta.source=suno"
    if not _is_blank(_text(meta.get("suno_id"))):
        return "meta.suno_id"
    for tag in _meta_tags(meta):
        if tag == "suno":
            return "meta.tags=suno"
        if tag.startswith("sunoid:"):
            return "meta.tags=sunoid"
    return None


def _legacy_lyria(meta: Mapping[str, Any]) -> Optional[str]:
    """The evidence that this entry came from the embedded Lyria sidecar.

    INT-002's twin of :func:`_legacy_suno`, and for the same reason: the audio
    the sidecar returns carries no frame naming Lyria, so the only thing that
    identifies it is what ``lyria.importer`` wrote into the entry's metadata --
    a ``model`` of "lyria", plus the ``lyria`` / ``lyriaid:<id>`` tags. Reading
    them here is what lets the badge, the provider filter and the facet agree
    without opening a single audio file.

    ``model`` is matched by SUBSTRING, exactly as ``db.infer_provider``'s
    ``lyria`` arm reads the same column, and deliberately so: the SQL fallback
    has no ``lyria`` arm (adding one is a schema step -- see the note on
    ``db._PROVIDER_BY_MODEL_SUBSTRING``), so this detection is what fills the
    ``provider`` column for such a row at write time and keeps the filter, the
    facet and the badge from ever having to ask the fallback about one.
    """
    if "lyria" in _text(meta.get("model")).lower():
        return "meta.model=lyria"
    for tag in _meta_tags(meta):
        if tag == "lyria":
            return "meta.tags=lyria"
        if tag.startswith("lyriaid:"):
            return "meta.tags=lyriaid"
    return None


def _from_meta_provider(
    embedded: Mapping[str, Any], meta: Mapping[str, Any]
) -> Optional[ProviderInfo]:
    slug = _slugify(_text(meta.get("provider")))
    if not slug:
        return None
    rule = _RULES_BY_SLUG.get(slug)
    label = _text(meta.get("provider_label")) or (
        rule.label if rule else _text(meta.get("provider"))
    )
    raw_is_ai = meta.get("provider_is_ai")
    if isinstance(raw_is_ai, bool):
        is_ai = raw_is_ai
    else:
        parsed = _parse_bool(_text(raw_is_ai))
        is_ai = parsed if parsed is not None else bool(rule.is_ai if rule else False)
    provider_id = _text(meta.get("provider_id"))
    return ProviderInfo(
        provider=slug,
        label=label or slug,
        is_ai=is_ai,
        provider_id=(
            provider_id
            if not _is_blank(provider_id)
            else _provider_id_from(embedded, meta, rule)
        ),
        confidence="explicit",
        evidence="meta.provider",
    )


def detect_provider(
    embedded: Mapping[str, str],
    meta: Optional[Mapping[str, Any]] = None,
) -> Optional[ProviderInfo]:
    """Identify the service a track came from, or None when nothing says.

    ``embedded`` is exactly what ``tags.extract_embedded_tags`` returns.
    ``meta`` is the entry's stored metadata, which may carry an already
    decided ``provider`` (it wins) or the legacy Suno markers.
    """
    embedded = embedded or {}
    meta = meta or None

    if meta is not None:
        decided = _from_meta_provider(embedded, meta)
        if decided is not None:
            return decided

    # 1. An id frame a provider writes under its own name.
    for rule in PROVIDER_RULES:
        value, key = _first(embedded, rule.id_keys)
        if value:
            return ProviderInfo(
                provider=rule.provider,
                label=rule.label,
                is_ai=rule.is_ai,
                provider_id=value,
                confidence="explicit",
                evidence=f"{key}={value}",
            )

    # 2. A generator-ish frame naming a provider we know.
    tool_value, tool_key = _first(embedded, GENERATOR_KEYS)
    if tool_value:
        rule = _rule_for_tool(tool_value)
        if rule is not None:
            return ProviderInfo(
                provider=rule.provider,
                label=rule.label,
                is_ai=rule.is_ai,
                provider_id=_provider_id_from(embedded, meta, rule),
                confidence="explicit",
                evidence=f"{tool_key}={tool_value}",
            )

    # 3. Legacy entries labeled before this feature existed.
    if meta is not None:
        legacy = _legacy_suno(meta)
        if legacy:
            rule = _RULES_BY_SLUG["suno"]
            return ProviderInfo(
                provider=rule.provider,
                label=rule.label,
                is_ai=rule.is_ai,
                provider_id=_provider_id_from(embedded, meta, rule),
                confidence="explicit",
                evidence=legacy,
            )
        # INT-002: the same step for the embedded Lyria sidecar. After Suno,
        # which cannot collide with it -- no entry carries both sets of
        # markers -- and before the unknown-tool arm, so a Lyria track that
        # also names some encoder is still filed under Lyria.
        lyria = _legacy_lyria(meta)
        if lyria:
            rule = _RULES_BY_SLUG["lyria"]
            return ProviderInfo(
                provider=rule.provider,
                label=rule.label,
                is_ai=rule.is_ai,
                provider_id=_provider_id_from(embedded, meta, rule),
                confidence="explicit",
                evidence=lyria,
            )

    # 4. A tool we have never heard of is still where this file came from —
    #    unless it only describes the encoder or the DAW it was bounced from.
    if tool_value and not _is_generic_tool(tool_value):
        slug = _slugify(tool_value)
        if slug:
            return ProviderInfo(
                provider=slug,
                label=tool_value,
                is_ai=False,
                provider_id=None,
                confidence="explicit",
                evidence=f"{tool_key}={tool_value}",
                origin=ORIGIN_TOOL_FRAME,
            )

    # 5. Weaker signals: the album a store stamps on its downloads, or a
    #    URL left in a url frame or the comment.
    album = _lookup(embedded, "album")
    rule = _rule_for_album(album)
    if rule is not None:
        return ProviderInfo(
            provider=rule.provider,
            label=rule.label,
            is_ai=rule.is_ai,
            provider_id=_provider_id_from(embedded, meta, rule),
            confidence="inferred",
            evidence=f"album={album}",
        )

    for key, text in _url_candidates(embedded):
        rule, host = _rule_for_hosts(_hosts(text))
        if rule is not None:
            return ProviderInfo(
                provider=rule.provider,
                label=rule.label,
                is_ai=rule.is_ai,
                provider_id=_provider_id_from(embedded, meta, rule),
                confidence="inferred",
                evidence=f"{key}={host}",
            )

    # 6. Weakest of all: a download that names nobody, recognised by the
    #    SHAPE of the handful of tags it does carry. Everything above wins.
    for rule in PROVIDER_RULES:
        if rule.fingerprint is None:
            continue
        found = rule.fingerprint(embedded)
        if found is None:
            continue
        track_id, evidence = found
        return ProviderInfo(
            provider=rule.provider,
            label=rule.label,
            is_ai=rule.is_ai,
            provider_id=track_id or _provider_id_from(embedded, meta, rule),
            confidence="inferred",
            evidence=evidence,
        )

    return None


def curated_fields(
    embedded: Mapping[str, str],
    info: Optional[ProviderInfo] = None,
) -> dict[str, Any]:
    """The song-describing subset of ``embedded``, under stable names.

    Only keys with a real value are returned — never "", None, or an
    all-zero uuid — and only from the closed set in :data:`CURATED_FIELDS`.
    Analytics frames are unreachable by construction: they are not in the
    table, and :func:`_lookup` refuses them anyway.
    """
    embedded = embedded or {}
    out: dict[str, Any] = {}

    instrumental: Optional[bool] = None
    raw_instrumental, _ = _first(embedded, _INSTRUMENTAL_KEYS)
    if raw_instrumental:
        instrumental = _parse_bool(raw_instrumental)

    for field, keys in CURATED_FIELDS:
        value, _key = _first(embedded, keys)
        if not value:
            continue
        if field == "is_instrumental":
            if instrumental is not None:
                out[field] = instrumental
            continue
        if field == "bpm":
            try:
                bpm = float(value)
            except (TypeError, ValueError):
                out[field] = value
                continue
            if bpm > 0:
                out[field] = int(bpm) if bpm.is_integer() else bpm
            continue
        out[field] = value

    if info is not None and info.provider_id and not _is_blank(info.provider_id):
        out["provider_id"] = info.provider_id

    # Suno's `prompt` frame holds the lyrics the song was sung from, so an
    # entry with words gets both — unless the file says it is instrumental.
    if (
        info is not None
        and info.provider == "suno"
        and instrumental is not True
        and "lyrics" not in out
        and out.get("prompt")
    ):
        out["lyrics"] = out["prompt"]

    return out


def provider_wire_fields(info: Optional[ProviderInfo]) -> dict[str, Any]:
    """The four provider keys every library API entry dict carries."""
    if info is None:
        return {
            "provider": None,
            "provider_label": None,
            "provider_is_ai": None,
            "provider_id": None,
        }
    return {
        "provider": info.provider,
        "provider_label": info.label,
        "provider_is_ai": info.is_ai,
        "provider_id": info.provider_id,
    }
