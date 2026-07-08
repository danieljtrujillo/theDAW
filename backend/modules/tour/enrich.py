"""Booking-contact enrichment: venue website scrape + LLM extraction, with
Gemini google_search grounding when no website is on record.

Reuses the assistant's provider registry wholesale (PROVIDERS/_get_api_key/
_chat_url in backend/assistant_routes.py), so whatever key works in the
assistant — Gemini, OpenAI, Anthropic, Grok, Groq, OpenRouter (free included)
— works here, resolved request-key > pool > env exactly like chat. Keys the
user typed into the assistant UI live in browser localStorage and arrive on
the request; nothing new to configure.

Two paths:
  * Venue HAS a website -> fetch the homepage + up to two likely contact/
    booking subpages (SSRF-guarded: resolved IP pinned, non-public addresses
    refused, redirects re-validated per hop, body size capped), strip to
    text, and ask the chosen provider's OpenAI-compatible chat endpoint for a
    strict-JSON contact extraction. Works with EVERY provider.
  * No website -> Gemini google_search grounding does search + extraction in
    one native generateContent call (decision 36). Other providers have no
    wired search tool yet, so they return a clear "needs Gemini" error
    instead of guessing.

Results cache per venue for a week under data/tour_cache/.
"""

from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import logging
import re
import socket
from typing import Any, Optional
from urllib.parse import urljoin, urlparse, urlunparse

import httpx

from backend.assistant_routes import (
    PROVIDERS,
    _chat_url,
    _fetch_gemini_models,
    _get_api_key,
)

from .discovery import USER_AGENT, UpstreamError, _cache_dir, _cache_get, _cache_put

log = logging.getLogger(__name__)

ENRICH_TTL_SEC = 7 * 24 * 3600
MAX_PAGE_BYTES = 500_000
MAX_PAGE_CHARS = 8_000
MAX_SUBPAGES = 2

GEMINI_NATIVE_BASE = "https://generativelanguage.googleapis.com/v1beta"

_EXTRACT_SYS = (
    "You extract music-venue booking contacts. Reply with ONE JSON object and "
    "nothing else, using exactly these keys: booking_email (string, '' if "
    "unknown), booking_form_url (string, '' if unknown), phone (string, '' if "
    "unknown), contact_name (string, '' if unknown), submission_notes (string: "
    "how the venue wants booking inquiries, '' if unknown), confidence (one of "
    "'high', 'medium', 'low'). Prefer booking/talent contacts over general "
    "info contacts. Never invent values."
)


# ── SSRF-guarded page fetching ───────────────────────────────────────────────
#
# Venue website tags are arbitrary user-editable OSM data, so every fetch is
# guarded against being pointed at localhost / the LAN / cloud metadata. Three
# layers, because each defeats a different bypass:
#   1. Resolve the host ourselves (non-blocking) and reject if ANY address is
#      non-public.
#   2. PIN the validated IP into the connection (httpx cannot re-resolve to a
#      rebound private address — closes DNS-rebinding TOCTOU).
#   3. Disable auto-redirects and re-run 1+2 on every Location hop (a public
#      host can no longer 302 us into the LAN).

MAX_REDIRECTS = 3


class _UnsafeUrl(Exception):
    """A URL or redirect target failed the SSRF guard."""


def _validated_public_ip(infos: list) -> Optional[str]:
    """From getaddrinfo results, return one address to pin — but only if EVERY
    resolved address is public. Any private/loopback/link-local/reserved/
    multicast/unspecified address fails the whole host."""
    chosen: Optional[str] = None
    for info in infos:
        addr = info[4][0]
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            return None
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            return None
        if chosen is None:
            chosen = addr
    return chosen


async def _resolve_public_ip(host: str) -> Optional[str]:
    """Non-blocking resolve (keeps the event loop free) + public-only check."""
    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except OSError:
        return None
    return _validated_public_ip(infos) if infos else None


async def _fetch_guarded(client: httpx.AsyncClient, url: str) -> str:
    """GET a URL under the full SSRF guard, following redirects manually and
    re-validating each hop, with a streamed body capped at MAX_PAGE_BYTES.
    Returns page text ('' when the response is non-200 or non-text). Raises
    _UnsafeUrl if the URL or any redirect target is unsafe/unresolvable."""
    current = url
    for _ in range(MAX_REDIRECTS + 1):
        p = urlparse(current)
        if p.scheme not in ("http", "https") or not p.hostname:
            raise _UnsafeUrl(current)
        ip = await _resolve_public_ip(p.hostname)
        if ip is None:
            raise _UnsafeUrl(current)
        port = p.port or (443 if p.scheme == "https" else 80)
        default_port = (p.scheme == "https" and port == 443) or (
            p.scheme == "http" and port == 80
        )
        host_header = p.hostname if default_port else f"{p.hostname}:{port}"
        pinned_netloc = f"[{ip}]:{port}" if ":" in ip else f"{ip}:{port}"
        pinned_url = urlunparse(
            (p.scheme, pinned_netloc, p.path or "/", p.params, p.query, "")
        )
        async with client.stream(
            "GET",
            pinned_url,
            headers={"Host": host_header, "User-Agent": USER_AGENT},
            extensions={"sni_hostname": p.hostname},
            follow_redirects=False,
        ) as resp:
            if resp.status_code in (301, 302, 303, 307, 308):
                location = resp.headers.get("location", "")
                if not location:
                    return ""
                current = urljoin(current, location)
                continue
            if resp.status_code != 200:
                return ""
            ctype = resp.headers.get("content-type", "")
            if "html" not in ctype and "text" not in ctype:
                return ""
            total = 0
            chunks: list[bytes] = []
            async for chunk in resp.aiter_bytes():
                chunks.append(chunk)
                total += len(chunk)
                if total >= MAX_PAGE_BYTES:
                    break
            raw = b"".join(chunks)[:MAX_PAGE_BYTES]
            encoding = resp.encoding or "utf-8"
            try:
                return raw.decode(encoding, errors="replace")
            except LookupError:
                return raw.decode("utf-8", errors="replace")
    raise _UnsafeUrl(f"too many redirects for {url!r}")


_TAG_STRIP = re.compile(r"<(script|style)[^>]*>.*?</\1>", re.IGNORECASE | re.DOTALL)
_TAGS = re.compile(r"<[^>]+>")
_WS = re.compile(r"[ \t\r\f\v]*\n[ \t\r\f\v]*|[ \t\r\f\v]{2,}")


def _html_to_text(html: str) -> str:
    text = _TAG_STRIP.sub(" ", html)
    text = _TAGS.sub(" ", text)
    text = (
        text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
    )
    return _WS.sub("\n", text).strip()[:MAX_PAGE_CHARS]


_CONTACT_HREF = re.compile(
    r'href=["\']([^"\']*(?:contact|booking|book-|hire|events?|about)[^"\']*)["\']',
    re.IGNORECASE,
)


def _contact_links(html: str, base_url: str) -> list[str]:
    base_host = urlparse(base_url).hostname
    out: list[str] = []
    for match in _CONTACT_HREF.findall(html):
        absolute = urljoin(base_url, match)
        p = urlparse(absolute)
        if p.scheme not in ("http", "https") or p.hostname != base_host:
            continue
        if absolute not in out:
            out.append(absolute)
        if len(out) >= MAX_SUBPAGES:
            break
    return out


async def _gather_site_text(website: str) -> list[dict[str, str]]:
    """Homepage + likely contact/booking subpages as stripped text blocks."""
    blocks: list[dict[str, str]] = []
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            home_html = await _fetch_guarded(client, website)
        except _UnsafeUrl as exc:
            raise UpstreamError(
                f"Refusing to fetch {exc} (unsafe or unresolvable)."
            ) from exc
        except httpx.HTTPError as exc:
            raise UpstreamError(f"Could not fetch venue site: {exc}") from exc
        if home_html:
            blocks.append({"url": website, "text": _html_to_text(home_html)})
            for link in _contact_links(home_html, website):
                try:
                    sub_html = await _fetch_guarded(client, link)
                except (_UnsafeUrl, httpx.HTTPError):
                    continue
                if sub_html:
                    blocks.append({"url": link, "text": _html_to_text(sub_html)})
    return [b for b in blocks if b["text"]]


# ── LLM extraction ───────────────────────────────────────────────────────────


def _parse_json_block(text: str) -> Optional[dict[str, Any]]:
    """Find the first JSON object in a completion (models love to add prose)."""
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                try:
                    parsed = json.loads(text[start : i + 1])
                    return parsed if isinstance(parsed, dict) else None
                except json.JSONDecodeError:
                    return None
    return None


def _normalize(raw: dict[str, Any], source_url: str) -> dict[str, Any]:
    def s(key: str) -> str:
        v = raw.get(key)
        return v.strip() if isinstance(v, str) else ""

    confidence = s("confidence").lower()
    if confidence not in ("high", "medium", "low"):
        confidence = "low"
    return {
        "booking_email": s("booking_email"),
        "booking_form_url": s("booking_form_url"),
        "phone": s("phone"),
        "contact_name": s("contact_name"),
        "submission_notes": s("submission_notes"),
        "confidence": confidence,
        "source_url": source_url,
    }


def _venue_header(venue: dict[str, Any]) -> str:
    return (
        f"Venue: {venue.get('name', '')}\n"
        f"Category: {venue.get('category', '')}\n"
        f"Address: {venue.get('address', '')}\n"
        f"Known phone: {venue.get('phone', '')}\n"
        f"Known email: {venue.get('email', '')}\n"
    )


async def _chat_extract(
    provider: str,
    model: str,
    api_key: str,
    venue: dict[str, Any],
    blocks: list[dict[str, str]],
) -> dict[str, Any]:
    """Extraction over fetched page text via the provider's OpenAI-compatible
    chat endpoint — the exact transport the assistant uses for every provider."""
    pages = "\n\n".join(f"--- PAGE {b['url']} ---\n{b['text']}" for b in blocks)
    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": _EXTRACT_SYS},
            {
                "role": "user",
                "content": f"{_venue_header(venue)}\nWebsite pages:\n{pages}",
            },
        ],
        "temperature": 0.1,
        "max_tokens": 500,
    }
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                _chat_url(provider),
                json=body,
                headers={"Authorization": f"Bearer {api_key}"},
            )
    except httpx.HTTPError as exc:
        raise UpstreamError(f"{provider} unreachable: {exc}") from exc
    if resp.status_code != 200:
        detail = resp.text[:300]
        raise UpstreamError(f"{provider} returned HTTP {resp.status_code}: {detail}")
    try:
        content = resp.json()["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
        raise UpstreamError(f"{provider} response malformed: {exc}") from exc
    parsed = _parse_json_block(content)
    if parsed is None:
        raise UpstreamError(f"{provider} did not return the expected JSON object.")
    return _normalize(parsed, blocks[0]["url"] if blocks else "")


async def _gemini_search_extract(
    model: str, api_key: str, venue: dict[str, Any]
) -> dict[str, Any]:
    """No website on record: one native generateContent call with the
    google_search grounding tool does search + extraction together."""
    prompt = (
        f"{_EXTRACT_SYS}\n\nFind the official website / booking page for this "
        f"music venue and extract its booking contact.\n{_venue_header(venue)}"
    )
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "tools": [{"google_search": {}}],
    }
    url = f"{GEMINI_NATIVE_BASE}/models/{model}:generateContent"
    try:
        async with httpx.AsyncClient(timeout=90.0) as client:
            resp = await client.post(
                url, json=body, headers={"x-goog-api-key": api_key}
            )
    except httpx.HTTPError as exc:
        raise UpstreamError(f"Gemini unreachable: {exc}") from exc
    if resp.status_code != 200:
        raise UpstreamError(
            f"Gemini returned HTTP {resp.status_code}: {resp.text[:300]}"
        )
    try:
        parts = resp.json()["candidates"][0]["content"]["parts"]
        text = " ".join(p.get("text", "") for p in parts)
    except (KeyError, IndexError, TypeError, json.JSONDecodeError) as exc:
        raise UpstreamError(f"Gemini response malformed: {exc}") from exc
    parsed = _parse_json_block(text)
    if parsed is None:
        raise UpstreamError("Gemini grounding did not return the expected JSON object.")
    return _normalize(parsed, "google_search")


# ── Orchestration ────────────────────────────────────────────────────────────

# The app's model catalog carries UI aliases (e.g. "gemini-flash-recent") that
# the Gemini API itself does not accept. Resolve aliases against the LIVE
# model list — per the repo's hard rule, model ids are never written from
# memory. Cached for the process lifetime.
_gemini_model_cache: Optional[str] = None

_VERSION_RE = re.compile(r"gemini-(\d+)\.(\d+)")
_EXCLUDE_TOKENS = ("image", "live", "tts", "audio", "embedding", "thinking", "robotics")


async def _resolve_gemini_model(api_key: str, requested: str) -> str:
    global _gemini_model_cache
    req = (requested or "").strip()
    if req and req != "gemini-flash-recent":
        return req
    if _gemini_model_cache:
        return _gemini_model_cache

    try:
        models = await _fetch_gemini_models(api_key)
    except Exception as exc:  # noqa: BLE001 — surface as a provider error
        raise UpstreamError(f"Could not list Gemini models: {exc}") from exc

    def version(mid: str) -> tuple[int, int]:
        m = _VERSION_RE.match(mid)
        return (int(m.group(1)), int(m.group(2))) if m else (0, 0)

    flash = [
        m["id"]
        for m in models
        if "flash" in m["id"] and not any(t in m["id"] for t in _EXCLUDE_TOKENS)
    ]
    if not flash:
        raise UpstreamError("No Gemini flash model available on this key.")
    # Newest version wins; among equals prefer stable ids over preview/exp.
    flash.sort(
        key=lambda i: (version(i), "preview" not in i and "exp" not in i, i),
        reverse=True,
    )
    chosen = str(flash[0])
    _gemini_model_cache = chosen
    log.info("tour: resolved gemini enrichment model -> %s", chosen)
    return chosen


def resolve_provider_key(provider: str, request_key: Optional[str]) -> str:
    if provider not in PROVIDERS:
        raise UpstreamError(f"Unknown provider {provider!r}.")
    key = _get_api_key(provider, request_key)
    if not key:
        raise UpstreamError(
            f"No API key for {provider} — add one in the assistant panel or set "
            f"{PROVIDERS[provider].get('env_key', 'its env var')}."
        )
    return key


# Serialize outbound enrichment so a flood of /enrich requests (each spends the
# user's LLM key and fetches an arbitrary site) cannot run in parallel; the
# lock bounds concurrency and cost to one in-flight call at a time.
_enrich_lock = asyncio.Lock()

# Bound the on-disk cache: each enrich writes one small JSON file, but a caller
# looping fresh ids would otherwise grow the dir without limit.
MAX_CACHE_ENTRIES = 1000


def _prune_enrich_cache() -> None:
    try:
        files = sorted(
            _cache_dir().glob("enrich_*.json"), key=lambda f: f.stat().st_mtime
        )
    except OSError:
        return
    for stale in files[:-MAX_CACHE_ENTRIES]:
        try:
            stale.unlink()
        except OSError:
            pass


async def enrich_venue(
    venue: dict[str, Any],
    provider: str,
    model: Optional[str],
    request_key: Optional[str],
    force: bool = False,
) -> dict[str, Any]:
    vid = str(venue.get("id") or "").strip()
    if not vid:
        raise UpstreamError("Venue id missing.")
    # Hash the client-controlled id into the cache filename — a raw id like
    # "../../tour_keys" would otherwise let the write/read escape the cache dir.
    cache_name = "enrich_" + hashlib.sha1(vid.encode("utf-8")).hexdigest()[:16]
    if not force:
        cached = _cache_get(cache_name, ENRICH_TTL_SEC)
        if cached is not None:
            return {**cached, "cached": True}

    api_key = resolve_provider_key(provider, request_key)

    # One outbound enrichment at a time (bounds LLM spend + fetch concurrency).
    async with _enrich_lock:
        # Another request may have populated the cache while we waited.
        if not force:
            cached = _cache_get(cache_name, ENRICH_TTL_SEC)
            if cached is not None:
                return {**cached, "cached": True}

        if provider == "gemini":
            chosen_model = await _resolve_gemini_model(api_key, model or "")
        else:
            chosen_model = (model or "").strip() or str(
                PROVIDERS[provider]["default_model"]
            )

        website = str(venue.get("website") or "").strip()
        if website:
            blocks = await _gather_site_text(website)
            if not blocks:
                raise UpstreamError("The venue site returned no readable pages.")
            result = await _chat_extract(provider, chosen_model, api_key, venue, blocks)
        elif provider == "gemini":
            result = await _gemini_search_extract(chosen_model, api_key, venue)
        else:
            raise UpstreamError(
                "No website on record for this venue — web-search enrichment "
                "currently runs on the Gemini provider only. Pick Gemini, or add "
                "the venue's website to OSM."
            )

        result["provider"] = provider
        result["model"] = chosen_model
        _cache_put(cache_name, result)
        _prune_enrich_cache()
    return {**result, "cached": False}
