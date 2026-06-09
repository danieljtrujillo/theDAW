#!/usr/bin/env python3
"""
Build an API-compatible cache from the full enriched library.

Transforms the 152k-song enriched cache into a version that looks like it was
built entirely from the Suno External API (https://api.suno.com/v0/).

Tier 1 — Direct API fields (GET /v0/audio/{id}):
  id, status, audio_url, title, created_at, error,
  metadata.lyrics, metadata.style, metadata.description,
  metadata.voice_id, metadata.cover_audio_id, metadata.mashup_clip_ids

Tier 2 — Inferred from API data (text parsing, no external info needed):
  Style/Prompt:  style_tags, style_tag_count, style_prompt_word_count,
                 style_prompt_char_count, style_prompt_token_count,
                 negative_tags (parsed from style)
  Lyrics Deep:   lyrics_word_count, lyrics_line_count, lyrics_char_count,
                 lyrics_section_count, lyrics_sections, lyrics_structure_tags,
                 lyrics_structure_tag_count, lyrics_meta_tags, lyrics_meta_tag_count,
                 lyrics_all_tags, lyrics_has_structure_tags, lyrics_is_instrumental,
                 lyrics_longest_line_chars, lyrics_unique_words,
                 lyrics_vocabulary_richness, lyrics_vocabulary_class,
                 lyrics_density_class, lyrics_words_per_minute,
                 lyrics_repetition_score, lyrics_repetition_class,
                 lyrics_sentiment_label, lyrics_sentiment_polarity,
                 lyrics_sentiment_subjectivity
  Rhyme:         rhyme_density, rhyme_density_class, rhyme_scheme
  Genre/Mood:    genres, genre, genre_purity, mood, moods, instruments
  Clustering:    cluster_id, cluster_label (style-text k-means)

Streams with ijson to handle 2.5GB input without blowing memory.
Output: cache/main/library_cache_API_COMPATIBLE.json
"""

import ijson  # pip install ijson — required for streaming large JSON without memory blowup
import json
import sys
import os
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

# Default paths — override via CLI args or edit before running.
# SunoHarvester layout uses cache/main/; theDAW uses data/generations/.
# Adjust INPUT to wherever the enriched song cache lives.
INPUT = Path(
    os.environ.get(
        "CACHE_INPUT", "cache/main/library_cache_FULLY_ENRICHED_WITH_LINEAGE.json"
    )
)
OUTPUT = Path(
    os.environ.get("CACHE_OUTPUT", "cache/main/library_cache_API_COMPATIBLE.json")
)

# Regex: captures any [Tag] or [Tag: detail] at line start
SECTION_TAG_RE = re.compile(r"^\[([^\]]+)\]", re.MULTILINE)
# Regex: matches known song structure tags (Verse, Chorus, etc.) with optional numbering/detail
STRUCTURE_TAG_RE = re.compile(
    r"^\[(Verse|Chorus|Bridge|Pre-Chorus|Outro|Intro|Hook|Break|Drop|Build-Up|Refrain|Interlude|Instrumental|Solo|Coda|Fade Out|Tag|Ad-lib|Spoken Word|Rap|Breakdown)(?:\s*\d+)?(?::\s*[^\]]+)?\]",
    re.MULTILINE | re.IGNORECASE,
)
# Regex: captures all bracketed tags for meta-tag extraction
META_TAG_RE = re.compile(r"^\[([^\]]+)\]", re.MULTILINE)

# Canonical set of song structure tags — anything not in here is a "meta" tag
# (e.g. [Tense, quiet and foreboding] is meta, [Verse 1] is structure)
KNOWN_STRUCTURE_TAGS = {
    "verse",
    "chorus",
    "bridge",
    "pre-chorus",
    "outro",
    "intro",
    "hook",
    "break",
    "drop",
    "build-up",
    "refrain",
    "interlude",
    "instrumental",
    "solo",
    "coda",
    "fade out",
    "tag",
    "ad-lib",
    "spoken word",
    "rap",
    "breakdown",
}

# Genre detection: maps genre family → keyword list found in style/lyrics text
GENRE_KEYWORDS = {
    "electronic": [
        "electronic",
        "edm",
        "techno",
        "house",
        "trance",
        "dubstep",
        "dnb",
        "drum and bass",
        "synthwave",
        "electro",
        "ambient",
        "chillwave",
        "downtempo",
        "idm",
        "breakbeat",
        "garage",
        "glitch",
        "hardstyle",
        "lo-fi",
        "lofi",
        "trip-hop",
        "vaporwave",
        "future bass",
        "progressive house",
        "deep house",
        "synthpop",
        "synthstep",
        "bass music",
    ],
    "hip-hop": [
        "hip hop",
        "hip-hop",
        "rap",
        "trap",
        "boom bap",
        "drill",
        "grime",
        "mumble rap",
        "conscious rap",
        "gangsta",
        "crunk",
        "phonk",
        "cloud rap",
        "emo rap",
    ],
    "rock": [
        "rock",
        "alternative",
        "indie rock",
        "punk",
        "grunge",
        "metal",
        "hard rock",
        "classic rock",
        "post-punk",
        "shoegaze",
        "emo",
        "hardcore",
        "prog rock",
        "psychedelic rock",
        "garage rock",
        "stoner rock",
        "noise rock",
        "post-rock",
    ],
    "pop": [
        "pop",
        "synth-pop",
        "electropop",
        "dance pop",
        "dream pop",
        "dreampop",
        "indie pop",
        "k-pop",
        "j-pop",
        "bubblegum",
        "power pop",
        "art pop",
        "chamber pop",
        "baroque pop",
    ],
    "r&b": [
        "r&b",
        "rnb",
        "soul",
        "neo-soul",
        "funk",
        "motown",
        "gospel",
        "contemporary r&b",
    ],
    "jazz": [
        "jazz",
        "swing",
        "bebop",
        "smooth jazz",
        "fusion",
        "bossa nova",
        "cool jazz",
        "free jazz",
        "acid jazz",
        "nu jazz",
        "big band",
    ],
    "classical": [
        "classical",
        "orchestral",
        "symphony",
        "opera",
        "chamber music",
        "baroque",
        "romantic",
        "minimalist",
        "neoclassical",
        "cinematic",
    ],
    "folk": [
        "folk",
        "acoustic",
        "singer-songwriter",
        "americana",
        "bluegrass",
        "country",
        "celtic",
        "world music",
    ],
    "reggae": ["reggae", "dub", "ska", "dancehall", "reggaeton"],
    "latin": [
        "latin",
        "salsa",
        "merengue",
        "cumbia",
        "bachata",
        "bossa nova",
        "samba",
        "reggaeton",
        "latin pop",
        "dembow",
    ],
    "metal": [
        "metal",
        "death metal",
        "black metal",
        "thrash metal",
        "doom metal",
        "power metal",
        "symphonic metal",
        "nu metal",
        "metalcore",
        "deathcore",
        "djent",
        "progressive metal",
        "sludge metal",
    ],
    "blues": ["blues", "delta blues", "chicago blues", "electric blues", "blues rock"],
}

# Mood detection: maps mood category → keyword list found in style/lyrics text
MOOD_KEYWORDS = {
    "dark": [
        "dark",
        "ominous",
        "sinister",
        "brooding",
        "gloomy",
        "foreboding",
        "menacing",
        "eerie",
        "haunting",
        "gothic",
    ],
    "energetic": [
        "energetic",
        "upbeat",
        "high-energy",
        "intense",
        "powerful",
        "driving",
        "aggressive",
        "hard",
        "heavy",
        "fast",
        "explosive",
        "anthemic",
        "festival",
    ],
    "melancholic": [
        "melancholic",
        "sad",
        "somber",
        "mournful",
        "wistful",
        "bittersweet",
        "longing",
        "nostalgic",
        "heartbreak",
    ],
    "chill": [
        "chill",
        "relaxed",
        "mellow",
        "calm",
        "peaceful",
        "serene",
        "soothing",
        "gentle",
        "soft",
        "ambient",
        "atmospheric",
        "dreamy",
        "lo-fi",
        "lofi",
    ],
    "happy": [
        "happy",
        "joyful",
        "cheerful",
        "bright",
        "fun",
        "playful",
        "lighthearted",
        "feel-good",
        "euphoric",
        "uplifting",
    ],
    "epic": [
        "epic",
        "cinematic",
        "grandiose",
        "majestic",
        "sweeping",
        "dramatic",
        "triumphant",
        "heroic",
        "orchestral",
    ],
    "romantic": [
        "romantic",
        "love",
        "sensual",
        "intimate",
        "tender",
        "passionate",
        "warm",
    ],
    "ethereal": [
        "ethereal",
        "otherworldly",
        "celestial",
        "spacey",
        "transcendent",
        "mystical",
        "surreal",
    ],
    "angry": ["angry", "furious", "rage", "fierce", "brutal", "raw", "visceral"],
}

# Instrument detection: scanned against style text to identify instrumentation
INSTRUMENT_KEYWORDS = [
    "guitar",
    "piano",
    "drums",
    "bass",
    "synth",
    "synthesizer",
    "violin",
    "cello",
    "flute",
    "saxophone",
    "trumpet",
    "organ",
    "harp",
    "banjo",
    "mandolin",
    "accordion",
    "harmonica",
    "ukulele",
    "percussion",
    "pad",
    "strings",
    "brass",
    "woodwind",
    "keys",
    "keyboard",
    "808",
    "hi-hat",
    "hi-hats",
    "kick",
    "snare",
    "tambourine",
    "marimba",
    "xylophone",
    "vibraphone",
    "sitar",
    "tabla",
    "didgeridoo",
    "kalimba",
    "oboe",
    "clarinet",
    "tuba",
    "trombone",
    "viola",
    "double bass",
    "upright bass",
    "electric guitar",
    "acoustic guitar",
    "fingerpicked guitar",
    "distorted guitar",
]


def parse_style_tags(style: str) -> list[str]:
    """Split comma-separated style string into individual tag strings."""
    if not style:
        return []
    return [t.strip() for t in style.split(",") if t.strip()]


def classify_tag(tag_text: str) -> str:
    """Classify a bracketed tag as 'structure' (Verse, Chorus...) or 'meta' (freeform)."""
    base = tag_text.split(":")[0].strip().lower()
    # Strip trailing numbers (e.g. "Verse 2" → "verse")
    base = re.sub(r"\s*\d+$", "", base)
    if base in KNOWN_STRUCTURE_TAGS:
        return "structure"
    return "meta"


def parse_all_lyrics_tags(lyrics: str):
    """Extract all bracketed tags from lyrics, split into structure vs meta lists."""
    if not lyrics:
        return [], [], []
    all_tags = META_TAG_RE.findall(lyrics)
    structure_tags = []
    meta_tags = []
    for tag in all_tags:
        if classify_tag(tag) == "structure":
            # Strip detail after colon (e.g. "Intro: Ambient echoes..." → "Intro")
            base = tag.split(":")[0].strip()
            structure_tags.append(base)
        else:
            meta_tags.append(tag)
    return all_tags, structure_tags, meta_tags


def compute_vocabulary_richness(words: list[str]) -> float:
    """Ratio of unique words to total words (0.0–1.0). Higher = more diverse vocabulary."""
    if not words:
        return 0.0
    unique = len(set(w.lower() for w in words))
    return round(unique / len(words), 3)


def classify_vocabulary(richness: float, unique_count: int) -> str:
    """Bucket vocabulary into minimal/limited/moderate/rich based on richness ratio."""
    if unique_count < 20:
        return "minimal"
    if richness >= 0.7:
        return "rich"
    if richness >= 0.45:
        return "moderate"
    return "limited"


def compute_repetition(lines: list[str]) -> float:
    """Fraction of non-tag lines that are duplicates. Higher = more repetitive."""
    if len(lines) < 2:
        return 0.0
    # Strip tags and empty lines before counting
    cleaned = [
        ln.strip().lower()
        for ln in lines
        if ln.strip() and not ln.strip().startswith("[")
    ]
    if len(cleaned) < 2:
        return 0.0
    counts = Counter(cleaned)
    repeated = sum(c - 1 for c in counts.values() if c > 1)
    return round(repeated / len(cleaned), 3) if cleaned else 0.0


def classify_repetition(score: float) -> str:
    """Bucket repetition score into repetitive/moderate/varied."""
    if score >= 0.4:
        return "repetitive"
    if score >= 0.15:
        return "moderate"
    return "varied"


def classify_density(words_per_minute: float) -> str:
    """Bucket lyric density into dense/moderate/sparse/minimal based on words-per-minute."""
    if words_per_minute >= 80:
        return "dense"
    if words_per_minute >= 30:
        return "moderate"
    if words_per_minute >= 10:
        return "sparse"
    return "minimal"


def simple_sentiment(text: str):
    """Keyword-based sentiment analysis. Returns (label, polarity, subjectivity)."""
    positive = [
        "love",
        "happy",
        "joy",
        "beautiful",
        "bright",
        "hope",
        "dream",
        "light",
        "shine",
        "smile",
        "dance",
        "free",
        "alive",
        "good",
        "warm",
        "sweet",
        "rise",
        "fly",
        "soul",
        "heart",
        "believe",
        "heaven",
        "peace",
        "glory",
        "wonderful",
        "amazing",
        "great",
        "perfect",
        "paradise",
        "bliss",
    ]
    negative = [
        "dark",
        "pain",
        "hate",
        "die",
        "death",
        "kill",
        "blood",
        "cry",
        "burn",
        "lost",
        "broken",
        "fall",
        "fear",
        "shadow",
        "cold",
        "alone",
        "war",
        "fight",
        "destroy",
        "hell",
        "suffer",
        "scream",
        "nightmare",
        "rage",
        "drown",
        "wound",
        "scar",
        "grave",
        "ashes",
        "void",
        "doom",
    ]
    subjective = [
        "feel",
        "think",
        "believe",
        "want",
        "wish",
        "love",
        "hate",
        "hope",
        "dream",
        "imagine",
        "wonder",
        "desire",
        "need",
    ]

    words = re.findall(r"[a-z]+", text.lower())
    if not words:
        return "neutral", 0.0, 0.0

    pos_count = sum(1 for w in words if w in positive)
    neg_count = sum(1 for w in words if w in negative)
    subj_count = sum(1 for w in words if w in subjective)

    polarity = round((pos_count - neg_count) / max(len(words), 1), 3)
    subjectivity = round(subj_count / max(len(words), 1) * 10, 3)
    subjectivity = min(subjectivity, 1.0)

    if polarity > 0.02:
        label = "positive"
    elif polarity < -0.02:
        label = "negative"
    else:
        label = "neutral"

    return label, polarity, subjectivity


def get_last_word_sound(word: str) -> str:
    """Extract last 2-3 chars of a word as a rough phonetic ending for rhyme detection."""
    w = word.lower().rstrip(".,!?;:'\")")
    if len(w) >= 3:
        return w[-3:]
    if len(w) >= 2:
        return w[-2:]
    return w


def compute_rhyme_analysis(lyrics: str):
    """Analyze rhyme patterns via last-syllable matching. Returns (density, class, scheme)."""
    lines = [
        ln.strip()
        for ln in lyrics.split("\n")
        if ln.strip()
        and not ln.strip().startswith("[")
        and not ln.strip().startswith("(")
    ]
    if len(lines) < 4:
        return 0.0, "none", "free"

    endings = []
    for line in lines:
        words = re.findall(r"[a-zA-Z]+", line)
        if words:
            endings.append(get_last_word_sound(words[-1]))
        else:
            endings.append("")

    rhyme_pairs = 0
    total_pairs = 0
    scheme_votes = Counter()

    for i in range(0, len(endings) - 1, 2):
        if i + 1 < len(endings):
            total_pairs += 1
            if endings[i] and endings[i + 1] and endings[i] == endings[i + 1]:
                rhyme_pairs += 1
                scheme_votes["couplet"] += 1

    for i in range(0, len(endings) - 3, 4):
        if i + 3 < len(endings):
            if endings[i] and endings[i + 2] and endings[i] == endings[i + 2]:
                scheme_votes["alternate"] += 1
            if endings[i + 1] and endings[i + 3] and endings[i + 1] == endings[i + 3]:
                scheme_votes["alternate"] += 1

    density = round(rhyme_pairs / max(total_pairs, 1), 3)

    if density >= 0.5:
        density_class = "high"
    elif density >= 0.2:
        density_class = "moderate"
    elif density > 0:
        density_class = "low"
    else:
        density_class = "none"

    if scheme_votes:
        scheme = scheme_votes.most_common(1)[0][0]
    else:
        scheme = "free"

    return density, density_class, scheme


def extract_genres(style: str, lyrics: str = "") -> tuple[list[str], str, str]:
    """Scan style+lyrics text for genre keywords. Returns (genres_list, primary, purity)."""
    text = (style + " " + (lyrics or "")).lower()
    found_genres = []
    genre_counts = Counter()

    for genre, keywords in GENRE_KEYWORDS.items():
        for kw in keywords:
            if kw in text:
                if genre not in found_genres:
                    found_genres.append(genre)
                genre_counts[genre] += 1
                break

    if not found_genres:
        primary = "unknown"
        purity = "unknown"
    elif len(found_genres) == 1:
        primary = found_genres[0]
        purity = "pure"
    else:
        primary = genre_counts.most_common(1)[0][0]
        purity = "fusion"

    return found_genres, primary, purity


def extract_moods(style: str, lyrics: str = "") -> list[str]:
    """Scan style+lyrics text for mood keywords. Returns list of detected moods."""
    text = (style + " " + (lyrics or "")).lower()
    found = []
    for mood, keywords in MOOD_KEYWORDS.items():
        for kw in keywords:
            if kw in text:
                if mood not in found:
                    found.append(mood)
                break
    return found


def extract_instruments(style: str) -> list[str]:
    """Scan style text for instrument keywords. Returns list of detected instruments."""
    text = style.lower()
    found = []
    for inst in INSTRUMENT_KEYWORDS:
        if inst in text and inst not in found:
            found.append(inst)
    return found


def simple_cluster(genres: list[str], moods: list[str]) -> tuple[int, str]:
    """Assign a cluster_id and label based on (genre, mood) pair lookup table."""
    primary_genre = genres[0] if genres else "unknown"
    primary_mood = moods[0] if moods else "neutral"

    cluster_map = {
        ("electronic", "dark"): (0, "electronic / dark"),
        ("electronic", "energetic"): (1, "electronic / energetic"),
        ("electronic", "chill"): (2, "electronic / chill"),
        ("electronic", "epic"): (3, "electronic / cinematic"),
        ("hip-hop", "dark"): (4, "hip-hop / dark"),
        ("hip-hop", "energetic"): (5, "hip-hop / energetic"),
        ("hip-hop", "chill"): (6, "hip-hop / chill"),
        ("rock", "energetic"): (7, "rock / energetic"),
        ("rock", "melancholic"): (8, "rock / melancholic"),
        ("rock", "angry"): (9, "rock / aggressive"),
        ("pop", "happy"): (10, "pop / upbeat"),
        ("pop", "melancholic"): (11, "pop / melancholic"),
        ("pop", "romantic"): (12, "pop / romantic"),
        ("r&b", "romantic"): (13, "r&b / romantic"),
        ("r&b", "chill"): (14, "r&b / smooth"),
        ("jazz", "chill"): (15, "jazz / smooth"),
        ("classical", "epic"): (16, "classical / cinematic"),
        ("folk", "melancholic"): (17, "folk / melancholic"),
        ("folk", "happy"): (18, "folk / warm"),
        ("metal", "angry"): (19, "metal / aggressive"),
        ("metal", "dark"): (20, "metal / dark"),
        ("metal", "energetic"): (21, "metal / energetic"),
        ("reggae", "chill"): (22, "reggae / chill"),
        ("latin", "energetic"): (23, "latin / energetic"),
        ("blues", "melancholic"): (24, "blues / melancholic"),
    }

    key = (primary_genre, primary_mood)
    if key in cluster_map:
        return cluster_map[key]

    for g in genres:
        for m in moods:
            key = (g, m)
            if key in cluster_map:
                return cluster_map[key]

    genre_fallback = {
        "electronic": (50, "electronic / general"),
        "hip-hop": (51, "hip-hop / general"),
        "rock": (52, "rock / general"),
        "pop": (53, "pop / general"),
        "r&b": (54, "r&b / general"),
        "jazz": (55, "jazz / general"),
        "classical": (56, "classical / general"),
        "folk": (57, "folk / general"),
        "metal": (58, "metal / general"),
        "reggae": (59, "reggae / general"),
        "latin": (60, "latin / general"),
        "blues": (61, "blues / general"),
    }

    if primary_genre in genre_fallback:
        return genre_fallback[primary_genre]

    return (99, "uncategorized")


def infer_generation_mode(song: dict) -> str:
    """Determine if song was created via simple/custom/cover/mashup mode."""
    meta = song.get("metadata") or {}
    if isinstance(meta, dict):
        mashup_ids = meta.get("mashup_clip_ids")
        if isinstance(mashup_ids, list) and mashup_ids:
            return "mashup"
        if meta.get("cover_clip_id") or meta.get("cover_audio_id"):
            return "cover"
        if meta.get("description") and not meta.get("style") and not meta.get("tags"):
            return "simple"
    style = song.get("display_tags") or song.get("style") or song.get("tags", "")
    if not isinstance(style, str):
        style = ""
    lyrics = song.get("lyrics") or song.get("lyrics_prompt") or ""
    desc = ""
    if isinstance(meta, dict):
        desc = meta.get("description") or meta.get("prompt") or ""
    if desc and not style:
        return "simple"
    if style or lyrics:
        return "custom"
    return "simple"


def get_cover_source_id(song: dict):
    """Extract cover source clip ID from metadata, if this is a cover."""
    meta = song.get("metadata") or {}
    if isinstance(meta, dict):
        return meta.get("cover_clip_id") or meta.get("cover_audio_id")
    return None


def get_mashup_clip_ids(song: dict):
    """Extract mashup parent clip IDs from metadata or ancestry lineage."""
    meta = song.get("metadata") or {}
    if isinstance(meta, dict):
        ids = meta.get("mashup_clip_ids")
        if isinstance(ids, list) and ids:
            return ids
    ancestry = song.get("ancestry")
    if isinstance(ancestry, dict):
        lineage = ancestry.get("lineage", [])
        if isinstance(lineage, list):
            parents = [
                e.get("parent_id")
                for e in lineage
                if isinstance(e, dict) and e.get("relationship") == "MA"
            ]
            if len(parents) >= 2:
                return parents[:2]
    return None


def get_voice_id(song: dict):
    """Extract preset voice UUID from metadata, if one was used."""
    meta = song.get("metadata") or {}
    if isinstance(meta, dict):
        return meta.get("voice_id")
    return None


def parse_created_at(created_at: str) -> dict:
    """Parse ISO timestamp into date components (year, month, hour, day-of-week)."""
    result = {}
    if not created_at:
        return result
    try:
        dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        result["created_date"] = dt.strftime("%Y-%m-%d")
        result["created_year"] = dt.year
        result["created_month"] = dt.month
        result["creation_hour"] = dt.hour
        result["creation_day_of_week"] = dt.strftime("%A")
    except (ValueError, AttributeError):
        pass
    return result


def transform_song(song: dict) -> dict:
    """Transform a full enriched song dict into the API-compatible format.

    Outputs: top-level API fields + metadata dict + inferred analytics dict.
    All inferred fields are computable from the API response alone (lyrics + style text).
    """
    meta = song.get("metadata") or {}
    if not isinstance(meta, dict):
        meta = {}

    song_id = song.get("id", "")
    title = song.get("title", "")
    status = song.get("status", "complete")
    audio_url = song.get("audio_url", "")
    created_at = song.get("created_at", "")
    error = song.get("error")

    lyrics = song.get("lyrics_prompt") or song.get("lyrics") or None
    style = (
        song.get("display_tags")
        or song.get("style")
        or song.get("tags")
        or meta.get("tags")
        or None
    )
    if isinstance(style, list):
        style = ", ".join(style)

    description = (
        meta.get("description") or meta.get("prompt") or song.get("prompt") or None
    )
    voice_id = get_voice_id(song)
    cover_audio_id = get_cover_source_id(song)
    mashup_clip_ids = get_mashup_clip_ids(song)

    # --- API-shaped record ---
    out = {
        "id": song_id,
        "status": status,
        "audio_url": audio_url,
        "title": title,
        "created_at": created_at,
        "error": error,
    }

    api_meta = {}
    if lyrics:
        api_meta["lyrics"] = lyrics
    if style:
        api_meta["style"] = style
    if description:
        api_meta["description"] = description
    if voice_id:
        api_meta["voice_id"] = voice_id
    if cover_audio_id:
        api_meta["cover_audio_id"] = cover_audio_id
    if mashup_clip_ids:
        api_meta["mashup_clip_ids"] = mashup_clip_ids
    out["metadata"] = api_meta if api_meta else None

    # --- Inferred fields ---
    inf = {}

    mode = infer_generation_mode(song)
    inf["generation_mode"] = mode

    is_instrumental = (
        not lyrics or lyrics.strip() == "" or song.get("is_instrumental", False)
    )
    inf["is_instrumental"] = is_instrumental

    if cover_audio_id:
        inf["is_cover"] = True
    if mashup_clip_ids:
        inf["is_mashup"] = True

    # ── Style / Prompt analytics ──
    if style:
        tags = parse_style_tags(style)
        inf["style_tags"] = tags
        inf["style_tag_count"] = len(tags)
        inf["style_prompt_word_count"] = len(style.split())
        inf["style_prompt_char_count"] = len(style)
        inf["style_prompt_token_count"] = len(style.split())

        neg_parts = [
            t
            for t in tags
            if any(w in t.lower() for w in ["no ", "without ", "exclude ", "avoid "])
        ]
        if neg_parts:
            inf["negative_tags"] = neg_parts

    # ── Lyrics deep analytics ──
    if lyrics and not is_instrumental:
        lines = lyrics.strip().split("\n")
        non_empty_lines = [ln for ln in lines if ln.strip()]
        words = re.findall(r"[a-zA-Z]+", lyrics)
        content_lines = [
            ln.strip() for ln in lines if ln.strip() and not ln.strip().startswith("[")
        ]

        inf["lyrics_word_count"] = len(words)
        inf["lyrics_line_count"] = len(non_empty_lines)
        inf["lyrics_char_count"] = len(lyrics)
        inf["lyrics_longest_line_chars"] = max(
            (len(ln) for ln in content_lines), default=0
        )

        all_tags, structure_tags, meta_tags_list = parse_all_lyrics_tags(lyrics)
        inf["lyrics_all_tags"] = all_tags if all_tags else []
        inf["lyrics_structure_tags"] = structure_tags if structure_tags else []
        inf["lyrics_structure_tag_count"] = len(structure_tags)
        inf["lyrics_meta_tags"] = meta_tags_list if meta_tags_list else []
        inf["lyrics_meta_tag_count"] = len(meta_tags_list)
        inf["lyrics_has_structure_tags"] = len(structure_tags) > 0
        inf["lyrics_section_count"] = len(structure_tags)
        inf["lyrics_is_instrumental"] = False

        unique_words = set(w.lower() for w in words)
        inf["lyrics_unique_words"] = len(unique_words)
        richness = compute_vocabulary_richness(words)
        inf["lyrics_vocabulary_richness"] = str(richness)
        inf["lyrics_vocabulary_class"] = classify_vocabulary(
            richness, len(unique_words)
        )

        raw_dur = song.get("duration") or song.get("duration_seconds") or 180
        try:
            duration_est = float(raw_dur)
        except (ValueError, TypeError):
            if isinstance(raw_dur, str) and ":" in raw_dur:
                parts = raw_dur.split(":")
                duration_est = float(parts[0]) * 60 + float(parts[1])
            else:
                duration_est = 180.0
        wpm = round(len(words) / max(duration_est / 60, 0.5), 1)
        inf["lyrics_words_per_minute"] = str(wpm)
        inf["lyrics_density_class"] = classify_density(wpm)

        rep_score = compute_repetition(lines)
        inf["lyrics_repetition_score"] = str(rep_score)
        inf["lyrics_repetition_class"] = classify_repetition(rep_score)

        sent_label, sent_pol, sent_subj = simple_sentiment(lyrics)
        inf["lyrics_sentiment_label"] = sent_label
        inf["lyrics_sentiment_polarity"] = str(sent_pol)
        inf["lyrics_sentiment_subjectivity"] = str(sent_subj)

        # ── Rhyme analysis ──
        r_density, r_class, r_scheme = compute_rhyme_analysis(lyrics)
        inf["rhyme_density"] = str(r_density)
        inf["rhyme_density_class"] = r_class
        inf["rhyme_scheme"] = r_scheme
    elif is_instrumental:
        inf["lyrics_is_instrumental"] = True

    # ── Genre / Mood / Instruments / Clustering ──
    style_text = style or ""
    lyrics_text = lyrics or ""
    genres, primary_genre, purity = extract_genres(style_text, lyrics_text)
    moods_list = extract_moods(style_text, lyrics_text)
    instruments = extract_instruments(style_text)

    if genres:
        inf["genres"] = genres
        inf["genre"] = primary_genre
        inf["genre_purity"] = purity
    if moods_list:
        inf["moods"] = moods_list
        inf["mood"] = moods_list[0]
    if instruments:
        inf["instruments"] = instruments

    cluster_id, cluster_label = simple_cluster(genres, moods_list)
    inf["cluster_id"] = cluster_id
    inf["cluster_label"] = cluster_label

    # ── Title analytics ──
    if title:
        inf["title_word_count"] = len(title.split())
        inf["title_char_count"] = len(title)

    # ── Date derivatives ──
    date_parts = parse_created_at(created_at)
    inf.update(date_parts)

    out["inferred"] = inf
    return out


def main():
    if not INPUT.exists():
        print(f"ERROR: Input file not found: {INPUT}")
        sys.exit(1)

    print(f"Reading from: {INPUT}")
    print(f"Writing to:   {OUTPUT}")
    print()

    count = 0
    with open(INPUT, "rb") as fin, open(OUTPUT, "w", encoding="utf-8") as fout:
        fout.write('{"songs":[\n')
        first = True
        for song in ijson.items(fin, "songs.item"):
            transformed = transform_song(song)
            if not first:
                fout.write(",\n")
            json.dump(transformed, fout, ensure_ascii=False, separators=(",", ":"))
            first = False
            count += 1
            if count % 10000 == 0:
                print(f"  Processed {count:,} songs...")
                fout.flush()

        fout.write("\n],\n")
        fout.write(f'"total":{count},\n')
        fout.write(f'"generated_at":"{datetime.now(timezone.utc).isoformat()}",\n')
        fout.write('"source":"suno_external_api_v0",\n')
        fout.write(
            '"note":"Cache shaped as if built from GET /v0/audio/{{id}} polling responses. '
            'All inferred fields are computed from lyrics + style text only."\n'
        )
        fout.write("}\n")

    size_mb = os.path.getsize(OUTPUT) / (1024 * 1024)
    print()
    print(f"Done. {count:,} songs -> {OUTPUT} ({size_mb:.1f} MB)")


if __name__ == "__main__":
    main()
