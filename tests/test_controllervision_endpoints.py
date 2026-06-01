"""Contract tests for the /api/controllervision router."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from backend.modules.controllervision import router as router_module
from backend.modules.controllervision import session as pairing


@pytest.fixture(autouse=True)
def _reset_pairing_sessions():
    with pairing._lock:
        pairing._sessions.clear()
    yield
    with pairing._lock:
        pairing._sessions.clear()


@pytest.fixture
def client() -> TestClient:
    app = FastAPI()
    app.include_router(router_module.router, prefix="/api/controllervision")
    return TestClient(app)


def test_capabilities_endpoint_reports_cv_and_ai_metadata(monkeypatch, client: TestClient):
    monkeypatch.setattr(router_module, "cv_available", lambda: True)
    monkeypatch.setattr(
        router_module, "pick_vision_provider", lambda: ("openai", "gpt-4.1-mini")
    )

    response = client.get("/api/controllervision/")

    assert response.status_code == 200
    body = response.json()
    assert body == {
        "ok": True,
        "available": True,
        "engine": "opencv (classical: hough circles + contour shape)",
        "ai_available": True,
        "ai_provider": "openai/gpt-4.1-mini",
        "note": "AI identify uses your Assistant keys; classical CV needs opencv; mapping still comes from MIDI",
    }


def test_detect_endpoint_returns_upload_source_and_counts(monkeypatch, client: TestClient):
    monkeypatch.setattr(router_module, "cv_available", lambda: True)
    monkeypatch.setattr(
        router_module,
        "detect_controls_in_image",
        lambda image_bytes: {
            "available": True,
            "controls": [{"kind": "knob", "cx": 0.5, "cy": 0.5, "w": 0.1, "h": 0.1}],
            "counts": {"knob": 1, "fader": 0, "pad": 0},
        },
    )

    response = client.post(
        "/api/controllervision/detect",
        files={"image_file": ("controller.jpg", b"fake-image", "image/jpeg")},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["available"] is True
    assert body["counts"] == {"knob": 1, "fader": 0, "pad": 0}
    assert body["controls"][0]["kind"] == "knob"
    assert body["source"] == "upload"


def test_ai_identify_endpoint_returns_upload_source(monkeypatch, client: TestClient):
    async def fake_identify(image_bytes: bytes, mime: str = "image/jpeg"):
        assert image_bytes == b"fake-image"
        assert mime == "image/png"
        return {
            "available": True,
            "brand": "Novation",
            "model": "Launchkey",
            "counts": {"knob": 8, "fader": 9, "pad": 16},
        }

    monkeypatch.setattr(router_module, "identify_with_vision_llm", fake_identify)

    response = client.post(
        "/api/controllervision/identify",
        files={"image_file": ("controller.png", b"fake-image", "image/png")},
    )

    assert response.status_code == 200
    assert response.json() == {
        "available": True,
        "brand": "Novation",
        "model": "Launchkey",
        "counts": {"knob": 8, "fader": 9, "pad": 16},
        "source": "upload",
    }


def test_detect_by_name_returns_empty_contract_when_no_hit(
    monkeypatch, client: TestClient
):
    async def fake_search(query: str):
        assert query == "Launchkey 49"
        return None

    monkeypatch.setattr(router_module, "cv_available", lambda: True)
    monkeypatch.setattr(router_module, "search_wikimedia_image", fake_search)

    response = client.post(
        "/api/controllervision/detect-by-name",
        data={"device_name": "  Launchkey 49  "},
    )

    assert response.status_code == 200
    assert response.json() == {
        "available": True,
        "found": False,
        "query": "Launchkey 49",
        "controls": [],
        "counts": {},
    }


def test_phone_pairing_session_round_trips_result(monkeypatch, client: TestClient):
    monkeypatch.setattr(router_module, "pick_vision_provider", lambda: None)
    monkeypatch.setattr(router_module, "cv_available", lambda: True)
    monkeypatch.setattr(
        router_module,
        "detect_controls_in_image",
        lambda image_bytes: {
            "available": True,
            "counts": {"knob": 2, "fader": 1, "pad": 4},
            "controls": [],
        },
    )

    create_response = client.post("/api/controllervision/session")
    assert create_response.status_code == 200
    created = create_response.json()
    sid = created["id"]
    assert created["mobile_path"] == f"/api/controllervision/m/{sid}"

    pending_response = client.get(f"/api/controllervision/session/{sid}")
    assert pending_response.status_code == 200
    assert pending_response.json() == {"id": sid, "status": "pending"}

    upload_response = client.post(
        f"/api/controllervision/session/{sid}/upload",
        files={"image_file": ("controller.jpg", b"fake-image", "image/jpeg")},
    )
    assert upload_response.status_code == 200
    assert upload_response.json() == {
        "ok": True,
        "counts": {"knob": 2, "fader": 1, "pad": 4},
        "brand": None,
        "model": None,
    }

    ready_response = client.get(f"/api/controllervision/session/{sid}")
    assert ready_response.status_code == 200
    assert ready_response.json() == {
        "id": sid,
        "status": "ready",
        "result": {
            "available": True,
            "counts": {"knob": 2, "fader": 1, "pad": 4},
            "controls": [],
            "source": "phone",
        },
    }


def test_phone_upload_returns_404_when_session_expires_before_store(
    monkeypatch, client: TestClient
):
    monkeypatch.setattr(router_module, "pick_vision_provider", lambda: None)
    monkeypatch.setattr(router_module, "cv_available", lambda: True)
    monkeypatch.setattr(
        router_module,
        "detect_controls_in_image",
        lambda image_bytes: {"available": True, "counts": {}, "controls": []},
    )
    monkeypatch.setattr(pairing, "session_exists", lambda sid: True)
    monkeypatch.setattr(pairing, "set_result", lambda sid, result: False)

    response = client.post(
        "/api/controllervision/session/expired/upload",
        files={"image_file": ("controller.jpg", b"fake-image", "image/jpeg")},
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "session not found or expired"
