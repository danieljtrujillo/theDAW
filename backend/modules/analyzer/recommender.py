"""Hybrid recommendation engine: deterministic rules + LLM ranking.

Flow:
  1. Run rules.evaluate_rules(descriptors, target) to get candidate cards
  2. Sort by priority x confidence
  3. Optionally call the theDAW LLM assistant for ranking/explanation
  4. Return the cards + summary

The LLM call enriches but never replaces the rules. If the backend is
unreachable or the LLM errors, the rules-only cards are returned as-is.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Any

import httpx

from . import rules

log = logging.getLogger(__name__)

# The theDAW main backend assistant endpoint.
# Default assumes the main backend runs on localhost:8600.
_ASSISTANT_BASE = os.environ.get("THEDAW_BACKEND_URL", "http://127.0.0.1:8600")
_ASSISTANT_CHAT_URL = f"{_ASSISTANT_BASE}/api/assistant/chat"

# Provider/model to use for LLM enrichment (configurable via env).
_LLM_PROVIDER = os.environ.get("ANALYZER_LLM_PROVIDER", "gemini")
_LLM_MODEL = os.environ.get("ANALYZER_LLM_MODEL", None)  # None = backend default

# Timeout for the LLM call — we don't want analysis to hang.
_LLM_TIMEOUT_SEC = float(os.environ.get("ANALYZER_LLM_TIMEOUT", "15"))


async def recommend(
    descriptors: dict,
    target: dict | None = None,
) -> dict:
    """Hybrid recommendation: rules + LLM ranking.

    Args:
        descriptors: Full descriptor bundle from descriptors.py.
        target: Optional target spec (platform, genre, reference, intent).

    Returns:
        {
            "cards": [...],
            "summary": "...",
            "source_classification": {...},
            "llm_enriched": bool,
        }
    """
    # --- Step 1: deterministic rule evaluation ---
    cards: list[dict] = rules.evaluate_rules(descriptors, target)

    # --- Step 2: sort by priority (ascending = higher priority first) x confidence ---
    cards.sort(key=lambda c: (c.get("priority", 99), -c.get("confidence", 0)))

    # Build source classification from descriptors
    high = descriptors.get("high_level", {})
    source_classification = {
        "type": high.get("source_type", "unknown"),
        "subtype": _infer_subtype(high),
        "confidence": high.get("source_confidence", 0.0),
    }

    # --- Step 3: optional LLM enrichment ---
    llm_enriched = False
    try:
        llm_result = await _call_llm(descriptors, cards, target)
        if llm_result:
            cards = _merge_llm_result(cards, llm_result)
            llm_enriched = True
    except Exception:
        log.warning("LLM enrichment failed — returning rules-only cards", exc_info=True)

    # --- Step 4: build summary ---
    summary = _build_summary(cards)

    return {
        "cards": cards,
        "summary": summary,
        "source_classification": source_classification,
        "llm_enriched": llm_enriched,
    }


def _infer_subtype(high_level: dict) -> str:
    """Infer a source subtype from high-level descriptors."""
    priors = high_level.get("instrument_priors", {})
    source = high_level.get("source_type", "unknown")

    if source == "music":
        vocal_score = priors.get("vocal", 0)
        drums_score = priors.get("drums", 0)
        if vocal_score > 0.6:
            return "vocal_mix"
        if drums_score > 0.6 and vocal_score < 0.3:
            return "instrumental"
        return "full_mix"
    if source == "speech":
        return "dialogue"
    if source == "sfx":
        return "sound_effect"
    return "unknown"


def _build_summary(cards: list[dict]) -> str:
    """Build a natural-language summary from the card list."""
    if not cards:
        return "No issues detected. Audio appears well-balanced."

    n = len(cards)
    # Collect unique problem keywords for a concise summary
    problems = []
    for c in cards[:5]:  # top 5 issues
        problem = c.get("problem", "")
        # Extract a short label from the problem description
        if problem:
            # Take the first clause/phrase
            short = problem.split(".")[0].split(",")[0].strip()
            if short and short not in problems:
                problems.append(short)

    problem_str = ", ".join(problems[:3])
    suffix = f" (+{n - 3} more)" if n > 3 else ""
    return f"{n} issues detected. Primary concerns: {problem_str}.{suffix}"


async def _call_llm(
    descriptors: dict,
    cards: list[dict],
    target: dict | None,
) -> dict | None:
    """POST to /api/assistant/chat with the descriptor summary + candidate cards.

    Asks the LLM to:
      - Rank the candidates by importance
      - Add natural-language explanations
      - Suggest any missed issues

    Returns parsed JSON from the LLM response, or None on failure.
    """
    # Build a compact prompt with the analysis data
    prompt = _build_llm_prompt(descriptors, cards, target)

    body: dict[str, Any] = {
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are an expert audio mastering engineer and mix analyst. "
                    "You receive audio analysis descriptors and candidate fix cards. "
                    "Your job is to rank the cards by priority, add concise natural-language "
                    "explanations to each card, and suggest any issues the rules may have missed. "
                    "Respond ONLY with valid JSON matching the schema provided."
                ),
            },
            {"role": "user", "content": prompt},
        ],
        "provider": _LLM_PROVIDER,
    }
    if _LLM_MODEL:
        body["model"] = _LLM_MODEL

    async with httpx.AsyncClient(timeout=_LLM_TIMEOUT_SEC) as client:
        resp = await client.post(_ASSISTANT_CHAT_URL, json=body)

    if resp.status_code != 200:
        log.warning("LLM assistant returned %d: %s", resp.status_code, resp.text[:200])
        return None

    # The assistant endpoint streams SSE. We need to collect the full response.
    return _parse_sse_response(resp.text)


def _build_llm_prompt(
    descriptors: dict,
    cards: list[dict],
    target: dict | None,
) -> str:
    """Build a structured prompt for the LLM."""
    # Compact descriptor summary (skip raw arrays)
    desc_summary = {
        "low_level": {
            k: v
            for k, v in descriptors.get("low_level", {}).items()
            if k not in ("mfcc_mean", "beat_positions")
        },
        "mid_level": {
            k: v
            for k, v in descriptors.get("mid_level", {}).items()
            if k not in ("chroma", "beat_positions")
        },
        "high_level": descriptors.get("high_level", {}),
        "duration_sec": descriptors.get("duration_sec"),
        "sample_rate": descriptors.get("sample_rate"),
        "channels": descriptors.get("channels"),
    }

    # Compact card summary (drop heavy fields)
    card_summary = []
    for c in cards:
        card_summary.append(
            {
                "id": c.get("id"),
                "priority": c.get("priority"),
                "confidence": c.get("confidence"),
                "problem": c.get("problem"),
                "evidence": c.get("evidence"),
                "action": c.get("action"),
            }
        )

    prompt_data = {
        "descriptors": desc_summary,
        "candidate_cards": card_summary,
        "target": target or {},
    }

    return (
        "Analyze the following audio descriptors and candidate fix cards.\n\n"
        "```json\n" + json.dumps(prompt_data, indent=2, default=str) + "\n```\n\n"
        "Respond with JSON matching this schema:\n"
        "```json\n"
        "{\n"
        '  "ranked_card_ids": ["id1", "id2", ...],\n'
        '  "explanations": {"card_id": "natural language explanation", ...},\n'
        '  "missed_issues": [\n'
        "    {\n"
        '      "id": "new_issue_id",\n'
        '      "priority": 1-10,\n'
        '      "confidence": 0.0-1.0,\n'
        '      "problem": "description",\n'
        '      "evidence": "why this matters",\n'
        '      "action": {"tool": "tool_id", "params": {}, "description": "what to do"}\n'
        "    }\n"
        "  ]\n"
        "}\n"
        "```\n"
        "ONLY output the JSON object, no markdown fences, no commentary."
    )


def _parse_sse_response(text: str) -> dict | None:
    """Parse the SSE stream from the assistant endpoint.

    The endpoint streams `data: ...` lines. We collect all content chunks
    and try to parse the combined text as JSON.
    """
    collected = []

    for line in text.splitlines():
        if not line.startswith("data: "):
            continue
        payload = line[6:].strip()
        if payload == "[DONE]":
            break
        try:
            chunk = json.loads(payload)
            # OpenAI-compatible SSE: choices[0].delta.content
            choices = chunk.get("choices", [])
            if choices:
                delta = choices[0].get("delta", {})
                content = delta.get("content", "")
                if content:
                    collected.append(content)
        except json.JSONDecodeError:
            # Some chunks may not be JSON (e.g. comments)
            continue

    if not collected:
        return None

    full_text = "".join(collected).strip()

    # Strip markdown code fences if the LLM wrapped its response
    if full_text.startswith("```"):
        lines = full_text.splitlines()
        # Remove first and last fence lines
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        full_text = "\n".join(lines).strip()

    try:
        return json.loads(full_text)
    except json.JSONDecodeError:
        log.warning("Failed to parse LLM response as JSON: %s", full_text[:200])
        return None


def _merge_llm_result(cards: list[dict], llm: dict) -> list[dict]:
    """Merge LLM ranking and explanations back into the card list."""
    cards_by_id = {c["id"]: c for c in cards}

    # Apply explanations
    explanations = llm.get("explanations", {})
    for card_id, explanation in explanations.items():
        if card_id in cards_by_id:
            cards_by_id[card_id]["llm_explanation"] = explanation

    # Re-order by LLM ranking if provided
    ranked_ids = llm.get("ranked_card_ids", [])
    if ranked_ids:
        ordered = []
        seen = set()
        for rid in ranked_ids:
            if rid in cards_by_id and rid not in seen:
                card = cards_by_id[rid]
                card["llm_rank"] = len(ordered) + 1
                ordered.append(card)
                seen.add(rid)
        # Append any cards not in the LLM ranking
        for c in cards:
            if c["id"] not in seen:
                ordered.append(c)
        cards = ordered

    # Add any missed issues the LLM found
    missed = llm.get("missed_issues", [])
    for issue in missed:
        if not isinstance(issue, dict):
            continue
        issue_id = issue.get("id", "")
        if issue_id and issue_id not in cards_by_id:
            # Mark as LLM-sourced
            issue["source"] = "llm"
            issue.setdefault("alternatives", [])
            issue.setdefault(
                "confidence_breakdown",
                {
                    "evidence_quality": 0.5,
                    "detector_reliability": 0.5,
                    "context_fit": 0.5,
                    "consensus": 0.5,
                },
            )
            cards.append(issue)

    return cards
