"""Status codes for the Hugging Face auth router (backend.modules.hfauth).

The point of this suite is one distinction the app got wrong for two days
(gantasmo/theDAW#144): a 502 anywhere in theDAW means a gateway in front of the
backend could not reach the backend, so nothing upstream was contacted. This
router's own upstream failures are the OPPOSITE fact and must never borrow that
code -- they answer 503 plus the ``x-thedaw-hop: huggingface`` marker. The
frontend reads both (frontend/src/lib/hfAuthClient.ts).

``_whoami`` is monkeypatched in the router namespace, so nothing here touches
the network or the user's real token file.
"""

from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.modules.hfauth import router as hfauth


@pytest.fixture
def client(monkeypatch, tmp_path):
    """A TestClient over an app mounting only the hfauth router.

    The token path points at a tmp file and the whoami cache is reset, so a test
    can never read or write the developer's real ~/.cache token.
    """
    monkeypatch.setattr(hfauth, "_TOKEN_PATH", tmp_path / "token")
    monkeypatch.delenv("HF_TOKEN", raising=False)
    with hfauth._cache_lock:
        hfauth._cache.update(
            {"token": None, "checked_at": 0.0, "logged_in": None, "username": None}
        )

    app = FastAPI()
    app.include_router(hfauth.router, prefix="/api/hfauth")
    with TestClient(app) as test_client:
        yield test_client


def _status_error(code: int) -> httpx.HTTPStatusError:
    """What httpx raises when the Hub answers with ``code``."""
    request = httpx.Request("GET", hfauth._WHOAMI_URL)
    return httpx.HTTPStatusError(
        f"HTTP {code}", request=request, response=httpx.Response(code, request=request)
    )


def test_rejected_token_is_401(client, monkeypatch):
    """The Hub's verdict on the token itself -- not a transport failure."""

    def reject(token, timeout):
        raise _status_error(401)

    monkeypatch.setattr(hfauth, "_whoami", reject)
    resp = client.post("/api/hfauth/login", json={"token": "hf_bad"})
    assert resp.status_code == 401
    assert resp.json()["detail"] == "Invalid Hugging Face token"
    assert hfauth.HOP_HEADER not in resp.headers


def test_hub_answered_badly_is_503_and_names_the_hop(client, monkeypatch):
    """A non-auth HTTP error from huggingface.co. Was 502, which collided with
    the gateway's "we never reached the backend" -- the exact inversion in #144."""

    def hub_500(token, timeout):
        raise _status_error(500)

    monkeypatch.setattr(hfauth, "_whoami", hub_500)
    resp = client.post("/api/hfauth/login", json={"token": "hf_good"})
    assert resp.status_code == 503, "502 means OUR backend was never reached"
    assert resp.headers[hfauth.HOP_HEADER] == hfauth.HOP_HUGGINGFACE
    assert resp.json()["detail"] == "huggingface.co returned HTTP 500"


def test_hub_unreachable_is_503_and_names_the_hop(client, monkeypatch):
    """No answer at all from the Hub: same hop, same status, its own words."""

    def offline(token, timeout):
        raise httpx.ConnectError("getaddrinfo failed")

    monkeypatch.setattr(hfauth, "_whoami", offline)
    resp = client.post("/api/hfauth/login", json={"token": "hf_good"})
    assert resp.status_code == 503
    assert resp.headers[hfauth.HOP_HEADER] == hfauth.HOP_HUGGINGFACE
    detail = resp.json()["detail"]
    assert detail.startswith("Could not reach huggingface.co:")
    assert "getaddrinfo failed" in detail


def test_odd_payload_is_503_not_500(client, monkeypatch):
    """A whoami answer with no username is still an upstream problem."""

    def nonsense(token, timeout):
        raise ValueError("whoami response had no username")

    monkeypatch.setattr(hfauth, "_whoami", nonsense)
    resp = client.post("/api/hfauth/login", json={"token": "hf_good"})
    assert resp.status_code == 503
    assert resp.headers[hfauth.HOP_HEADER] == hfauth.HOP_HUGGINGFACE


def test_login_never_answers_502(client, monkeypatch):
    """The guard, stated directly: no failure of this router may answer 502."""
    failures = [
        _status_error(500),
        _status_error(429),
        httpx.ReadTimeout("timed out"),
        httpx.ConnectError("refused"),
        ValueError("odd payload"),
    ]
    for exc in failures:

        def raiser(token, timeout, exc=exc):
            raise exc

        monkeypatch.setattr(hfauth, "_whoami", raiser)
        resp = client.post("/api/hfauth/login", json={"token": "hf_good"})
        assert resp.status_code != 502, f"{type(exc).__name__} answered 502"


def test_successful_login_stores_the_token(client, monkeypatch, tmp_path):
    """The happy path still works, and writes the hub's standard token file."""
    monkeypatch.setattr(hfauth, "_whoami", lambda token, timeout: "someone")
    resp = client.post("/api/hfauth/login", json={"token": "hf_good"})
    assert resp.status_code == 200
    assert resp.json() == {"logged_in": True, "username": "someone"}
    assert (tmp_path / "token").read_text(encoding="utf-8") == "hf_good"


def test_status_reports_signed_out_without_a_token(client):
    """No token on disk and no env var: a real, measured "no"."""
    resp = client.get("/api/hfauth/status")
    assert resp.status_code == 200
    assert resp.json()["logged_in"] is False
    assert resp.json()["token_source"] == "none"


def test_status_never_fails_when_the_hub_is_down(client, monkeypatch, tmp_path):
    """An offline check caches "unknown", so /status stays 200 with
    ``logged_in: null`` instead of logging an offline user out."""
    (tmp_path / "token").write_text("hf_good", encoding="utf-8")

    def offline(token, timeout):
        raise httpx.ConnectError("offline")

    monkeypatch.setattr(hfauth, "_whoami", offline)
    resp = client.get("/api/hfauth/status")
    assert resp.status_code == 200
    body = resp.json()
    assert body["logged_in"] is None
    assert body["token_source"] == "stored"
