"""A timed request that also says which thread held the interpreter.

``timed_get_with_stacks`` runs one ``TestClient`` GET and, when it takes
longer than ``sample_after`` seconds, samples every thread's stack at that
moment. The scale test (``test_library_startup_at_scale``) puts the sample
in its failure message, so a probe that stalls on a CI machine names the
code that stalled it instead of a bare number.
"""

from __future__ import annotations

import sys
import threading
import time
import traceback

from fastapi.testclient import TestClient


def timed_get_with_stacks(
    client: TestClient, url: str, *, sample_after: float = 0.4, **kwargs
) -> tuple[float, object, str]:
    """Seconds taken, the response, and the sampled stacks (blank when the
    request finished before ``sample_after``)."""
    frames: list[str] = []
    done = threading.Event()

    def sample() -> None:
        if done.wait(sample_after):
            return
        names = {t.ident: t.name for t in threading.enumerate()}
        for tid, frame in sys._current_frames().items():
            stack = "".join(traceback.format_stack(frame)[-10:])
            frames.append(f"--- thread {names.get(tid, tid)}\n{stack}")

    sampler = threading.Thread(target=sample, name="stack-sampler", daemon=True)
    sampler.start()
    began = time.perf_counter()
    response = client.get(url, **kwargs)
    took = time.perf_counter() - began
    done.set()
    sampler.join(2.0)
    return took, response, "\n".join(frames)
