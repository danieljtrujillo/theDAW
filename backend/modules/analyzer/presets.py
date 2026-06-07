"""Reference profiles, platform targets, and variant adjustments.

These are the static knowledge tables that the recommender and stack_builder
consult when mapping analysis results to concrete tool parameters.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Platform loudness targets
# ---------------------------------------------------------------------------
# Mirrors delivery/router.py PRESETS but adds LRA (loudness range) targets
# that the delivery module doesn't track. The analyzer needs LRA to decide
# whether dynamics processing is needed.

PLATFORM_TARGETS: dict[str, dict] = {
    "spotify": {"lufs": -14, "tp": -2, "lra": 7},
    "apple": {"lufs": -16, "tp": -1, "lra": 11},
    "youtube": {"lufs": -14, "tp": -1, "lra": 9},
    "tidal": {"lufs": -14, "tp": -1, "lra": 9},
    "amazon": {"lufs": -14, "tp": -2, "lra": 7},
    "soundcloud": {"lufs": -14, "tp": -2, "lra": 7},
    "club": {"lufs": -8, "tp": -0.1, "lra": 5},
    "cd": {"lufs": -14, "tp": -0.3, "lra": 8},
    "podcast": {"lufs": -16, "tp": -1, "lra": 11},
    "universal": {"lufs": -14, "tp": -2, "lra": 9},
}

# ---------------------------------------------------------------------------
# Genre reference profiles
# ---------------------------------------------------------------------------
# These describe the "ideal" tonal/dynamic characteristics for a genre.
# The recommender compares measured descriptors against these to detect
# deviations that warrant correction.
#
# Fields:
#   centroid_target  – expected spectral centroid (Hz)
#   low_tilt         – expected low-frequency emphasis vs flat (dB)
#   dynamic_range    – expected LRA (LU)
#   crest_factor     – expected crest factor (dB)
#   compression_ratio – typical bus compression ratio
#   transient_class  – expected transient character
#   stereo_width     – expected stereo width (0-1 normalized)
#   warmth           – expected perceptual warmth (0-1)
#   brightness       – expected perceptual brightness (0-1)

GENRE_PROFILES: dict[str, dict] = {
    "pop": {
        "centroid_target": 3000,
        "low_tilt": 0,
        "dynamic_range": 8,
        "crest_factor": 10,
        "compression_ratio": 3.0,
        "transient_class": "moderate",
        "stereo_width": 0.75,
        "warmth": 0.5,
        "brightness": 0.65,
    },
    "rock": {
        "centroid_target": 2800,
        "low_tilt": 1,
        "dynamic_range": 9,
        "crest_factor": 12,
        "compression_ratio": 3.5,
        "transient_class": "aggressive",
        "stereo_width": 0.7,
        "warmth": 0.55,
        "brightness": 0.6,
    },
    "edm": {
        "centroid_target": 3500,
        "low_tilt": 2,
        "dynamic_range": 6,
        "crest_factor": 8,
        "compression_ratio": 4.0,
        "transient_class": "aggressive",
        "stereo_width": 0.85,
        "warmth": 0.4,
        "brightness": 0.75,
    },
    "jazz": {
        "centroid_target": 2200,
        "low_tilt": -1,
        "dynamic_range": 14,
        "crest_factor": 18,
        "compression_ratio": 1.5,
        "transient_class": "soft",
        "stereo_width": 0.6,
        "warmth": 0.65,
        "brightness": 0.45,
    },
    "classical": {
        "centroid_target": 2000,
        "low_tilt": -1,
        "dynamic_range": 16,
        "crest_factor": 20,
        "compression_ratio": 1.2,
        "transient_class": "soft",
        "stereo_width": 0.8,
        "warmth": 0.6,
        "brightness": 0.4,
    },
    "hiphop": {
        "centroid_target": 2600,
        "low_tilt": 3,
        "dynamic_range": 7,
        "crest_factor": 10,
        "compression_ratio": 3.5,
        "transient_class": "aggressive",
        "stereo_width": 0.65,
        "warmth": 0.6,
        "brightness": 0.55,
    },
    "rnb": {
        "centroid_target": 2400,
        "low_tilt": 2,
        "dynamic_range": 8,
        "crest_factor": 11,
        "compression_ratio": 2.5,
        "transient_class": "moderate",
        "stereo_width": 0.7,
        "warmth": 0.7,
        "brightness": 0.5,
    },
    "metal": {
        "centroid_target": 3200,
        "low_tilt": 1,
        "dynamic_range": 6,
        "crest_factor": 8,
        "compression_ratio": 5.0,
        "transient_class": "aggressive",
        "stereo_width": 0.75,
        "warmth": 0.35,
        "brightness": 0.7,
    },
    "ambient": {
        "centroid_target": 1800,
        "low_tilt": 0,
        "dynamic_range": 18,
        "crest_factor": 22,
        "compression_ratio": 1.0,
        "transient_class": "soft",
        "stereo_width": 0.9,
        "warmth": 0.7,
        "brightness": 0.35,
    },
    "folk": {
        "centroid_target": 2400,
        "low_tilt": 0,
        "dynamic_range": 12,
        "crest_factor": 16,
        "compression_ratio": 1.8,
        "transient_class": "moderate",
        "stereo_width": 0.55,
        "warmth": 0.65,
        "brightness": 0.5,
    },
}

# ---------------------------------------------------------------------------
# Stack variant adjustments
# ---------------------------------------------------------------------------
# These modify the default tool parameters when building a stack.
#
# Fields:
#   lufs_offset       – dB offset from platform target LUFS
#   compression_ratio – base compression ratio for dynamics stage
#   lra_target        – target loudness range (LU)
#   attack_emphasis   – transient shaper attack amount (0-1)
#   sustain_emphasis   – transient shaper sustain amount (0-1)
#   eq_strength       – multiplier on corrective EQ gains
#   exciter_amount    – harmonic exciter drive (0 = off)
#   ceiling_dbtp      – true-peak limiter ceiling
#   confidence_threshold – minimum card confidence to include in stack

VARIANT_ADJUSTMENTS: dict[str, dict] = {
    "transparent": {
        "lufs_offset": -2,
        "compression_ratio": 1.5,
        "lra_target": 11,
        "attack_emphasis": 0.0,
        "sustain_emphasis": 0.0,
        "eq_strength": 0.7,
        "exciter_amount": 0.0,
        "ceiling_dbtp": -1.0,
        "confidence_threshold": 0.7,
    },
    "punchy": {
        "lufs_offset": 0,
        "compression_ratio": 3.0,
        "lra_target": 8,
        "attack_emphasis": 0.4,
        "sustain_emphasis": -0.1,
        "eq_strength": 1.0,
        "exciter_amount": 2.0,
        "ceiling_dbtp": -1.0,
        "confidence_threshold": 0.5,
    },
    "loud": {
        "lufs_offset": 4,
        "compression_ratio": 5.0,
        "lra_target": 5,
        "attack_emphasis": 0.2,
        "sustain_emphasis": 0.3,
        "eq_strength": 1.2,
        "exciter_amount": 4.0,
        "ceiling_dbtp": -0.3,
        "confidence_threshold": 0.3,
    },
    "reference": {
        "lufs_offset": 0,
        "compression_ratio": 2.0,
        "lra_target": 9,
        "attack_emphasis": 0.0,
        "sustain_emphasis": 0.0,
        "eq_strength": 1.0,
        "exciter_amount": 0.0,
        "ceiling_dbtp": -1.0,
        "confidence_threshold": 0.4,
    },
}

# ---------------------------------------------------------------------------
# Tool → stage mapping
# ---------------------------------------------------------------------------
# Maps each tool id to its position in the 6-stage construction order.
# Used by stack_builder to sort the chain correctly.

TOOL_STAGE_MAP: dict[str, str] = {
    # Stage 1: Repair / cleanup
    "neural_denoise": "repair",
    "declip": "repair",
    "dehum": "repair",
    "declick": "repair",
    "breath_remove": "repair",
    # Stage 2: Corrective tone
    "parametric_eq": "corrective_tone",
    "dynamic_eq": "corrective_tone",
    "match_eq": "corrective_tone",
    "spectral_stabilizer": "corrective_tone",
    # Stage 3: Dynamics control
    "multiband_dynamics": "dynamics",
    "transient_shaper": "dynamics",
    # Stage 4: Character / saturation
    "harmonic_exciter": "character",
    # Stage 5: Spatial / stereo
    "stereo_imager": "spatial",
    # Stage 6: Safety / loudness / output
    "maximizer": "output",
    "loudness_meter": "output",
    "smart_export": "output",
}

# Ordered stage list for sorting
STAGE_ORDER: list[str] = [
    "repair",
    "corrective_tone",
    "dynamics",
    "character",
    "spatial",
    "output",
]
