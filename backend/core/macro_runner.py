"""Macro-graph runner — Character-FX macros (Ghost Voice, Alien Transmission, …).

A macro is a linear chain of FFmpeg filter nodes defined as data. Macro-level
knobs map to internal node parameters via simple lambdas, so one exposed control
can drive several filters at once. The runner resolves the mapping, builds a
single ``-af`` chain (or ``-filter_complex`` when a node needs multiple inputs),
and renders.

Example macro:
    GHOST_VOICE = {
        "knobs": {"ghostiness": 0.5, "size": 0.5, "gate": -30, "mix": 0.7},
        "nodes": [
            {"filter": "afftdn", "args": lambda k: f"nr={12 + k['ghostiness']*24}"},
            {"filter": "atempo", "args": lambda k: f"{1 - k['ghostiness']*0.25:.3f}"},
            {"filter": "aecho",  "args": lambda k: f"0.8:0.9:{int(60+k['size']*900)}:{0.3+k['size']*0.4:.2f}"},
        ],
    }
"""

from __future__ import annotations

from pathlib import Path

from ..lib import ffmpeg


def build_chain(macro: dict, knobs: dict) -> str:
    """Resolve a macro's nodes against knob values into an ffmpeg -af chain string."""
    parts: list[str] = []
    for node in macro["nodes"]:
        filt = node["filter"]
        arg = node.get("args")
        if callable(arg):
            arg = arg(knobs)
        parts.append(f"{filt}={arg}" if arg else filt)
    return ",".join(parts)


async def run_macro(
    macro: dict, input_path: Path, output_path: Path, params: dict
) -> Path:
    """Render a macro graph. Knob defaults come from macro['knobs'], overridden by params."""
    knobs = {**macro.get("knobs", {}), **params}
    chain = build_chain(macro, knobs)
    await ffmpeg.render(input_path, output_path, ["-af", chain])
    return output_path
