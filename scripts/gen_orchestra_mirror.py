"""Write frontend/src/lib/orchestraData.ts from the backend's orchestral registry.

The registry in backend/modules/notation/instruments.py is the one source of
truth for what a part is. The frontend reads this generated copy, and
tests/test_orchestra_registry.py fails when the copy differs from what the
backend generates. After any edit to the registry, run from the repo root:

    python scripts/gen_orchestra_mirror.py

The writer lives here, outside backend/modules/notation, because nothing in
that package may write files except the guarded MusicXML writer
(tests/test_notation_engine_b12.py).
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]


def main() -> int:
    # The script runs from anywhere, so the checkout goes on the path before
    # the registry is imported.
    if str(REPO) not in sys.path:
        sys.path.insert(0, str(REPO))
    from backend.modules.notation.instruments import (
        FRONTEND_MIRROR,
        frontend_module_text,
    )

    target = REPO / FRONTEND_MIRROR
    target.write_text(frontend_module_text(), encoding="utf-8", newline="\n")
    print(target)
    return 0


if __name__ == "__main__":
    sys.exit(main())
