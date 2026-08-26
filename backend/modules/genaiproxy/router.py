"""Google Gemini native-REST proxy module.

A thin pass-through layer that forwards requests from theDAW's frontend to
Google's Generative Language API at ``https://generativelanguage.googleapis.com``
while injecting the server-side ``GEMINI_API_KEY`` (the same env var the in-app
assistant uses). The browser never sees the real key.

What this module does:
  - Replays an allowlisted path + method to Google, swapping in the server key
    as ``x-goog-api-key``.
  - Refuses callers that are not this machine's UI (see access.py). The key is
    the user's money; the server binds 0.0.0.0.
  - Strips any client-supplied ``key`` query param and ``authorization`` header
    so a frontend placeholder key cannot leak through or override the real one.
  - Returns Google's status, body, and content-type unchanged so the client SDK
    behaves exactly as if it had hit Google directly.

Mounted at /api/genai-proxy by backend/modules/loader.py (api_prefix in
module.json). The APIRouter here has NO prefix — the loader applies it.
"""

from __future__ import annotations

import json
import os
import re

import httpx
from fastapi import APIRouter, Request, Response

from . import access

router = APIRouter()

UPSTREAM_BASE = "https://generativelanguage.googleapis.com"

# The generation surface the app uses, plus the neighbouring endpoints an SDK
# call needs (uploads for large media, long-running operations, caches). Paths
# outside it -- tuned models, corpora, permissions -- are account management,
# never something a music UI asks for, so they stay closed even to a caller
# that passes the access gate. Version segments are matched loosely (v1, v1beta,
# v1beta2, v1alpha, ...) so a newer API version keeps working untouched.
_ALLOWED_PATH = re.compile(
    r"^(?:upload/)?v1[a-z0-9]*/"
    r"(?:models|cachedContents|files|media|operations|batches)(?:[/:].*)?$"
)


@router.api_route("/{rest:path}", methods=["GET", "POST", "OPTIONS"])
async def proxy(rest: str, request: Request) -> Response:
    """Forward an allowlisted path + method to Google, injecting the server key."""
    denial = access.denial_reason(request)
    if denial:
        return Response(
            status_code=403,
            content=json.dumps({"error": f"genai proxy: {denial}"}).encode(),
            media_type="application/json",
        )

    path = rest.lstrip("/")
    if not _ALLOWED_PATH.match(path):
        return Response(
            status_code=403,
            content=json.dumps({"error": "genai proxy: path not allowed"}).encode(),
            media_type="application/json",
        )

    body = await request.body()
    key = os.environ.get("GEMINI_API_KEY", "")

    if not key:
        return Response(
            status_code=503,
            content=b'{"error":"GEMINI_API_KEY not set on server"}',
            media_type="application/json",
        )

    url = f"{UPSTREAM_BASE}/{path}"

    # Pass through every query param except any client-supplied ``key`` (the real
    # key travels in the ``x-goog-api-key`` header instead) and our own access
    # token, which is for this hop only and must never reach Google.
    dropped = {"key", access.TOKEN_QUERY.lower()}
    params = {k: v for k, v in request.query_params.items() if k.lower() not in dropped}

    # Build a clean header set: only the content type and our server key. We
    # deliberately drop the client's authorization header and any placeholder key.
    headers = {
        "content-type": request.headers.get("content-type", "application/json"),
        "x-goog-api-key": key,
    }

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(120.0, read=120.0)
        ) as client:
            resp = await client.request(
                method=request.method,
                url=url,
                params=params,
                content=body,
                headers=headers,
            )
    except httpx.HTTPError as e:
        return Response(
            status_code=502,
            content=json.dumps({"error": str(e)}).encode(),
            media_type="application/json",
        )

    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type", "application/json"),
    )
