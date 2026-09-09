"""The optional interpretive pass: one chat call to whatever provider the
assistant already has a key for, returning ONLY ``meaning`` devices.

Deterministic detection (rhyme, sound, repetition, structure) is computed from
the words and is reproducible; metaphor, irony and puns are readings, not
measurements, so they live behind this pass and are never on by default.

There is no shared LLM client in this repo: the assistant's provider registry
IS the client (PROVIDERS / _get_api_key / _chat_url in
``backend/assistant_routes.py``), exactly as ``tour/enrich.py`` and
``controllervision/engine.py`` use it. Keys resolve request-key > pool > env,
so a key typed into the assistant panel works here with nothing to configure.

The model is asked to anchor every finding to the ``line:word`` indices we
printed for it, and everything it sends back is re-validated against the real
document — an out-of-range index, an unknown kind or unparseable JSON is
dropped rather than trusted.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from typing import Any, Optional

import httpx

from backend.assistant_routes import PROVIDERS, _chat_url, _get_api_key
from backend.modules.lyrics.schema import LyricsDoc

from .schema import FAMILY_OF, MEANING_KINDS, Device, LlmPass, Span

log = logging.getLogger(__name__)

# The providers the assistant resolves keys for, in the order the tour module
# probes them (``tour/router.py`` get_status). Local runtimes (ollama, lmstudio)
# are omitted: they need no key, so probing one tells us nothing about whether a
# model is actually loaded there — the user picks those explicitly.
PROVIDER_ORDER = ("gemini", "openai", "anthropic", "grok", "groq", "openrouter")

# A ceiling on what one pass may return, so a runaway reply cannot bury the
# deterministic findings under hundreds of speculative ones.
MAX_DEVICES = 80
# Nothing the model proposes is certain; the UI's confidence floor slider is
# meant to be able to hide the whole pass in one drag.
DEFAULT_CONFIDENCE = 0.6
MAX_CONFIDENCE = 0.95

# Long songs cost real money and blow past context; the pass reads the head of
# the lyric, which is where the writing establishes its images anyway.
MAX_PROMPT_LINES = 200

_SYS = (
    "You are a poetry and lyric analyst. You are given a song lyric where every "
    "word is printed as `line:word text`, using the document's own indices. "
    "Find figurative and semantic devices ONLY — the rhyme, alliteration and "
    "repetition are already detected by other means, do not report them.\n"
    "Reply with ONE JSON object and nothing else — no prose, no markdown "
    "fences:\n"
    '{"devices": [{"kind": string, "label": string, "detail": string, '
    '"confidence": number 0..1, "spans": [[line, word], ...]}]}\n'
    "`kind` MUST be one of: " + ", ".join(MEANING_KINDS) + ".\n"
    "`spans` MUST be [line, word] index pairs copied from the printed lyric, "
    "covering exactly the words the device lives in. `label` is a few words for "
    'a findings list (e.g. "metaphor: the city breathes"); `detail` is one '
    "sentence saying what it means. Report only what is really there: a plain "
    "line with no figurative reading gets no entry."
)


class LlmError(RuntimeError):
    """The interpretive pass could not run. Recorded on ``LlmPass.error``."""


# Serialize outbound calls: each one spends the user's key, and two SING tabs
# asking at once should cost one call at a time, not two.
_llm_lock = asyncio.Lock()


def available_providers(request_key: str = "") -> list[str]:
    """The providers that have a usable key right now, in probe order."""
    found: list[str] = []
    for pid in PROVIDER_ORDER:
        try:
            if _get_api_key(pid, request_key or None):
                found.append(pid)
        except Exception:  # noqa: BLE001 - a broken provider entry is not fatal
            continue
    return found


def resolve_provider_key(provider: str, request_key: str = "") -> str:
    if provider not in PROVIDERS:
        raise LlmError(f"unknown provider {provider!r}")
    key = _get_api_key(provider, request_key or None)
    if not key:
        env = PROVIDERS[provider].get("env_key") or "its env var"
        raise LlmError(
            f"no API key for {provider} — add one in the assistant panel or set {env}"
        )
    return key


def pick_provider(request_key: str = "") -> str:
    """First provider with a working key, the way ``controllervision`` picks a
    vision provider. Raises when nothing is configured."""
    found = available_providers(request_key)
    if not found:
        raise LlmError(
            "no LLM provider has a key — add one in the assistant panel first"
        )
    return found[0]


async def resolve_model(provider: str, model: str, api_key: str) -> str:
    """The model id to call. An explicit request model always wins; otherwise
    the provider's OWN catalog default in ``assistant_routes`` is used — model
    ids are never written from memory here. Gemini's catalog default is a UI
    alias the API does not accept, so it goes through the live-list resolver
    the tour module already maintains."""
    chosen = (model or "").strip() or str(
        PROVIDERS.get(provider, {}).get("default_model") or ""
    )
    if provider == "gemini":
        from backend.modules.tour.enrich import _resolve_gemini_model

        try:
            return await _resolve_gemini_model(api_key, chosen)
        except Exception as e:  # noqa: BLE001 - surfaced as a pass failure
            raise LlmError(f"could not resolve a Gemini model: {e}") from e
    if not chosen:
        raise LlmError(f"no default model for {provider}; pass one in the request")
    return chosen


def indexed_lyric(doc: LyricsDoc) -> str:
    """The lyric with every word carrying its ``line:word`` address, so the
    model can only answer in coordinates that exist. Markers ("[Chorus]") are
    printed as context but have no words to anchor to."""
    out: list[str] = []
    for li, line in enumerate(doc.lines):
        if line.kind == "marker":
            out.append(f"{line.text}")
            continue
        if not line.words:
            continue
        out.append(" ".join(f"{li}:{wi} {w.text}" for wi, w in enumerate(line.words)))
        if len(out) >= MAX_PROMPT_LINES:
            break
    return "\n".join(out)


def parse_json_block(text: str) -> Optional[dict[str, Any]]:
    """Pull one JSON object out of a reply that may be fenced or padded with
    prose (the tolerant parser ``controllervision`` uses)."""
    if not text:
        return None
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    raw = fenced.group(1) if fenced else None
    if raw is None:
        start = text.find("{")
        end = text.rfind("}")
        raw = text[start : end + 1] if start != -1 and end > start else None
    if raw is None:
        return None
    try:
        parsed = json.loads(raw)
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _confidence(value: Any) -> float:
    try:
        conf = float(value)
    except (TypeError, ValueError, OverflowError):
        return DEFAULT_CONFIDENCE
    if conf <= 0.0:
        return DEFAULT_CONFIDENCE
    # Never 1.0: that is reserved for a match the detectors actually measured.
    return max(0.05, min(MAX_CONFIDENCE, conf))


def devices_from_reply(
    payload: dict[str, Any], doc: LyricsDoc
) -> tuple[list[Device], int]:
    """Validate the model's findings against the real document.

    Returns ``(devices, dropped)``. A finding survives only when its kind is a
    known MEANING kind and at least one of its spans lands on a word that
    exists — model output never reaches the UI unchecked.
    """
    raw = payload.get("devices")
    if not isinstance(raw, list):
        return [], 0
    devices: list[Device] = []
    dropped = 0
    for i, item in enumerate(raw):
        if len(devices) >= MAX_DEVICES:
            dropped += 1
            continue
        if not isinstance(item, dict):
            dropped += 1
            continue
        kind = str(item.get("kind") or "").strip().lower()
        if kind not in MEANING_KINDS:
            dropped += 1
            continue
        spans: list[Span] = []
        for pair in item.get("spans") or []:
            if not isinstance(pair, (list, tuple)) or len(pair) < 2:
                continue
            try:
                li, wi = int(pair[0]), int(pair[1])
            except (TypeError, ValueError, OverflowError):
                # json.loads accepts Infinity/NaN and unbounded ints, so a
                # model can hand us a "number" int() refuses: drop the span,
                # never let it out of the validator.
                continue
            if not (0 <= li < len(doc.lines)):
                continue
            line = doc.lines[li]
            if line.kind != "lyric" or not (0 <= wi < len(line.words)):
                continue
            spans.append(Span(line=li, word=wi, text=line.words[wi].text))
        if not spans:
            dropped += 1
            continue
        gid = f"llm-{i}"
        devices.append(
            Device(
                id=f"{gid}-0",
                kind=kind,
                family=FAMILY_OF[kind],
                label=str(item.get("label") or kind.replace("-", " ")).strip()[:200],
                group=gid,
                spans=spans,
                detail=str(item.get("detail") or "").strip()[:400],
                confidence=_confidence(item.get("confidence")),
                source="llm",
            )
        )
    return devices, dropped


async def _chat(provider: str, model: str, api_key: str, prompt: str) -> str:
    """One chat completion, over the transport the assistant uses for this
    provider. Anthropic speaks ``/v1/messages``; everybody else is
    OpenAI-compatible."""
    if provider == "anthropic":
        url = f"{PROVIDERS['anthropic']['base_url']}/v1/messages"
        headers = {
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }
        body = {
            "model": model,
            "max_tokens": 4000,
            "system": _SYS,
            "messages": [{"role": "user", "content": prompt}],
        }
    else:
        url = _chat_url(provider)
        headers = {"Content-Type": "application/json"}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        body = {
            "model": model,
            "messages": [
                {"role": "system", "content": _SYS},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.2,
            "stream": False,
        }
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(url, json=body, headers=headers)
    except httpx.HTTPError as e:
        raise LlmError(f"{provider} unreachable: {e}") from e
    if resp.status_code != 200:
        raise LlmError(
            f"{provider} returned HTTP {resp.status_code}: {resp.text[:300]}"
        )
    try:
        data = resp.json()
    except ValueError as e:
        raise LlmError(f"{provider} response was not JSON: {e}") from e
    if provider == "anthropic":
        return "".join(
            blk.get("text", "")
            for blk in (data.get("content") or [])
            if isinstance(blk, dict) and blk.get("type") == "text"
        )
    try:
        content = ((data.get("choices") or [{}])[0].get("message") or {}).get("content")
    except (AttributeError, IndexError, TypeError) as e:
        raise LlmError(f"{provider} response malformed: {e}") from e
    if isinstance(content, list):  # some providers return content parts
        return "".join(p.get("text", "") for p in content if isinstance(p, dict))
    return str(content or "")


async def interpret(
    doc: LyricsDoc, provider: str = "", model: str = "", api_key: str = ""
) -> tuple[list[Device], LlmPass]:
    """Run the interpretive pass over ``doc``.

    Returns the validated ``meaning`` devices and the provenance to store on
    ``LyricAnalysisDoc.llm``. Raises ``LlmError`` when the pass could not run
    at all — the caller records that on ``LlmPass.error`` rather than letting
    a failed reading look like "no devices found".
    """
    chosen = (provider or "").strip() or pick_provider(api_key)
    key = resolve_provider_key(chosen, api_key)
    chosen_model = await resolve_model(chosen, model, key)
    prompt = indexed_lyric(doc)
    if not prompt.strip():
        raise LlmError("no lyric words to interpret")
    async with _llm_lock:
        text = await _chat(chosen, chosen_model, key, prompt)
    parsed = parse_json_block(text)
    if parsed is None:
        raise LlmError(f"{chosen} did not return the expected JSON object")
    devices, dropped = devices_from_reply(parsed, doc)
    if dropped:
        log.info(
            "lyricanalysis: dropped %d unanchored/unknown findings from %s/%s",
            dropped,
            chosen,
            chosen_model,
        )
    return devices, LlmPass(provider=chosen, model=chosen_model, ran_at=time.time())
