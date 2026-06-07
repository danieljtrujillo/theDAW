"""ToolModule — the reusable backbone for every tool family.

A family (mastering, restoration, …) declares a list of ``ToolSpec``s and calls
``build_router(family, tools)``. That returns a FastAPI ``APIRouter`` exposing:

    GET  /tools            → manifest of this family's tools (drives the UI)
    POST /process          → run one tool on an uploaded file, return audio

Dispatch is by ``ToolSpec.mode``:
    filter   → handler(params) -> list[str] ffmpeg filter args (or FilterGraph)
    process  → async handler(input_path, output_path, params) -> None
    macro    → async handler(input_path, output_path, params) -> None  (uses macro_runner)
    sidecar  → async handler(input_path, output_path, params, job) -> None (GPU model)

Tools whose ``handler is None`` answer 501 with a clear, honest message — never
fake output.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse, Response

from ..lib import ffmpeg
from ..lib.filtergraph import FilterGraph
from ..lib.params import ToolSpec

MIME = {
    "wav": "audio/wav",
    "flac": "audio/flac",
    "ogg": "audio/ogg",
    "mp3": "audio/mpeg",
    "aac": "audio/aac",
    "opus": "audio/opus",
    "m4a": "audio/mp4",
}


def build_router(family: str, tools: list[ToolSpec]) -> APIRouter:
    router = APIRouter()
    by_id = {t.id: t for t in tools}

    @router.get("/tools")
    async def list_tools():
        return {
            "family": family,
            "count": len(tools),
            "tools": [t.to_dict() for t in tools],
        }

    @router.get("/tools/{tool_id}")
    async def get_tool(tool_id: str):
        tool = by_id.get(tool_id)
        if not tool:
            raise HTTPException(404, f"Unknown tool: {tool_id}")
        return tool.to_dict()

    @router.post("/process")
    async def process(
        effect: str = Form(...),
        params: str = Form("{}"),
        output_format: str = Form("wav"),
        audio: UploadFile = File(...),
    ):
        tool = by_id.get(effect)
        if not tool:
            raise HTTPException(404, f"Unknown tool: {effect}")
        if output_format not in MIME:
            raise HTTPException(400, f"Unsupported format: {output_format}")

        try:
            raw = json.loads(params or "{}")
        except json.JSONDecodeError:
            raise HTTPException(400, "Invalid params JSON")
        try:
            validated = tool.validate_params(raw)
        except ValueError as e:
            raise HTTPException(400, str(e))

        if tool.handler is None:
            return JSONResponse(
                status_code=501,
                content={
                    "error": "not_implemented",
                    "tool": tool.id,
                    "mode": tool.mode,
                    "engine": tool.engine,
                    "message": (
                        f"'{tool.name}' is scaffolded but its {tool.mode} handler "
                        f"is not wired yet. See docs/edit-tool-stack for the spec."
                    ),
                    "params": validated,
                },
            )

        tmp = Path(tempfile.mkdtemp(prefix=f"edit_{family}_"))
        try:
            in_path = tmp / "input.wav"
            out_path = tmp / f"output.{output_format}"
            await ffmpeg.stream_upload_to(in_path, audio)

            if tool.mode == "filter":
                built = tool.handler(validated)
                filter_args = (
                    built.args() if isinstance(built, FilterGraph) else list(built)
                )
                await ffmpeg.render(in_path, out_path, filter_args)
            else:
                # process / macro / sidecar — handler owns the full render
                await tool.handler(in_path, out_path, validated)

            if not out_path.exists():
                raise HTTPException(500, "Tool produced no output")
            data = out_path.read_bytes()
            return Response(
                content=data,
                media_type=MIME.get(output_format, "audio/wav"),
                headers={
                    "Content-Disposition": f'attachment; filename="processed.{output_format}"'
                },
            )
        except ffmpeg.FFmpegError as e:
            raise HTTPException(500, f"ffmpeg error: {e.stderr[-400:]}")
        except HTTPException:
            raise
        except NotImplementedError as e:
            raise HTTPException(501, str(e) or f"{tool.name} not implemented")
        except Exception as e:  # noqa: BLE001 — surface the real error, never swallow
            raise HTTPException(500, f"{tool.name} failed: {e}")
        finally:
            ffmpeg.cleanup(tmp)

    return router
