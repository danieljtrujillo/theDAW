"""Parameter automation for an offline VST3 print (``POST /api/vst/process-file``).

EDIT's automation lanes can ride a hosted plugin's parameters. Live, the app
writes each lane's value into the running plugin every frame; offline, a print
runs the plugin over a file, so the lanes travel with the file as curves over
its sample frames and the renderer moves the parameters as it goes, block by
block.

The wire shape is the one the native host reads from ``--automation-json``: a
JSON array of ``{"index": N, "name": "...", "points": [[frame, value], ...]}``.
``index`` is the parameter's position in the plugin's own list (the ``p<index>``
of the lane), ``name`` the plugin's own name for it (how the pedalboard renderer,
which numbers parameters its own way, finds it), and ``points`` a piecewise-
linear curve of the NORMALIZED value (0..1) over the uploaded file's frames,
ascending. Before the first point and after the last the value holds.

Structure is checked here and a malformed body is refused outright: a render
that silently dropped the automation would print a sound the user never heard.
A value outside 0..1 is clamped, as ``--params-json`` clamps one.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass

#: The most parameters one print may automate. Far past what a lane list holds.
MAX_AUTOMATED_PARAMS = 512
#: The most points across every curve of one print (a curved lane is cut into
#: short straight pieces, so an hour of dense curves stays well under this).
MAX_AUTOMATION_POINTS = 2_000_000
#: The longest parameter name kept; a plugin's own names are far shorter.
_MAX_NAME_CHARS = 200

#: Frames per block while automation is being applied. The renderer moves a
#: parameter at the start of each block, so this is the time resolution of the
#: printed automation: 256 frames is under 6 ms at 44.1 kHz.
AUTOMATION_BLOCK_SIZE = 256


@dataclass(frozen=True)
class ParamAutomation:
    """One automated parameter: its index, its name, and its curve."""

    index: int
    name: str | None
    points: tuple[tuple[int, float], ...]

    def to_host_json(self) -> dict:
        """The entry as the native host's ``--automation-json`` reads it."""
        out: dict = {"index": self.index, "points": [[f, v] for f, v in self.points]}
        if self.name:
            out["name"] = self.name
        return out


def _number(value: object) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def parse_param_automation(raw: str) -> list[ParamAutomation]:
    """Parse the ``automation`` form field. Empty means none.

    Raises:
        ValueError: with the reason, for anything that is not the wire shape.
    """
    text = (raw or "").strip()
    if not text:
        return []
    try:
        document = json.loads(text)
    except json.JSONDecodeError as e:
        raise ValueError(f"automation is not valid JSON ({e})") from e
    if not isinstance(document, list):
        raise ValueError("automation must be a JSON array")
    if len(document) > MAX_AUTOMATED_PARAMS:
        raise ValueError(
            f"automation names {len(document)} parameters; at most "
            f"{MAX_AUTOMATED_PARAMS} can be automated in one print"
        )
    out: list[ParamAutomation] = []
    total = 0
    seen: set[int] = set()
    for position, entry in enumerate(document):
        if not isinstance(entry, dict):
            raise ValueError(f"automation entry {position} is not an object")
        index = entry.get("index")
        if isinstance(index, bool) or not isinstance(index, int) or index < 0:
            raise ValueError(
                f"automation entry {position} needs a whole, non-negative index"
            )
        if index in seen:
            raise ValueError(f"automation names parameter {index} twice")
        seen.add(index)
        name = entry.get("name")
        if name is not None and not isinstance(name, str):
            raise ValueError(f"automation entry {position} has a name that is not text")
        points = entry.get("points")
        if not isinstance(points, list) or not points:
            raise ValueError(f"automation of parameter {index} has no points")
        total += len(points)
        if total > MAX_AUTOMATION_POINTS:
            raise ValueError(
                f"automation holds more than {MAX_AUTOMATION_POINTS} points"
            )
        curve: list[tuple[int, float]] = []
        last = -1
        for point in points:
            if not isinstance(point, list) or len(point) != 2:
                raise ValueError(
                    f"automation of parameter {index} has a point that is not [frame, value]"
                )
            frame = _number(point[0])
            value = _number(point[1])
            if frame is None or value is None or frame < 0 or frame != int(frame):
                raise ValueError(
                    f"automation of parameter {index} has a point that is not a whole "
                    "frame and a finite value"
                )
            at = int(frame)
            if at < last:
                raise ValueError(
                    f"automation of parameter {index} does not run forward in time"
                )
            curve.append((at, min(1.0, max(0.0, value))))
            last = at
        out.append(
            ParamAutomation(
                index=index,
                name=(name.strip()[:_MAX_NAME_CHARS] or None) if name else None,
                points=tuple(curve),
            )
        )
    return out


def automation_value_at(points: tuple[tuple[int, float], ...], frame: int) -> float:
    """The curve's value at ``frame``: linear between points, held outside them."""
    if frame <= points[0][0]:
        return points[0][1]
    if frame >= points[-1][0]:
        return points[-1][1]
    lo, hi = 0, len(points) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if points[mid][0] <= frame:
            lo = mid
        else:
            hi = mid
    (f0, v0), (f1, v1) = points[lo], points[hi]
    if f1 <= f0:
        return v1
    return v0 + (v1 - v0) * ((frame - f0) / (f1 - f0))
