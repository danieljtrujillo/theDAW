"""backend.core.pipeline: one run per artifact, one model on the GPU."""

from __future__ import annotations

import asyncio

from backend.core import pipeline


def test_run_once_joins_the_run_in_flight():
    calls = 0

    async def factory():
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.05)
        return "stems"

    async def main():
        results = await asyncio.gather(
            pipeline.run_once("stems:e1", factory),
            pipeline.run_once("stems:e1", factory),
            pipeline.run_once("stems:e1", factory),
        )
        assert results == ["stems"] * 3
        assert not pipeline.in_flight("stems:e1")
        # A later call runs again (the first finished).
        assert await pipeline.run_once("stems:e1", factory) == "stems"

    asyncio.run(main())
    assert calls == 2


def test_run_once_keys_are_independent():
    async def factory(v):
        await asyncio.sleep(0.02)
        return v

    async def main():
        a, b = await asyncio.gather(
            pipeline.run_once("stems:a", lambda: factory("a")),
            pipeline.run_once("midi:a", lambda: factory("b")),
        )
        assert (a, b) == ("a", "b")

    asyncio.run(main())


def test_run_once_survives_a_cancelled_waiter():
    """The SING tab closing (its await cancelled) must not kill the
    separation the background queue is also waiting for."""

    async def factory():
        await asyncio.sleep(0.1)
        return "done"

    async def main():
        first = asyncio.create_task(pipeline.run_once("stems:c", factory))
        await asyncio.sleep(0.01)
        second = asyncio.create_task(pipeline.run_once("stems:c", factory))
        await asyncio.sleep(0.01)
        second.cancel()
        try:
            await second
        except asyncio.CancelledError:
            pass
        assert pipeline.in_flight("stems:c")
        assert await first == "done"
        await pipeline.wait_for("stems:c")
        assert not pipeline.in_flight("stems:c")

    asyncio.run(main())


def test_run_once_propagates_errors_to_every_waiter():
    async def factory():
        await asyncio.sleep(0.02)
        raise RuntimeError("demucs died")

    async def main():
        results = await asyncio.gather(
            pipeline.run_once("stems:err", factory),
            pipeline.run_once("stems:err", factory),
            return_exceptions=True,
        )
        assert all(isinstance(r, RuntimeError) for r in results)
        assert not pipeline.in_flight("stems:err")
        await pipeline.wait_for("stems:err")  # no-op, does not raise

    asyncio.run(main())


def test_gpu_lane_runs_one_model_at_a_time_and_parks_the_idle_queue():
    from backend.core.idle import get_idle_manager

    idle = get_idle_manager()
    active = 0
    peak = 0
    order: list[str] = []

    async def heavy(tag):
        nonlocal active, peak
        async with pipeline.gpu(tag):
            active += 1
            peak = max(peak, active)
            order.append(f"{tag}:start")
            assert f"gpu:{tag}" in idle.active_tags()
            assert not idle.is_idle()
            await asyncio.sleep(0.03)
            order.append(f"{tag}:end")
            active -= 1

    async def main():
        await asyncio.gather(heavy("whisper"), heavy("stems"), heavy("midi"))

    asyncio.run(main())
    assert peak == 1, "two models shared the GPU lane"
    assert len(order) == 6
    for i in range(0, 6, 2):
        assert order[i].endswith(":start") and order[i + 1].endswith(":end")
    assert not any(t.startswith("gpu:") for t in idle.active_tags())


def test_stems_device_prefers_the_request_then_settings_then_the_card(monkeypatch):
    monkeypatch.setattr(pipeline, "_settings", lambda section: {"device": "auto"})
    monkeypatch.setattr(pipeline, "gpu_device", lambda: "cuda")
    assert pipeline.stems_device("cpu") == "cpu"
    assert pipeline.stems_device(None) == "cuda"
    monkeypatch.setattr(pipeline, "_settings", lambda section: {"device": "cpu"})
    assert pipeline.stems_device(None) == "cpu"
    monkeypatch.setattr(pipeline, "_settings", lambda section: {})
    monkeypatch.setattr(pipeline, "gpu_device", lambda: "cpu")
    assert pipeline.stems_device(None) == "cpu"


def test_ensure_stems_returns_existing_rows_without_separating(monkeypatch, tmp_path):
    audio = tmp_path / "song.wav"
    audio.write_bytes(b"RIFF")

    class Db:
        def list_stems(self, entry_id):
            return [{"stem_name": "vocals"}]

    monkeypatch.setattr(pipeline, "_entry_paths", lambda e: (Db(), audio, tmp_path))
    ran = False

    async def boom(*a, **k):
        nonlocal ran
        ran = True

    import backend.modules.stems.engine as engine

    monkeypatch.setattr(engine, "separate_entry", boom)
    rows = asyncio.run(pipeline.ensure_stems("e"))
    assert rows == [{"stem_name": "vocals"}]
    assert ran is False


def test_ensure_midi_waits_for_stems_then_converts_once(monkeypatch, tmp_path):
    audio = tmp_path / "song.wav"
    audio.write_bytes(b"RIFF")
    state = {"stems": False, "midis": []}

    class Db:
        def list_stems(self, entry_id):
            return [{"stem_name": "vocals"}] if state["stems"] else []

        def list_midis(self, entry_id):
            return list(state["midis"])

    monkeypatch.setattr(pipeline, "_entry_paths", lambda e: (Db(), audio, tmp_path))
    monkeypatch.setattr(pipeline, "_settings", lambda s: {"from_stems": True})
    converted = 0

    def convert_entry(db, entry_id, audio_path, entry_dir, *, from_stems):
        nonlocal converted
        converted += 1
        assert state["stems"], "converted before the stems were there"
        state["midis"] = [{"id": "full"}]

    import backend.modules.midi.runner as runner

    monkeypatch.setattr(runner, "convert_entry", convert_entry)

    async def stems_run():
        await asyncio.sleep(0.05)
        state["stems"] = True
        return [{"stem_name": "vocals"}]

    async def main():
        stems_task = asyncio.create_task(pipeline.run_once("stems:m", stems_run))
        await asyncio.sleep(0.01)
        a, b = await asyncio.gather(
            pipeline.ensure_midi("m"), pipeline.ensure_midi("m")
        )
        await stems_task
        assert a == b == [{"id": "full"}]

    asyncio.run(main())
    assert converted == 1
