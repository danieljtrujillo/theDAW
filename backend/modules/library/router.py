"""FastAPI router for the disk-backed library.

Endpoints (prefix from module.json → `/api/library`):

    GET    /entries            list all library entries (no audio bytes)
    GET    /entries/{id}       single entry record
    GET    /audio/{id}         stream the audio file
    PATCH  /entries/{id}       update user-mutable fields
    DELETE /entries/{id}       remove the entry (audio + metadata)
    POST   /import             accept an audio upload, return new entry

The audio stream uses FileResponse so range requests work (essential for
the player to scrub) and there's no in-memory copy of large files.
"""

from __future__ import annotations

import json
import logging
import mimetypes
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Body, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, Response

from .bundle import build_bundle_bytes
from .store import LibraryStore, default_library_root

log = logging.getLogger(__name__)


_store: Optional[LibraryStore] = None


def get_store() -> LibraryStore:
    global _store
    if _store is None:
        project_root = Path(__file__).resolve().parents[3]
        _store = LibraryStore(default_library_root(project_root))
    return _store


router = APIRouter()


@router.get("/entries")
def list_entries() -> dict[str, Any]:
    store = get_store()
    entries = [r.to_dict() for r in store.list_entries()]
    return {"entries": entries, "count": len(entries), "root": str(store.root)}


@router.get("/entries/{entry_id}")
def get_entry(entry_id: str) -> dict[str, Any]:
    record = get_store().get_entry(entry_id)
    if record is None:
        raise HTTPException(404, f"Entry {entry_id!r} not found")
    return record.to_dict()


@router.get("/audio/{entry_id}")
def stream_audio(entry_id: str) -> FileResponse:
    audio_path = get_store().get_audio_path(entry_id)
    if audio_path is None or not audio_path.is_file():
        raise HTTPException(404, f"Audio for entry {entry_id!r} not found")
    mime, _ = mimetypes.guess_type(str(audio_path))
    return FileResponse(
        path=str(audio_path),
        media_type=mime or "audio/wav",
        filename=audio_path.name,
    )


@router.patch("/entries/{entry_id}")
def update_entry(entry_id: str, patch: dict[str, Any] = Body(...)) -> dict[str, Any]:
    record = get_store().update_entry(entry_id, patch)
    if record is None:
        raise HTTPException(404, f"Entry {entry_id!r} not found")
    return record.to_dict()


@router.delete("/entries/{entry_id}")
def delete_entry(entry_id: str) -> dict[str, Any]:
    ok = get_store().delete_entry(entry_id)
    if not ok:
        raise HTTPException(
            404, f"Entry {entry_id!r} not found or could not be deleted"
        )
    return {"deleted": entry_id}


@router.get("/{entry_id}/bundle")
def download_bundle(entry_id: str) -> Response:
    store = get_store()
    record = store.get_entry(entry_id)
    if record is None:
        raise HTTPException(404, f"Entry {entry_id!r} not found")

    audio_path = store.get_audio_path(entry_id)
    entry_dir = store._dir_for(entry_id)  # noqa: SLF001
    metadata_path = (entry_dir / "metadata.json") if entry_dir else None

    analysis: Optional[dict[str, Any]] = None
    stems: list[dict[str, Any]] = []
    midis: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    if store.db is not None:
        analysis = store.db.get_analysis(entry_id)
        stems = store.db.list_stems(entry_id)
        midis = store.db.list_midis(entry_id)
        # Edges where entry is either parent or child.
        edges = store.db.list_relations(from_id=entry_id) + store.db.list_relations(
            to_id=entry_id
        )

    data = build_bundle_bytes(
        entry_id=entry_id,
        record=record.to_dict(),
        audio_path=audio_path,
        metadata_path=metadata_path,
        analysis=analysis,
        stems=stems,
        midis=midis,
        lineage_edges=edges,
    )

    safe_title = "".join(
        c if c.isalnum() or c in "-_." else "_" for c in (record.title or "entry")
    )[:60]
    filename = f"{safe_title}_{entry_id[:8]}.zip"
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/{entry_id}/lineage")
def get_lineage(entry_id: str, depth: int = 3) -> dict[str, Any]:
    """Return nodes + edges within ``depth`` hops of ``entry_id``.

    BFS over the ``relations`` table in both directions (parents AND
    children). Cheap because edges are indexed both ways."""
    store = get_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    record = store.get_entry(entry_id)
    if record is None:
        raise HTTPException(404, f"entry {entry_id!r} not found")

    depth = max(0, min(int(depth), 10))
    seen_ids: set[str] = {entry_id}
    edges: list[dict[str, Any]] = []
    frontier: list[str] = [entry_id]
    for _ in range(depth):
        next_frontier: list[str] = []
        for node_id in frontier:
            outgoing = store.db.list_relations(from_id=node_id)
            incoming = store.db.list_relations(to_id=node_id)
            for e in outgoing + incoming:
                edges.append(e)
                for nb in (e["from_id"], e["to_id"]):
                    if nb not in seen_ids:
                        seen_ids.add(nb)
                        next_frontier.append(nb)
        frontier = next_frontier
        if not frontier:
            break

    # Materialize node payloads for everything we touched.
    nodes: list[dict[str, Any]] = []
    for node_id in seen_ids:
        node_row = store.db.get_entry(node_id)
        if node_row is not None:
            nodes.append(
                {
                    "id": node_id,
                    "kind": "entry",
                    "title": node_row.get("title"),
                    "source": node_row.get("source"),
                    "duration_sec": node_row.get("duration_sec"),
                }
            )
        else:
            # Stem / midi / external label — keep it in the graph
            # without a full row so the visualization can show it as
            # a placeholder.
            nodes.append({"id": node_id, "kind": "external"})

    # Dedup edges by (from, to, kind).
    seen_edges = set()
    deduped_edges: list[dict[str, Any]] = []
    for e in edges:
        key = (e["from_id"], e["to_id"], e["kind"])
        if key in seen_edges:
            continue
        seen_edges.add(key)
        deduped_edges.append(e)

    return {"root": entry_id, "nodes": nodes, "edges": deduped_edges}


@router.get("/_all/stems")
def list_all_stems() -> dict[str, Any]:
    """Return every stem across every entry, joined to the parent
    entry's title for grouping in the UI."""
    store = get_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    out: list[dict[str, Any]] = []
    for entry in store.db.list_entries():
        for stem in store.db.list_stems(entry["id"]):
            stem_payload = dict(stem)
            stem_payload["parent_title"] = entry.get("title")
            stem_payload["parent_id"] = entry["id"]
            out.append(stem_payload)
    return {"stems": out, "count": len(out)}


@router.get("/_all/midi")
def list_all_midi() -> dict[str, Any]:
    """Return every MIDI file across every entry, joined to the parent
    entry's title."""
    store = get_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    out: list[dict[str, Any]] = []
    for entry in store.db.list_entries():
        for midi in store.db.list_midis(entry["id"]):
            midi_payload = dict(midi)
            midi_payload["parent_title"] = entry.get("title")
            midi_payload["parent_id"] = entry["id"]
            out.append(midi_payload)
    return {"midis": out, "count": len(out)}


@router.get("/_graph/all")
def get_full_graph() -> dict[str, Any]:
    """Return EVERY entry + relation in the library, PLUS virtual nodes
    for stems / midis / external source-labels referenced in edges but
    not present in the entries table. Without those virtual nodes the
    genealogy view sees chimera-children as orphans (their from_id is a
    file-name string, not an entry id) and the layered layout collapses
    to one row. Cheap up to a few thousand entries; if it grows large
    we'll paginate later."""
    store = get_store()
    if store.db is None:
        raise HTTPException(503, "library DB not available")
    raw_entries = store.db.list_entries()
    raw_edges = store.db.list_relations()

    entries_by_id: dict[str, dict[str, Any]] = {r["id"]: r for r in raw_entries}
    nodes: list[dict[str, Any]] = [
        {
            "id": r["id"],
            "kind": "entry",
            "title": r.get("title"),
            "source": r.get("source"),
            "duration_sec": r.get("duration_sec"),
            "model": r.get("model"),
        }
        for r in raw_entries
    ]
    seen_ids = set(entries_by_id.keys())

    # Look up stems + midis once so we can label virtual nodes nicely.
    all_stems: dict[str, dict[str, Any]] = {}
    all_midis: dict[str, dict[str, Any]] = {}
    for entry in raw_entries:
        for s in store.db.list_stems(entry["id"]):
            all_stems[s["id"]] = s
        for m in store.db.list_midis(entry["id"]):
            all_midis[m["id"]] = m

    for edge in raw_edges:
        for ref in (edge["from_id"], edge["to_id"]):
            if ref in seen_ids:
                continue
            seen_ids.add(ref)
            if ref in all_stems:
                stem = all_stems[ref]
                nodes.append(
                    {
                        "id": ref,
                        "kind": "stem",
                        "title": stem.get("stem_name") or ref,
                        "source": "stem",
                        "model": stem.get("model"),
                    }
                )
            elif ref in all_midis:
                midi = all_midis[ref]
                nodes.append(
                    {
                        "id": ref,
                        "kind": "midi",
                        "title": Path(midi.get("midi_path") or ref).stem,
                        "source": "midi",
                        "model": midi.get("engine"),
                    }
                )
            else:
                # Chimera source-label or external reference.
                nodes.append(
                    {
                        "id": ref,
                        "kind": "external",
                        "title": ref,
                        "source": "external",
                    }
                )

    return {"nodes": nodes, "edges": raw_edges, "count": len(nodes)}


@router.post("/import")
async def import_entry(
    file: UploadFile = File(...),
    metadata: str = Form("{}"),
) -> dict[str, Any]:
    try:
        meta_dict = json.loads(metadata) if metadata else {}
    except json.JSONDecodeError as e:
        raise HTTPException(400, f"metadata must be JSON: {e}")
    if not isinstance(meta_dict, dict):
        raise HTTPException(400, "metadata must be a JSON object")

    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(400, "empty file")

    record = get_store().import_blob(
        audio_bytes=audio_bytes,
        filename=file.filename or "import.wav",
        mime_type=file.content_type or "audio/wav",
        metadata=meta_dict,
    )
    return record.to_dict()
