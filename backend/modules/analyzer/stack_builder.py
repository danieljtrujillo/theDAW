"""Convert accepted decision cards into an ordered effect chain.

Construction order:
  1. Repair / cleanup        (denoise, declip, dehum, declick)
  2. Corrective tone         (EQ, dynamic EQ, match EQ)
  3. Dynamics control        (multiband, transient shaper)
  4. Character / saturation  (exciter, character FX)
  5. Spatial / stereo        (imager)
  6. Safety / loudness       (maximizer, smart export)

Variant adjusts params:
  - transparent: minimal, conservative, -16 LUFS, wide LRA
  - punchy: moderate dynamics, transient emphasis, -14 LUFS
  - loud: aggressive, -10 LUFS, narrow LRA
  - reference: match reference profile exactly
"""

from __future__ import annotations

import logging

from .presets import (
    PLATFORM_TARGETS,
    STAGE_ORDER,
    TOOL_STAGE_MAP,
    VARIANT_ADJUSTMENTS,
)

log = logging.getLogger(__name__)


def build_stack(
    cards: list[dict],
    variant: str = "transparent",
    source_type: str = "music",
) -> dict:
    """Convert accepted decision cards into an ordered effect chain.

    Args:
        cards: List of accepted/modified decision cards from the recommender.
        variant: Stack variant — "transparent", "punchy", "loud", or "reference".
        source_type: Source classification — "music", "speech", "sfx", etc.

    Returns:
        {
            "variant": str,
            "chain": [{tool, params, stage}, ...],
            "confidence": float,
            "explanation": str,
        }
    """
    adjustments = VARIANT_ADJUSTMENTS.get(variant, VARIANT_ADJUSTMENTS["transparent"])
    confidence_threshold = adjustments["confidence_threshold"]

    # Filter cards below the variant's confidence threshold
    accepted = [c for c in cards if c.get("confidence", 0) >= confidence_threshold]

    if not accepted:
        return {
            "variant": variant,
            "chain": [],
            "confidence": 1.0,
            "explanation": f"No cards met the {variant} confidence threshold ({confidence_threshold}).",
        }

    # Map cards to chain entries with stage assignment
    chain_entries: list[dict] = []
    for card in accepted:
        action = card.get("action", {})
        tool_id = action.get("tool", "")
        if not tool_id:
            continue

        stage = TOOL_STAGE_MAP.get(tool_id, "corrective_tone")
        params = dict(action.get("params", {}))

        # Adjust params based on variant
        params = _adjust_params_for_variant(tool_id, params, adjustments, source_type)

        chain_entries.append(
            {
                "tool": tool_id,
                "params": params,
                "stage": stage,
                "_priority": card.get("priority", 99),
                "_confidence": card.get("confidence", 0),
            }
        )

    # Sort by stage order, then priority within stage
    stage_index = {s: i for i, s in enumerate(STAGE_ORDER)}
    chain_entries.sort(key=lambda e: (stage_index.get(e["stage"], 99), e["_priority"]))

    # Deduplicate: only one instance of each tool per stage
    seen: set[tuple[str, str]] = set()
    deduped: list[dict] = []
    for entry in chain_entries:
        key = (entry["tool"], entry["stage"])
        if key not in seen:
            seen.add(key)
            deduped.append(entry)

    # Ensure the output stage has a maximizer/loudness tool if variant demands it
    has_output = any(e["stage"] == "output" for e in deduped)
    if not has_output and variant in ("punchy", "loud"):
        deduped.append(_make_output_entry(variant, adjustments))

    # Add transient shaper for punchy/loud if not already present
    if variant in ("punchy", "loud"):
        has_transient = any(e["tool"] == "transient_shaper" for e in deduped)
        if not has_transient and adjustments["attack_emphasis"] > 0:
            deduped.append(_make_transient_entry(adjustments))
            # Re-sort after adding
            deduped.sort(
                key=lambda e: (stage_index.get(e["stage"], 99), e.get("_priority", 99))
            )

    # Add exciter for punchy/loud if not already present
    if adjustments["exciter_amount"] > 0:
        has_exciter = any(e["tool"] == "harmonic_exciter" for e in deduped)
        if not has_exciter:
            deduped.append(_make_exciter_entry(adjustments))
            deduped.sort(
                key=lambda e: (stage_index.get(e["stage"], 99), e.get("_priority", 99))
            )

    # Clean up internal fields and build final chain
    chain = []
    for entry in deduped:
        chain.append(
            {
                "tool": entry["tool"],
                "params": entry["params"],
                "stage": entry["stage"],
            }
        )

    # Average confidence across accepted cards
    if accepted:
        avg_confidence = sum(c.get("confidence", 0) for c in accepted) / len(accepted)
    else:
        avg_confidence = 1.0

    explanation = _build_explanation(variant, chain, source_type)

    return {
        "variant": variant,
        "chain": chain,
        "confidence": round(avg_confidence, 2),
        "explanation": explanation,
    }


def _adjust_params_for_variant(
    tool_id: str,
    params: dict,
    adjustments: dict,
    source_type: str,
) -> dict:
    """Adjust tool params based on the selected variant."""
    params = dict(params)  # don't mutate caller's dict

    eq_strength = adjustments["eq_strength"]
    compression_ratio = adjustments["compression_ratio"]
    ceiling = adjustments["ceiling_dbtp"]

    # --- EQ tools: scale gains by eq_strength ---
    if tool_id in ("parametric_eq", "dynamic_eq", "spectral_stabilizer"):
        for key in ("lowGain", "midGain", "highGain", "amount"):
            if key in params:
                params[key] = round(params[key] * eq_strength, 1)

    # --- Dynamic EQ: scale thresholds ---
    if tool_id == "dynamic_eq":
        for key in ("band1Ratio", "band2Ratio", "band3Ratio"):
            if key in params:
                # Scale ratio toward variant's compression preference
                base = params[key]
                params[key] = round(base * (compression_ratio / 3.0), 1)

    # --- Multiband dynamics: adjust ratio and threshold ---
    if tool_id == "multiband_dynamics":
        for key in ("lowRatio", "midRatio", "highRatio"):
            if key in params:
                params[key] = round(
                    max(1.0, params[key] * (compression_ratio / 3.0)), 1
                )
        # For loud variant, lower thresholds (more compression)
        if adjustments.get("lra_target", 9) < 7:
            for key in ("lowThresh", "midThresh", "highThresh"):
                if key in params:
                    params[key] = max(-60, params[key] - 4)

    # --- Transient shaper ---
    if tool_id == "transient_shaper":
        params["attack"] = round(adjustments["attack_emphasis"] * 100, 0)
        params["sustain"] = round(adjustments["sustain_emphasis"] * 100, 0)

    # --- Harmonic exciter ---
    if tool_id == "harmonic_exciter":
        params["amount"] = adjustments["exciter_amount"]

    # --- Maximizer: use variant's loudness settings ---
    if tool_id == "maximizer":
        platform = PLATFORM_TARGETS.get("universal", {"lufs": -14, "tp": -2, "lra": 9})
        base_lufs = platform["lufs"]
        params["targetLUFS"] = base_lufs + adjustments["lufs_offset"]
        params["targetLRA"] = adjustments["lra_target"]
        params["ceiling"] = ceiling

    # --- Loudness meter ---
    if tool_id == "loudness_meter":
        platform = PLATFORM_TARGETS.get("universal", {"lufs": -14, "tp": -2, "lra": 9})
        base_lufs = platform["lufs"]
        params["targetLUFS"] = base_lufs + adjustments["lufs_offset"]
        params["targetLRA"] = adjustments["lra_target"]
        params["ceiling"] = ceiling

    # --- Stereo imager: speech should be narrower ---
    if tool_id == "stereo_imager" and source_type == "speech":
        params["width"] = min(params.get("width", 100), 80)

    return params


def _make_output_entry(variant: str, adjustments: dict) -> dict:
    """Create a maximizer chain entry for variants that need one."""
    platform = PLATFORM_TARGETS.get("universal", {"lufs": -14, "tp": -2, "lra": 9})
    base_lufs = platform["lufs"]

    return {
        "tool": "maximizer",
        "params": {
            "ceiling": adjustments["ceiling_dbtp"],
            "targetLUFS": base_lufs + adjustments["lufs_offset"],
            "targetLRA": adjustments["lra_target"],
            "attack": 5,
            "release": 50,
        },
        "stage": "output",
        "_priority": 99,
        "_confidence": 1.0,
    }


def _make_transient_entry(adjustments: dict) -> dict:
    """Create a transient shaper chain entry."""
    return {
        "tool": "transient_shaper",
        "params": {
            "attack": round(adjustments["attack_emphasis"] * 100, 0),
            "sustain": round(adjustments["sustain_emphasis"] * 100, 0),
            "fastEnv": 1.0,
            "slowEnv": 50,
            "outputGain": 0,
        },
        "stage": "dynamics",
        "_priority": 50,
        "_confidence": 0.8,
    }


def _make_exciter_entry(adjustments: dict) -> dict:
    """Create a harmonic exciter chain entry."""
    return {
        "tool": "harmonic_exciter",
        "params": {
            "amount": adjustments["exciter_amount"],
            "freq": 4500,
            "blend": 5,
            "outputGain": 0,
        },
        "stage": "character",
        "_priority": 50,
        "_confidence": 0.7,
    }


def _build_explanation(variant: str, chain: list[dict], source_type: str) -> str:
    """Build a natural-language explanation of the stack."""
    stage_counts: dict[str, int] = {}
    for entry in chain:
        stage = entry["stage"]
        stage_counts[stage] = stage_counts.get(stage, 0) + 1

    n_tools = len(chain)
    stages_used = ", ".join(sorted(stage_counts.keys()))

    variant_desc = {
        "transparent": "minimal corrective processing, conservative loudness target, wide dynamic range",
        "punchy": "moderate dynamics control, transient emphasis, standard loudness target",
        "loud": "aggressive dynamics, maximized loudness, narrow dynamic range",
        "reference": "reference-matched processing, target-specific parameters",
    }

    desc = variant_desc.get(variant, "custom processing")

    return (
        f"{variant.capitalize()} variant: {desc}. "
        f"{n_tools} tools across stages: {stages_used}. "
        f"Source type: {source_type}."
    )
