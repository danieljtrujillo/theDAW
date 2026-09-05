"""Shared TypedDict contracts for the Chimera v2 mashup engine.

This module holds NO logic and imports nothing at runtime beyond ``typing``.
Every v2 module (analysis, tempo, harmony, arrange, conform, render, master,
stems, router) codes against these shapes, so treat them as frozen.

Three timebases appear throughout. Every float that is a time in seconds is
in exactly one of them; the field comments say which:

* ``SOURCE``    — seconds in the normalized clip BEFORE any tempo conform.
                  ``ClipAnalysis.beats``, ``BarFeature.start_sec``,
                  ``Phrase.start_sec/end_sec`` and ``Run.src_*`` live here.
* ``CONFORMED`` — ``SOURCE / ratio`` (what v1 called "stretched"). This is
                  the clip's own timeline after stretching to the target
                  tempo. ``Placement.window_*`` lives here.
* ``OUTPUT``    — the mashup timeline. ``Placement.output_*``,
                  ``Run.output_*``, ``Seam.sec`` and ``RunAudio.t0_sec``
                  live here.

All seconds are ``float``; all indices are ``int``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal, Optional, TypedDict

if TYPE_CHECKING:  # pragma: no cover - typing only
    import numpy as np

Lane = Literal["lead", "support"]
Role = Literal["full", "hp", "stem_found", "stem_layer"]
Transition = Literal["blend", "cut", "fade"]
SeamKind = Literal["lead_switch", "drop", "support_in", "support_out"]
Arc = Literal["song", "rise", "flat"]


class BeatGrid(TypedDict):
    period_sec: float  # fitted inter-beat interval (SOURCE time)
    phase_sec: float  # time of beat index 0 on the fitted line (SOURCE)
    drift_pct: float  # |fitted period / nominal period - 1| * 100
    cv: float  # coefficient of variation of inter-beat intervals after outlier removal
    confidence: float  # 1 - cv, clamped [0, 1]; 0 when < 8 beats
    kept_beats: list[float]  # beats that survived outlier removal (SOURCE time)
    steady: bool  # cv <= 0.08


class BarFeature(TypedDict):
    bar: int
    start_sec: float  # SOURCE time, downbeat-phase corrected
    rms_db: float
    low_frac: float
    onset_density: float
    centroid_hz: float
    chroma: list[float]  # 12 (mean over the bar)
    mfcc: list[float]  # 13 (mean over the bar)


class Phrase(TypedDict):
    idx: int
    start_bar: int
    bars: int
    start_sec: float  # SOURCE (pre-conform) seconds
    end_sec: float  # SOURCE (pre-conform) seconds
    lufs: float  # integrated (>= 3 s) or RMS dBFS fallback
    energy: float  # 0..1, normalised ACROSS the stack by arrange.normalize_energy
    low_frac: float
    onset_density: float
    centroid_hz: float
    section_label: Literal["intro", "build", "peak", "body", "outro"]


class ClipAnalysis(TypedDict):
    bpm: Optional[float]
    beats: list[float]  # SOURCE time
    confidence: float
    duration_sec: float
    samplerate: int
    key: Optional[str]
    scale: Optional[str]
    key_confidence: Optional[float]
    key_strength: Optional[float]
    lufs: float
    percussive_ratio: float
    low_band_fraction: float
    grid: Optional[BeatGrid]
    downbeat_phase: int
    downbeat_confidence: float
    phrase_phase: int
    phrase_confidence: float
    bars: list[BarFeature]
    tonal: bool
    source: Literal["client", "cache", "computed", "mixed"]


class ConformPlan(TypedDict):
    ratio: float
    tempo_multiplier: float
    semitones: int
    rb_options: dict[str, str]
    preset: Literal["percussive", "tonal", "default"]
    lock: bool
    note: Optional[str]


class Placement(TypedDict):
    # v1 keys (identical semantics; window_* in the CONFORMED clip timebase
    # = source / ratio)
    output_start_sec: float  # OUTPUT; AUDIBLE span incl. pre/post-roll
    output_end_sec: float  # OUTPUT; AUDIBLE span incl. pre/post-roll
    window_start_sec: float  # CONFORMED
    window_end_sec: float  # CONFORMED
    chunk_idx: int
    rms: float
    # v2 additive
    clip: int
    phrase_idx: int
    lane: Lane
    role: Role
    run_id: int
    gain_db: float
    fade_in_sec: float
    fade_out_sec: float
    nominal_start_sec: float  # OUTPUT; slot edges without tails
    nominal_end_sec: float  # OUTPUT; slot edges without tails


class Run(TypedDict):
    run_id: int
    clip: int
    lane: Lane
    role: Role
    first_phrase: int
    last_phrase: int
    output_start_sec: float  # OUTPUT; nominal (slot edges)
    output_end_sec: float  # OUTPUT; nominal (slot edges)
    src_start_sec: float  # SOURCE time of the phrases
    src_end_sec: float  # SOURCE time of the phrases
    fade_in_sec: float  # tail: audio before output_start
    fade_out_sec: float  # tail: audio after output_end
    gain_db: float


class Seam(TypedDict):
    sec: float  # OUTPUT
    kind: SeamKind
    transition: Transition
    bars: float
    heal_start_sec: float  # OUTPUT
    heal_end_sec: float  # OUTPUT
    clips: list[int]
    lanes: list[Lane]


class Section(TypedDict):
    start_sec: float  # OUTPUT
    end_sec: float  # OUTPUT
    label: str
    target_energy: float


class Schedule(TypedDict):
    total_sec: float
    total_bars: int
    bar_sec: float
    beat_sec: float
    phrase_bars: int
    n_slots: int
    slot_bars: list[int]
    contour: list[float]
    density: list[int]
    lead_by_slot: list[int]
    runs: list[Run]
    placements: list[Placement]
    seams: list[Seam]
    sections: list[Section]
    warnings: list[str]


class RunAudio(TypedDict):
    run_id: int
    kind: Literal["full", "found", "layer"]
    audio: "np.ndarray"  # [N, 2] float32 at out_sr, CONFORMED and grid-locked
    t0_sec: float  # OUTPUT-timeline time of audio[0] (= output_start_sec - margin_sec)
    locked: bool
    lock_report: dict
