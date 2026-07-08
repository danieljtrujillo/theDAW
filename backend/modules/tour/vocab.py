"""Curated genre/vibe vocabulary for venue annotation.

OSM has no reliable genre taxonomy, so each entry combines tag-value tokens
(matched against ``genre`` / ``music_genre`` / ``music`` tags) with name/
description keywords. Matching is deliberately loose — the point is a useful
first-pass filter, not ground truth; the booking-contact enrichment slice can
sharpen individual venues later.
"""

from __future__ import annotations

# label -> {"tags": [tag-value tokens], "keywords": [name/description tokens]}
GENRES: dict[str, dict[str, list[str]]] = {
    "electronic": {
        "tags": [
            "electronic",
            "techno",
            "house",
            "edm",
            "dnb",
            "drum_and_bass",
            "trance",
            "dubstep",
        ],
        "keywords": ["techno", "house", "rave", "electro", "bass", "warehouse"],
    },
    "rock/metal": {
        "tags": ["rock", "metal", "punk", "hardcore", "grunge"],
        "keywords": ["rock", "metal", "punk"],
    },
    "hip-hop": {
        "tags": ["hip_hop", "hip-hop", "rap", "rnb", "r_and_b"],
        "keywords": ["hip hop", "hip-hop", "rap"],
    },
    "jazz/blues": {
        "tags": ["jazz", "blues", "swing", "soul", "funk"],
        "keywords": ["jazz", "blues", "soul", "funk"],
    },
    "country/folk": {
        "tags": ["country", "folk", "bluegrass", "americana"],
        "keywords": ["country", "folk", "honky", "saloon", "bluegrass"],
    },
    "latin": {
        "tags": ["latin", "salsa", "cumbia", "reggaeton", "bachata"],
        "keywords": ["salsa", "latin", "cantina", "cumbia"],
    },
    "indie/alt": {
        "tags": ["indie", "alternative", "shoegaze"],
        "keywords": ["indie", "alternative"],
    },
}

VIBES: dict[str, dict[str, list[str]]] = {
    "live room": {
        # live_music=yes handled explicitly in annotate(); these catch the rest
        "tags": ["live"],
        "keywords": ["live music", "music hall", "listening room", "stage"],
    },
    "dance club": {
        "tags": [],
        "keywords": ["club", "disco", "dance"],
    },
    "dive bar": {
        "tags": [],
        "keywords": ["dive", "tavern", "saloon"],
    },
    "listening bar": {
        "tags": [],
        "keywords": ["listening", "hifi", "hi-fi", "vinyl", "record bar"],
    },
    "festival": {
        "tags": [],
        "keywords": ["festival", "fairground", "amphitheater", "amphitheatre"],
    },
    "theater": {
        "tags": [],
        "keywords": ["theatre", "theater", "playhouse", "opera"],
    },
}

# Categories that imply a vibe regardless of name/keywords.
_CATEGORY_VIBES: dict[str, str] = {
    "nightclub": "dance club",
    "music_venue": "live room",
    "concert_hall": "live room",
    "events_venue": "live room",
    "theatre": "theater",
    "arts_centre": "theater",
    "festival_grounds": "festival",
    "dance": "dance club",
}


def _tokens(tags: dict[str, str]) -> str:
    """Genre-ish tag values, lowercased and joined for substring matching."""
    parts = [
        tags.get("genre", ""),
        tags.get("music_genre", ""),
        tags.get("music", ""),
        tags.get("description", ""),
    ]
    return " ".join(p.lower() for p in parts if p)


def annotate(
    name: str, category: str, tags: dict[str, str]
) -> tuple[list[str], list[str]]:
    """Return (genres, vibes) labels matched for one venue."""
    hay_tags = _tokens(tags)
    hay_name = (name or "").lower()

    genres: list[str] = []
    for label, spec in GENRES.items():
        if any(t in hay_tags for t in spec["tags"]) or any(
            k in hay_name for k in spec["keywords"]
        ):
            genres.append(label)

    vibes: list[str] = []
    implied = _CATEGORY_VIBES.get(category)
    if implied:
        vibes.append(implied)
    if tags.get("live_music") == "yes" and "live room" not in vibes:
        vibes.append("live room")
    for label, spec in VIBES.items():
        if label in vibes:
            continue
        if any(t in hay_tags for t in spec["tags"]) or any(
            k in hay_name for k in spec["keywords"]
        ):
            vibes.append(label)
    return genres, vibes
