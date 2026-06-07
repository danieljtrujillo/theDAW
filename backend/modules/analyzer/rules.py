"""
Deterministic rule engine for the audio analyzer module.

Takes a descriptor bundle (output of descriptors.py) and produces candidate
decision cards with confidence scores, evidence, and alternative actions.

Each rule evaluates specific audio characteristics against thresholds and
reference values, producing structured decision cards that downstream
components (recommender.py, stack_builder.py) consume.

Confidence formula:
    confidence = evidence_quality * detector_reliability * context_fit * consensus
"""

from __future__ import annotations

from typing import Any

# ---------------------------------------------------------------------------
# Valid tool IDs from the 49-tool backend
# ---------------------------------------------------------------------------
TOOL_IDS = frozenset(
    {
        "parametric_eq",
        "multiband_dynamics",
        "maximizer",
        "stereo_imager",
        "harmonic_exciter",
        "transient_shaper",
        "neural_denoise",
        "dehum",
        "deess",
        "declick",
        "declip",
        "dereverb",
        "vocal_isolate",
    }
)

# ---------------------------------------------------------------------------
# Default platform targets (LUFS)
# ---------------------------------------------------------------------------
PLATFORM_TARGETS: dict[str, float] = {
    "spotify": -14.0,
    "apple": -16.0,
    "youtube": -14.0,
    "amazon": -14.0,
    "tidal": -14.0,
    "soundcloud": -14.0,
    "broadcast": -24.0,
    "cinema": -27.0,
    "podcast": -16.0,
}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _clamp(value: float, lo: float = 0.0, hi: float = 1.0) -> float:
    """Clamp *value* between *lo* and *hi*."""
    return max(lo, min(hi, value))


def _confidence(
    evidence_quality: float,
    detector_reliability: float,
    context_fit: float,
    consensus: float,
) -> tuple[float, dict[str, float]]:
    """Return (overall_confidence, breakdown_dict) from four factors."""
    eq = _clamp(evidence_quality)
    dr = _clamp(detector_reliability)
    cf = _clamp(context_fit)
    co = _clamp(consensus)
    score = eq * dr * cf * co
    breakdown = {
        "evidence_quality": round(eq, 3),
        "detector_reliability": round(dr, 3),
        "context_fit": round(cf, 3),
        "consensus": round(co, 3),
    }
    return round(score, 4), breakdown


def _safe_get(data: dict, *keys: str, default: Any = None) -> Any:
    """Safely traverse nested dicts."""
    current = data
    for key in keys:
        if not isinstance(current, dict):
            return default
        current = current.get(key, default)
        if current is default:
            return default
    return current


def _artifact(descriptors: dict, name: str) -> dict:
    """Return an artifact flag sub-dict, defaulting to not-detected."""
    return _safe_get(
        descriptors, "high_level", "artifact_flags", name, default={"detected": False}
    )


def _severity_above(descriptors: dict, artifact_name: str, threshold: float) -> bool:
    """Check if an artifact's severity exceeds *threshold*."""
    af = _artifact(descriptors, artifact_name)
    return af.get("detected", False) and af.get("severity", 0) > threshold


def _source_is(descriptors: dict, target: dict | None, *types: str) -> bool:
    """True if the source type (from target override or descriptors) matches."""
    if target and target.get("source_type") in types:
        return True
    src = _safe_get(descriptors, "high_level", "source_type", default="")
    return src in types


def _vocal_prior(descriptors: dict) -> float:
    """Return the vocal instrument prior probability."""
    return _safe_get(
        descriptors, "high_level", "instrument_priors", "vocal", default=0.0
    )


def _target_lufs(target: dict | None) -> float:
    """Resolve the target LUFS from the target dict or default to -14."""
    if target:
        explicit = target.get("target_lufs")
        if explicit is not None:
            return float(explicit)
        platform = target.get("platform", "")
        if platform in PLATFORM_TARGETS:
            return PLATFORM_TARGETS[platform]
    return -14.0


# ---------------------------------------------------------------------------
# Individual rule functions
#
# Each returns a decision card dict or None if the rule does not fire.
# ---------------------------------------------------------------------------


def _rule_low_end_excess(descriptors: dict, target: dict | None) -> dict | None:
    """Rule 1 -- Low-end excess / muddiness.

    Triggers when: low band energy is above reference, centroid is low,
    and crest factor in lows is elevated.
    """
    band_energies = _safe_get(descriptors, "low_level", "band_energies_db", default={})
    low_energy = band_energies.get("low", -999)
    low_mid_energy = band_energies.get("low_mid", -999)
    band_energies.get("sub", -999)
    centroid = _safe_get(descriptors, "low_level", "spectral_centroid_hz", default=5000)
    crest = _safe_get(descriptors, "low_level", "crest_factor_db", default=0)
    _safe_get(descriptors, "high_level", "perceptual", "boxiness", default=0)
    _safe_get(descriptors, "high_level", "perceptual", "warmth", default=0.5)
    bloom = _artifact(descriptors, "low_end_bloom")

    # Thresholds
    low_excess = low_energy > -10  # band energy above -10 dB is high
    low_mid_excess = low_mid_energy > -8
    low_centroid = centroid < 2000
    high_crest = crest > 15

    # Need at least two conditions
    signals = sum([low_excess, low_mid_excess, low_centroid, high_crest])
    if signals < 2 and not bloom.get("detected", False):
        return None

    # Determine cut frequency based on where excess is
    if low_mid_excess and low_excess:
        cut_freq = 200
        cut_gain = -3.0
    elif low_excess:
        cut_freq = 150
        cut_gain = -2.5
    else:
        cut_freq = 250
        cut_gain = -2.0

    evidence_parts = []
    if low_excess:
        evidence_parts.append(f"low band energy {low_energy:.1f} dB (elevated)")
    if low_mid_excess:
        evidence_parts.append(f"low-mid energy {low_mid_energy:.1f} dB (elevated)")
    if low_centroid:
        evidence_parts.append(f"spectral centroid {centroid:.0f} Hz (low)")
    if high_crest:
        evidence_parts.append(f"crest factor {crest:.1f} dB (high in lows)")
    if bloom.get("detected"):
        evidence_parts.append("low-end bloom artifact flagged")

    evidence_quality = _clamp(signals / 4.0 + 0.3)
    detector_reliability = 0.85
    context_fit = 0.9 if not _source_is(descriptors, target, "drums") else 0.7
    consensus = _clamp(
        0.5 + (signals - 2) * 0.15 + (0.1 if bloom.get("detected") else 0)
    )

    conf, breakdown = _confidence(
        evidence_quality, detector_reliability, context_fit, consensus
    )

    return {
        "id": "low_end_excess",
        "priority": 2,
        "confidence": conf,
        "problem": "Low-end excess and muddiness detected in the 120-250 Hz region",
        "evidence": "; ".join(evidence_parts),
        "action": {
            "tool": "parametric_eq",
            "params": {
                "lowShelfFreq": cut_freq,
                "lowShelfGain": cut_gain,
                "lowShelfQ": 0.7,
            },
            "description": f"Low-shelf cut at {cut_freq} Hz, {cut_gain} dB",
        },
        "alternatives": [
            {
                "tool": "multiband_dynamics",
                "description": "Multiband compression on low band (below 250 Hz) to control excess energy",
            },
        ],
        "confidence_breakdown": breakdown,
    }


def _rule_vocal_plosives(descriptors: dict, target: dict | None) -> dict | None:
    """Rule 2 -- Vocal plosives.

    Triggers when: transient spikes below 120 Hz detected alongside
    speech/singing prior.
    """
    vocal_prior = _vocal_prior(descriptors)
    if vocal_prior < 0.3:
        return None

    # Look for sub-band transient energy (proxy: high sub energy + onset density)
    sub_energy = _safe_get(
        descriptors, "low_level", "band_energies_db", "sub", default=-999
    )
    onset_density = _safe_get(
        descriptors, "mid_level", "onset_density_per_sec", default=0
    )
    crest = _safe_get(descriptors, "low_level", "crest_factor_db", default=0)

    # Plosives produce transient spikes in sub/low band
    sub_spike = sub_energy > -20
    transient_dense = onset_density > 2.0
    high_crest = crest > 14

    signals = sum([sub_spike, transient_dense, high_crest])
    if signals < 2:
        return None

    evidence_parts = []
    if sub_spike:
        evidence_parts.append(
            f"sub-band energy {sub_energy:.1f} dB (elevated for vocal)"
        )
    if transient_dense:
        evidence_parts.append(f"onset density {onset_density:.1f}/sec")
    if high_crest:
        evidence_parts.append(f"crest factor {crest:.1f} dB")
    evidence_parts.append(f"vocal prior {vocal_prior:.0%}")

    evidence_quality = _clamp(0.5 + signals * 0.15)
    detector_reliability = 0.7  # indirect detection (no explicit plosive detector)
    context_fit = _clamp(vocal_prior)
    consensus = _clamp(0.5 + (signals - 2) * 0.2)

    conf, breakdown = _confidence(
        evidence_quality, detector_reliability, context_fit, consensus
    )

    return {
        "id": "vocal_plosives",
        "priority": 2,
        "confidence": conf,
        "problem": "Vocal plosive transients detected (low-frequency bursts below 120 Hz)",
        "evidence": "; ".join(evidence_parts),
        "action": {
            "tool": "parametric_eq",
            "params": {
                "highPassFreq": 80,
                "highPassSlope": 12,
                "dynamicHP": True,
            },
            "description": "Clip gain reduction + dynamic high-pass filter at 80 Hz",
        },
        "alternatives": [
            {
                "tool": "multiband_dynamics",
                "description": "Broadband compressor with sidechain high-pass to reduce plosive impact",
            },
        ],
        "confidence_breakdown": breakdown,
    }


def _rule_sibilance(descriptors: dict, target: dict | None) -> dict | None:
    """Rule 3 -- Sibilance.

    Triggers when: narrow-band excess in 5-10 kHz + voiced prior +
    sibilance artifact flag.
    """
    sib = _artifact(descriptors, "sibilance")
    if not sib.get("detected", False):
        return None

    severity = sib.get("severity", 0)
    center_hz = sib.get("center_hz", 7000)
    vocal_prior = _vocal_prior(descriptors)
    voicing_conf = _safe_get(descriptors, "mid_level", "voicing_confidence", default=0)

    evidence_parts = [
        f"sibilance detected at {center_hz} Hz (severity {severity:.2f})",
    ]
    if vocal_prior > 0.3:
        evidence_parts.append(f"vocal prior {vocal_prior:.0%}")
    if voicing_conf > 0.5:
        evidence_parts.append(f"voicing confidence {voicing_conf:.0%}")

    evidence_quality = _clamp(0.6 + severity * 0.4)
    detector_reliability = 0.85
    context_fit = _clamp(0.5 + vocal_prior * 0.5)
    consensus = _clamp(0.6 + severity * 0.3 + (0.1 if voicing_conf > 0.5 else 0))

    conf, breakdown = _confidence(
        evidence_quality, detector_reliability, context_fit, consensus
    )

    # Calculate de-esser params from detected center
    deess_freq = int(round(center_hz / 100) * 100)  # round to nearest 100
    deess_range = _clamp(severity * 8, 2.0, 10.0)  # dB range

    return {
        "id": "sibilance_detected",
        "priority": 2,
        "confidence": conf,
        "problem": f"Sibilance excess detected in the {center_hz:.0f} Hz region",
        "evidence": "; ".join(evidence_parts),
        "action": {
            "tool": "deess",
            "params": {
                "frequency": deess_freq,
                "range": round(deess_range, 1),
                "mode": "split_band",
            },
            "description": f"De-esser tuned to {deess_freq} Hz with {deess_range:.1f} dB range",
        },
        "alternatives": [
            {
                "tool": "parametric_eq",
                "description": f"Dynamic EQ dip at {deess_freq} Hz, wideband mode",
            },
        ],
        "confidence_breakdown": breakdown,
    }


def _rule_harshness(descriptors: dict, target: dict | None) -> dict | None:
    """Rule 4 -- Harshness.

    Triggers when: repeated excess in 2.5-5 kHz, elevated centroid/flux.
    """
    harsh = _artifact(descriptors, "harshness")
    centroid = _safe_get(descriptors, "low_level", "spectral_centroid_hz", default=0)
    flux = _safe_get(descriptors, "low_level", "spectral_flux_mean", default=0)
    brightness = _safe_get(
        descriptors, "high_level", "perceptual", "brightness", default=0.5
    )
    _safe_get(descriptors, "high_level", "perceptual", "clarity", default=0.5)

    harsh_detected = harsh.get("detected", False)
    harsh_severity = harsh.get("severity", 0)
    harsh_center = harsh.get("center_hz", 3400)

    # Alternate detection via centroid + flux
    centroid_high = centroid > 3000
    flux_high = flux > 0.5
    bright_high = brightness > 0.7

    if harsh_detected:
        signals = 2 + sum([centroid_high, flux_high, bright_high])
    else:
        signals = sum([centroid_high, flux_high, bright_high])
        if signals < 2:
            return None

    evidence_parts = []
    if harsh_detected:
        evidence_parts.append(
            f"harshness artifact at {harsh_center} Hz (severity {harsh_severity:.2f})"
        )
    if centroid_high:
        evidence_parts.append(f"elevated spectral centroid {centroid:.0f} Hz")
    if flux_high:
        evidence_parts.append(f"high spectral flux {flux:.2f}")
    if bright_high:
        evidence_parts.append(f"brightness {brightness:.2f}")

    evidence_quality = _clamp(0.5 + (0.3 if harsh_detected else 0) + signals * 0.1)
    detector_reliability = 0.85 if harsh_detected else 0.65
    context_fit = 0.85
    consensus = _clamp(0.5 + signals * 0.1)

    conf, breakdown = _confidence(
        evidence_quality, detector_reliability, context_fit, consensus
    )

    center_freq = int(harsh_center) if harsh_detected else 3400
    cut_gain = round(-1.5 - harsh_severity * 3, 1) if harsh_detected else -2.0
    cut_q = 2.0

    return {
        "id": "harshness_detected",
        "priority": 1,
        "confidence": conf,
        "problem": f"Harshness detected in the {center_freq} Hz region (2.5-5 kHz)",
        "evidence": "; ".join(evidence_parts),
        "action": {
            "tool": "parametric_eq",
            "params": {
                "midFreq": center_freq,
                "midGain": cut_gain,
                "midQ": cut_q,
            },
            "description": f"Dynamic EQ dip at {center_freq} Hz, {cut_gain} dB, Q {cut_q}",
        },
        "alternatives": [
            {
                "tool": "harmonic_exciter",
                "description": "Reduce exciter drive in 2-5 kHz range",
            },
            {
                "tool": "multiband_dynamics",
                "description": "Compress high-mid band with faster release to soften harshness",
            },
        ],
        "confidence_breakdown": breakdown,
    }


def _rule_boxiness(descriptors: dict, target: dict | None) -> dict | None:
    """Rule 5 -- Boxiness.

    Triggers when: persistent excess in 200-500 Hz range.
    """
    band_energies = _safe_get(descriptors, "low_level", "band_energies_db", default={})
    low_mid_energy = band_energies.get("low_mid", -999)
    band_energies.get("mid", -999)
    boxiness_percept = _safe_get(
        descriptors, "high_level", "perceptual", "boxiness", default=0
    )
    warmth = _safe_get(descriptors, "high_level", "perceptual", "warmth", default=0.5)

    # Boxiness: low-mid excess and/or perceptual boxiness flag
    low_mid_excess = low_mid_energy > -9
    boxy_percept = boxiness_percept > 0.5
    warmth_excess = warmth > 0.7

    signals = sum([low_mid_excess, boxy_percept, warmth_excess])
    if signals < 1:
        return None
    # Require perceptual confirmation or strong energy evidence
    if not boxy_percept and not low_mid_excess:
        return None

    evidence_parts = []
    if low_mid_excess:
        evidence_parts.append(f"low-mid band energy {low_mid_energy:.1f} dB (elevated)")
    if boxy_percept:
        evidence_parts.append(f"perceptual boxiness score {boxiness_percept:.2f}")
    if warmth_excess:
        evidence_parts.append(f"warmth {warmth:.2f} (may indicate low-mid buildup)")

    evidence_quality = _clamp(0.5 + signals * 0.15)
    detector_reliability = 0.80
    context_fit = 0.85 if _source_is(descriptors, target, "vocal", "music") else 0.7
    consensus = _clamp(0.5 + (signals - 1) * 0.2)

    conf, breakdown = _confidence(
        evidence_quality, detector_reliability, context_fit, consensus
    )

    cut_freq = 350  # center of boxy range
    cut_gain = round(-2.0 - boxiness_percept * 2, 1)

    return {
        "id": "boxiness_detected",
        "priority": 3,
        "confidence": conf,
        "problem": "Boxiness detected: persistent excess in the 200-500 Hz range",
        "evidence": "; ".join(evidence_parts),
        "action": {
            "tool": "parametric_eq",
            "params": {
                "midFreq": cut_freq,
                "midGain": cut_gain,
                "midQ": 1.5,
            },
            "description": f"EQ cut at {cut_freq} Hz, {cut_gain} dB, Q 1.5",
        },
        "alternatives": [
            {
                "tool": "multiband_dynamics",
                "description": "Multiband expansion on 200-500 Hz to reduce boxy resonance",
            },
        ],
        "confidence_breakdown": breakdown,
    }


def _rule_weak_transients(descriptors: dict, target: dict | None) -> dict | None:
    """Rule 6 -- Weak transients.

    Triggers when: low onset contrast, low crest factor.
    """
    crest = _safe_get(descriptors, "low_level", "crest_factor_db", default=20)
    onset_density = _safe_get(
        descriptors, "mid_level", "onset_density_per_sec", default=0
    )
    transient_class = _safe_get(
        descriptors, "mid_level", "transient_class", default="moderate"
    )
    density_percept = _safe_get(
        descriptors, "high_level", "perceptual", "density", default=0.5
    )

    low_crest = crest < 8
    weak_transients = transient_class in ("weak", "soft")
    high_density = density_percept > 0.7  # over-compressed feel
    low_onset = onset_density < 1.5

    signals = sum([low_crest, weak_transients, high_density, low_onset])
    if signals < 2:
        return None

    evidence_parts = []
    if low_crest:
        evidence_parts.append(f"low crest factor {crest:.1f} dB")
    if weak_transients:
        evidence_parts.append(f"transient class: {transient_class}")
    if high_density:
        evidence_parts.append(f"high perceptual density {density_percept:.2f}")
    if low_onset:
        evidence_parts.append(f"low onset density {onset_density:.1f}/sec")

    evidence_quality = _clamp(0.5 + signals * 0.12)
    detector_reliability = 0.75
    # Transient shaping is most relevant for drums/percussive content
    context_fit = 0.9 if _source_is(descriptors, target, "drums", "music") else 0.65
    consensus = _clamp(0.4 + signals * 0.15)

    conf, breakdown = _confidence(
        evidence_quality, detector_reliability, context_fit, consensus
    )

    return {
        "id": "weak_transients",
        "priority": 3,
        "confidence": conf,
        "problem": "Weak transient attack: low onset contrast and low crest factor suggest over-compressed or dull dynamics",
        "evidence": "; ".join(evidence_parts),
        "action": {
            "tool": "transient_shaper",
            "params": {
                "attack": 20,
                "sustain": 0,
            },
            "description": "Transient shaper: +20% attack emphasis to restore punch",
        },
        "alternatives": [
            {
                "tool": "multiband_dynamics",
                "description": "Relax compressor ratio/threshold to allow more transient through",
            },
        ],
        "confidence_breakdown": breakdown,
    }


def _rule_stereo_instability(descriptors: dict, target: dict | None) -> dict | None:
    """Rule 7 -- Stereo instability / phase risk.

    Triggers when: correlation dips, side-channel overload.
    """
    correlation = _safe_get(descriptors, "mid_level", "stereo_correlation", default=1.0)
    width = _safe_get(descriptors, "mid_level", "stereo_width", default=0.5)
    ms_ratio = _safe_get(descriptors, "mid_level", "mid_side_ratio_db", default=0)
    channels = _safe_get(descriptors, "channels", default=2)

    if channels < 2:
        return None

    low_correlation = correlation < 0.4
    side_overload = ms_ratio < -6  # side louder than mid by >6 dB
    very_wide = width > 0.85

    signals = sum([low_correlation, side_overload, very_wide])
    if signals < 1:
        return None
    # Require correlation issue specifically
    if not low_correlation and not side_overload:
        return None

    evidence_parts = []
    if low_correlation:
        evidence_parts.append(f"stereo correlation {correlation:.2f} (low, phase risk)")
    if side_overload:
        evidence_parts.append(f"mid/side ratio {ms_ratio:.1f} dB (side-heavy)")
    if very_wide:
        evidence_parts.append(f"stereo width {width:.2f} (very wide)")

    evidence_quality = _clamp(0.6 + signals * 0.15)
    detector_reliability = 0.90  # correlation is a very reliable metric
    context_fit = 0.85
    consensus = _clamp(0.5 + signals * 0.15)

    conf, breakdown = _confidence(
        evidence_quality, detector_reliability, context_fit, consensus
    )

    target_width = max(50, int(width * 100) - 20)  # reduce by ~20%

    return {
        "id": "stereo_instability",
        "priority": 2,
        "confidence": conf,
        "problem": "Stereo instability / phase risk: low inter-channel correlation with wide stereo image",
        "evidence": "; ".join(evidence_parts),
        "action": {
            "tool": "stereo_imager",
            "params": {
                "width": target_width,
                "ellipticalLowFreq": 200,
                "msEq": True,
            },
            "description": f"Elliptical lows below 200 Hz, M/S EQ, reduce width to {target_width}%",
        },
        "alternatives": [
            {
                "tool": "multiband_dynamics",
                "description": "Dynamically narrow width when correlation drops below threshold",
            },
        ],
        "confidence_breakdown": breakdown,
    }


def _rule_under_target_loudness(descriptors: dict, target: dict | None) -> dict | None:
    """Rule 8 -- Under-target loudness.

    Triggers when: integrated LUFS is below target with available headroom.
    """
    lufs_i = _safe_get(descriptors, "low_level", "lufs_integrated", default=None)
    if lufs_i is None:
        return None

    true_peak = _safe_get(descriptors, "low_level", "true_peak_dbtp", default=0)
    _safe_get(descriptors, "low_level", "peak_db", default=0)

    target_val = _target_lufs(target)
    deficit = target_val - lufs_i  # positive = under target

    if deficit < 1.5:
        return None  # close enough or already louder

    headroom = abs(true_peak) if true_peak < 0 else 0
    # Only suggest if there's meaningful headroom
    if headroom < 0.5 and deficit > 3:
        # Very little headroom but big deficit -- still flag but note limitation
        pass

    evidence_parts = [
        f"integrated LUFS {lufs_i:.1f} (target {target_val:.1f}, deficit {deficit:.1f} LU)",
        f"true peak {true_peak:.1f} dBTP (headroom {headroom:.1f} dB)",
    ]

    evidence_quality = _clamp(0.7 + min(deficit / 10, 0.3))
    detector_reliability = 0.95  # LUFS is a very reliable measurement
    platform = target.get("platform", "") if target else ""
    context_fit = 0.95 if platform in PLATFORM_TARGETS else 0.80
    consensus = _clamp(0.6 + min(deficit / 8, 0.3))

    conf, breakdown = _confidence(
        evidence_quality, detector_reliability, context_fit, consensus
    )

    ceiling = -1.0 if platform != "apple" else -1.0  # Apple uses -1 dBTP
    target_lufs_param = target_val

    return {
        "id": "under_target_loudness",
        "priority": 2,
        "confidence": conf,
        "problem": f"Loudness is {deficit:.1f} LU below target ({target_val:.0f} LUFS)",
        "evidence": "; ".join(evidence_parts),
        "action": {
            "tool": "maximizer",
            "params": {
                "ceiling": ceiling,
                "targetLUFS": target_lufs_param,
            },
            "description": f"Maximize to {target_lufs_param:.0f} LUFS with {ceiling} dBTP ceiling",
        },
        "alternatives": [
            {
                "tool": "multiband_dynamics",
                "description": "Multistage clipper + limiter for more transparent loudness gain",
            },
        ],
        "confidence_breakdown": breakdown,
    }


def _rule_clipping(descriptors: dict, target: dict | None) -> dict | None:
    """Rule 9 -- Clipping detected.

    Triggers when: clipping artifact severity > 0.
    """
    clip = _artifact(descriptors, "clipping")
    if not clip.get("detected", False):
        return None

    severity = clip.get("severity", 0)
    if severity <= 0:
        return None

    locations = clip.get("locations_sec", [])
    loc_str = (
        f" at {', '.join(f'{t:.1f}s' for t in locations[:5])}" if locations else ""
    )

    evidence_parts = [
        f"clipping detected (severity {severity:.2f}){loc_str}",
    ]

    true_peak = _safe_get(descriptors, "low_level", "true_peak_dbtp", default=0)
    if true_peak >= 0:
        evidence_parts.append(f"true peak {true_peak:.1f} dBTP (at or above 0)")

    evidence_quality = _clamp(0.7 + severity * 0.3)
    detector_reliability = 0.92
    context_fit = 0.90
    consensus = _clamp(0.6 + severity * 0.3)

    conf, breakdown = _confidence(
        evidence_quality, detector_reliability, context_fit, consensus
    )

    return {
        "id": "clipping_detected",
        "priority": 1,
        "confidence": conf,
        "problem": "Digital clipping detected in audio signal",
        "evidence": "; ".join(evidence_parts),
        "action": {
            "tool": "declip",
            "params": {
                "severity": round(severity, 2),
                "mode": "auto",
            },
            "description": f"De-clip module (severity {severity:.2f})",
        },
        "alternatives": [
            {
                "tool": "maximizer",
                "description": "Gain reduction before clipping point to prevent re-clipping",
            },
        ],
        "confidence_breakdown": breakdown,
    }


def _rule_hum(descriptors: dict, target: dict | None) -> dict | None:
    """Rule 10 -- Hum detected.

    Triggers when: hum artifact flag is set.
    """
    hum = _artifact(descriptors, "hum")
    if not hum.get("detected", False):
        return None

    hum_freq = hum.get("frequency_hz", 60)
    severity = hum.get("severity", 0.5)

    evidence_parts = [
        f"hum detected at {hum_freq} Hz (severity {severity:.2f})",
    ]

    evidence_quality = _clamp(0.7 + severity * 0.3)
    detector_reliability = 0.90  # hum detection via FFT is reliable
    context_fit = 0.95  # hum is always unwanted
    consensus = _clamp(0.7 + severity * 0.2)

    conf, breakdown = _confidence(
        evidence_quality, detector_reliability, context_fit, consensus
    )

    return {
        "id": "hum_detected",
        "priority": 1,
        "confidence": conf,
        "problem": f"Electrical hum detected at {hum_freq} Hz",
        "evidence": "; ".join(evidence_parts),
        "action": {
            "tool": "dehum",
            "params": {
                "frequency": hum_freq,
                "harmonics": 4,
                "mode": "adaptive",
            },
            "description": f"De-hum at {hum_freq} Hz with 4 harmonics",
        },
        "alternatives": [
            {
                "tool": "parametric_eq",
                "description": f"Notch filter chain at {hum_freq}, {hum_freq * 2}, {hum_freq * 3}, {hum_freq * 4} Hz",
            },
        ],
        "confidence_breakdown": breakdown,
    }


def _rule_broadband_noise(descriptors: dict, target: dict | None) -> dict | None:
    """Rule 11 -- Broadband noise.

    Triggers when: noise artifact severity above threshold.
    """
    noise = _artifact(descriptors, "noise")
    if not noise.get("detected", False):
        return None

    severity = noise.get("severity", 0)
    noise_threshold = 0.1  # minimum severity to act on

    if severity < noise_threshold:
        return None

    flatness = _safe_get(descriptors, "low_level", "spectral_flatness", default=0)

    evidence_parts = [
        f"broadband noise detected (severity {severity:.2f})",
    ]
    if flatness > 0.3:
        evidence_parts.append(
            f"spectral flatness {flatness:.2f} (elevated, consistent with noise)"
        )

    evidence_quality = _clamp(0.6 + severity * 0.4)
    detector_reliability = 0.85
    context_fit = 0.90
    consensus = _clamp(0.5 + severity * 0.3 + (0.1 if flatness > 0.3 else 0))

    conf, breakdown = _confidence(
        evidence_quality, detector_reliability, context_fit, consensus
    )

    denoise_amount = round(_clamp(severity * 1.2, 0.1, 1.0), 2)

    return {
        "id": "broadband_noise",
        "priority": 1,
        "confidence": conf,
        "problem": "Broadband noise floor detected above acceptable threshold",
        "evidence": "; ".join(evidence_parts),
        "action": {
            "tool": "neural_denoise",
            "params": {
                "amount": denoise_amount,
                "mode": "adaptive",
            },
            "description": f"Neural denoise at {denoise_amount:.0%} strength",
        },
        "alternatives": [
            {
                "tool": "multiband_dynamics",
                "description": "Spectral gate to reduce noise between phrases",
            },
        ],
        "confidence_breakdown": breakdown,
    }


def _rule_excessive_reverb(descriptors: dict, target: dict | None) -> dict | None:
    """Rule 12 -- Excessive reverb / room sound.

    Triggers when: low direct-to-reverberant ratio estimate (high warmth +
    low clarity + high density can indicate reverberant content).
    """
    clarity = _safe_get(descriptors, "high_level", "perceptual", "clarity", default=0.5)
    warmth = _safe_get(descriptors, "high_level", "perceptual", "warmth", default=0.5)
    density = _safe_get(descriptors, "high_level", "perceptual", "density", default=0.5)

    # Direct-to-reverberant ratio estimate:
    # Low clarity + high warmth + high density suggests reverberant
    drr_estimate = clarity - (warmth * 0.3 + density * 0.3)

    low_clarity = clarity < 0.4
    reverberant = drr_estimate < 0.0

    # Also check spectral decay: high spectral flux might indicate reverb tail
    flux = _safe_get(descriptors, "low_level", "spectral_flux_mean", default=0)

    signals = sum([low_clarity, reverberant, flux < 0.2])
    if signals < 2:
        return None

    evidence_parts = []
    if low_clarity:
        evidence_parts.append(f"low clarity score {clarity:.2f}")
    if reverberant:
        evidence_parts.append(f"estimated DRR {drr_estimate:.2f} (reverberant)")
    if flux < 0.2:
        evidence_parts.append(f"low spectral flux {flux:.2f} (smeared transients)")
    evidence_parts.append(f"warmth {warmth:.2f}, density {density:.2f}")

    evidence_quality = _clamp(0.4 + signals * 0.15)
    detector_reliability = 0.65  # DRR estimate is indirect
    context_fit = 0.85 if _source_is(descriptors, target, "vocal", "speech") else 0.7
    consensus = _clamp(0.4 + signals * 0.15)

    conf, breakdown = _confidence(
        evidence_quality, detector_reliability, context_fit, consensus
    )

    dereverb_amount = round(_clamp((0.5 - clarity) * 2, 0.1, 0.8), 2)

    return {
        "id": "excessive_reverb",
        "priority": 3,
        "confidence": conf,
        "problem": "Excessive reverb or room sound reducing clarity",
        "evidence": "; ".join(evidence_parts),
        "action": {
            "tool": "dereverb",
            "params": {
                "amount": dereverb_amount,
                "mode": "adaptive",
            },
            "description": f"De-reverb at {dereverb_amount:.0%} strength",
        },
        "alternatives": [
            {
                "tool": "multiband_dynamics",
                "description": "Gate with fast release to cut reverb tails between phrases",
            },
        ],
        "confidence_breakdown": breakdown,
    }


def _rule_mono_compatibility(descriptors: dict, target: dict | None) -> dict | None:
    """Rule 13 -- Mono compatibility risk.

    Triggers when: stereo width high + correlation low.
    """
    correlation = _safe_get(descriptors, "mid_level", "stereo_correlation", default=1.0)
    width = _safe_get(descriptors, "mid_level", "stereo_width", default=0.5)
    channels = _safe_get(descriptors, "channels", default=2)

    if channels < 2:
        return None

    # Mono compatibility risk: wide + low correlation
    wide = width > 0.7
    low_corr = correlation < 0.5

    if not (wide and low_corr):
        return None

    ms_ratio = _safe_get(descriptors, "mid_level", "mid_side_ratio_db", default=0)

    evidence_parts = [
        f"stereo width {width:.2f} (wide)",
        f"stereo correlation {correlation:.2f} (low -- mono cancellation risk)",
    ]
    if ms_ratio < -3:
        evidence_parts.append(f"mid/side ratio {ms_ratio:.1f} dB (side-heavy)")

    evidence_quality = _clamp(0.7 + (1.0 - correlation) * 0.3)
    detector_reliability = 0.90
    context_fit = 0.85
    consensus = _clamp(0.5 + (1.0 - correlation) * 0.3 + (width - 0.7) * 0.5)

    conf, breakdown = _confidence(
        evidence_quality, detector_reliability, context_fit, consensus
    )

    mono_bass_freq = 150

    return {
        "id": "mono_compatibility_risk",
        "priority": 2,
        "confidence": conf,
        "problem": "Mono compatibility risk: significant phase cancellation likely when summed to mono",
        "evidence": "; ".join(evidence_parts),
        "action": {
            "tool": "stereo_imager",
            "params": {
                "ellipticalLowFreq": mono_bass_freq,
                "monoBelow": mono_bass_freq,
                "checkPhase": True,
            },
            "description": f"Mono bass below {mono_bass_freq} Hz + phase check",
        },
        "alternatives": [
            {
                "tool": "stereo_imager",
                "description": "Narrow imager to reduce width while preserving spatial impression",
            },
        ],
        "confidence_breakdown": breakdown,
    }


def _rule_dynamic_range_narrow(descriptors: dict, target: dict | None) -> dict | None:
    """Rule 14 -- Dynamic range too narrow.

    Triggers when: loudness range < 5 LU.
    """
    lra = _safe_get(descriptors, "low_level", "loudness_range_lu", default=None)
    if lra is None:
        return None

    if lra >= 5.0:
        return None

    crest = _safe_get(descriptors, "low_level", "crest_factor_db", default=20)
    density = _safe_get(descriptors, "high_level", "perceptual", "density", default=0.5)

    evidence_parts = [
        f"loudness range {lra:.1f} LU (below 5 LU threshold)",
    ]
    if crest < 8:
        evidence_parts.append(f"low crest factor {crest:.1f} dB")
    if density > 0.7:
        evidence_parts.append(f"high perceptual density {density:.2f}")

    signals = 1 + (1 if crest < 8 else 0) + (1 if density > 0.7 else 0)

    evidence_quality = _clamp(0.7 + (5.0 - lra) * 0.06)
    detector_reliability = 0.92  # LRA is a reliable measurement
    context_fit = 0.80  # not always a problem (e.g., some EDM is intentionally loud)
    # Lower context fit for source types where narrow range is expected
    if _source_is(descriptors, target, "drums"):
        context_fit = 0.60
    consensus = _clamp(0.5 + signals * 0.15)

    conf, breakdown = _confidence(
        evidence_quality, detector_reliability, context_fit, consensus
    )

    return {
        "id": "dynamic_range_narrow",
        "priority": 3,
        "confidence": conf,
        "problem": f"Dynamic range too narrow ({lra:.1f} LU) -- audio may sound over-compressed",
        "evidence": "; ".join(evidence_parts),
        "action": {
            "tool": "maximizer",
            "params": {
                "reduceLimiting": True,
                "targetLRA": 8.0,
            },
            "description": "Reduce limiting to expand dynamic range toward 8 LU",
        },
        "alternatives": [
            {
                "tool": "multiband_dynamics",
                "description": "Parallel processing: blend uncompressed signal to restore dynamics",
            },
        ],
        "confidence_breakdown": breakdown,
    }


def _rule_dynamic_range_wide(descriptors: dict, target: dict | None) -> dict | None:
    """Rule 15 -- Dynamic range too wide.

    Triggers when: loudness range > 15 LU for streaming targets.
    """
    lra = _safe_get(descriptors, "low_level", "loudness_range_lu", default=None)
    if lra is None:
        return None

    # Only flag for streaming / music contexts
    platform = target.get("platform", "") if target else ""
    streaming_platforms = {
        "spotify",
        "apple",
        "youtube",
        "amazon",
        "tidal",
        "soundcloud",
    }
    is_streaming = platform in streaming_platforms

    # For broadcast/cinema, wider range is expected
    threshold = 15.0 if is_streaming or not platform else 20.0

    if lra <= threshold:
        return None

    crest = _safe_get(descriptors, "low_level", "crest_factor_db", default=0)

    evidence_parts = [
        f"loudness range {lra:.1f} LU (above {threshold:.0f} LU threshold)",
    ]
    if crest > 20:
        evidence_parts.append(f"high crest factor {crest:.1f} dB")
    if is_streaming:
        evidence_parts.append(
            f"target platform: {platform} (streaming normalization applies)"
        )

    signals = 1 + (1 if crest > 20 else 0) + (1 if is_streaming else 0)

    evidence_quality = _clamp(0.6 + (lra - threshold) * 0.03)
    detector_reliability = 0.92
    context_fit = 0.90 if is_streaming else 0.65
    consensus = _clamp(0.5 + signals * 0.12)

    conf, breakdown = _confidence(
        evidence_quality, detector_reliability, context_fit, consensus
    )

    target_lufs = _target_lufs(target)

    return {
        "id": "dynamic_range_wide",
        "priority": 3,
        "confidence": conf,
        "problem": f"Dynamic range too wide ({lra:.1f} LU) for streaming delivery",
        "evidence": "; ".join(evidence_parts),
        "action": {
            "tool": "multiband_dynamics",
            "params": {
                "ratio": 2.5,
                "threshold": -18,
                "attack": 10,
                "release": 100,
            },
            "description": "Gentle compression + limiting to reduce dynamic range for streaming",
        },
        "alternatives": [
            {
                "tool": "maximizer",
                "description": f"Maximize to {target_lufs:.0f} LUFS to bring up quiet sections",
            },
        ],
        "confidence_breakdown": breakdown,
    }


# ---------------------------------------------------------------------------
# Rule registry
# ---------------------------------------------------------------------------

_RULES = [
    _rule_low_end_excess,  # 1
    _rule_vocal_plosives,  # 2
    _rule_sibilance,  # 3
    _rule_harshness,  # 4
    _rule_boxiness,  # 5
    _rule_weak_transients,  # 6
    _rule_stereo_instability,  # 7
    _rule_under_target_loudness,  # 8
    _rule_clipping,  # 9
    _rule_hum,  # 10
    _rule_broadband_noise,  # 11
    _rule_excessive_reverb,  # 12
    _rule_mono_compatibility,  # 13
    _rule_dynamic_range_narrow,  # 14
    _rule_dynamic_range_wide,  # 15
]


# ---------------------------------------------------------------------------
# Conflict resolution
# ---------------------------------------------------------------------------


def _resolve_conflicts(cards: list[dict]) -> list[dict]:
    """Remove or merge conflicting decision cards.

    Conflicts handled:
    - stereo_instability and mono_compatibility_risk: keep highest confidence,
      merge evidence.
    - dynamic_range_narrow and dynamic_range_wide: mutually exclusive, keep
      the one that fired (only one can fire for a given LRA value).
    - under_target_loudness and dynamic_range_narrow: both valid but loudness
      action should account for narrow range.
    """
    {c["id"]: c for c in cards}

    # Stereo conflict: if both stereo rules fire, merge into the higher-priority one
    stereo_ids = {"stereo_instability", "mono_compatibility_risk"}
    stereo_cards = [c for c in cards if c["id"] in stereo_ids]
    if len(stereo_cards) == 2:
        # Keep the one with higher confidence, absorb evidence from the other
        stereo_cards.sort(key=lambda c: c["confidence"], reverse=True)
        winner, loser = stereo_cards
        winner["evidence"] += f"; also: {loser['problem'].lower()}"
        # Add loser's action as an alternative if not already present
        loser_alt = {
            "tool": loser["action"]["tool"],
            "description": loser["action"]["description"],
        }
        if loser_alt not in winner["alternatives"]:
            winner["alternatives"].append(loser_alt)
        cards = [c for c in cards if c["id"] != loser["id"]]

    return cards


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def evaluate_rules(descriptors: dict, target: dict | None = None) -> list[dict]:
    """Evaluate all rules against the descriptor bundle.

    Args:
        descriptors: The full descriptor bundle from descriptors.py, containing
            ``low_level``, ``mid_level``, ``high_level``, plus metadata fields
            (``duration_sec``, ``sample_rate``, ``channels``, ``bit_depth``).
        target: Optional target specification containing any of:
            - ``platform``: streaming platform (spotify, apple, youtube, etc.)
            - ``target_lufs``: explicit loudness target
            - ``reference_spectrum``: reference spectral profile
            - ``source_type``: content type override (vocal, master, drums, bus)

    Returns:
        A list of decision card dicts sorted by priority (1 = highest) then
        by descending confidence. Each card contains:
        ``id``, ``priority``, ``confidence``, ``problem``, ``evidence``,
        ``action``, ``alternatives``, ``confidence_breakdown``.
    """
    if target is None:
        target = {}

    cards: list[dict] = []

    for rule_fn in _RULES:
        try:
            card = rule_fn(descriptors, target)
            if card is not None:
                cards.append(card)
        except Exception:
            # Individual rule failures must not crash the engine.
            # In production, log the exception for debugging.
            continue

    # Resolve conflicting / redundant cards
    cards = _resolve_conflicts(cards)

    # Sort by priority (ascending = higher priority first), then confidence (descending)
    cards.sort(key=lambda c: (c["priority"], -c["confidence"]))

    return cards
