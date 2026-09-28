"""Build theDAW's orchestral SoundFont (SF3) from VSCO 2 CE and VCSL.

Both sources are Versilian Studios sample sets released under CC0 1.0:

  VSCO 2 Community Edition  https://github.com/sgossner/VSCO-2-CE
      The ``SFZ`` branch carries the samples plus one ``.sfz`` mapping per
      articulation. Those mappings are the source of truth for key ranges,
      root keys, velocity bands and per-region levels.
  Versilian Community Sample Library  https://github.com/sgossner/VCSL
      No mappings; the concert harp and vibraphone are mapped from their file
      names (``KSHarp_A2_mf1.wav``), with the octave convention measured once
      per instrument (the harp names are scientific pitch, the vibraphone names
      sit an octave low).

Run from the repo root:

    python scripts/build_orchestra_sf3.py --out build/theDAW-Orchestra.sf3
    python scripts/build_orchestra_sf3.py --section strings --out build/strings.sf3
    python scripts/build_orchestra_sf3.py --list

Both repositories are read at the newest commit of their branch. The commit
each build used is written into the manifest next to the bank. Samples are
fetched one file at a time into a cache (``--cache``, default
``~/.cache/theDAW/orchestra-sf3``), checked against the git blob hash from the
repository tree, and reused on the next run. Nothing is written into the git
checkout. A build that would download more than ``--max-download-mb`` stops
before the first sample and says how much it needs.

How the bank is written
-----------------------
The file is written here, by a small SoundFont 2.04 writer, and the samples
are Ogg Vorbis streams encoded by libsndfile through ``soundfile`` (already a
base dependency). Polyphone's command line (``polyphone -1|-2|-3|-4 -i IN``)
converts an existing sf2/sf3/sfz file to another format and has no option for
modulators, so it cannot write the CC1 crossfades this bank exists for, and it
is not installed on the build machines. Its SFZ import would also drop the
crossfade: VSCO's SFZ files switch dynamic layers by velocity.

Dynamics on CC1
---------------
Sustained presets (``mode="cc1"``) keep every dynamic layer of a note playing
across the full velocity range and fade the layers against each other with
per-zone modulators on CC1 (the mod wheel) into initialAttenuation:

  2 layers  p: concave CC1 -> +480 cB, gain (1 - x);  f: the mirror, gain x.
  3 layers  the CC1 range splits at its midpoint with switch sources; each half
            is a 2-layer fade built from bipolar concave/convex sources.

The switch source is the only breakpoint a SoundFont modulator has, so a note
with four or more layers keeps its softest, middle and loudest ones. Every
zone in a CC1 preset also carries a zero-amount copy of the default
"CC1 -> vibrato" modulator, which turns the mod-wheel vibrato off for that
zone. CC1 presets play each layer at its recorded level, so a swell gets
louder as well as brighter (VSCO's ``volume`` opcodes lift the soft layers to
the loud one's level and leave loudness to velocity). A note with one layer
gets a CC1 level ramp instead (``--cc1-level-db``). Velocity still shapes the
attack level through the default velocity modulator. Short articulations
(``mode="velocity"``) keep VSCO's velocity layers and volumes.

Bank layout (the manifest lists every preset with its articulation):

  bank 0  default sustain, GM program numbers (violin section 40, viola 41 ...)
  bank 1  staccato / spiccato      bank 2  pizzicato     bank 3  tremolo / roll
  bank 4  the other sustain (non-vibrato, or trombone vibrato)
  bank 5  straight mute            bank 7  harmon mute
  bank 8+ solo violin (bank 8 sustain, 9 spiccato, 10 pizzicato, 11 tremolo)
  bank 128 program 48  orchestral percussion kit

Levelling
---------
Each preset is held to the bundled ``frontend/public/soundfonts/gm.sf3`` on
the same program (``--reference``): a held middle note at velocity 100 and
CC1 127 is rendered through SpessaSynth (``frontend/src/lib/soundbankLevels.ts``,
run with ``npx tsx``) in both banks, and the level is the loudest 100 ms RMS.
The difference is written into the preset's samples. SpessaSynth clamps a
decoded sample to +-1.0, so a boost that would pass full scale peak limits
the samples first (a smooth 30 ms gain, at most ``--max-limit-db``, 3 dB, on
any sample: more flattens the attacks). What the samples cannot take is the
preset's ``playback_gain_db``, which the app adds after the synth
(``frontend/src/lib/soundbankGain.ts``, read from the manifest's
``playback_gain`` table keyed ``"bank:program"``), capped so a velocity-127
note stays under -1 dBFS. A few
measure/adjust passes run on a PCM probe bank before the SF3 is encoded,
then the written bank is measured again, with a clipping check at velocity
127 on each preset's loudest zone. The manifest's ``levelling`` block holds
the before/after table. ``--no-level`` skips all of it (no Node needed).
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import logging
import math
import os
import re
import struct
import sys
import time
import urllib.parse
import urllib.request
from collections.abc import Callable, Iterable, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import soundfile as sf

log = logging.getLogger("build_orchestra_sf3")

# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Source:
    key: str
    repo: str
    ref: str
    title: str
    homepage: str
    licence: str = "CC0-1.0"
    licence_url: str = "https://creativecommons.org/publicdomain/zero/1.0/"
    credit: str = ""


VSCO = Source(
    key="vsco",
    repo="sgossner/VSCO-2-CE",
    ref="SFZ",
    title="VS Chamber Orchestra: Community Edition",
    homepage="https://github.com/sgossner/VSCO-2-CE",
    credit=(
        "Versilian Studios / Sam Gossner and Ivy Audio / Simon Dalzell; "
        "sample cutting by Elan Hickler / Soundemote"
    ),
)
VCSL = Source(
    key="vcsl",
    repo="sgossner/VCSL",
    ref="master",
    title="Versilian Community Sample Library",
    homepage="https://github.com/sgossner/VCSL",
    credit="Versilian Studios LLC",
)
SOURCES = {s.key: s for s in (VSCO, VCSL)}

RAW_URL = "https://raw.githubusercontent.com/{repo}/{ref}/{path}"
API_COMMIT = "https://api.github.com/repos/{repo}/commits/{ref}"
API_TREE = "https://api.github.com/repos/{repo}/git/trees/{sha}?recursive=1"

# ---------------------------------------------------------------------------
# Preset catalogue
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FileMap:
    """A VCSL instrument mapped from its file names."""

    folder: str
    pattern: str  # regex with named groups `note` and `dyn`
    dynamics: tuple[str, ...]  # dynamic tokens, softest first
    octave_shift: int = 0  # semitones added to the named note
    release: float = 1.0


@dataclass(frozen=True)
class PresetSpec:
    name: str
    section: str
    articulation: str
    bank: int
    program: int
    mode: str  # "cc1" or "velocity"
    source: str  # "vsco" or "vcsl"
    sfz: str = ""
    files: FileMap | None = None
    aliases: tuple[tuple[int, int], ...] = ()  # extra (bank, program) slots


def _p(name, section, art, bank, program, mode, sfz, *aliases):
    return PresetSpec(
        name, section, art, bank, program, mode, "vsco", sfz, None, aliases
    )


PRESETS: tuple[PresetSpec, ...] = (
    # Strings (sections)
    _p("Violins", "strings", "sustain", 0, 40, "cc1", "ViolinEnsSusVib.sfz"),
    _p(
        "Violins Spiccato",
        "strings",
        "spiccato",
        1,
        40,
        "velocity",
        "ViolinEnsSpic.sfz",
    ),
    _p(
        "Violins Pizzicato",
        "strings",
        "pizzicato",
        2,
        40,
        "velocity",
        "ViolinEnsPizz.sfz",
        (0, 45),
    ),
    _p(
        "Violins Tremolo",
        "strings",
        "tremolo",
        3,
        40,
        "cc1",
        "ViolinEnsTrem.sfz",
        (0, 44),
    ),
    _p("Violas", "strings", "sustain", 0, 41, "cc1", "ViolaEnsSusVib.sfz"),
    _p("Violas Spiccato", "strings", "spiccato", 1, 41, "velocity", "ViolaEnsSpic.sfz"),
    _p(
        "Violas Pizzicato",
        "strings",
        "pizzicato",
        2,
        41,
        "velocity",
        "ViolaEnsPizz.sfz",
    ),
    _p("Violas Tremolo", "strings", "tremolo", 3, 41, "cc1", "ViolaEnsTrem.sfz"),
    _p("Celli", "strings", "sustain", 0, 42, "cc1", "CelloEnsSusVib.sfz"),
    _p("Celli Spiccato", "strings", "spiccato", 1, 42, "velocity", "CelloEnsSpic.sfz"),
    _p(
        "Celli Pizzicato", "strings", "pizzicato", 2, 42, "velocity", "CelloEnsPizz.sfz"
    ),
    _p("Celli Tremolo", "strings", "tremolo", 3, 42, "cc1", "CelloEnsTrem.sfz"),
    _p("Contrabass", "strings", "sustain", 0, 43, "cc1", "ContrabassSusVB.sfz"),
    _p(
        "Contrabass Spiccato",
        "strings",
        "spiccato",
        1,
        43,
        "velocity",
        "ContrabassSpic.sfz",
    ),
    _p(
        "Contrabass Pizzicato",
        "strings",
        "pizzicato",
        2,
        43,
        "velocity",
        "ContrabassPizz.sfz",
    ),
    _p("Contrabass Tremolo", "strings", "tremolo", 3, 43, "cc1", "ContrabassTrem.sfz"),
    _p(
        "Contrabass NonVib",
        "strings",
        "non-vibrato",
        4,
        43,
        "cc1",
        "ContrabassSusNV.sfz",
    ),
    # Solo violin
    _p("Solo Violin", "strings", "sustain", 8, 40, "cc1", "SViolinVib.sfz"),
    _p(
        "Solo Violin Spiccato",
        "strings",
        "spiccato",
        9,
        40,
        "velocity",
        "SViolinSpic.sfz",
    ),
    _p(
        "Solo Violin Pizzicato",
        "strings",
        "pizzicato",
        10,
        40,
        "velocity",
        "SViolinPizz.sfz",
    ),
    _p("Solo Violin Tremolo", "strings", "tremolo", 11, 40, "cc1", "SViolinTrem.sfz"),
    # Woodwinds
    _p("Piccolo", "woodwinds", "sustain", 0, 72, "cc1", "PiccoloSus.sfz"),
    _p(
        "Piccolo Staccato",
        "woodwinds",
        "staccato",
        1,
        72,
        "velocity",
        "PiccoloStac.sfz",
    ),
    _p("Flute", "woodwinds", "sustain", 0, 73, "cc1", "FluteSusVib.sfz"),
    _p("Flute Staccato", "woodwinds", "staccato", 1, 73, "velocity", "FluteStac.sfz"),
    _p("Flute NonVib", "woodwinds", "non-vibrato", 4, 73, "cc1", "FluteSusNV.sfz"),
    _p("Flute Swell", "woodwinds", "expressive", 6, 73, "cc1", "FluteExpVib.sfz"),
    _p("Oboe", "woodwinds", "sustain", 0, 68, "cc1", "OboeSusVib.sfz"),
    _p("Oboe Staccato", "woodwinds", "staccato", 1, 68, "velocity", "OboeStac.sfz"),
    _p("Oboe NonVib", "woodwinds", "non-vibrato", 4, 68, "cc1", "OboeSusNV.sfz"),
    _p("Clarinet", "woodwinds", "sustain", 0, 71, "cc1", "ClarinetSus.sfz"),
    _p(
        "Clarinet Staccato",
        "woodwinds",
        "staccato",
        1,
        71,
        "velocity",
        "ClarinetStac.sfz",
    ),
    _p("Bassoon", "woodwinds", "sustain", 0, 70, "cc1", "BassoonVib.sfz"),
    _p(
        "Bassoon Staccato",
        "woodwinds",
        "staccato",
        1,
        70,
        "velocity",
        "BassoonStac.sfz",
    ),
    _p("Bassoon NonVib", "woodwinds", "non-vibrato", 4, 70, "cc1", "BassoonSus.sfz"),
    # Brass
    _p("French Horn", "brass", "sustain", 0, 60, "cc1", "FHornSus.sfz"),
    _p("French Horn Staccato", "brass", "staccato", 1, 60, "velocity", "FHornStac.sfz"),
    _p("French Horn Muted", "brass", "muted", 5, 60, "cc1", "FHornMute.sfz"),
    _p("Trumpet", "brass", "sustain", 0, 56, "cc1", "TrumpetSusVib.sfz"),
    _p("Trumpet Staccato", "brass", "staccato", 1, 56, "velocity", "TrumpetStac.sfz"),
    _p("Trumpet NonVib", "brass", "non-vibrato", 4, 56, "cc1", "TrumpetSus.sfz"),
    _p(
        "Trumpet Straight Mute",
        "brass",
        "muted",
        5,
        56,
        "cc1",
        "TrumpetStraightMuteSus.sfz",
        (0, 59),
    ),
    _p(
        "Trumpet Harmon Mute",
        "brass",
        "harmon",
        7,
        56,
        "cc1",
        "TrumpetHarmonMuteSus.sfz",
    ),
    _p("Trombone", "brass", "sustain", 0, 57, "cc1", "TromboneSus.sfz"),
    _p("Trombone Staccato", "brass", "staccato", 1, 57, "velocity", "TromboneStac.sfz"),
    _p("Trombone Vibrato", "brass", "vibrato", 4, 57, "cc1", "TromboneVib.sfz"),
    _p("Tuba", "brass", "sustain", 0, 58, "cc1", "TubaSus.sfz"),
    _p("Tuba Staccato", "brass", "staccato", 1, 58, "velocity", "TubaStac.sfz"),
    # Percussion
    _p("Timpani", "percussion", "hit", 0, 47, "velocity", "Timpani.sfz"),
    _p("Timpani Roll", "percussion", "roll", 3, 47, "velocity", "TimpaniRolls.sfz"),
    _p("Glockenspiel", "percussion", "hit", 0, 9, "velocity", "Glockenspiel.sfz"),
    _p("Marimba", "percussion", "hit", 0, 12, "velocity", "Marimba.sfz"),
    _p("Xylophone", "percussion", "hit", 0, 13, "velocity", "Xylophone.sfz"),
    _p("Tubular Bells", "percussion", "hit", 0, 14, "velocity", "TubularBells.sfz"),
    _p("Orchestra Kit", "percussion", "kit", 128, 48, "velocity", "GM-StylePerc.sfz"),
    PresetSpec(
        "Concert Harp",
        "strings",
        "pluck",
        0,
        46,
        "velocity",
        "vcsl",
        files=FileMap(
            folder="Chordophones/Composite Chordophones/Concert Harp",
            pattern=r"^KSHarp_(?P<note>[A-G]#?-?\d)_(?P<dyn>p|mf|f)\d*\.wav$",
            dynamics=("p", "mf", "f"),
            release=6.0,
        ),
    ),
    PresetSpec(
        "Vibraphone",
        "percussion",
        "soft mallets",
        0,
        11,
        "velocity",
        "vcsl",
        files=FileMap(
            folder="Idiophones/Struck Idiophones/Vibraphone/Soft Mallets",
            pattern=r"^Vibes_soft_(?P<note>[A-G]#?-?\d)_(?P<dyn>v\d)_rr\d+_Main\.wav$",
            dynamics=("v1", "v2", "v3"),
            octave_shift=12,
            release=4.0,
        ),
    ),
)

#: A key-split "String Ensemble" (GM 48) layered from the section presets.
ENSEMBLE_SPLIT: tuple[tuple[str, int, int], ...] = (
    ("Contrabass", 0, 39),
    ("Celli", 40, 54),
    ("Violas", 55, 61),
    ("Violins", 62, 127),
)

SECTIONS = ("strings", "woodwinds", "brass", "percussion")

# ---------------------------------------------------------------------------
# SoundFont constants
# ---------------------------------------------------------------------------

GEN_VIB_LFO_TO_PITCH = 6
GEN_PAN = 17
GEN_ATTACK_VOL_ENV = 34
GEN_RELEASE_VOL_ENV = 38
GEN_INSTRUMENT = 41
GEN_KEY_RANGE = 43
GEN_VEL_RANGE = 44
GEN_INITIAL_ATTENUATION = 48
GEN_FINE_TUNE = 52
GEN_SAMPLE_ID = 53
GEN_SAMPLE_MODES = 54
GEN_OVERRIDING_ROOT_KEY = 58

CURVE_LINEAR = 0
CURVE_CONCAVE = 1
CURVE_CONVEX = 2
CURVE_SWITCH = 3

CC_MOD_WHEEL = 1

#: Attenuation, in centibels, a crossfading layer reaches at the far end of
#: its fade (a concave source into 480 cB gives a linear gain ramp).
XFADE_CB = 480
#: Attenuation that silences a layer outside its half of the CC1 range.
MUTE_CB = 1440
#: SpessaSynth (and FluidSynth) scale a zone's initialAttenuation by 0.4, the
#: EMU correction; levels from the SFZ are divided by it so they land as meant.
EMU_ATTENUATION_FACTOR = 0.4

SAMPLE_TYPE_MONO = 1
SAMPLE_TYPE_VORBIS = 0x10


def mod_source(
    index: int,
    *,
    cc: bool = True,
    negative: bool = False,
    bipolar: bool = False,
    curve: int = CURVE_LINEAR,
) -> int:
    """Encode an SFModulator source word (SoundFont 2.04, section 8.2)."""
    return (
        (index & 0x7F)
        | (0x80 if cc else 0)
        | (0x100 if negative else 0)
        | (0x200 if bipolar else 0)
        | ((curve & 0x3F) << 10)
    )


@dataclass(frozen=True)
class Modulator:
    src: int
    dest: int
    amount: int
    amt_src: int = 0
    trans: int = 0

    def pack(self) -> bytes:
        return struct.pack(
            "<HHhHH", self.src, self.dest, self.amount, self.amt_src, self.trans
        )


#: Zero-amount copy of the default "mod wheel -> vibrato" modulator. An
#: identical modulator in a zone replaces the default one, so CC1 stops adding
#: vibrato in every zone that carries this.
NO_MOD_WHEEL_VIBRATO = Modulator(mod_source(CC_MOD_WHEEL), GEN_VIB_LFO_TO_PITCH, 0)

#: How much quieter a single-layer note in a CC1 preset plays at CC1 = 0 than
#: at 127, in dB. Notes with two or more layers get louder from the recordings
#: themselves (see zone_level_db); a note with one layer has nothing to fade
#: to, so CC1 moves its level.
CC1_LEVEL_DB = 15.0


def cc1_level_modulator(level_db: float = CC1_LEVEL_DB) -> Modulator:
    """CC1 -> initialAttenuation, linear in dB: ``level_db`` down at CC1 = 0,
    none at 127. Modulator attenuation is not EMU-scaled, so 1 dB is 10 cB."""
    return Modulator(
        mod_source(CC_MOD_WHEEL, negative=True),
        GEN_INITIAL_ATTENUATION,
        round(level_db * 10),
    )


def cc1_layer_modulators(
    layer: int, layers: int, amount: int = XFADE_CB
) -> list[Modulator]:
    """CC1 -> initialAttenuation modulators that fade layer ``layer`` of ``layers``.

    ``layers`` is 1, 2 or 3 (plan_zones reduces bigger stacks to three). The
    list always ends with NO_MOD_WHEEL_VIBRATO.
    """
    if not 0 <= layer < layers <= 3:
        raise ValueError(f"layer {layer} of {layers} is not a 1-3 layer stack")
    att = GEN_INITIAL_ATTENUATION
    cc1 = CC_MOD_WHEEL
    # Unipolar switches: 1 strictly below / strictly above the midpoint. A
    # synth that switches at "> 0.5" reads CC1 = 64 as neither, so the mutes
    # below are built from bipolar switches, which read the midpoint as one
    # side or the other, and the fades vanish there on their own (every
    # bipolar curve is 0 at the midpoint).
    low_half = mod_source(cc1, negative=True, curve=CURVE_SWITCH)
    high_half = mod_source(cc1, curve=CURVE_SWITCH)
    mods: list[Modulator] = []
    if layers == 2:
        mods.append(
            Modulator(
                mod_source(cc1, negative=layer == 1, curve=CURVE_CONCAVE), att, amount
            )
        )
    elif layers == 3:
        if layer == 0:
            # Lower half: A * concave(2x), written A - A * convex(1 - 2x).
            # Upper half and midpoint: MUTE_CB, from (MUTE_CB * low) - MUTE_CB * bipolar(low).
            mods += [
                Modulator(low_half, att, amount + MUTE_CB),
                Modulator(
                    mod_source(cc1, negative=True, bipolar=True, curve=CURVE_CONVEX),
                    att,
                    -amount,
                    amt_src=low_half,
                ),
                Modulator(
                    mod_source(cc1, negative=True, bipolar=True, curve=CURVE_SWITCH),
                    att,
                    -MUTE_CB,
                ),
            ]
        elif layer == 1:
            mods += [
                Modulator(
                    mod_source(cc1, negative=True, bipolar=True, curve=CURVE_CONCAVE),
                    att,
                    amount,
                    amt_src=low_half,
                ),
                Modulator(
                    mod_source(cc1, bipolar=True, curve=CURVE_CONCAVE),
                    att,
                    amount,
                    amt_src=high_half,
                ),
            ]
        else:
            # Upper half: A * concave(2 - 2x), written A - A * convex(2x - 1).
            # Lower half and midpoint: MUTE_CB, mirrored from layer 0.
            mods += [
                Modulator(high_half, att, amount + MUTE_CB),
                Modulator(
                    mod_source(cc1, bipolar=True, curve=CURVE_CONVEX),
                    att,
                    -amount,
                    amt_src=high_half,
                ),
                Modulator(
                    mod_source(cc1, bipolar=True, curve=CURVE_SWITCH), att, -MUTE_CB
                ),
            ]
    mods.append(NO_MOD_WHEEL_VIBRATO)
    return mods


# -- Reference model of the curves, used by the tests and the --curve report.


def _concave(v: float) -> float:
    if v <= 0:
        return 0.0
    if v >= 1:
        return 1.0
    return -(400 / 960) * math.log10(1 - v)


def _convex(v: float) -> float:
    if v <= 0:
        return 0.0
    if v >= 1:
        return 1.0
    return 1 - _concave(1 - v)


def source_value(src: int, cc_values: dict[int, int]) -> float:
    """What a source word reads for the given CC values (SoundFont 2.04 semantics,
    matching SpessaSynth's 14-bit controller table)."""
    index = src & 0x7F
    if not src & 0x80:
        if index == 0:
            return 1.0  # "no controller"
        raise ValueError(f"source {src:#x} is not a CC source")
    raw = (cc_values.get(index, 0) << 7) / 16384
    if src & 0x100:
        raw = 1 - raw
    bipolar = bool(src & 0x200)
    curve = (src >> 10) & 0x3F
    if curve == CURVE_SWITCH:
        v = 1.0 if raw > 0.5 else 0.0
        return v * 2 - 1 if bipolar else v
    if curve == CURVE_LINEAR:
        return raw * 2 - 1 if bipolar else raw
    fn = _concave if curve == CURVE_CONCAVE else _convex
    if bipolar:
        u = raw * 2 - 1
        return -fn(-u) if u < 0 else fn(u)
    return fn(raw)


def layer_attenuation_cb(mods: Iterable[Modulator], cc1: int) -> float:
    """Sum of the attenuation modulators at a CC1 value, clamped like a synth."""
    total = 0.0
    for m in mods:
        if m.dest != GEN_INITIAL_ATTENUATION:
            continue
        values = {CC_MOD_WHEEL: cc1}
        total += (
            source_value(m.src, values)
            * source_value(m.amt_src or 0, values)
            * m.amount
        )
    return max(0.0, min(1440.0, total))


# ---------------------------------------------------------------------------
# SFZ parsing
# ---------------------------------------------------------------------------

_NOTE_OFFSETS = {"c": 0, "d": 2, "e": 4, "f": 5, "g": 7, "a": 9, "b": 11}


def note_to_midi(name: str) -> int:
    """``A#0`` / ``c4`` / ``Eb3`` -> MIDI number, with C4 = 60."""
    m = re.fullmatch(r"([A-Ga-g])([#b]?)(-?\d+)", name.strip())
    if not m:
        raise ValueError(f"not a note name: {name!r}")
    letter, accidental, octave = m.groups()
    value = _NOTE_OFFSETS[letter.lower()] + (12 * (int(octave) + 1))
    if accidental == "#":
        value += 1
    elif accidental == "b":
        value -= 1
    return value


def _sfz_key(value: str) -> int:
    value = value.strip()
    try:
        return int(value)
    except ValueError:
        return note_to_midi(value)


@dataclass
class Region:
    sample: str  # path inside the source repository, forward slashes
    lokey: int = 0
    hikey: int = 127
    keycenter: int = 60
    lovel: int = 0
    hivel: int = 127
    volume: float = 0.0  # dB, may be positive
    tune: int = 0  # cents
    attack: float = 0.001
    release: float = 1.0
    opcodes: dict[str, str] = field(default_factory=dict, repr=False)


_HEADER_RE = re.compile(r"<(\w+)>")
_OPCODE_RE = re.compile(r"([A-Za-z0-9_]+)=")


def _parse_opcodes(body: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in body.splitlines():
        line = line.split("//", 1)[0]
        matches = list(_OPCODE_RE.finditer(line))
        for i, m in enumerate(matches):
            end = matches[i + 1].start() if i + 1 < len(matches) else len(line)
            out[m.group(1)] = line[m.end() : end].strip()
    return out


def parse_sfz(text: str) -> list[Region]:
    """Every region of an SFZ file with its inherited opcodes applied.

    Handles the headers VSCO uses (control, global, master, group, region).
    ``default_path`` is joined onto each sample and backslashes become slashes.
    """
    control: dict[str, str] = {}
    global_ops: dict[str, str] = {}
    master: dict[str, str] = {}
    group: dict[str, str] = {}
    regions: list[Region] = []
    pieces = _HEADER_RE.split(text)
    # pieces = [preamble, header, body, header, body, ...]
    for i in range(1, len(pieces), 2):
        header = pieces[i].lower()
        ops = _parse_opcodes(pieces[i + 1])
        if header == "control":
            control.update(ops)
        elif header == "global":
            global_ops = ops
            master = {}
            group = {}
        elif header == "master":
            master = ops
            group = {}
        elif header == "group":
            group = ops
        elif header == "region":
            merged = {**global_ops, **master, **group, **ops}
            regions.append(
                _region_from_opcodes(merged, control.get("default_path", ""))
            )
    return regions


def _region_from_opcodes(ops: dict[str, str], default_path: str) -> Region:
    sample = (default_path + ops.get("sample", "")).replace("\\", "/").lstrip("/")
    key = ops.get("key")
    lokey = _sfz_key(ops.get("lokey", key if key is not None else "0"))
    hikey = _sfz_key(ops.get("hikey", key if key is not None else "127"))
    keycenter = _sfz_key(
        ops.get("pitch_keycenter", key if key is not None else str(lokey))
    )
    return Region(
        sample=sample,
        lokey=lokey,
        hikey=hikey,
        keycenter=keycenter,
        lovel=int(ops.get("lovel", 0)),
        hivel=int(ops.get("hivel", 127)),
        volume=float(ops.get("volume", 0) or 0),
        tune=int(float(ops.get("tune", 0) or 0)),
        attack=float(ops.get("ampeg_attack", 0.001) or 0.001),
        release=float(ops.get("ampeg_release", 1.0) or 1.0),
        opcodes=ops,
    )


def first_round_robin(regions: Sequence[Region]) -> list[Region]:
    """Keep one round robin: SoundFont has none. Regions in a random group
    other than the first (``lorand`` > 0) or a sequence slot other than the
    first (``seq_position`` > 1) are dropped; keyswitched regions are refused."""
    kept = []
    for r in regions:
        if "sw_last" in r.opcodes or "sw_lokey" in r.opcodes:
            raise ValueError(
                "keyswitch SFZ files are not mapped; use the per-articulation files"
            )
        if float(r.opcodes.get("lorand", 0) or 0) > 0:
            continue
        if int(float(r.opcodes.get("seq_position", 1) or 1)) > 1:
            continue
        kept.append(r)
    return kept


def regions_from_files(names: Iterable[str], fmap: FileMap) -> list[Region]:
    """Regions for an unmapped instrument from its sample file names.

    Root keys come from the names (plus ``octave_shift``). Each root owns the
    keys up to halfway to its neighbours; dynamics become velocity bands split
    evenly in the order of ``fmap.dynamics``.
    """
    pattern = re.compile(fmap.pattern)
    by_key: dict[int, dict[str, str]] = {}
    for name in sorted(names):
        m = pattern.match(name)
        if not m:
            continue
        key = note_to_midi(m.group("note")) + fmap.octave_shift
        dyn = m.group("dyn")
        if dyn not in fmap.dynamics:
            continue
        by_key.setdefault(key, {}).setdefault(dyn, name)
    keys = sorted(by_key)
    regions: list[Region] = []
    for i, key in enumerate(keys):
        lo = 0 if i == 0 else (keys[i - 1] + key) // 2 + 1
        hi = 127 if i == len(keys) - 1 else (key + keys[i + 1]) // 2
        dyns = [d for d in fmap.dynamics if d in by_key[key]]
        for j, dyn in enumerate(dyns):
            lovel = round(j * 128 / len(dyns))
            hivel = round((j + 1) * 128 / len(dyns)) - 1
            regions.append(
                Region(
                    sample=f"{fmap.folder}/{by_key[key][dyn]}",
                    lokey=lo,
                    hikey=hi,
                    keycenter=key,
                    lovel=lovel,
                    hivel=hivel,
                    release=fmap.release,
                )
            )
    return regions


# ---------------------------------------------------------------------------
# Zone planning
# ---------------------------------------------------------------------------


@dataclass
class ZonePlan:
    region: Region
    lokey: int
    hikey: int
    lovel: int
    hivel: int
    layer: int = 0
    layers: int = 1
    modulators: list[Modulator] = field(default_factory=list)


def _pick_layers(stack: list[Region]) -> list[Region]:
    if len(stack) <= 3:
        return stack
    return [stack[0], stack[(len(stack) - 1) // 2 + (len(stack) - 1) % 2], stack[-1]]


def plan_zones(
    regions: Sequence[Region], mode: str, level_db: float = CC1_LEVEL_DB
) -> list[ZonePlan]:
    """Turn SFZ regions into SoundFont zones.

    ``velocity`` keeps each region's key and velocity ranges. ``cc1`` walks the
    keyboard, finds the stack of regions covering each key (softest first by
    velocity band), and emits one zone per region per run of keys whose stack
    is the same; each zone spans all velocities and fades on CC1 against the
    other layers. A key with a single layer gets ``level_db`` louder from
    CC1 = 0 to 127 instead.
    """
    if mode == "velocity":
        return [
            ZonePlan(r, r.lokey, r.hikey, max(0, r.lovel), min(127, r.hivel))
            for r in sorted(regions, key=lambda r: (r.lokey, r.lovel))
        ]
    if mode != "cc1":
        raise ValueError(f"unknown mode {mode!r}")
    ordered = sorted(regions, key=lambda r: (r.lovel, r.hivel))
    ids = {id(r): i for i, r in enumerate(ordered)}
    plans: list[ZonePlan] = []
    run_start = 0
    run_stack: tuple[int, ...] = ()

    def flush(end_key: int) -> None:
        if not run_stack:
            return
        stack = _pick_layers([ordered[i] for i in run_stack])
        for layer, region in enumerate(stack):
            plans.append(
                ZonePlan(
                    region,
                    run_start,
                    end_key,
                    0,
                    127,
                    layer,
                    len(stack),
                    [
                        *cc1_layer_modulators(layer, len(stack)),
                        *([cc1_level_modulator(level_db)] if len(stack) == 1 else []),
                    ],
                )
            )

    for key in range(128):
        stack = tuple(ids[id(r)] for r in ordered if r.lokey <= key <= r.hikey)
        if stack != run_stack:
            flush(key - 1)
            run_start, run_stack = key, stack
    flush(127)
    return plans


# ---------------------------------------------------------------------------
# SoundFont writer
# ---------------------------------------------------------------------------


@dataclass
class SampleData:
    name: str
    data: np.ndarray  # mono float32 in [-1, 1]
    rate: int
    root: int
    correction: int = 0


@dataclass
class Zone:
    generators: list[tuple[int, int]]  # (oper, amount) with ranges packed lo | hi << 8
    modulators: list[Modulator] = field(default_factory=list)


@dataclass
class Instrument:
    name: str
    zones: list[Zone]


@dataclass
class Preset:
    name: str
    bank: int
    program: int
    zones: list[Zone]


def _range(lo: int, hi: int) -> int:
    return (lo & 0xFF) | ((hi & 0xFF) << 8)


def _name20(name: str) -> bytes:
    raw = name.encode("ascii", "replace")[:20]
    return raw + b"\0" * (20 - len(raw))


def _chunk(tag: bytes, payload: bytes) -> bytes:
    pad = b"\0" if len(payload) % 2 else b""
    return tag + struct.pack("<I", len(payload)) + payload + pad


def _list(tag: bytes, chunks: Sequence[bytes]) -> bytes:
    body = tag + b"".join(chunks)
    return b"LIST" + struct.pack("<I", len(body)) + body


def _zstr(text: str) -> bytes:
    raw = text.encode("ascii", "replace") + b"\0"
    return raw + (b"\0" if len(raw) % 2 else b"")


#: Frames handed to libsndfile per write. libvorbis analyses a whole write
#: at once on the stack, and a multi-second write overflows the 1 MB Windows
#: main-thread stack ("Windows fatal exception: stack overflow").
VORBIS_BLOCK = 8192


def encode_vorbis(data: np.ndarray, rate: int, compression: float) -> bytes:
    buf = io.BytesIO()
    with sf.SoundFile(
        buf,
        mode="w",
        samplerate=rate,
        channels=1,
        format="OGG",
        subtype="VORBIS",
        compression_level=compression,
    ) as out:
        for start in range(0, len(data), VORBIS_BLOCK):
            out.write(data[start : start + VORBIS_BLOCK])
    return buf.getvalue()


def _order_generators(gens: list[tuple[int, int]], last: int) -> list[tuple[int, int]]:
    """keyRange first, velRange second, the instrument/sampleID generator last."""
    key = [g for g in gens if g[0] == GEN_KEY_RANGE]
    vel = [g for g in gens if g[0] == GEN_VEL_RANGE]
    tail = [g for g in gens if g[0] == last]
    rest = [g for g in gens if g[0] not in (GEN_KEY_RANGE, GEN_VEL_RANGE, last)]
    return key + vel + rest + tail


def _hydra(
    items: Sequence[tuple[bytes, list[Zone]]],
    header_fmt: Callable[[bytes, int], bytes],
    terminal: bytes,
    last_gen: int,
) -> tuple[bytes, bytes, bytes, bytes]:
    headers, bags, mods, gens = [], [], [], []
    gen_i = mod_i = bag_i = 0
    for head, zones in items:
        headers.append(header_fmt(head, bag_i))
        for zone in zones:
            bags.append(struct.pack("<HH", gen_i, mod_i))
            bag_i += 1
            for m in zone.modulators:
                mods.append(m.pack())
                mod_i += 1
            for oper, amount in _order_generators(zone.generators, last_gen):
                if oper in (GEN_KEY_RANGE, GEN_VEL_RANGE):
                    gens.append(struct.pack("<HH", oper, amount))
                else:
                    gens.append(struct.pack("<Hh", oper, amount))
                gen_i += 1
    headers.append(header_fmt(terminal, bag_i))
    bags.append(struct.pack("<HH", gen_i, mod_i))
    mods.append(b"\0" * 10)
    gens.append(b"\0" * 4)
    return b"".join(headers), b"".join(bags), b"".join(mods), b"".join(gens)


def write_soundfont(
    path: Path,
    samples: Sequence[SampleData],
    instruments: Sequence[Instrument],
    presets: Sequence[Preset],
    info: dict[str, str],
    *,
    compress: bool = True,
    compression: float = 0.5,
) -> int:
    """Write an SF3 (Vorbis samples) or, with ``compress=False``, an SF2.

    Returns the file size in bytes.
    """
    smpl = bytearray()
    shdr = []
    for s in samples:
        data = np.asarray(s.data, dtype=np.float32)
        # SpessaSynth clamps decoded samples to +-1.0 and 16-bit PCM has no
        # room above it, so nothing is written past full scale.
        data = np.clip(data, -1.0, 1.0)
        if compress:
            blob = encode_vorbis(data, s.rate, compression)
            start = len(smpl)
            smpl += blob
            end = len(smpl)
            loop_start, loop_end = 0, len(data)
            stype = SAMPLE_TYPE_MONO | SAMPLE_TYPE_VORBIS
        else:
            pcm = np.round(data * 32767).astype("<i2").tobytes()
            start = len(smpl) // 2
            smpl += pcm + b"\0" * 92  # 46 zero points after every sample
            end = start + len(data)
            loop_start, loop_end = start, end
            stype = SAMPLE_TYPE_MONO
        shdr.append(
            _name20(s.name)
            + struct.pack(
                "<IIIIIBbHH",
                start,
                end,
                loop_start,
                loop_end,
                s.rate,
                s.root,
                s.correction,
                0,
                stype,
            )
        )
    shdr.append(_name20("EOS") + b"\0" * 26)

    phdr, pbag, pmod, pgen = _hydra(
        [
            (_name20(p.name) + struct.pack("<HH", p.program, p.bank), p.zones)
            for p in presets
        ],
        lambda head, bag: head + struct.pack("<HIII", bag, 0, 0, 0),
        _name20("EOP") + struct.pack("<HH", 0, 0),
        GEN_INSTRUMENT,
    )
    inst, ibag, imod, igen = _hydra(
        [(_name20(i.name), i.zones) for i in instruments],
        lambda head, bag: head + struct.pack("<H", bag),
        _name20("EOI"),
        GEN_SAMPLE_ID,
    )
    version = (3, 1) if compress else (2, 4)
    info_chunks = [
        _chunk(b"ifil", struct.pack("<HH", *version)),
        _chunk(b"isng", _zstr("EMU8000")),
    ]
    for tag in ("INAM", "ICRD", "IENG", "IPRD", "ICOP", "ICMT", "ISFT"):
        if info.get(tag):
            info_chunks.append(_chunk(tag.encode(), _zstr(info[tag])))
    body = b"sfbk" + b"".join(
        [
            _list(b"INFO", info_chunks),
            _list(b"sdta", [_chunk(b"smpl", bytes(smpl))]),
            _list(
                b"pdta",
                [
                    _chunk(b"phdr", phdr),
                    _chunk(b"pbag", pbag),
                    _chunk(b"pmod", pmod),
                    _chunk(b"pgen", pgen),
                    _chunk(b"inst", inst),
                    _chunk(b"ibag", ibag),
                    _chunk(b"imod", imod),
                    _chunk(b"igen", igen),
                    _chunk(b"shdr", b"".join(shdr)),
                ],
            ),
        ]
    )
    blob = b"RIFF" + struct.pack("<I", len(body)) + body
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".part")
    tmp.write_bytes(blob)
    os.replace(tmp, path)
    return len(blob)


def read_soundfont(path: Path) -> dict:
    """Parse the pdta hydra and INFO of a SoundFont back into plain dicts.

    Used by the tests and by ``--inspect``; it reads exactly what
    write_soundfont writes and every standard SF2/SF3.
    """
    data = Path(path).read_bytes()
    if data[:4] != b"RIFF" or data[8:12] != b"sfbk":
        raise ValueError("not a SoundFont")
    chunks: dict[bytes, bytes] = {}

    def walk(buf: bytes, pos: int, end: int) -> None:
        while pos + 8 <= end:
            tag = buf[pos : pos + 4]
            size = struct.unpack_from("<I", buf, pos + 4)[0]
            if tag == b"LIST":
                walk(buf, pos + 12, pos + 8 + size)
            else:
                chunks[tag] = buf[pos + 8 : pos + 8 + size]
            pos += 8 + size + (size % 2)

    walk(data, 12, len(data))

    def records(tag: bytes, size: int) -> list[bytes]:
        raw = chunks[tag]
        return [raw[i : i + size] for i in range(0, len(raw), size)]

    def gens(tag: bytes) -> list[tuple[int, int]]:
        out = []
        for rec in records(tag, 4):
            oper = struct.unpack_from("<H", rec)[0]
            if oper in (GEN_KEY_RANGE, GEN_VEL_RANGE):
                lo, hi = rec[2], rec[3]
                out.append((oper, (lo, hi)))
            else:
                out.append((oper, struct.unpack_from("<h", rec, 2)[0]))
        return out

    def mods(tag: bytes) -> list[Modulator]:
        return [Modulator(*struct.unpack("<HHhHH", rec)) for rec in records(tag, 10)]

    def zones(
        bag_tag: bytes, gen_tag: bytes, mod_tag: bytes, first: int, last: int
    ) -> list[dict]:
        bags = [struct.unpack("<HH", r) for r in records(bag_tag, 4)]
        g, m = gens(gen_tag), mods(mod_tag)
        out = []
        for b in range(first, last):
            out.append(
                {
                    "generators": g[bags[b][0] : bags[b + 1][0]],
                    "modulators": m[bags[b][1] : bags[b + 1][1]],
                }
            )
        return out

    def name(raw: bytes) -> str:
        return raw[:20].split(b"\0", 1)[0].decode("ascii", "replace")

    phdr = records(b"phdr", 38)
    presets = []
    for i in range(len(phdr) - 1):
        program, bank, bag = struct.unpack_from("<HHH", phdr[i], 20)
        nxt = struct.unpack_from("<H", phdr[i + 1], 24)[0]
        presets.append(
            {
                "name": name(phdr[i]),
                "bank": bank,
                "program": program,
                "zones": zones(b"pbag", b"pgen", b"pmod", bag, nxt),
            }
        )
    inst = records(b"inst", 22)
    instruments = []
    for i in range(len(inst) - 1):
        bag = struct.unpack_from("<H", inst[i], 20)[0]
        nxt = struct.unpack_from("<H", inst[i + 1], 20)[0]
        instruments.append(
            {"name": name(inst[i]), "zones": zones(b"ibag", b"igen", b"imod", bag, nxt)}
        )
    samples = []
    for rec in records(b"shdr", 46)[:-1]:
        start, end, ls, le, rate, root, corr, link, stype = struct.unpack_from(
            "<IIIIIBbHH", rec, 20
        )
        samples.append(
            {
                "name": name(rec),
                "start": start,
                "end": end,
                "rate": rate,
                "root": root,
                "type": stype,
            }
        )
    info = {}
    for tag in (b"INAM", b"ICOP", b"ICMT", b"ISFT", b"ICRD", b"IENG"):
        if tag in chunks:
            info[tag.decode()] = (
                chunks[tag].split(b"\0", 1)[0].decode("ascii", "replace")
            )
    version = struct.unpack("<HH", chunks[b"ifil"])
    return {
        "version": version,
        "info": info,
        "presets": presets,
        "instruments": instruments,
        "samples": samples,
        "smpl": chunks[b"smpl"],
    }


# ---------------------------------------------------------------------------
# Audio preparation
# ---------------------------------------------------------------------------

#: Trailing audio quieter than this (relative to the sample's peak) is cut.
TAIL_FLOOR_DB = -72.0
TAIL_KEEP_S = 0.05
TAIL_FADE_S = 0.02


def prepare_audio(data: np.ndarray, rate: int) -> np.ndarray:
    """Mono float32 with the silent tail trimmed and a short fade at the end."""
    x = np.asarray(data, dtype=np.float32)
    if x.ndim == 2:
        x = x.mean(axis=1, dtype=np.float32)
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    if peak <= 0:
        return x[: max(1, int(rate * 0.01))]
    floor = peak * 10 ** (TAIL_FLOOR_DB / 20)
    loud = np.nonzero(np.abs(x) > floor)[0]
    end = (
        min(len(x), int(loud[-1]) + 1 + int(TAIL_KEEP_S * rate))
        if loud.size
        else len(x)
    )
    x = x[:end].copy()
    fade = min(len(x), int(TAIL_FADE_S * rate))
    if fade > 1:
        x[-fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)
    return x


def seconds_to_timecents(seconds: float) -> int:
    seconds = max(0.001, float(seconds))
    return max(-12000, min(8000, round(1200 * math.log2(seconds))))


# ---------------------------------------------------------------------------
# Fetching
# ---------------------------------------------------------------------------


def default_cache_dir() -> Path:
    env = os.getenv("THEDAW_SF3_CACHE")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".cache" / "theDAW" / "orchestra-sf3"


def git_blob_sha(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def _http_get(url: str, *, accept_json: bool = False, attempts: int = 4) -> bytes:
    headers = {"User-Agent": "theDAW-build-orchestra-sf3"}
    token = os.getenv("GITHUB_TOKEN")
    if token and "api.github.com" in url:
        headers["Authorization"] = f"Bearer {token}"
    if accept_json:
        headers["Accept"] = "application/vnd.github+json"
    delay = 1.0
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(
                urllib.request.Request(url, headers=headers), timeout=60
            ) as r:
                return r.read()
        except Exception:
            if attempt == attempts - 1:
                raise
            time.sleep(delay)
            delay *= 2
    raise RuntimeError("unreachable")


@dataclass
class RepoSnapshot:
    source: Source
    commit: str
    blobs: dict[str, tuple[str, int]]  # path -> (blob sha, size)

    def raw_url(self, path: str) -> str:
        return RAW_URL.format(
            repo=self.source.repo, ref=self.commit, path=urllib.parse.quote(path)
        )


def snapshot(source: Source, cache: Path) -> RepoSnapshot:
    """The newest commit of the source branch and its file listing."""
    commit = json.loads(
        _http_get(API_COMMIT.format(repo=source.repo, ref=source.ref), accept_json=True)
    )
    sha = commit["sha"]
    tree_sha = commit["commit"]["tree"]["sha"]
    tree_cache = cache / "trees" / f"{source.key}-{sha}.json"
    if tree_cache.is_file():
        tree = json.loads(tree_cache.read_text(encoding="utf-8"))
    else:
        tree = json.loads(
            _http_get(API_TREE.format(repo=source.repo, sha=tree_sha), accept_json=True)
        )
        if tree.get("truncated"):
            raise RuntimeError(f"{source.repo} tree listing came back truncated")
        tree_cache.parent.mkdir(parents=True, exist_ok=True)
        tree_cache.write_text(json.dumps(tree), encoding="utf-8")
    blobs = {
        e["path"]: (e["sha"], int(e.get("size", 0)))
        for e in tree["tree"]
        if e["type"] == "blob"
    }
    return RepoSnapshot(source, sha, blobs)


def cached_path(cache: Path, snap: RepoSnapshot, path: str) -> Path:
    return cache / snap.source.key / Path(*path.split("/"))


def is_cached(cache: Path, snap: RepoSnapshot, path: str) -> bool:
    target = cached_path(cache, snap, path)
    if not target.is_file():
        return False
    sha, size = snap.blobs[path]
    return target.stat().st_size == size


def fetch(cache: Path, snap: RepoSnapshot, path: str) -> Path:
    """Download one file into the cache and check it against its blob hash."""
    target = cached_path(cache, snap, path)
    sha, size = snap.blobs[path]
    if target.is_file() and target.stat().st_size == size:
        return target
    data = _http_get(snap.raw_url(path))
    if git_blob_sha(data) != sha:
        raise RuntimeError(
            f"{path}: content does not match the repository's blob {sha}"
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".part")
    tmp.write_bytes(data)
    os.replace(tmp, target)
    return target


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------


@dataclass
class PlannedPreset:
    spec: PresetSpec
    zones: list[ZonePlan]


def select_presets(
    sections: Sequence[str] | None, names: Sequence[str] | None
) -> list[PresetSpec]:
    chosen = list(PRESETS)
    if sections:
        wanted = {s.lower() for s in sections}
        unknown = wanted - set(SECTIONS)
        if unknown:
            raise SystemExit(f"unknown section(s): {', '.join(sorted(unknown))}")
        chosen = [p for p in chosen if p.section in wanted]
    if names:
        wanted_names = {n.lower() for n in names}
        chosen = [p for p in chosen if p.name.lower() in wanted_names]
    if not chosen:
        raise SystemExit("no presets selected")
    return chosen


def plan_presets(
    specs: Sequence[PresetSpec],
    load_sfz: Callable[[str], str],
    list_files: Callable[[str], list[str]],
    level_db: float = CC1_LEVEL_DB,
) -> list[PlannedPreset]:
    planned = []
    for spec in specs:
        if spec.source == "vsco":
            regions = first_round_robin(parse_sfz(load_sfz(spec.sfz)))
        else:
            assert spec.files is not None
            regions = regions_from_files(list_files(spec.files.folder), spec.files)
        if not regions:
            raise RuntimeError(f"{spec.name}: no regions")
        planned.append(PlannedPreset(spec, plan_zones(regions, spec.mode, level_db)))
    return planned


#: Peak a preset's loudest sample is scaled to.
PEAK_TARGET = 0.98


def zone_level_db(spec: PresetSpec, plan: ZonePlan) -> float:
    """The level a zone should play at, relative to its raw recording.

    Velocity presets keep the SFZ ``volume``. CC1 presets play the recordings
    as they are: VSCO's ``volume`` lifts each soft layer to the level of the
    loud one (p +20 dB, f +7 dB for the violins) and leaves loudness to
    velocity, and a CC1 crossfade between levelled layers would only change
    the timbre.
    """
    return 0.0 if spec.mode == "cc1" else plan.region.volume


def assemble(
    planned: Sequence[PlannedPreset],
    load_audio: Callable[[PresetSpec, str], tuple[np.ndarray, int]],
) -> tuple[list[SampleData], list[Instrument], list[Preset], list[dict]]:
    """Build the sample pool, instruments and presets.

    Each preset gets one make-up gain, the largest that keeps every one of its
    zones at or below PEAK_TARGET once its zone level is applied, so relative
    levels inside the preset hold and the loudest sample reaches full scale.
    A sample is stored once, at the gain its first preset gave it; a later
    zone that wants it at another level makes up the difference with
    initialAttenuation, and a preset that would need a boost there is lowered
    as a whole until none does.
    """
    samples: list[SampleData] = []
    sample_index: dict[tuple[str, str], int] = {}
    sample_gain_db: dict[int, float] = {}
    instruments: list[Instrument] = []
    presets: list[Preset] = []
    manifest: list[dict] = []
    inst_by_name: dict[str, int] = {}

    for pp in planned:
        spec = pp.spec
        fresh: dict[tuple[str, str], tuple[np.ndarray, int, int]] = {}
        headroom: list[float] = []
        for plan in pp.zones:
            key = (spec.source, plan.region.sample)
            if key in sample_index:
                continue
            if key not in fresh:
                audio, rate = load_audio(spec, plan.region.sample)
                audio = prepare_audio(audio, rate)
                fresh[key] = (audio, int(rate), plan.region.keycenter)
            peak = float(np.max(np.abs(fresh[key][0]))) or 1.0
            headroom.append(
                20 * math.log10(PEAK_TARGET / peak) - zone_level_db(spec, plan)
            )
        makeup_db = min(headroom) if headroom else 0.0

        zone_samples = []
        for plan in pp.zones:
            key = (spec.source, plan.region.sample)
            if key not in sample_index:
                audio, rate, root = fresh.pop(key)
                gain_db = zone_level_db(spec, plan) + makeup_db
                stem = plan.region.sample.rsplit("/", 1)[-1].rsplit(".", 1)[0]
                sample_index[key] = len(samples)
                sample_gain_db[len(samples)] = gain_db
                samples.append(
                    SampleData(
                        stem[:20],
                        audio * np.float32(10 ** (gain_db / 20)),
                        rate,
                        root,
                    )
                )
            zone_samples.append(sample_index[key])

        atten_db = [
            sample_gain_db[si] - (zone_level_db(spec, plan) + makeup_db)
            for si, plan in zip(zone_samples, pp.zones)
        ]
        lift = max(0.0, -min(atten_db))
        zones = []
        for si, plan, att in zip(zone_samples, pp.zones, atten_db):
            cb = round((att + lift) * 10 / EMU_ATTENUATION_FACTOR)
            gens: list[tuple[int, int]] = [
                (GEN_KEY_RANGE, _range(plan.lokey, plan.hikey)),
                (GEN_VEL_RANGE, _range(plan.lovel, plan.hivel)),
                (GEN_ATTACK_VOL_ENV, seconds_to_timecents(plan.region.attack)),
                (GEN_RELEASE_VOL_ENV, seconds_to_timecents(plan.region.release)),
                (GEN_OVERRIDING_ROOT_KEY, plan.region.keycenter),
                (GEN_SAMPLE_MODES, 0),
            ]
            if cb:
                gens.append((GEN_INITIAL_ATTENUATION, min(MUTE_CB, cb)))
            if plan.region.tune:
                gens.append((GEN_FINE_TUNE, plan.region.tune))
            gens.append((GEN_SAMPLE_ID, si))
            zones.append(Zone(gens, list(plan.modulators)))
        inst_by_name[spec.name] = len(instruments)
        instruments.append(Instrument(spec.name[:20], zones))
        slots = [(spec.bank, spec.program), *spec.aliases]
        for bank, program in slots:
            presets.append(
                Preset(
                    spec.name[:20],
                    bank,
                    program,
                    [Zone([(GEN_INSTRUMENT, inst_by_name[spec.name])])],
                )
            )
        layer_counts = sorted({z.layers for z in pp.zones})
        manifest.append(
            {
                "name": spec.name,
                "section": spec.section,
                "articulation": spec.articulation,
                "bank": spec.bank,
                "program": spec.program,
                "aliases": [list(a) for a in spec.aliases],
                "dynamics": "cc1" if spec.mode == "cc1" else "velocity",
                "cc1_layers": layer_counts if spec.mode == "cc1" else [],
                "zones": len(zones),
                "source": spec.source,
                "mapping": spec.sfz or (spec.files.folder if spec.files else ""),
            }
        )

    if all(name in inst_by_name for name, _, _ in ENSEMBLE_SPLIT):
        zones = [
            Zone(
                [(GEN_KEY_RANGE, _range(lo, hi)), (GEN_INSTRUMENT, inst_by_name[name])]
            )
            for name, lo, hi in ENSEMBLE_SPLIT
        ]
        presets.append(Preset("String Ensemble", 0, 48, zones))
        manifest.append(
            {
                "name": "String Ensemble",
                "section": "strings",
                "articulation": "sustain",
                "bank": 0,
                "program": 48,
                "aliases": [],
                "dynamics": "cc1",
                "cc1_layers": [],
                "zones": len(zones),
                "source": "vsco",
                "mapping": "key split: "
                + ", ".join(f"{n} {lo}-{hi}" for n, lo, hi in ENSEMBLE_SPLIT),
            }
        )
    presets.sort(key=lambda p: (p.bank, p.program))
    return samples, instruments, presets, manifest


# ---------------------------------------------------------------------------
# Levelling against the bundled General MIDI bank
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[1]
FRONTEND_DIR = REPO_ROOT / "frontend"
REFERENCE_BANK = FRONTEND_DIR / "public" / "soundfonts" / "gm.sf3"
LEVEL_CLI = "src/lib/soundbankLevelsCli.ts"

#: The level is measured on a held note at this velocity with CC1 at 127.
LEVEL_VELOCITY = 100
LEVEL_CC1 = 127
#: Clipping is checked at full velocity and full CC1.
CLIP_VELOCITY = 127
LEVEL_TOLERANCE_DB = 1.5
#: Synth output peak a levelled preset may reach at full velocity.
OUTPUT_PEAK_LIMIT = 10 ** (-1 / 20)
#: Largest sample value levelling may write. SpessaSynth clamps decoded
#: samples to +-1.0, so a louder sample would clip in the app.
SAMPLE_CEILING = 0.98
#: Most peak limiting levelling applies to any sample, in dB. More flattens
#: the attacks; the app makes up what is left at playback (playback_gain_db).
MAX_LIMIT_DB = 3.0
#: Half-width of the limiter's gain smoothing, in seconds.
LIMITER_WINDOW_S = 0.03
#: Measure/adjust passes, and the residual that ends them early.
LEVEL_PASSES = 4
LEVEL_SETTLED_DB = 0.3
#: The String Ensemble split is measured on G4, in the violins' range.
ENSEMBLE_NOTE = 67
#: Kit presets are measured on the snare (GM key 38) when the kit has one.
KIT_LEVEL_KEY = 38
#: Zones fainter than this at CC1 = 127 are not the playing layer.
_SILENT_LAYER_CB = 60


def _zone_gens(zone: Zone) -> dict[int, int]:
    return dict(zone.generators)


def _zone_keys(zone: Zone) -> tuple[int, int]:
    packed = _zone_gens(zone).get(GEN_KEY_RANGE, _range(0, 127))
    return packed & 0xFF, packed >> 8


def _zone_vels(zone: Zone) -> tuple[int, int]:
    packed = _zone_gens(zone).get(GEN_VEL_RANGE, _range(0, 127))
    return packed & 0xFF, packed >> 8


def level_note(instrument: Instrument, drum: bool = False) -> int:
    """The note a preset is measured on: the middle of the keys it covers
    (the snare for a kit that has one)."""
    keys = sorted(
        {
            k
            for z in instrument.zones
            for k in range(_zone_keys(z)[0], _zone_keys(z)[1] + 1)
        }
    )
    if drum and KIT_LEVEL_KEY in keys:
        return KIT_LEVEL_KEY
    return keys[len(keys) // 2]


def _playing_at_full(zone: Zone) -> bool:
    """Whether a zone sounds at velocity 127 with CC1 at 127."""
    lo, hi = _zone_vels(zone)
    if not lo <= CLIP_VELOCITY <= hi:
        return False
    return layer_attenuation_cb(zone.modulators, 127) < _SILENT_LAYER_CB


def _zone_output_scale(zone: Zone, samples: Sequence[SampleData]) -> float:
    sample = samples[_zone_gens(zone)[GEN_SAMPLE_ID]]
    peak = float(np.max(np.abs(sample.data))) if sample.data.size else 0.0
    att_db = (
        _zone_gens(zone).get(GEN_INITIAL_ATTENUATION, 0) * EMU_ATTENUATION_FACTOR / 10
    )
    return peak * 10 ** (-att_db / 20)


def loudest_key(instrument: Instrument, samples: Sequence[SampleData]) -> int:
    """A key on the zone that plays loudest at full velocity and CC1: the
    one to render for the clipping check."""
    zones = [z for z in instrument.zones if _playing_at_full(z)] or instrument.zones
    zone = max(zones, key=lambda z: _zone_output_scale(z, samples))
    lo, hi = _zone_keys(zone)
    root = _zone_gens(zone).get(GEN_OVERRIDING_ROOT_KEY, lo)
    return max(lo, min(hi, root))


def instrument_samples(instrument: Instrument) -> list[int]:
    return sorted({_zone_gens(z)[GEN_SAMPLE_ID] for z in instrument.zones})


@dataclass
class LevelTarget:
    """One levelled preset: where it is measured and what it is held to."""

    name: str
    instrument: int
    bank: int
    program: int
    note: int
    ref_bank: int
    ref_program: int


def level_targets(
    presets: Sequence[Preset],
    instruments: Sequence[Instrument],
    manifest: Sequence[dict],
) -> list[LevelTarget]:
    """Each built preset's primary slot, compared with the reference preset on
    the same program (bank 0, or the kit bank for a kit). Aliases share their
    preset's instrument and the String Ensemble is built from the section
    instruments, so neither is levelled on its own."""
    primary = {(m["bank"], m["program"]): m["name"] for m in manifest}
    targets = []
    for p in presets:
        full = primary.get((p.bank, p.program))
        if full is None or full[:20] != p.name:
            continue
        if len(p.zones) != 1:
            continue
        inst = _zone_gens(p.zones[0])[GEN_INSTRUMENT]
        drum = p.bank == 128
        targets.append(
            LevelTarget(
                name=full,
                instrument=inst,
                bank=p.bank,
                program=p.program,
                note=level_note(instruments[inst], drum),
                ref_bank=128 if drum else 0,
                ref_program=p.program,
            )
        )
    return targets


def peak_limit(data: np.ndarray, ceiling: float, rate: int) -> np.ndarray:
    """Bring every peak of ``data`` down to ``ceiling`` with a smooth gain.

    The gain curve is the per-sample need (``ceiling / |x|``, at most 1) run
    through a minimum filter of +-LIMITER_WINDOW_S, then a moving average of
    the same half-width. Every averaged value comes from minima whose windows
    include the sample it lands on, so the result never passes ``ceiling``,
    and the gain moves over about twice the window, slow enough not to
    distort a low string's waveform.
    """
    from scipy.ndimage import minimum_filter1d, uniform_filter1d

    x = np.asarray(data, dtype=np.float32)
    mag = np.abs(x)
    if not x.size or float(mag.max()) <= ceiling:
        return x
    need = np.minimum(1.0, ceiling / np.maximum(mag, 1e-12)).astype(np.float32)
    half = max(1, int(LIMITER_WINDOW_S * rate))
    held = minimum_filter1d(need, size=2 * half + 1, mode="nearest")
    gain = uniform_filter1d(held, size=2 * half + 1, mode="nearest")
    out = x * gain
    # uniform_filter1d sums in float32; a last clamp absorbs its rounding.
    return np.clip(out, -ceiling, ceiling)


def level_gains(
    targets: Sequence[LevelTarget],
    measured: dict[str, float],
    reference: dict[str, float],
    instruments: Sequence[Instrument],
    samples: Sequence[SampleData],
    max_limit_db: float,
) -> dict[str, float]:
    """The gain (dB) toward each preset's reference level that its samples
    can take: up to the point where the preset's hottest sample would need
    more than ``max_limit_db`` of peak limiting to stay under SAMPLE_CEILING.
    What is left is made up at playback (see playback_gain_db)."""
    gains = {}
    for t in targets:
        want = reference[t.name] - measured[t.name]
        peaks = [
            float(np.max(np.abs(samples[i].data)))
            for i in instrument_samples(instruments[t.instrument])
        ]
        headroom = 20 * math.log10(SAMPLE_CEILING / max(max(peaks), 1e-9))
        gains[t.name] = min(want, headroom + max_limit_db)
    return gains


def level_sample(t: LevelTarget, instruments: Sequence[Instrument]) -> int:
    """The sample the measured note plays (velocity LEVEL_VELOCITY, CC1 127)."""
    zones = [
        z
        for z in instruments[t.instrument].zones
        if _zone_keys(z)[0] <= t.note <= _zone_keys(z)[1]
        and _zone_vels(z)[0] <= LEVEL_VELOCITY <= _zone_vels(z)[1]
    ]
    playing = [
        z
        for z in zones
        if layer_attenuation_cb(z.modulators, LEVEL_CC1) < _SILENT_LAYER_CB
    ]
    zone = (playing or zones or instruments[t.instrument].zones)[-1]
    return _zone_gens(zone)[GEN_SAMPLE_ID]


def apply_level_gains(
    targets: Sequence[LevelTarget],
    gains: dict[str, float],
    instruments: Sequence[Instrument],
    samples: list[SampleData],
    limited_db: dict[int, float] | None = None,
) -> None:
    """Scale each preset's samples by its gain, peak limiting any sample the
    gain would push past SAMPLE_CEILING (``limited_db`` collects how far each
    sample was limited). A sample two presets share is scaled by the larger
    gain, and the other preset's zones attenuate the difference."""
    by_inst = {t.instrument: gains[t.name] for t in targets}
    sample_gain: dict[int, float] = {}
    for inst, gain in by_inst.items():
        for si in instrument_samples(instruments[inst]):
            sample_gain[si] = max(sample_gain.get(si, gain), gain)
    for si, gain in sample_gain.items():
        s = samples[si]
        scale = 10 ** (gain / 20)
        peak = float(np.max(np.abs(s.data))) if s.data.size else 0.0
        data = s.data
        if peak * scale > SAMPLE_CEILING:
            data = peak_limit(data, SAMPLE_CEILING / scale, s.rate)
            if limited_db is not None:
                limited_db[si] = limited_db.get(si, 0.0) + 20 * math.log10(
                    peak * scale / SAMPLE_CEILING
                )
        samples[si] = SampleData(
            s.name, data * np.float32(scale), s.rate, s.root, s.correction
        )
    for inst, gain in by_inst.items():
        for zone in instruments[inst].zones:
            gens = _zone_gens(zone)
            extra_db = sample_gain[gens[GEN_SAMPLE_ID]] - gain
            if extra_db <= 0:
                continue
            cb = gens.get(GEN_INITIAL_ATTENUATION, 0) + round(
                extra_db * 10 / EMU_ATTENUATION_FACTOR
            )
            zone.generators = [
                g for g in zone.generators if g[0] != GEN_INITIAL_ATTENUATION
            ]
            zone.generators.insert(-1, (GEN_INITIAL_ATTENUATION, min(MUTE_CB, cb)))


Measurer = Callable[[dict[str, Path], list[dict]], dict[str, dict]]


def measure_with_spessasynth(
    banks: dict[str, Path], jobs: list[dict]
) -> dict[str, dict]:
    """Render every job through SpessaSynth (``frontend/src/lib/soundbankLevels.ts``)."""
    import shutil
    import subprocess
    import tempfile

    npx = shutil.which("npx")
    if not npx or not (FRONTEND_DIR / "node_modules" / "spessasynth_core").is_dir():
        raise SystemExit(
            "levelling renders through SpessaSynth and needs Node with the frontend's "
            "node_modules; install them or pass --no-level"
        )
    with tempfile.TemporaryDirectory() as tmp:
        jobs_path = Path(tmp) / "jobs.json"
        out_path = Path(tmp) / "levels.json"
        jobs_path.write_text(
            json.dumps({"banks": {k: str(v) for k, v in banks.items()}, "jobs": jobs}),
            encoding="utf-8",
        )
        subprocess.run(
            [npx, "tsx", LEVEL_CLI, str(jobs_path), str(out_path)],
            cwd=FRONTEND_DIR,
            check=True,
        )
        return json.loads(out_path.read_text(encoding="utf-8"))


def _job(
    job_id: str, bank_key: str, bank: int, program: int, note: int, velocity: int
) -> dict:
    return {
        "id": job_id,
        "bankKey": bank_key,
        "bank": bank,
        "program": program,
        "note": note,
        "velocity": velocity,
        "cc1": LEVEL_CC1,
    }


@dataclass
class LevelRun:
    targets: list[LevelTarget]
    before: dict[str, dict]
    gains: dict[str, float]
    #: How far the measured note's sample was peak limited, in dB.
    limited_db: dict[str, float]
    passes: int
    #: How far the preset's most limited sample was peak limited, in dB.
    limited_max_db: dict[str, float]


def _preset_limited_db(
    t: LevelTarget, instruments: Sequence[Instrument], limited: dict[int, float]
) -> float:
    return max(
        (limited.get(si, 0.0) for si in instrument_samples(instruments[t.instrument])),
        default=0.0,
    )


def level_bank(
    samples: list[SampleData],
    instruments: Sequence[Instrument],
    presets: Sequence[Preset],
    manifest: Sequence[dict],
    info: dict[str, str],
    scratch: Path,
    reference: Path,
    measure: Measurer,
    max_limit_db: float = MAX_LIMIT_DB,
) -> LevelRun:
    """Level every preset against ``reference`` in the samples themselves.

    Each pass writes a PCM probe bank beside ``scratch``, renders it, and
    applies the difference to the reference. Limiting takes a little RMS
    with it, so a later pass corrects what an earlier one left; passes stop
    once every preset is within LEVEL_SETTLED_DB. ``verify_levels`` measures
    the bank that is finally written.
    """
    targets = level_targets(presets, instruments, manifest)
    probe = scratch.with_name(scratch.stem + ".level-probe.sf2")
    before: dict[str, dict] = {}
    ref: dict[str, float] = {}
    total = {t.name: 0.0 for t in targets}
    limited_by_sample: dict[int, float] = {}
    passes = 0
    for passes in range(1, LEVEL_PASSES + 1):
        write_soundfont(probe, samples, instruments, presets, info, compress=False)
        try:
            jobs = [
                _job(
                    f"ours:{t.name}", "ours", t.bank, t.program, t.note, LEVEL_VELOCITY
                )
                for t in targets
            ]
            if passes == 1:
                jobs += [
                    _job(
                        f"ref:{t.name}",
                        "ref",
                        t.ref_bank,
                        t.ref_program,
                        t.note,
                        LEVEL_VELOCITY,
                    )
                    for t in targets
                ]
            got = measure({"ours": probe, "ref": reference}, jobs)
        finally:
            probe.unlink(missing_ok=True)
        if passes == 1:
            before = got
            ref = {t.name: got[f"ref:{t.name}"]["rmsDb"] for t in targets}
        measured = {t.name: got[f"ours:{t.name}"]["rmsDb"] for t in targets}
        step = {}
        for t in targets:
            left = max_limit_db - _preset_limited_db(t, instruments, limited_by_sample)
            step[t.name] = level_gains(
                [t], measured, ref, instruments, samples, max(0.0, left)
            )[t.name]
        if passes > 1 and all(abs(v) <= LEVEL_SETTLED_DB for v in step.values()):
            break
        apply_level_gains(targets, step, instruments, samples, limited_by_sample)
        for name, v in step.items():
            total[name] += v
    limited = {
        t.name: round(limited_by_sample.get(level_sample(t, instruments), 0.0), 2)
        for t in targets
    }
    limited_max = {
        t.name: round(_preset_limited_db(t, instruments, limited_by_sample), 2)
        for t in targets
    }
    return LevelRun(targets, before, total, limited, passes, limited_max)


def playback_gain_db(shortfall_db: float, output_peak: float) -> float:
    """The gain the app applies at playback to a preset that is still
    ``shortfall_db`` under its reference: all of it, unless that would take
    the velocity-127 output ``output_peak`` past OUTPUT_PEAK_LIMIT."""
    room = 20 * math.log10(OUTPUT_PEAK_LIMIT / max(output_peak, 1e-9))
    # Rounded down, so a capped gain never lands a hair over the limit.
    return math.floor(min(shortfall_db, room) * 100 + 1e-9) / 100


def verify_levels(
    bank: Path,
    reference: Path,
    run: LevelRun,
    instruments: Sequence[Instrument],
    samples: Sequence[SampleData],
    measure: Measurer,
    presets: Sequence[Preset] = (),
) -> list[dict]:
    """Measure the written bank and return the before/after table, with the
    playback gain that makes up each preset's remaining shortfall. A String
    Ensemble split in ``presets`` gets a row of its own against the
    reference's program 48."""
    targets, before, gains = run.targets, run.before, run.gains
    jobs = []
    loud = {}
    for t in targets:
        jobs.append(
            _job(f"after:{t.name}", "ours", t.bank, t.program, t.note, LEVEL_VELOCITY)
        )
        loud[t.name] = loudest_key(instruments[t.instrument], samples)
        jobs.append(
            _job(
                f"clip:{t.name}", "ours", t.bank, t.program, loud[t.name], CLIP_VELOCITY
            )
        )
    ensemble = next(
        (p for p in presets if (p.bank, p.program) == (0, 48) and len(p.zones) > 1),
        None,
    )
    if ensemble is not None:
        for key, bank_key in (("after", "ours"), ("ref", "ref")):
            jobs.append(
                _job(
                    f"{key}:{ensemble.name}",
                    bank_key,
                    0,
                    48,
                    ENSEMBLE_NOTE,
                    LEVEL_VELOCITY,
                )
            )
    after = measure({"ours": bank, "ref": reference}, jobs)
    table = []
    for t in targets:
        ref = before[f"ref:{t.name}"]
        was = before[f"ours:{t.name}"]
        now = after[f"after:{t.name}"]
        clip = after[f"clip:{t.name}"]
        delta = now["rmsDb"] - ref["rmsDb"]
        play = playback_gain_db(-delta, clip["peak"])
        table.append(
            {
                "name": t.name,
                "bank": t.bank,
                "program": t.program,
                "note": t.note,
                "reference": {
                    "preset": ref["preset"],
                    "bank": ref["presetBank"],
                    "program": ref["presetProgram"],
                    "level_db": round(ref["rmsDb"], 2),
                },
                "before_db": round(was["rmsDb"], 2),
                "gain_db": round(gains[t.name], 2),
                "peak_limited_db": run.limited_db[t.name],
                "peak_limited_max_db": run.limited_max_db[t.name],
                "after_db": round(now["rmsDb"], 2),
                "after_minus_reference_db": round(delta, 2),
                "playback_gain_db": play,
                "played_minus_reference_db": round(delta + play, 2),
                "within_tolerance": abs(delta + play) <= LEVEL_TOLERANCE_DB,
                "played": now["preset"],
                "clip_check": {
                    "note": loud[t.name],
                    "velocity": CLIP_VELOCITY,
                    "cc1": LEVEL_CC1,
                    "output_peak": round(clip["peak"], 4),
                    "output_peak_with_playback_gain": round(
                        clip["peak"] * 10 ** (play / 20), 4
                    ),
                    "clips": clip["peak"] * 10 ** (play / 20) >= OUTPUT_PEAK_LIMIT,
                },
            }
        )
    if ensemble is not None:
        now = after[f"after:{ensemble.name}"]
        ref = after[f"ref:{ensemble.name}"]
        delta = now["rmsDb"] - ref["rmsDb"]
        members = {_zone_gens(z)[GEN_INSTRUMENT] for z in ensemble.zones}
        peak = max(
            (
                row["clip_check"]["output_peak"]
                for row, t in zip(table, targets)
                if t.instrument in members
            ),
            default=0.0,
        )
        play = playback_gain_db(-delta, peak)
        table.append(
            {
                "name": ensemble.name,
                "bank": 0,
                "program": 48,
                "note": ENSEMBLE_NOTE,
                "reference": {
                    "preset": ref["preset"],
                    "bank": ref["presetBank"],
                    "program": ref["presetProgram"],
                    "level_db": round(ref["rmsDb"], 2),
                },
                "before_db": None,
                "gain_db": 0.0,
                "peak_limited_db": 0.0,
                "peak_limited_max_db": 0.0,
                "after_db": round(now["rmsDb"], 2),
                "after_minus_reference_db": round(delta, 2),
                "playback_gain_db": play,
                "played_minus_reference_db": round(delta + play, 2),
                "within_tolerance": abs(delta + play) <= LEVEL_TOLERANCE_DB,
                "played": now["preset"],
                "clip_check": {
                    "note": None,
                    "velocity": CLIP_VELOCITY,
                    "cc1": LEVEL_CC1,
                    "output_peak": round(peak, 4),
                    "output_peak_with_playback_gain": round(
                        peak * 10 ** (play / 20), 4
                    ),
                    "clips": peak * 10 ** (play / 20) >= OUTPUT_PEAK_LIMIT,
                },
            }
        )
    return table


def playback_gain_table(
    levels: Sequence[dict], manifest: Sequence[dict]
) -> dict[str, float]:
    """``{"bank:program": dB}`` for every preset slot, aliases included: what
    the app adds at playback (frontend/src/lib/soundbankGain.ts)."""
    by_name = {row["name"]: row["playback_gain_db"] for row in levels}
    out: dict[str, float] = {}
    for m in manifest:
        gain = by_name.get(m["name"])
        if gain is None:
            continue
        for bank, program in [(m["bank"], m["program"]), *m.get("aliases", [])]:
            out[f"{bank}:{program}"] = gain
    return dict(
        sorted(out.items(), key=lambda kv: tuple(int(x) for x in kv[0].split(":")))
    )


def attribution_text(snaps: Sequence[RepoSnapshot]) -> str:
    lines = [
        "theDAW Orchestra - sample sources",
        "",
        "Every sample in this bank comes from a CC0 1.0 (public domain) library.",
        "No attribution is required; the credit below is given as the authors ask.",
        "",
    ]
    for snap in snaps:
        s = snap.source
        lines += [
            f"{s.title}",
            f"  {s.homepage} (commit {snap.commit})",
            f"  Licence: {s.licence} {s.licence_url}",
            f"  Credit: {s.credit}",
            "",
        ]
    return "\n".join(lines)


def build(args: argparse.Namespace) -> int:
    started = time.monotonic()
    cache = Path(args.cache).expanduser().resolve()
    specs = select_presets(args.section, args.preset)
    needed_sources = sorted({p.source for p in specs})
    snaps = {key: snapshot(SOURCES[key], cache) for key in needed_sources}
    for snap in snaps.values():
        log.info("%s at %s", snap.source.repo, snap.commit[:10])

    def load_sfz(name: str) -> str:
        return fetch(cache, snaps["vsco"], name).read_text(
            encoding="utf-8", errors="replace"
        )

    def list_files(folder: str) -> list[str]:
        prefix = folder.rstrip("/") + "/"
        return [
            p[len(prefix) :]
            for p in snaps["vcsl"].blobs
            if p.startswith(prefix) and "/" not in p[len(prefix) :]
        ]

    planned = plan_presets(specs, load_sfz, list_files, args.cc1_level_db)
    wanted: list[tuple[str, str]] = sorted(
        {(pp.spec.source, z.region.sample) for pp in planned for z in pp.zones}
    )
    missing = [p for src, p in wanted if p not in snaps[src].blobs]
    if missing:
        raise SystemExit(
            "samples named by the mapping are not in the repository:\n  "
            + "\n  ".join(missing)
        )
    to_fetch = [(src, p) for src, p in wanted if not is_cached(cache, snaps[src], p)]
    fetch_bytes = sum(snaps[src].blobs[p][1] for src, p in to_fetch)
    total_bytes = sum(snaps[src].blobs[p][1] for src, p in wanted)
    log.info(
        "%d presets, %d samples (%.0f MB), %d to download (%.0f MB)",
        len(specs),
        len(wanted),
        total_bytes / 1e6,
        len(to_fetch),
        fetch_bytes / 1e6,
    )
    if args.dry_run:
        return 0
    if fetch_bytes > args.max_download_mb * 1e6:
        raise SystemExit(
            f"this build downloads {fetch_bytes / 1e6:.0f} MB, over --max-download-mb "
            f"{args.max_download_mb}; raise the limit or pick fewer --section/--preset"
        )
    fetch_started = time.monotonic()
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        for i, _ in enumerate(
            pool.map(lambda sp: fetch(cache, snaps[sp[0]], sp[1]), to_fetch), 1
        ):
            if i % 25 == 0 or i == len(to_fetch):
                log.info("downloaded %d/%d", i, len(to_fetch))
    fetch_seconds = time.monotonic() - fetch_started

    def load_audio(spec: PresetSpec, path: str) -> tuple[np.ndarray, int]:
        data, rate = sf.read(
            cached_path(cache, snaps[spec.source], path),
            dtype="float32",
            always_2d=False,
        )
        return data, rate

    encode_started = time.monotonic()
    samples, instruments, presets, manifest = assemble(planned, load_audio)
    out = Path(args.out).resolve()
    used = [snaps[k] for k in needed_sources]
    info = {
        "INAM": args.name,
        "ICRD": time.strftime("%Y-%m-%d"),
        "IENG": "theDAW scripts/build_orchestra_sf3.py",
        "IPRD": "theDAW",
        "ICOP": "CC0 1.0. Samples: Versilian Studios (VSCO 2 CE, VCSL).",
        "ICMT": (
            "Sustained presets crossfade their dynamic layers on CC1 (mod wheel). "
            "Banks: 0 sustain, 1 staccato/spiccato, 2 pizzicato, 3 tremolo/roll, "
            "4 alternate sustain, 5 straight mute, 6 swell, 7 harmon mute, 8-11 solo violin, "
            "128 kit. Sources: "
            + ", ".join(f"{s.source.repo}@{s.commit[:10]}" for s in used)
        ),
        "ISFT": "theDAW build_orchestra_sf3",
    }
    level_seconds = 0.0
    levelled = None
    if not args.no_level:
        level_started = time.monotonic()
        reference = Path(args.reference).resolve()
        levelled = level_bank(
            samples,
            instruments,
            presets,
            manifest,
            info,
            out,
            reference,
            measure_with_spessasynth,
            args.max_limit_db,
        )
        level_seconds += time.monotonic() - level_started
    size = write_soundfont(
        out,
        samples,
        instruments,
        presets,
        info,
        compress=not args.sf2,
        compression=args.compression,
    )
    levels: list[dict] = []
    if levelled is not None:
        verify_started = time.monotonic()
        levels = verify_levels(
            out,
            Path(args.reference).resolve(),
            levelled,
            instruments,
            samples,
            measure_with_spessasynth,
            presets,
        )
        level_seconds += time.monotonic() - verify_started
        for row in levels:
            log.info(
                "level %-24s ref %-20s %6.1f  before %6s  gain %+5.1f  limit %4.1f  "
                "after %6.1f  playback %+5.1f  played %+.1f%s",
                row["name"],
                (row["reference"]["preset"] or "?")[:20],
                row["reference"]["level_db"],
                "-" if row["before_db"] is None else f"{row['before_db']:.1f}",
                row["gain_db"],
                row["peak_limited_max_db"],
                row["after_db"],
                row["playback_gain_db"],
                row["played_minus_reference_db"],
                "" if row["within_tolerance"] else "  OUT OF TOLERANCE",
            )
            if row["clip_check"]["clips"]:
                log.warning(
                    "level %s clips at velocity 127 with its playback gain: peak %s",
                    row["name"],
                    row["clip_check"]["output_peak_with_playback_gain"],
                )
    encode_seconds = time.monotonic() - encode_started - level_seconds
    total_seconds = time.monotonic() - started
    manifest_doc = {
        "name": args.name,
        "file": out.name,
        "format": "sf2" if args.sf2 else "sf3",
        "size_bytes": size,
        "sha256": hashlib.sha256(out.read_bytes()).hexdigest(),
        "built": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "licence": "CC0-1.0",
        "sources": [
            {
                "repo": s.source.repo,
                "commit": s.commit,
                "homepage": s.source.homepage,
                "licence": s.source.licence,
                "credit": s.source.credit,
            }
            for s in used
        ],
        "cc1_crossfade_cb": XFADE_CB,
        "cc1_level_db": args.cc1_level_db,
        "samples": len(samples),
        "sample_peak_max": round(
            max(float(np.max(np.abs(s.data))) for s in samples), 3
        ),
        "playback_gain": playback_gain_table(levels, manifest) if levels else {},
        "levelling": {
            "reference": Path(args.reference).name,
            "method": (
                f"loudest 100 ms RMS of a held note, velocity {LEVEL_VELOCITY}, CC1 "
                f"{LEVEL_CC1}, rendered by SpessaSynth; reference preset on the same "
                f"program; tolerance {LEVEL_TOLERANCE_DB} dB; clip check at velocity "
                f"{CLIP_VELOCITY} on each preset's loudest zone"
            ),
            "passes": levelled.passes if levelled else 0,
            "max_limit_db": args.max_limit_db,
            "presets": levels,
            "out_of_tolerance": [
                r["name"] for r in levels if not r["within_tolerance"]
            ],
            "clipping": [r["name"] for r in levels if r["clip_check"]["clips"]],
            "short_after_playback_gain": [
                r["name"]
                for r in levels
                if r["played_minus_reference_db"] < -LEVEL_TOLERANCE_DB
            ],
        }
        if levels
        else None,
        "source_bytes": total_bytes,
        "timing_s": {
            "download": round(fetch_seconds, 1),
            "encode_and_write": round(encode_seconds, 1),
            "levelling": round(level_seconds, 1),
            "total": round(total_seconds, 1),
        },
        "presets": manifest,
    }
    out.with_suffix(".json").write_text(
        json.dumps(manifest_doc, indent=2), encoding="utf-8"
    )
    out.with_name(out.stem + "-ATTRIBUTION.txt").write_text(
        attribution_text(used), encoding="utf-8"
    )
    log.info(
        "wrote %s: %.1f MB, %d presets, %d samples; download %.0fs, encode %.0fs, total %.0fs",
        out,
        size / 1e6,
        len(presets),
        len(samples),
        fetch_seconds,
        encode_seconds,
        total_seconds,
    )
    return 0


def curve_report() -> str:
    """The gain each layer plays at across CC1, for eyeballing the fades."""
    rows = ["cc1  " + "  ".join(f"{n}L:{i}" for n in (2, 3) for i in range(n))]
    for cc in sorted({*range(0, 128, 8), 63, 64, 65, 127}):
        cells = []
        for n in (2, 3):
            for i in range(n):
                cb = layer_attenuation_cb(cc1_layer_modulators(i, n), cc)
                cells.append(f"{-cb / 10:6.1f}")
        rows.append(f"{cc:4d} " + " ".join(cells))
    return (
        "\n".join(rows) + "\n(dB per layer; columns: 2-layer p,f then 3-layer p,mf,f)"
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--out", default="build/theDAW-Orchestra.sf3", help="output bank path"
    )
    parser.add_argument(
        "--name", default="theDAW Orchestra", help="bank name (INFO INAM)"
    )
    parser.add_argument(
        "--cache", default=str(default_cache_dir()), help="sample cache directory"
    )
    parser.add_argument(
        "--section", action="append", choices=SECTIONS, help="build only this section"
    )
    parser.add_argument(
        "--preset", action="append", help="build only this preset (by name)"
    )
    parser.add_argument("--max-download-mb", type=float, default=1000.0)
    parser.add_argument("--jobs", type=int, default=8, help="parallel downloads")
    parser.add_argument(
        "--cc1-level-db",
        type=float,
        default=CC1_LEVEL_DB,
        help="how much quieter CC1 presets play at CC1 = 0 than at 127",
    )
    parser.add_argument(
        "--compression",
        type=float,
        default=0.5,
        help="Vorbis compression level, 0 (best quality) to 1 (smallest)",
    )
    parser.add_argument(
        "--sf2", action="store_true", help="write 16-bit PCM SF2 instead of SF3"
    )
    parser.add_argument(
        "--no-level",
        action="store_true",
        help="skip levelling against the reference bank (needs Node + frontend node_modules)",
    )
    parser.add_argument(
        "--reference",
        default=str(REFERENCE_BANK),
        help="bank each preset is levelled against (default: the bundled gm.sf3)",
    )
    parser.add_argument(
        "--max-limit-db",
        type=float,
        default=MAX_LIMIT_DB,
        help="most peak limiting levelling may apply to a sample, in dB",
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="plan and size the build only"
    )
    parser.add_argument("--list", action="store_true", help="list the presets and exit")
    parser.add_argument(
        "--curves", action="store_true", help="print the CC1 fade table and exit"
    )
    parser.add_argument(
        "--inspect", metavar="BANK", help="print a bank's presets and exit"
    )
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    if args.list:
        for p in PRESETS:
            print(
                f"{p.bank:3d}:{p.program:<3d} {p.section:<10} {p.name:<24} {p.mode:<8} {p.sfz or p.files.folder}"
            )
        return 0
    if args.curves:
        print(curve_report())
        return 0
    if args.inspect:
        bank = read_soundfont(Path(args.inspect))
        print(f"version {bank['version']}, {len(bank['samples'])} samples")
        for p in bank["presets"]:
            print(f"{p['bank']:3d}:{p['program']:<3d} {p['name']}")
        return 0
    return build(args)


if __name__ == "__main__":
    sys.exit(main())
