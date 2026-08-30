"""Parse an Audima Sway ``.swayproj`` controller-layout file into a DawProject.

A ``.swayproj`` is NOT a session: it carries controller presets (pad-zone
rectangles with MIDI note/CC assignments, colours, grid modes) plus encoder
bank tables -- no tracks, no clips, no tempo, no audio references. The binary
layout was reverse-engineered from the four shipped "Audima Labs The Sway"
projects and verified against SwayCommand's factory swaymap (PULSE=CC35,
SWAY=CC37, GLIDE=CC50, SCULPT=CC38, STRIKE=CC73/74, encoders CC20..27):

    file    := 0xFF 0x02 preset* pad(2)
    preset  := name[20, ASCII NUL-padded] mode_a mode_b
               zones[N][79] trailer[209]
               where N = the byte at +0x16 (zone[0]'s first byte doubles as
               the count) and block_size = 231 + 79*N
    zone    := +0x01 type byte,
               +0x02 f32le x0, +0x06 y0, +0x0A x1, +0x0E y1 (pad rect),
               +0x16..+0x1C seven CC slots (0xFF = unused),
               +0x2B pitch class, +0x2C octave (note = octave*12 + class),
               +0x43 RGB off colour, +0x46 RGB on colour
    trailer := 0xFF 0x01, pitch/octave tables, 8x8 encoder-CC bank table

The import surfaces every distinct CC / note per preset as a
``DawControllerMapping`` with the preset's name as ``param_name``. That is the
exact hook the frontend already has: performRouting.trySeedSwayDim matches the
six dim names (STRIKE / SWAY / PULSE / GLIDE / PRESS / SCULPT) against
``param_name``, so a project whose presets carry those names seeds the dim
bindings with ITS CCs on load. Tracks stay empty by design -- there are none
in the file.
"""

from __future__ import annotations

from pathlib import Path

from backend.modules.dawimport.models import DawControllerMapping, DawProject

_MAGIC = b"\xff\x02"
_NAME_LEN = 20
_HEAD_LEN = 22  # name[20] + mode_a + mode_b
_ZONE_LEN = 79
_TRAILER_LEN = 209
_SLOT_OFFSET = 0x16  # zone-relative offset of the CC slot array
# The slot array is 7 bytes on disk, but the 7th byte is NOT a CC: across every
# shipped project it repeats 59/71 regardless of the preset's real CC (it reads
# as a separate config field), and treating it as a CC mis-seeded four of the
# six dims. Only the first six bytes are CC slots.
_SLOT_COUNT = 6
_PITCH_CLASS_OFFSET = 0x2B
_OCTAVE_OFFSET = 0x2C
# Sanity bounds: no observed preset exceeds 12 zones; 64 leaves headroom while
# still catching a desynced parse (a garbage count would blow past it).
_MAX_ZONES = 64
_MAX_MAPPINGS = 512


def _preset_name(raw: bytes) -> str:
    """Decode the NUL-padded ASCII preset name; '' when it isn't text."""
    end = raw.find(b"\x00")
    chunk = raw if end < 0 else raw[:end]
    try:
        text = chunk.decode("ascii")
    except UnicodeDecodeError:
        return ""
    if any(ord(c) < 0x20 or ord(c) > 0x7E for c in text):
        return ""
    return text.strip()


def parse_swayproj(path: str) -> DawProject:
    """Parse a .swayproj controller layout into a (track-less) DawProject."""
    p = Path(path)
    if not p.is_file():
        raise FileNotFoundError(f".swayproj not found: {path}")
    data = p.read_bytes()
    if len(data) < len(_MAGIC) + _HEAD_LEN or not data.startswith(_MAGIC):
        raise ValueError("Not a .swayproj: missing FF 02 magic header")

    project = DawProject(source_daw="sway", name=p.stem)
    mappings: list[DawControllerMapping] = []
    presets = 0
    off = len(_MAGIC)

    while off + _HEAD_LEN + _TRAILER_LEN <= len(data):
        name = _preset_name(data[off : off + _NAME_LEN])
        zone_count = data[off + _HEAD_LEN]
        if zone_count > _MAX_ZONES:
            project.warnings.append(
                f"swayproj: stopped at byte {off} — implausible zone count "
                f"{zone_count} (preset {presets + 1}); layout may be a newer "
                "format revision"
            )
            break
        block = _HEAD_LEN + _ZONE_LEN * zone_count + _TRAILER_LEN
        if off + block > len(data):
            project.warnings.append(
                f"swayproj: truncated preset block at byte {off} "
                f"(needs {block}, {len(data) - off} left)"
            )
            break

        # Distinct CCs / notes for this preset, in slot order (the FIRST CC of
        # a dim-named preset is the dim's own CC — order matters for seeding).
        ccs: list[int] = []
        notes: list[int] = []
        for i in range(zone_count):
            z = off + _HEAD_LEN + _ZONE_LEN * i
            for s in range(_SLOT_COUNT):
                v = data[z + _SLOT_OFFSET + s]
                if v < 128 and v not in ccs:
                    ccs.append(v)
            pitch_class = data[z + _PITCH_CLASS_OFFSET]
            octave = data[z + _OCTAVE_OFFSET]
            if pitch_class < 12:
                note = octave * 12 + pitch_class
                if note < 128 and note not in notes:
                    notes.append(note)

        # device_name/track_name stay EMPTY on purpose: the frontend's dim
        # seeding matches dim names against param+device+track text, and any
        # device string containing "sway" would make every mapping hijack the
        # SWAY dim. Only the preset's own name may carry a dim name.
        label = name or f"Preset {presets + 1}"
        for cc in ccs:
            mappings.append(
                DawControllerMapping(
                    is_note=False,
                    channel=-1,  # the Sway transmits omni
                    number=cc,
                    target_kind="unknown",
                    param_name=label,
                )
            )
        for note in notes:
            mappings.append(
                DawControllerMapping(
                    is_note=True,
                    channel=-1,
                    number=note,
                    target_kind="unknown",
                    param_name=label,
                )
            )

        presets += 1
        off += block
        if len(mappings) >= _MAX_MAPPINGS:
            project.warnings.append(
                f"swayproj: mapping list capped at {_MAX_MAPPINGS} entries"
            )
            break

    if presets == 0:
        raise ValueError("Not a .swayproj: no preset blocks parsed")

    project.controller_mappings = mappings[:_MAX_MAPPINGS]
    project.warnings.append(
        f"swayproj: controller layout only — {presets} preset(s), "
        f"{len(project.controller_mappings)} mapping(s); a .swayproj carries "
        "no tracks, clips or tempo"
    )
    return project
