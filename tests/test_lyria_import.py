"""INT-002 -- backend.modules.lyria.importer, the sidecar -> library hand-off.

Covers, against a throwaway `http.server` standing in for the unmodified Lyria
app (the same device tests/test_lyria_b12.py uses, for the same reason: no real
npm/node process, no external network, no paid call):

  * A first sync imports every non-mock generation, with the title, prompt,
    lyrics, model, duration, tags, notes and audio BYTES the entry is supposed
    to carry.
  * A second sync imports nothing -- the seen map is what makes the panel's
    30 s timer safe.
  * `provider == "mock"` entries are skipped by default and imported only when
    the caller asks, because the sidecar's default cost-safe mode synthesizes
    them locally and a user's library is not a test fixture.
  * Nothing listening on the port is a no-op with a reason, never an exception.
  * An `audioUrl` pointing anywhere but the sidecar's own loopback origin is
    refused rather than fetched -- it arrives over HTTP and would otherwise be
    a server-side request forgery primitive.
  * Two concurrent syncs import once.
  * A `lyria`-tagged / `lyria`-modelled record resolves to provider `lyria`
    through the real provider tables, so the badge, the filter and the facet
    agree.

Every test writes into `tmp_path`: the library root through
`theDAW_GENERATIONS_DIR` (store.default_library_root) and the seen map through
`theDAW_LYRIA_IMPORTS_FILE` (importer.seen_map_path), so theDAW's real `data/`
tree is never touched.
"""

from __future__ import annotations

import asyncio
import http.server
import json
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator, Optional

import pytest

from backend.modules.lyria import importer, sidecar

# A tiny but real RIFF/WAVE header + payload, so `import_blob`'s tag reader and
# cover extractor are handed a file rather than a blob of noise.
WAV_ONE = b"RIFF$\x00\x00\x00WAVEfmt \x10\x00\x00\x00" + b"\x01\x00" * 8 + b"one-audio"
WAV_TWO = b"RIFF$\x00\x00\x00WAVEfmt \x10\x00\x00\x00" + b"\x01\x00" * 8 + b"two-audio"
MP3_ONE = b"ID3\x03\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x00" + b"mp3-audio"


def _generation(
    gen_id: str,
    *,
    provider: str = "gemini",
    fmt: str = "wav",
    title: Optional[str] = None,
    analysis: Optional[dict[str, Any]] = None,
    audio_url: Optional[str] = None,
) -> dict[str, Any]:
    item: dict[str, Any] = {
        "id": gen_id,
        "model": "lyria-3-pro",
        "format": fmt,
        "provider": provider,
        "prompt": f"prompt for {gen_id}",
        "lyrics": f"lyrics for {gen_id}",
        "generatedAt": "2026-09-23T10:00:00.000Z",
        "durationSeconds": 42.5,
        "audioUrl": audio_url
        if audio_url is not None
        else f"/generations/{gen_id}.{fmt}",
    }
    if title is not None:
        item["title"] = title
    if analysis is not None:
        item["analysis"] = analysis
    return item


class _SidecarState:
    """What the fake sidecar serves. Mutable so a test can change the listing
    between two syncs without restarting the server."""

    def __init__(self) -> None:
        self.generations: list[dict[str, Any]] = []
        self.audio: dict[str, bytes] = {}
        self.audio_hits: list[str] = []
        self.listing_hits = 0
        # False makes it a squatter: it serves the same listing path but does
        # not answer Lyria's /api/settings/status the way the real app does.
        self.is_lyria = True


def _handler_for(state: _SidecarState) -> type[http.server.BaseHTTPRequestHandler]:
    class _Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args: object) -> None:  # noqa: D102 - quiet tests
            pass

        def _send(self, code: int, body: bytes, content_type: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:  # noqa: N802 - stdlib method name
            if self.path == "/api/settings/status" and state.is_lyria:
                # The shape sidecar._is_lyria_server checks for.
                body = json.dumps(
                    {
                        "geminiServerKey": False,
                        "openRouterServerKey": False,
                        "defaultProvider": "gemini",
                    }
                ).encode("utf-8")
                self._send(200, body, "application/json")
                return
            if self.path == "/api/generations":
                state.listing_hits += 1
                body = json.dumps({"generations": state.generations}).encode("utf-8")
                self._send(200, body, "application/json")
                return
            if self.path in state.audio:
                state.audio_hits.append(self.path)
                self._send(200, state.audio[self.path], "application/octet-stream")
                return
            self.send_response(404)
            self.end_headers()

    return _Handler


@contextmanager
def _fake_sidecar(state: _SidecarState) -> Iterator[int]:
    server = http.server.HTTPServer(("127.0.0.1", 0), _handler_for(state))
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield port
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5.0)


@pytest.fixture
def lyria_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A temp library root and a temp seen map. theDAW's real data/ is never
    written by this module's tests."""
    root = tmp_path / "library"
    root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("theDAW_GENERATIONS_DIR", str(root))
    monkeypatch.setenv("theDAW_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv(importer.SEEN_MAP_ENV, str(tmp_path / "lyria_imports.json"))
    # library.router caches ONE store in a module global; a test's temp root
    # must not leak into the next test's.
    from backend.modules.library import router as library_router

    monkeypatch.setattr(library_router, "_store", None)
    return root


def _point_sidecar_at(monkeypatch: pytest.MonkeyPatch, port: int) -> None:
    """Make `resolve_config().port` the fake server's ephemeral port."""
    monkeypatch.setenv("theDAW_LYRIA_PORT", str(port))


def _entries() -> list[Any]:
    from backend.modules.library.router import get_store

    return get_store().list_entries()


# ---------------------------------------------------------------------------
# The happy path, twice
# ---------------------------------------------------------------------------


def test_first_sync_imports_every_non_mock_generation_with_its_metadata(
    lyria_env: Path, monkeypatch: pytest.MonkeyPatch
):
    state = _SidecarState()
    state.generations = [
        _generation(
            "abcdef0123456789",
            title="Neon Rain",
            analysis={
                "title": "Neon Rain (analysed)",
                "genre": "Synthwave",
                "mood": "dreamy",
                "bpm": 118,
                "key": "A minor",
                "instrumentation": ["synth", "drums"],
                "sections": [{"name": "intro", "start": 0, "end": 8}],
                "notes": "ignored -- the entry's notes are the summary line",
            },
        ),
        _generation("fedcba9876543210", fmt="mp3", provider="openrouter"),
    ]
    state.audio = {
        "/generations/abcdef0123456789.wav": WAV_ONE,
        "/generations/fedcba9876543210.mp3": MP3_ONE,
    }

    with _fake_sidecar(state) as port:
        _point_sidecar_at(monkeypatch, port)
        result = asyncio.run(importer.sync_generations())

    assert len(result["imported"]) == 2
    assert result["skipped"] == 0
    assert "reason" not in result

    by_title = {r.title: r for r in _entries()}
    assert set(by_title) == {"Neon Rain", "lyria_fedcba98"}

    first = by_title["Neon Rain"]
    assert first.model == "lyria"
    assert first.source == "generate"
    assert first.prompt == "prompt for abcdef0123456789"
    assert first.lyrics == "lyrics for abcdef0123456789"
    assert first.duration == pytest.approx(42.5)
    assert first.mime_type == "audio/wav"
    assert first.audio_filename == "Neon Rain.wav"
    assert first.notes == "Synthwave / dreamy / 118 BPM / A minor"
    assert {"lyria", "lyriaid:abcdef0123456789", "lyria-provider:gemini"} <= set(
        first.tags
    )

    # The real bytes, not a placeholder.
    from backend.modules.library.router import get_store

    entry_dir = get_store().root / first.id
    assert (entry_dir / "Neon Rain.wav").read_bytes() == WAV_ONE

    # No title on the second one: the filename falls back to the generation id
    # and the entry title to the documented `lyria_<id[:8]>`.
    second = by_title["lyria_fedcba98"]
    assert second.audio_filename == "fedcba9876543210.mp3"
    assert second.mime_type == "audio/mpeg"
    assert second.notes == ""
    assert "lyria-provider:openrouter" in second.tags

    seen = importer.load_seen_map()
    assert seen == {
        "abcdef0123456789": first.id,
        "fedcba9876543210": second.id,
    }


def test_second_sync_imports_nothing_new(
    lyria_env: Path, monkeypatch: pytest.MonkeyPatch
):
    state = _SidecarState()
    state.generations = [_generation("g1", title="One")]
    state.audio = {"/generations/g1.wav": WAV_ONE}

    with _fake_sidecar(state) as port:
        _point_sidecar_at(monkeypatch, port)
        first = asyncio.run(importer.sync_generations())
        second = asyncio.run(importer.sync_generations())

    assert len(first["imported"]) == 1
    assert second == {"imported": [], "skipped": 1}
    assert len(_entries()) == 1
    # The second run listed, but downloaded nothing.
    assert state.listing_hits == 2
    assert state.audio_hits == ["/generations/g1.wav"]


def test_a_new_generation_after_a_sync_is_the_only_thing_the_next_one_takes(
    lyria_env: Path, monkeypatch: pytest.MonkeyPatch
):
    state = _SidecarState()
    state.generations = [_generation("g1", title="One")]
    state.audio = {"/generations/g1.wav": WAV_ONE, "/generations/g2.wav": WAV_TWO}

    with _fake_sidecar(state) as port:
        _point_sidecar_at(monkeypatch, port)
        asyncio.run(importer.sync_generations())
        # Newest first, exactly as the sidecar lists them.
        state.generations = [_generation("g2", title="Two"), *state.generations]
        second = asyncio.run(importer.sync_generations())

    assert len(second["imported"]) == 1
    assert second["skipped"] == 1
    assert {r.title for r in _entries()} == {"One", "Two"}


# ---------------------------------------------------------------------------
# Mock entries
# ---------------------------------------------------------------------------


def test_mock_entries_are_skipped_by_default_and_imported_on_request(
    lyria_env: Path, monkeypatch: pytest.MonkeyPatch
):
    state = _SidecarState()
    state.generations = [
        _generation("real1", title="Real", provider="gemini"),
        _generation("mock1", title="Mock", provider="mock"),
    ]
    state.audio = {
        "/generations/real1.wav": WAV_ONE,
        "/generations/mock1.wav": WAV_TWO,
    }

    with _fake_sidecar(state) as port:
        _point_sidecar_at(monkeypatch, port)
        default_run = asyncio.run(importer.sync_generations())
        assert len(default_run["imported"]) == 1
        assert default_run["skipped"] == 1
        assert {r.title for r in _entries()} == {"Real"}

        opted_in = asyncio.run(importer.sync_generations(include_mock=True))

    assert len(opted_in["imported"]) == 1
    titles = {r.title for r in _entries()}
    assert titles == {"Real", "Mock"}
    mock_entry = next(r for r in _entries() if r.title == "Mock")
    assert "lyria-provider:mock" in mock_entry.tags


# ---------------------------------------------------------------------------
# Sidecar down
# ---------------------------------------------------------------------------


def test_sidecar_not_running_is_a_no_op_with_a_reason(
    lyria_env: Path, monkeypatch: pytest.MonkeyPatch
):
    # Bind and release an ephemeral port so we have one nothing is on.
    state = _SidecarState()
    with _fake_sidecar(state) as port:
        pass
    _point_sidecar_at(monkeypatch, port)

    assert not sidecar._port_is_listening(port)
    result = asyncio.run(importer.sync_generations())

    assert result == {"imported": [], "skipped": 0, "reason": "sidecar not running"}
    assert _entries() == []
    assert not importer.seen_map_path().exists()


def test_another_program_on_the_port_is_never_asked_for_generations(
    lyria_env: Path, monkeypatch: pytest.MonkeyPatch
):
    """Some other HTTP server holds the sidecar's port and happens to serve a
    /api/generations path. The 30 s sync must check it is Lyria first: it is
    never asked for a listing, nothing is downloaded, nothing is imported."""
    state = _SidecarState()
    state.is_lyria = False
    state.generations = [_generation("squat-1", title="Not Lyria")]
    state.audio = {"/generations/squat-1.wav": WAV_ONE}

    with _fake_sidecar(state) as port:
        _point_sidecar_at(monkeypatch, port)
        result = asyncio.run(importer.sync_generations())

    assert result["imported"] == []
    assert "not Lyria" in result["reason"]
    assert state.listing_hits == 0
    assert state.audio_hits == []
    assert _entries() == []
    assert not importer.seen_map_path().exists()


# ---------------------------------------------------------------------------
# SSRF: the audio may only come from the sidecar's own loopback origin
# ---------------------------------------------------------------------------


def test_an_audio_url_off_the_sidecars_origin_is_refused(
    lyria_env: Path, monkeypatch: pytest.MonkeyPatch
):
    state = _SidecarState()
    state.generations = [
        _generation("evil", title="Evil", audio_url="http://example.com/track.wav"),
        _generation("proto", title="Proto", audio_url="//attacker.invalid/track.wav"),
        _generation("ok", title="Fine"),
    ]
    state.audio = {"/generations/ok.wav": WAV_ONE}

    with _fake_sidecar(state) as port:
        _point_sidecar_at(monkeypatch, port)
        result = asyncio.run(importer.sync_generations())

    assert len(result["imported"]) == 1
    assert result["skipped"] == 2
    assert {r.title for r in _entries()} == {"Fine"}
    assert importer.load_seen_map().keys() == {"ok"}


def test_resolve_audio_url_rejects_every_origin_but_the_sidecars():
    origin = "http://127.0.0.1:5188"
    ok = importer.resolve_audio_url("/generations/x.wav", origin, 5188)
    assert ok == "http://127.0.0.1:5188/generations/x.wav"
    assert importer.resolve_audio_url("http://127.0.0.1:5188/a.wav", origin, 5188)
    # Another loopback service -- theDAW's own backend answers on 8600.
    assert (
        importer.resolve_audio_url("http://127.0.0.1:8600/a.wav", origin, 5188) is None
    )
    assert importer.resolve_audio_url("http://example.com/a.wav", origin, 5188) is None
    assert importer.resolve_audio_url("//example.com/a.wav", origin, 5188) is None
    assert importer.resolve_audio_url("file:///etc/passwd", origin, 5188) is None
    assert importer.resolve_audio_url("", origin, 5188) is None
    assert importer.resolve_audio_url(None, origin, 5188) is None


# ---------------------------------------------------------------------------
# Concurrency
# ---------------------------------------------------------------------------


def test_concurrent_syncs_import_each_generation_once(
    lyria_env: Path, monkeypatch: pytest.MonkeyPatch
):
    state = _SidecarState()
    state.generations = [
        _generation("c1", title="C1"),
        _generation("c2", title="C2"),
    ]
    state.audio = {"/generations/c1.wav": WAV_ONE, "/generations/c2.wav": WAV_TWO}

    async def _both() -> list[dict[str, Any]]:
        return list(
            await asyncio.gather(
                importer.sync_generations(), importer.sync_generations()
            )
        )

    with _fake_sidecar(state) as port:
        _point_sidecar_at(monkeypatch, port)
        results = asyncio.run(_both())

    imported = [entry_id for r in results for entry_id in r["imported"]]
    assert len(imported) == 2
    assert len(set(imported)) == 2
    assert len(_entries()) == 2
    # Each audio file was fetched exactly once: the loser of the lock re-read
    # the seen map and had nothing left to do.
    assert sorted(state.audio_hits) == [
        "/generations/c1.wav",
        "/generations/c2.wav",
    ]


# ---------------------------------------------------------------------------
# Provider tables
# ---------------------------------------------------------------------------


def test_the_provider_tables_file_a_lyria_record_under_lyria():
    from backend.modules.library.db import DERIVED_PROVIDERS, infer_provider
    from backend.modules.library.provider import detect_provider

    meta = {
        "model": "lyria",
        "source": "generate",
        "tags": ["lyria", "lyriaid:abcdef0123456789", "lyria-provider:gemini"],
    }
    info = detect_provider({}, meta)
    assert info is not None
    assert info.provider == "lyria"
    assert info.label == "Lyria 3 Pro"
    assert info.is_ai is True
    # The badge's provider id is the sidecar's own generation id.
    assert info.provider_id == "abcdef0123456789"

    # The tag alone is enough -- a record that lost its model column still
    # badges Lyria rather than falling through to theDAW's own slug.
    tag_only = detect_provider({}, {"tags": ["lyria"], "source": "generate"})
    assert tag_only is not None and tag_only.provider == "lyria"

    # And the (model, source) derivation, which is all a lineage node carries.
    assert infer_provider("lyria", "generate") == "lyria"
    assert DERIVED_PROVIDERS["lyria"] == ("Lyria 3 Pro", True)
    # Nothing else moved: the arms above this one still answer as they did.
    assert infer_provider("chirp-v4", "import") == "suno"
    assert infer_provider("stable-audio-3-medium", "generate") == "stable-audio"


def test_an_imported_entry_is_labeled_lyria_end_to_end(
    lyria_env: Path, monkeypatch: pytest.MonkeyPatch
):
    state = _SidecarState()
    state.generations = [_generation("badge1", title="Badged")]
    state.audio = {"/generations/badge1.wav": WAV_ONE}

    with _fake_sidecar(state) as port:
        _point_sidecar_at(monkeypatch, port)
        asyncio.run(importer.sync_generations())

    record = _entries()[0]
    assert record.provider == "lyria"
    assert record.provider_label == "Lyria 3 Pro"
    assert record.provider_is_ai is True
    assert record.provider_id == "badge1"


# ---------------------------------------------------------------------------
# The seen-map surface behind GET /api/lyria/imports
# ---------------------------------------------------------------------------


def test_imports_summary_reports_counts_and_no_audio(
    lyria_env: Path, monkeypatch: pytest.MonkeyPatch
):
    assert importer.imports_summary() == {
        "count": 0,
        "lyria_ids": [],
        "entry_ids": [],
    }

    state = _SidecarState()
    state.generations = [_generation("s1", title="S1"), _generation("s2", title="S2")]
    state.audio = {"/generations/s1.wav": WAV_ONE, "/generations/s2.wav": WAV_TWO}

    with _fake_sidecar(state) as port:
        _point_sidecar_at(monkeypatch, port)
        result = asyncio.run(importer.sync_generations())

    summary = importer.imports_summary()
    assert summary["count"] == 2
    assert summary["lyria_ids"] == ["s1", "s2"]
    assert summary["entry_ids"] == sorted(result["imported"])
    assert set(summary) == {"count", "lyria_ids", "entry_ids"}


def test_a_corrupt_seen_map_reads_as_empty_rather_than_raising(
    lyria_env: Path, monkeypatch: pytest.MonkeyPatch
):
    path = importer.seen_map_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not json", encoding="utf-8")
    assert importer.load_seen_map() == {}


# ---------------------------------------------------------------------------
# Small pure helpers
# ---------------------------------------------------------------------------


def test_safe_stem_strips_what_a_filename_cannot_hold():
    assert importer.safe_stem("Neon Rain", "fallback") == "Neon Rain"
    # Separators collapse and the leading dots/underscores are stripped, so a
    # traversal-shaped title cannot even look like one in the entry folder.
    assert importer.safe_stem("../../etc/passwd", "fallback") == "etc_passwd"
    assert importer.safe_stem("a\\b:c*d?", "fallback") == "a_b_c_d"
    assert importer.safe_stem("   ", "fallback") == "fallback"
    assert importer.safe_stem("", "gen-id") == "gen-id"
    assert len(importer.safe_stem("x" * 300, "fallback")) == 80


def test_analysis_notes_only_names_the_parts_that_are_there():
    assert (
        importer.analysis_notes(
            {"genre": "Synthwave", "mood": "dreamy", "bpm": 118, "key": "A minor"}
        )
        == "Synthwave / dreamy / 118 BPM / A minor"
    )
    assert importer.analysis_notes({"genre": "Ambient"}) == "Ambient"
    assert importer.analysis_notes({"bpm": 0}) == ""
    assert importer.analysis_notes({}) == ""
    assert importer.analysis_notes(None) == ""
