"""Deterministic semantic tagging and prompt inference from analysis.

Turns the numeric analysis (BPM, key/scale, loudness, pitch, duration,
channels) into human-readable descriptors and a Stable Audio-style prompt.
Everything here is pure and deterministic, so it is fully testable and always
produces a usable baseline. Optional ML enrichers (genre/mood/instrument via
Essentia/MERT/CLAP) and LLM refinement plug in on top: when ``analysis`` already
carries a ``genre`` or the entry has embedded tags, those fold into the prompt.
"""

from __future__ import annotations

from typing import Any, Optional


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if item and item not in seen:
            seen.add(item)
            out.append(item)
    return out


def _as_float(value: Any) -> Optional[float]:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _tempo_descriptors(bpm: Optional[float]) -> list[str]:
    b = _as_float(bpm)
    if b is None or b <= 0:
        return []
    if b < 70:
        return ["slow", "downtempo"]
    if b < 90:
        return ["relaxed", "laid-back"]
    if b < 110:
        return ["mid-tempo", "groovy"]
    if b < 130:
        return ["upbeat", "danceable"]
    if b < 150:
        return ["energetic", "driving"]
    if b < 180:
        return ["fast", "high-energy"]
    return ["very fast", "frenetic"]


def _tonality_descriptors(key: Any, scale: Any) -> list[str]:
    tags: list[str] = []
    if key and scale:
        tags.append(f"{key} {scale}".strip())
    normalized = str(scale or "").lower()
    if normalized == "minor":
        tags.append("moody")
    elif normalized == "major":
        tags.append("bright tonality")
    return tags


def _energy_descriptors(rms_db: Any, loudness_lufs: Any) -> list[str]:
    lufs = _as_float(loudness_lufs)
    if lufs is not None:
        if lufs > -9:
            return ["loud", "full", "punchy"]
        if lufs > -16:
            return ["balanced"]
        return ["soft", "dynamic", "intimate"]
    rms = _as_float(rms_db)
    if rms is not None:
        if rms > -10:
            return ["loud", "full", "punchy"]
        if rms > -18:
            return ["balanced"]
        return ["soft", "dynamic", "intimate"]
    return []


def _timbre_descriptors(pitch_mean_hz: Any, pitch_std_hz: Any) -> list[str]:
    tags: list[str] = []
    mean = _as_float(pitch_mean_hz)
    if mean is not None:
        if mean >= 500:
            tags.append("bright")
        elif mean <= 180:
            tags.append("deep")
    std = _as_float(pitch_std_hz)
    if std is not None:
        if std >= 150:
            tags.append("melodic")
        elif std <= 30:
            tags.append("steady")
    return tags


def _length_descriptors(duration_sec: Any) -> list[str]:
    duration = _as_float(duration_sec)
    if duration is None or duration <= 0:
        return []
    if duration < 30:
        return ["short loop"]
    if duration < 90:
        return ["loop"]
    if duration < 300:
        return ["full track"]
    return ["extended"]


def _channel_descriptors(channels: Any) -> list[str]:
    if channels == 2:
        return ["stereo"]
    if channels == 1:
        return ["mono"]
    return []


def _extra_descriptors(embedded_tags: Optional[dict[str, Any]]) -> list[str]:
    """Fold ID3-style or sidecar tags (genre/mood/instruments) into the prompt
    when present. Imported audio rarely has these; generated tracks often do."""
    out: list[str] = []
    if not isinstance(embedded_tags, dict):
        return out
    for key in ("genre", "mood", "style", "instruments"):
        value = embedded_tags.get(key)
        if isinstance(value, str) and value.strip():
            out.append(value.strip().lower())
        elif isinstance(value, list):
            out.extend(str(v).strip().lower() for v in value if str(v).strip())
    return out


def derive_semantic_tags(analysis: dict[str, Any]) -> list[str]:
    """Deterministic descriptors derived from an analysis payload."""
    duration = analysis.get("duration_sec")
    if duration is None:
        duration = analysis.get("duration")
    tags: list[str] = []
    tags += _tempo_descriptors(analysis.get("bpm"))
    tags += _tonality_descriptors(analysis.get("key"), analysis.get("scale"))
    tags += _energy_descriptors(analysis.get("rms_db"), analysis.get("loudness_lufs"))
    tags += _timbre_descriptors(
        analysis.get("pitch_mean_hz"), analysis.get("pitch_std_hz")
    )
    tags += _length_descriptors(duration)
    tags += _channel_descriptors(analysis.get("channels"))
    genre = analysis.get("genre")
    if genre:
        tags.append(str(genre).strip().lower())
    return _dedupe(tags)


def _prompt_confidence(analysis: dict[str, Any], descriptor_count: int) -> float:
    score = 0.3
    if _as_float(analysis.get("bpm")):
        score += 0.15
    if analysis.get("key") and analysis.get("scale"):
        key_confidence = _as_float(analysis.get("key_confidence"))
        score += 0.15 if (key_confidence is None or key_confidence >= 0.5) else 0.05
    if analysis.get("rms_db") is not None or analysis.get("loudness_lufs") is not None:
        score += 0.1
    if analysis.get("pitch_mean_hz") is not None:
        score += 0.05
    if analysis.get("genre"):
        score += 0.15
    if descriptor_count >= 4:
        score += 0.05
    # Deterministic analysis alone cannot be certain of genre/instruments.
    return round(min(score, 0.9), 2)


def generate_prompt(
    analysis: dict[str, Any],
    *,
    embedded_tags: Optional[dict[str, Any]] = None,
    title: Optional[str] = None,  # noqa: ARG001 - reserved for future title parsing
) -> dict[str, Any]:
    """Build a Stable Audio-style prompt and semantic tags from analysis.

    Returns ``{prompt_guess, prompt_confidence, semantic_tags}``. The prompt is
    a single descriptive sentence; the tags are a flat, de-duplicated list good
    for catalogue search.
    """
    tags = derive_semantic_tags(analysis)
    bpm = _as_float(analysis.get("bpm"))
    key = analysis.get("key")
    scale = analysis.get("scale")

    parts: list[str] = []
    if bpm:
        parts.append(f"approximately {round(bpm)} BPM")
    if key and scale:
        parts.append(f"in {key} {scale}")

    tonality_phrase = f"{key} {scale}" if key and scale else None
    descriptors = [t for t in tags if t != tonality_phrase]
    descriptors = _dedupe(descriptors + _extra_descriptors(embedded_tags))
    if descriptors:
        parts.append(", ".join(descriptors))

    prompt = ", ".join(parts).strip()
    if prompt:
        prompt = prompt[0].upper() + prompt[1:]
        if not prompt.endswith("."):
            prompt += "."

    return {
        "prompt_guess": prompt,
        "prompt_confidence": _prompt_confidence(analysis, len(descriptors)),
        "semantic_tags": tags,
    }
