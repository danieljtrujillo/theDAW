"""What the server is allowed to import before it binds its port.

Importing ``backend.server`` costs the user their whole startup: uvicorn does
not accept a connection until it returns, and every ``/api/*`` call before
that fails. Measured on a cold cache it was 15.6s, and 9.4s of that was
``scipy.signal`` — pulled in because ``chimera/router.py`` imports every
submodule eagerly and two of them filtered audio at module scope, for a
mastering call nobody had made yet.

So the heavy scientific stack is deferred, and this is what keeps it that
way. A new ``from scipy import signal`` at the top of any module a router
touches would quietly hand the startup cost back.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]

#: Libraries that must stay off the import path. Each one is seconds of cold
#: start, and none of them is needed to answer /api/health.
FORBIDDEN_AT_STARTUP = (
    "scipy",
    "librosa",
    "torch",
    "torchaudio",
    "transformers",
    "sklearn",
    "chromadb",
    "sentence_transformers",
    "matplotlib",
    "onnxruntime",
)

#: A subprocess, because whatever ran the test may already have imported half
#: of these — an in-process check would pass on a dirty sys.modules.
_PROBE = """
import sys, json
import backend.server
roots = sorted({m.split(".")[0] for m in sys.modules})
print("@@" + json.dumps(roots))
"""


@pytest.fixture(scope="module")
def startup_modules() -> set[str]:
    proc = subprocess.run(
        [sys.executable, "-c", _PROBE],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        timeout=600,
    )
    assert proc.returncode == 0, (
        f"importing backend.server failed:\n{proc.stderr[-2000:]}"
    )
    line = next(
        (ln for ln in proc.stdout.splitlines() if ln.startswith("@@")),
        None,
    )
    assert line is not None, f"probe printed nothing usable:\n{proc.stdout[-2000:]}"
    import json

    return set(json.loads(line[2:]))


@pytest.mark.parametrize("package", FORBIDDEN_AT_STARTUP)
def test_heavy_package_is_not_imported_at_startup(
    startup_modules: set[str], package: str
) -> None:
    assert package not in startup_modules, (
        f"{package} is imported while backend.server loads, which the user pays "
        f"for as startup latency before the port is even bound. Move it inside "
        f"the function that needs it."
    )


def test_the_deferred_scipy_helpers_still_work() -> None:
    """Deferring must not break the DSP — the helpers return the real module."""
    from backend.modules.chimera.master import _maximum_filter1d
    from backend.modules.chimera.render import scipy_signal

    signal = scipy_signal()
    assert hasattr(signal, "butter") and hasattr(signal, "lfilter")
    assert callable(_maximum_filter1d())
    # Second call is the cached module, not a re-import.
    assert scipy_signal() is signal
