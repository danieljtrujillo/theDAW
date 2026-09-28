"""``POST /api/sheetimport/parse`` parses off the event loop.

music21 takes seconds over a long score. The route is ``async``, so a parse
called on the event loop would hold every other request of the backend until
it finished. The probe: a parse that waits for a second request to be
answered. Run in the threadpool, the second request is answered while the
parse waits; run on the loop, the parse waits alone and gives up.
"""

from __future__ import annotations

import asyncio
import threading

import httpx
from fastapi import FastAPI

from backend.modules.sheetimport import parser as sheet_parser
from backend.modules.sheetimport import router as sheetimport_router

WAIT_SECONDS = 3.0


def test_a_parse_leaves_the_event_loop_free_for_other_requests(monkeypatch) -> None:
    answered = threading.Event()
    seen: dict[str, bool] = {}

    def slow_parse(data: bytes, name: str) -> dict:
        seen["answered_while_parsing"] = answered.wait(WAIT_SECONDS)
        return {"ok": True, "name": name, "tracks": []}

    monkeypatch.setattr(sheet_parser, "parse_score_bytes", slow_parse)
    app = FastAPI()
    app.include_router(sheetimport_router.router, prefix="/api/sheetimport")

    async def probe() -> tuple[int, int]:
        transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 51000))
        async with httpx.AsyncClient(
            transport=transport, base_url="http://127.0.0.1"
        ) as client:
            parse = asyncio.create_task(
                client.post(
                    "/api/sheetimport/parse",
                    files={"file": ("tune.abc", b"X:1\nK:C\nC|", "text/plain")},
                )
            )
            await asyncio.sleep(0.2)
            other = await client.get("/api/sheetimport/capabilities")
            answered.set()
            return (await parse).status_code, other.status_code

    parse_status, other_status = asyncio.run(probe())

    assert parse_status == 200 and other_status == 200
    assert seen["answered_while_parsing"], (
        "the parse held the event loop: nothing else was answered while it ran"
    )


def test_an_upload_over_the_limit_is_refused(monkeypatch) -> None:
    monkeypatch.setattr(sheetimport_router, "_MAX_BYTES", 16)
    app = FastAPI()
    app.include_router(sheetimport_router.router, prefix="/api/sheetimport")

    async def upload() -> int:
        transport = httpx.ASGITransport(app=app, client=("127.0.0.1", 51000))
        async with httpx.AsyncClient(
            transport=transport, base_url="http://127.0.0.1"
        ) as client:
            r = await client.post(
                "/api/sheetimport/parse",
                files={"file": ("tune.abc", b"X:1\nK:C\n" + b"C" * 64, "text/plain")},
            )
            return r.status_code

    assert asyncio.run(upload()) == 413
