"""Build the bundled example projects from the UNCANNY masters and their maps.

Each project carries the song on an audio track, a locator at every meter
change the rhythm engine found (named with the signature and tempo there), and
whatever extra state the project is meant to demonstrate. The locators are what
make these teachable: opening one shows where the song changes meter before a
single analysis is run.
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from backend.modules.project.tasmo_file import TasmoFile  # noqa: E402
from backend.modules.project.tasmo_project import (  # noqa: E402
    Clip,
    EffectChainNode,
    Locator,
    TasmoProject,
    Track,
)

# The meter-map page (theDAW rhythm module, UNCANNY maps) carries every
# track's analysis in a <script id="meter-data"> block. Point
# THEDAW_METER_MAPS at a different export to build from that instead.
ARTIFACT = Path(
    os.environ.get("THEDAW_METER_MAPS")
    or (Path.home() / "Music" / "UNCANNY Meter Maps.html")
)
# Opus transcodes of the masters, kept out of git: the .tasmo files embed
# them, so the repository does not need a second copy.
AUDIO_DIR = REPO / "examples" / "audio"
OUT_DIR = REPO / "examples" / "projects"

# Colours read straight off the meter-map page's legend, so a locator's colour
# says what family its bar length belongs to.
METER_COLOURS = {
    2: "#7c8699",
    4: "#5b9bd5",
    3: "#9a7bdc",
    6: "#9a7bdc",
    9: "#9a7bdc",
    12: "#9a7bdc",
    5: "#e2a94a",
    15: "#e2a94a",
    7: "#e2553f",
    14: "#e2553f",
}
OTHER_COLOUR = "#43b39a"


def load_maps() -> dict[str, dict]:
    html = ARTIFACT.read_text(encoding="utf-8", errors="replace")
    m = re.search(
        r'<script id="meter-data" type="application/json">(.*?)</script>', html, re.S
    )
    if not m:
        raise SystemExit("meter data not found in the artifact")
    return {t["title"].lower(): t for t in json.loads(m.group(1))}


def signature_parts(sig: str) -> tuple[int, int]:
    m = re.match(r"\s*(\d+)\s*/\s*(\d+)", sig)
    return (int(m.group(1)), int(m.group(2))) if m else (4, 4)


def locators_from(track: dict) -> list[Locator]:
    """One locator per meter segment, named so the change reads at a glance."""
    out: list[Locator] = []
    for i, seg in enumerate(track.get("meter_map") or []):
        num, _den = signature_parts(seg["time_signature"])
        mark = "?" if seg.get("uncertain") else ""
        out.append(
            Locator(
                id=f"meter-{i:02d}",
                name=f"{mark}{seg['time_signature']} at {seg['bpm']:.0f} bpm",
                position=round(float(seg["start_sec"]), 3),
                color=METER_COLOURS.get(num, OTHER_COLOUR),
            )
        )
    tempo_segments = (track.get("tempo") or {}).get("segments") or []
    for i, seg in enumerate(tempo_segments[1:], start=1):
        out.append(
            Locator(
                id=f"tempo-{i:02d}",
                name=f"tempo {seg['bpm']:.0f}",
                position=round(float(seg["start_sec"]), 3),
                color="#f0c674",
            )
        )
    out.sort(key=lambda loc: loc.position)
    return out


def audio_track(
    name: str,
    audio_path: Path,
    duration: float,
    *,
    colour: str,
    fx: list[EffectChainNode] | None = None,
) -> Track:
    clip = Clip(
        id="clip-mix",
        name=name,
        clip_type="audio",
        track_id="track-mix",
        start_time=0.0,
        end_time=round(duration, 3),
        audio_file=str(audio_path),
        sample_rate=48000,
        channels=2,
        fade_in=0.05,
        fade_out=1.5,
    )
    return Track(
        id="track-mix",
        name=name,
        type="audio",
        color=colour,
        order=0,
        clips=[clip],
        effect_chain=fx or [],
    )


def build(
    *,
    title: str,
    audio_name: str,
    map_key: str,
    colour: str,
    fx: list[EffectChainNode] | None = None,
    scenes: list[str] | None = None,
    extra_tracks: list[Track] | None = None,
) -> Path:
    maps = load_maps()
    data = maps[map_key]
    audio = AUDIO_DIR / audio_name
    if not audio.is_file():
        raise SystemExit(f"missing audio: {audio}")

    # The page's data writes the overall tempo as `bpm`; `global_bpm` is the
    # engine's own name for it, so accept either.
    t_block = data.get("tempo") or {}
    tempo = t_block.get("bpm") or t_block.get("global_bpm") or 120.0
    first = (data.get("meter_map") or [{}])[0]
    num, den = signature_parts(first.get("time_signature", "4/4"))

    project = TasmoProject(
        project_name=title,
        author="GANTASMO",
        tempo=round(float(tempo), 2),
        time_signature=[num, den],
        sample_rate=48000,
        tracks=[
            audio_track(title, audio, float(data["duration"]), colour=colour, fx=fx)
        ]
        + (extra_tracks or []),
        locators=locators_from(data),
        scenes=scenes or [],
    )

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"{title}.tasmo"
    manifest = TasmoFile.save(project, str(out), embed_audio=True)
    size = out.stat().st_size
    print(
        f"{title:38s} {size / 1_048_576:6.1f} MB  "
        f"{len(project.locators):3d} locators  {manifest['audio_mode']}"
    )
    return out


def fx_chain() -> list[EffectChainNode]:
    """A readable mastering chain: one of each stage, nothing stacked."""
    return [
        EffectChainNode(
            id="fx-eq",
            node_type="builtin",
            effect_name="equalizer",
            parameters={"low_gain_db": 1.5, "mid_gain_db": -1.0, "high_gain_db": 2.0},
        ),
        EffectChainNode(
            id="fx-comp",
            node_type="builtin",
            effect_name="compressor",
            parameters={
                "threshold_db": -18.0,
                "ratio": 2.5,
                "attack_ms": 12.0,
                "release_ms": 180.0,
            },
        ),
        EffectChainNode(
            id="fx-reverb",
            node_type="builtin",
            effect_name="reverb",
            parameters={"room_size": 0.35, "wet_level": 0.12, "dry_level": 0.88},
        ),
    ]


def main() -> int:
    build(
        title="will i dream",
        audio_name="will i dream.opus",
        map_key="will i dream",
        colour="#9a7bdc",
    )
    build(
        title="House of the Rising Sun",
        audio_name="House of the Rising Sun.opus",
        map_key="house of the rising sun",
        colour="#5b9bd5",
    )
    build(
        title="Miracle Mile",
        audio_name="Miracle Mile.opus",
        map_key="miracle mile",
        colour="#e2a94a",
        scenes=["Intro", "Verse", "Turn", "Chorus", "Break", "Out"],
    )
    build(
        title="Gravy",
        audio_name="Gravy.opus",
        map_key="gravy",
        colour="#43b39a",
        fx=fx_chain(),
    )
    build(
        title="Everything is Chrome in the Future",
        audio_name="Everything is Chrome in the Future.opus",
        map_key="everything is chrome in the future",
        colour="#e2553f",
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
