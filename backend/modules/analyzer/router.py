"""Analyzer module — FastAPI router with 3 endpoints.

This is a custom APIRouter (not using the standard build_router pattern)
because the analyzer is an analysis service, not a standard audio tool.

Endpoints:
  POST /analyze      — Extract full descriptor bundle from audio
  POST /recommend    — Analyze + generate decision cards
  POST /build-stack  — Convert accepted cards into ordered tool chain
"""

from __future__ import annotations

import json
import logging
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from ...lib import ffmpeg

log = logging.getLogger(__name__)

router = APIRouter()


@router.post("/analyze")
async def analyze(audio: UploadFile = File(...)):
    """Extract full descriptor bundle from uploaded audio.

    Returns the complete descriptor taxonomy as JSON:
    low_level, mid_level, high_level, plus file metadata.
    """
    tmp = Path(tempfile.mkdtemp(prefix="edit_analyzer_"))
    try:
        in_path = tmp / "input.wav"
        await ffmpeg.stream_upload_to(in_path, audio)

        from . import descriptors

        result = await descriptors.extract_descriptors(in_path)
        return result
    except HTTPException:
        raise
    except Exception as e:
        log.exception("Descriptor extraction failed")
        raise HTTPException(500, f"Analysis failed: {e}")
    finally:
        ffmpeg.cleanup(tmp)


@router.post("/recommend")
async def recommend_endpoint(
    audio: UploadFile = File(...),
    target: str = Form("{}"),
):
    """Analyze audio and generate prioritized decision cards.

    Args:
        audio: Audio file upload.
        target: JSON string with optional target spec:
            {
                "platform": "spotify",
                "genre": "pop",
                "reference": {...},
                "intent": "master for streaming"
            }

    Returns:
        {
            "cards": [...],
            "summary": "...",
            "source_classification": {...},
            "llm_enriched": bool
        }
    """
    try:
        target_dict = json.loads(target)
    except json.JSONDecodeError:
        raise HTTPException(400, "Invalid target JSON")

    tmp = Path(tempfile.mkdtemp(prefix="edit_analyzer_"))
    try:
        in_path = tmp / "input.wav"
        await ffmpeg.stream_upload_to(in_path, audio)

        # Step 1: extract descriptors
        from . import descriptors

        desc = await descriptors.extract_descriptors(in_path)

        # Step 2: run recommender (rules + optional LLM)
        from . import recommender

        result = await recommender.recommend(desc, target_dict or None)
        return result
    except HTTPException:
        raise
    except Exception as e:
        log.exception("Recommendation failed")
        raise HTTPException(500, f"Recommendation failed: {e}")
    finally:
        ffmpeg.cleanup(tmp)


@router.post("/build-stack")
async def build_stack_endpoint(
    cards: str = Form("[]"),
    variant: str = Form("transparent"),
    source_type: str = Form("music"),
):
    """Convert accepted decision cards into an ordered effect chain.

    Args:
        cards: JSON string of accepted/modified decision cards.
        variant: Stack variant — "transparent", "punchy", "loud", or "reference".
        source_type: Source classification — "music", "speech", "sfx".

    Returns:
        {
            "variant": str,
            "chain": [{tool, params, stage}, ...],
            "confidence": float,
            "explanation": str
        }
    """
    try:
        cards_list = json.loads(cards)
    except json.JSONDecodeError:
        raise HTTPException(400, "Invalid cards JSON")

    if not isinstance(cards_list, list):
        raise HTTPException(400, "Cards must be a JSON array")

    valid_variants = ("transparent", "punchy", "loud", "reference")
    if variant not in valid_variants:
        raise HTTPException(
            400,
            f"Invalid variant '{variant}'. Must be one of: {', '.join(valid_variants)}",
        )

    try:
        from . import stack_builder

        result = stack_builder.build_stack(
            cards=cards_list,
            variant=variant,
            source_type=source_type,
        )
        return result
    except Exception as e:
        log.exception("Stack build failed")
        raise HTTPException(500, f"Stack build failed: {e}")
