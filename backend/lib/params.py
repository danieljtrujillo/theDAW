"""Parameter + tool specifications and validation.

A ``ToolSpec`` is the single source of truth for one editor tool: its identity,
the parameters it exposes (each a ``ParamSpec``), how it runs (``mode``), and the
metadata the frontend needs to render its module UI. The same spec drives
validation on the backend and the control/visualization layout on the frontend.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Callable, Literal, Optional

ParamType = Literal["float", "int", "bool", "enum", "string"]
ToolMode = Literal["filter", "process", "sidecar", "macro"]
# UI control hint — maps to a frontend component (see docs/edit-tool-stack/00-ui-foundation.md)
Control = Literal[
    "ParamKnob",
    "ParamKnobMacro",
    "ParamSlider",
    "ParamFader",
    "RoundToggle",
    "PresetBrowser",
    "Dropdown",
    "TextInput",
    "MultibandSplitter",
]


@dataclass
class ParamSpec:
    """One tunable parameter of a tool."""

    name: str
    type: ParamType = "float"
    lo: Optional[float] = None
    hi: Optional[float] = None
    default: Any = None
    unit: str = ""
    control: Control = "ParamKnob"
    label: str = ""
    options: Optional[list[str]] = None  # for enum
    help: str = ""

    def validate(self, value: Any) -> Any:
        """Validate + coerce a raw value. Raises ValueError on a bad value."""
        if self.type == "bool":
            if isinstance(value, bool):
                return value
            if isinstance(value, (int, float)):
                return bool(value)
            raise ValueError(f"{self.name}: expected bool, got {value!r}")
        if self.type == "enum":
            if self.options and value not in self.options:
                raise ValueError(f"{self.name}: {value!r} not in {self.options}")
            return value
        if self.type == "string":
            return str(value)
        # numeric
        try:
            num = float(value)
        except (TypeError, ValueError):
            raise ValueError(f"{self.name}: expected number, got {value!r}")
        if self.lo is not None and num < self.lo:
            raise ValueError(f"{self.name}: {num} < min {self.lo}")
        if self.hi is not None and num > self.hi:
            raise ValueError(f"{self.name}: {num} > max {self.hi}")
        return int(round(num)) if self.type == "int" else num

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class ToolSpec:
    """Complete specification of one editor tool."""

    id: str
    name: str
    family: str
    description: str = ""
    params: list[ParamSpec] = field(default_factory=list)
    mode: ToolMode = "filter"
    engine: str = ""  # e.g. "ffmpeg:firequalizer", "model:mel-roformer"
    gpu: bool = False
    license: str = ""
    viz: str = "spectrum"  # frontend hero visualization archetype
    flagship: bool = False
    # handler is attached at registration time, not serialized:
    handler: Optional[Callable[..., Any]] = field(default=None, repr=False)

    def validate_params(self, raw: dict[str, Any]) -> dict[str, Any]:
        """Validate a raw params dict against this tool's ParamSpecs.

        Missing params fall back to their declared default. Unknown keys are
        ignored (forward-compatible). Returns the validated/coerced dict.
        """
        out: dict[str, Any] = {}
        for p in self.params:
            value = raw.get(p.name, p.default)
            if value is None and p.default is None:
                raise ValueError(f"Missing required parameter: {p.name}")
            out[p.name] = p.validate(value)
        return out

    def to_dict(self) -> dict:
        d = {
            "id": self.id,
            "name": self.name,
            "family": self.family,
            "description": self.description,
            "mode": self.mode,
            "engine": self.engine,
            "gpu": self.gpu,
            "license": self.license,
            "viz": self.viz,
            "flagship": self.flagship,
            "implemented": self.handler is not None,
            "params": [p.to_dict() for p in self.params],
        }
        return d
