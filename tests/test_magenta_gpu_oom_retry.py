"""A Magenta load that runs out of GPU memory is retried split across the
machine's cards, and the message is written from the engine's own numbers.

mrt2_base died with ``RESOURCE_EXHAUSTED`` at 8.21 GiB in use of an 8.25 GiB
cap while nvidia-smi on the Windows side reported 9.3 GiB free: the engine runs
in WSL, and Windows' figure did not reflect it. The first version
of this message trusted that figure and told the user the card was roomy. The
engine now reports what it holds (/health: gpu_at_error, gpus, sharded, plan),
the load is retried cut across all the cards when there are two, and every
sentence about memory comes from the engine.
"""

from __future__ import annotations

import asyncio

import pytest

import backend.modules.magenta.router as router
import backend.modules.magenta.sidecar as real_sidecar

OOM = (
    "JaxRuntimeError: RESOURCE_EXHAUSTED: Out of memory while trying to "
    "allocate 96.00MiB. [tf-allocator-allocation-error='']"
)
GIB = 2**30
# The numbers from the real failure.
AT_ERROR = {"bytes_in_use": int(8.21 * GIB), "bytes_limit": int(8.25 * GIB)}
PLAN_ONE = {"per_card_bytes": int(4.6 * GIB)}
PLAN_TWO = {"per_card_bytes": int(2.3 * GIB)}


# ── the message ─────────────────────────────────────────────────────────────


def test_one_card_out_of_memory_says_what_the_engine_held_and_which_model_fits():
    h = {
        "error": OOM,
        "gpus": 1,
        "sharded": False,
        "gpu_at_error": AT_ERROR,
        "plan": PLAN_ONE,
    }
    fix = router._classify_engine_error(h)["fix"]

    assert "8.21 GiB in use of the 8.25 GiB JAX could take" in fix
    assert "about 4.6 GiB per card" in fix
    assert "cannot hold this model" in fix
    assert "MRT2 Small" in fix
    assert "wait" not in fix.lower(), "there is no job to wait for"
    assert "free" not in fix.lower(), "the Windows free figure is not the engine's"


def test_two_cards_not_yet_split_names_the_split():
    h = {
        "error": OOM,
        "gpus": 2,
        "sharded": False,
        "gpu_at_error": AT_ERROR,
        "plan": PLAN_ONE,
    }
    fix = router._classify_engine_error(h)["fix"]

    assert "split across both cards" in fix
    assert "8.21 GiB in use" in fix


def test_out_of_memory_while_split_is_the_end_of_the_road():
    h = {
        "error": OOM,
        "gpus": 2,
        "sharded": True,
        "gpu_at_error": AT_ERROR,
        "plan": PLAN_TWO,
    }
    fix = router._classify_engine_error(h)["fix"]

    assert "split across 2 cards" in fix
    assert "cannot hold this model" in fix
    assert "MRT2 Small" in fix
    assert "Restart engine" not in fix, (
        "restarting the same way would fail the same way"
    )


def test_an_engine_that_reported_nothing_labels_the_windows_figure():
    """An older engine, or one that died before JAX was up: the only number is
    Windows', and the message says what that number cannot see."""
    fix = router._classify_engine_error({"error": OOM}, free_gb=9.3)["fix"]

    assert "Windows saw 9.3 GiB free" in fix
    assert "may not count what the WSL engine held" in fix
    assert "MRT2 Small" in fix


def test_no_numbers_at_all_still_says_what_to_do():
    fix = router._classify_engine_error({"error": OOM}, free_gb=None)["fix"]

    assert "GiB" not in fix
    assert "Restart the engine" in fix
    assert "MRT2 Small" in fix


def test_every_oom_is_classified_as_one():
    for err in (OOM, "out of memory", "OOM killed", "RESOURCE_EXHAUSTED"):
        assert router._classify_engine_error({"error": err})["error_kind"] == "gpu_oom"


def test_other_failures_are_untouched():
    assert (
        router._classify_engine_error({"error": "checkpoint not found"})["error_kind"]
        == "checkpoint_missing"
    )
    assert router._classify_engine_error({}) == {}


def test_the_gpu_line_prefers_the_moment_of_failure():
    h = {
        "gpu": {"bytes_in_use": 1 * GIB, "bytes_limit": 8 * GIB},
        "gpu_at_error": {"bytes_in_use": 7 * GIB, "bytes_limit": 8 * GIB},
    }
    assert router._gpu_line(h).startswith("7.00 GiB in use")
    assert router._gpu_line({"gpu": {"bytes_in_use": 3 * GIB}}) == "3.00 GiB in use"
    assert router._gpu_line({}) == ""


# ── the retry ───────────────────────────────────────────────────────────────


class _Sidecar:
    """A stub engine: it reports `states` in order, one per health() call."""

    def __init__(self, states):
        self.states = list(states)
        self.starts: list[bool] = []
        self.stops = 0
        self.last: dict = {}

    async def health(self):
        self.last = self.states.pop(0) if self.states else self.last
        return self.last

    def setup_state(self, refresh: bool = False):
        return {"ready": True}

    def engine_state(self, h, _setup):
        if h.get("error"):
            return "error"
        return "running" if h.get("available") else "starting"

    def start_engine(self, shard: bool = False):
        self.starts.append(shard)
        return {"spawned": True}

    def stop_engine(self):
        self.stops += 1
        return {
            "terminated": False,
            "reaped": [],
            "survivors": [],
            "left_running": [],
            "listed": True,
        }

    engines_still_running = staticmethod(real_sidecar.engines_still_running)
    elsewhere_detail = staticmethod(real_sidecar.elsewhere_detail)

    def gpu_free_gb(self):
        return 9.3


@pytest.fixture
def bring_up(monkeypatch):
    """_bring_up_sidecar with the GPU lane and the sleeps stubbed."""

    class _Lane:
        async def __aenter__(self):
            return None

        async def __aexit__(self, *_):
            return False

    from backend.core import pipeline

    monkeypatch.setattr(pipeline, "gpu", lambda _who: _Lane())
    # Bind the real sleep first: a lambda that reads asyncio.sleep at call time
    # would find the patched one and recurse.
    real_sleep = asyncio.sleep
    monkeypatch.setattr(asyncio, "sleep", lambda _s: real_sleep(0))
    return router._bring_up_sidecar


# Every case starts with the two probes that precede the spawn: the early exit
# and the one inside the lock, neither of which finds the engine available.
_NOT_UP = [{}, {}]


def test_out_of_memory_on_one_of_two_cards_restarts_split(bring_up, monkeypatch):
    engine = _Sidecar(
        _NOT_UP
        + [
            {"error": OOM, "gpus": 2, "sharded": False, "gpu_at_error": AT_ERROR},
            {"available": True, "gpus": 2, "sharded": True},
        ]
    )
    monkeypatch.setattr(router, "sidecar", engine)

    asyncio.run(bring_up(timeout=30))

    assert engine.starts == [False, True], (
        "the first spawn, then one asking for the split"
    )
    assert engine.stops == 2


def test_the_split_is_tried_once(bring_up, monkeypatch):
    """Out of memory while split is the machine's limit: report, do not loop."""
    engine = _Sidecar(
        _NOT_UP
        + [
            {"error": OOM, "gpus": 2, "sharded": False, "gpu_at_error": AT_ERROR},
            {
                "error": OOM,
                "gpus": 2,
                "sharded": True,
                "gpu_at_error": AT_ERROR,
                "plan": PLAN_TWO,
            },
        ]
    )
    monkeypatch.setattr(router, "sidecar", engine)

    with pytest.raises(RuntimeError) as raised:
        asyncio.run(bring_up(timeout=30))

    assert engine.starts == [False, True], "it did not keep restarting"
    assert "split across 2 cards" in str(raised.value)
    assert "MRT2 Small" in str(raised.value)


def test_one_card_machines_do_not_retry(bring_up, monkeypatch):
    """There is nothing to split across, so the failure is reported at once."""
    engine = _Sidecar(
        _NOT_UP
        + [
            {
                "error": OOM,
                "gpus": 1,
                "sharded": False,
                "gpu_at_error": AT_ERROR,
                "plan": PLAN_ONE,
            }
        ]
    )
    monkeypatch.setattr(router, "sidecar", engine)

    with pytest.raises(RuntimeError) as raised:
        asyncio.run(bring_up(timeout=30))

    assert engine.starts == [False], "the first spawn, and nothing after it"
    assert "8.21 GiB in use of the 8.25 GiB" in str(raised.value)
    assert "MRT2 Small" in str(raised.value)


def test_a_load_that_is_not_an_oom_never_retries(bring_up, monkeypatch):
    engine = _Sidecar(_NOT_UP + [{"error": "checkpoint not found", "gpus": 2}])
    monkeypatch.setattr(router, "sidecar", engine)

    with pytest.raises(RuntimeError) as raised:
        asyncio.run(bring_up(timeout=30))

    assert engine.starts == [False]
    assert "download it under Models" in str(raised.value)


def test_a_load_that_just_works_starts_once(bring_up, monkeypatch):
    engine = _Sidecar(_NOT_UP + [{"available": True, "gpus": 2}])
    monkeypatch.setattr(router, "sidecar", engine)

    asyncio.run(bring_up(timeout=30))

    assert engine.starts == [False], "spawned once, on one card"
    assert engine.stops == 1


# ── what the Settings card prints ───────────────────────────────────────────


def test_the_layout_line_says_speed_dtype_and_where():
    line = router.engine_layout_line(
        {"realtime_factor": 0.76, "params_dtype": "bf16", "sharded": False, "gpus": 2}
    )
    assert line == "runs at 0.76x realtime, bf16 params on one card"

    split = router.engine_layout_line(
        {"realtime_factor": 0.33, "params_dtype": "bf16", "sharded": True, "gpus": 2}
    )
    assert split == "runs at 0.33x realtime, bf16 params split across 2 cards"


def test_the_layout_line_waits_for_a_timed_warm_up():
    assert router.engine_layout_line({"params_dtype": "bf16"}) is None
    assert router.engine_layout_line({"realtime_factor": None}) is None


def test_the_card_gets_the_classified_advice_or_nothing():
    h = {"error": OOM, "gpus": 1, "gpu_at_error": AT_ERROR, "plan": PLAN_ONE}
    fix = router.engine_error_fix(h)
    assert fix is not None
    assert "MRT2 Small" in fix
    assert router.engine_error_fix({}) is None
