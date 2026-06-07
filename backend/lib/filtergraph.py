"""FilterGraph builder.

Refactor of the existing ``_build_filter`` so a tool can emit either a simple
single-input chain (``-af``) or a multi-pad complex graph (``-filter_complex``)
without the caller caring which. Multiband dynamics, stereo imager, parallel and
sidechain chains need ``-filter_complex``; most EQ/dynamics tools don't.
"""

from __future__ import annotations


class FilterGraph:
    """Accumulate filter nodes, then emit ffmpeg args."""

    def __init__(self) -> None:
        self._chain: list[str] = []  # simple linear chain
        self._complex: list[str] = []  # named-pad statements
        self._out_label: str | None = None

    # --- simple chain ---
    def af(self, *filters: str) -> "FilterGraph":
        """Append one or more simple filters to the linear chain."""
        self._chain.extend(f for f in filters if f)
        return self

    # --- complex graph ---
    def node(self, statement: str) -> "FilterGraph":
        """Add a raw -filter_complex statement, e.g.
        '[0:a]acrossover=split=250 4000[low][mid][high]'."""
        self._complex.append(statement)
        return self

    def out(self, label: str) -> "FilterGraph":
        """Declare the final output pad label for a complex graph."""
        self._out_label = label
        return self

    @property
    def is_complex(self) -> bool:
        return bool(self._complex)

    def args(self) -> list[str]:
        """Return ffmpeg args: ['-af', chain] or ['-filter_complex', graph, '-map', '[out]']."""
        if self._complex:
            graph = ";".join(self._complex)
            args = ["-filter_complex", graph]
            if self._out_label:
                args += ["-map", self._out_label]
            return args
        if self._chain:
            return ["-af", ",".join(self._chain)]
        return []

    def __bool__(self) -> bool:
        return bool(self._chain or self._complex)


def simple(*filters: str) -> list[str]:
    """Shortcut for a single ``-af`` chain."""
    return FilterGraph().af(*filters).args()
