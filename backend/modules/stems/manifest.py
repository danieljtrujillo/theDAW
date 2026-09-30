"""What a stems run was asked for, what it actually produced, and how the two differ.

A separation is not one model and its files are not interchangeable. The
external sidecar runs Demucs for 2/4/6 stems, and for "12" it runs
``htdemucs_6s`` and then hands ``drums.wav`` to LARSNET, which writes
``kick``/``snare``/``toms``/``hihat``/``cymbals`` and deletes the drums file
it consumed — ten files, not twelve. Two things follow that the repo could
not previously say out loud:

**Some files are sums of others.** ``no_vocals`` is the whole mix minus the
vocal; ``drums`` (when a LARSNET run left it behind) is the sum of the five
kit parts. Summing a file with the parts it already contains double-counts
that material, so a consumer has to know which is which before it mixes.

**Some files were re-gained and some were not.** LARSNET peak-normalizes
each part it writes to 0.98 independently; the Demucs stems are untouched.
Relative level between a LARSNET part and a Demucs stem is therefore not
the level they had in the mix.

And a run can end in three different places: every requested role present,
some role missing (a fetch failed), or the 12-stem LARSNET step falling back
to the undivided ``drums.wav``. The engine used to report all three as
"complete".

Everything here is a pure function over names — no I/O, no sidecar, no DB —
so the reconciliation can be unit-tested against every shape a run can take.
Names may arrive as filenames (``bass.wav``) or as the bare ``stem_name``
column from the library DB (``bass``); both normalize to the same role name.
"""

from __future__ import annotations

import re
from typing import Any, Iterable, Optional

# The current on-disk manifest shape. Bump when a key changes meaning so a
# reader can tell an old manifest from a new one.
MANIFEST_VERSION = 1
MANIFEST_FILENAME = "manifest.json"

# What the sidecar's LARSNET step writes when it splits drums.wav, in the
# order the kit is conventionally listed.
LARSNET_PARTS: tuple[str, ...] = ("kick", "snare", "toms", "hihat", "cymbals")

# LARSNET's pretrained weights are research weights; the parts inherit their
# licence and it travels with the files.
LARSNET_WEIGHTS_LICENSE = "CC BY-NC 4.0"

# Each LARSNET part is scaled so its own peak sits at 0.98 before it is
# written, independently of every other part.
LARSNET_NORMALIZED_PEAK = 0.98

# Quality tiers the sidecar actually resolves to distinct Demucs settings.
# Anything else is not a tier it implements, so we never claim it was used.
KNOWN_QUALITY_TIERS: tuple[str, ...] = ("fast", "balanced", "hq")

# The roles a run of each mode is supposed to deliver. 12 is the odd one:
# drums is consumed by LARSNET and replaced by the five kit parts, so a
# clean 12-stem run leaves ten files and no drums.
EXPECTED: dict[int, list[str]] = {
    2: ["vocals", "no_vocals"],
    4: ["vocals", "drums", "bass", "other"],
    6: ["vocals", "drums", "bass", "other", "guitar", "piano"],
    12: [
        "vocals",
        "bass",
        "other",
        "guitar",
        "piano",
        "kick",
        "snare",
        "toms",
        "hihat",
        "cymbals",
    ],
}

# "Processing 12-stem separation on cuda (balanced)" — the only place the
# sidecar tells us which device and quality tier it settled on. Its /status
# payload carries neither.
_SUBMIT_MESSAGE_RE = re.compile(
    r"separation on (?P<device>\S+)\s+\((?P<quality>[^)]*)\)"
)


def role_name(name: str) -> str:
    """The role a produced file stands for: ``"no_vocals.wav"`` → ``"no_vocals"``.

    Only a trailing extension is removed, so a role that contains a dot would
    survive intact. Raises TypeError for a non-string.
    """
    if not isinstance(name, str):
        raise TypeError(f"stem name must be a str, got {type(name).__name__}")
    stripped = name.strip()
    head, dot, tail = stripped.rpartition(".")
    # A dot with a non-empty head is an extension; ".hidden" is not.
    return head if dot and head else stripped


def _normalized_names(names: Iterable[str]) -> list[str]:
    """Role names in first-seen order, blanks dropped, duplicates collapsed."""
    out: list[str] = []
    seen: set[str] = set()
    for raw in names:
        role = role_name(raw)
        if not role or role in seen:
            continue
        seen.add(role)
        out.append(role)
    return out


def classify(names: Iterable[str]) -> list[dict[str, Any]]:
    """Describe each produced file: is it a part, or a sum of other parts?

    Returns one dict per distinct name, in first-seen order::

        {"name": str,
         "role": "part" | "aggregate",
         "gain_normalized": bool,
         "aggregate_of": [str, ...]}   # aggregates only

    ``drums`` is an aggregate exactly when at least one LARSNET part is also
    present — otherwise it is an ordinary Demucs stem. ``no_vocals`` is an
    aggregate of every part except the vocal, but only when there is anything
    else for it to aggregate: a pure 2-stem run is two parts, not one part
    and a sum of it.

    An aggregate's ``aggregate_of`` lists parts only, never another
    aggregate, so the members never double-count each other.
    """
    ordered = _normalized_names(names)
    present = set(ordered)

    larsnet_present = [p for p in LARSNET_PARTS if p in present]
    drums_is_aggregate = "drums" in present and bool(larsnet_present)
    no_vocals_is_aggregate = "no_vocals" in present and bool(
        present - {"no_vocals", "vocals"}
    )

    def is_aggregate(name: str) -> bool:
        if name == "drums":
            return drums_is_aggregate
        if name == "no_vocals":
            return no_vocals_is_aggregate
        return False

    parts = [n for n in ordered if not is_aggregate(n)]

    out: list[dict[str, Any]] = []
    for name in ordered:
        entry: dict[str, Any] = {
            "name": name,
            "role": "aggregate" if is_aggregate(name) else "part",
            "gain_normalized": name in LARSNET_PARTS,
        }
        if name == "drums" and drums_is_aggregate:
            entry["aggregate_of"] = larsnet_present
        elif name == "no_vocals" and no_vocals_is_aggregate:
            # No canonical running order for "everything else", so sort it:
            # the members are a set and the list has to be stable.
            entry["aggregate_of"] = sorted(p for p in parts if p != "vocals")
        out.append(entry)
    return out


def reconcile(requested_mode: int, produced_names: Iterable[str]) -> dict[str, Any]:
    """Line the roles a mode promises up against the files that exist.

    Returns ``{requested_mode, expected, produced, missing, unexpected,
    parts, aggregates, status}``, where ``parts`` and ``aggregates`` are the
    ``classify`` entries split by role.

    ``status`` is:

    ``degraded``
        12 was requested, ``drums`` survived, and not one LARSNET part
        appeared — the drum split fell back to the undivided stem. Only when
        the kit parts are the *sole* shortfall: if some other role is also
        missing, that is a worse outcome and must not hide behind this one.
    ``partial``
        any expected role is missing.
    ``complete``
        every expected role is present. Extra files (an 11th ``drums.wav``
        that LARSNET left behind) are reported in ``unexpected`` but do not
        make a run incomplete — nothing that was asked for is absent.

    Raises ValueError for a mode the sidecar does not implement.
    """
    if requested_mode not in EXPECTED:
        raise ValueError(
            f"unsupported stem mode {requested_mode!r}; "
            f"expected one of {sorted(EXPECTED)}"
        )

    expected = list(EXPECTED[requested_mode])
    produced = _normalized_names(produced_names)
    present = set(produced)

    missing = [role for role in expected if role not in present]
    unexpected = [name for name in produced if name not in set(expected)]

    described = classify(produced)
    parts = [e for e in described if e["role"] == "part"]
    aggregates = [e for e in described if e["role"] == "aggregate"]

    larsnet_fell_back = (
        requested_mode == 12
        and "drums" in present
        and not any(p in present for p in LARSNET_PARTS)
    )
    if larsnet_fell_back and set(missing) <= set(LARSNET_PARTS):
        status = "degraded"
    elif missing:
        status = "partial"
    else:
        status = "complete"

    return {
        "requested_mode": requested_mode,
        "expected": expected,
        "produced": produced,
        "missing": missing,
        "unexpected": unexpected,
        "parts": parts,
        "aggregates": aggregates,
        "status": status,
    }


def larsnet_note(produced_names: Iterable[str]) -> Optional[dict[str, Any]]:
    """Provenance for the drum parts, or None when the run produced none.

    The parts come from LARSNET's pretrained weights, whose licence forbids
    commercial use, and each one was peak-normalized on its own — both facts
    have to travel with the audio.
    """
    present = set(_normalized_names(produced_names))
    parts = [p for p in LARSNET_PARTS if p in present]
    if not parts:
        return None
    return {
        "parts": parts,
        "weights_license": LARSNET_WEIGHTS_LICENSE,
        "gain_normalized_peak": LARSNET_NORMALIZED_PEAK,
    }


def parse_sidecar_submit_message(message: Optional[str]) -> dict[str, Optional[str]]:
    """Pull the device and quality tier out of the sidecar's submit response.

    The sidecar resolves ``device=None`` to a real device and echoes its
    choice only in the free-text ``message`` of the upload response; its
    ``/status`` payload carries neither field. Returns
    ``{"device": None, "quality": None}`` when the message is absent or does
    not carry them, so a wording change degrades to "unknown" rather than to
    a wrong claim.
    """
    if not isinstance(message, str):
        return {"device": None, "quality": None}
    match = _SUBMIT_MESSAGE_RE.search(message)
    if match is None:
        return {"device": None, "quality": None}
    device = match.group("device").strip() or None
    quality = match.group("quality").strip() or None
    return {"device": device, "quality": quality}


def build_run_manifest(
    *,
    requested_mode: int,
    produced_names: Iterable[str],
    run_id: str,
    separated_at: str,
    quality_requested: Optional[str],
    quality_effective: Optional[str],
    device: Optional[str],
    device_source: str,
    file_bytes: dict[str, int],
) -> dict[str, Any]:
    """The full record written beside the stems as ``manifest.json``.

    ``separated_at`` is an ISO-8601 UTC timestamp; ``file_bytes`` maps role
    name to the size on disk of the file we wrote (not the size the sidecar
    listed, which is the pre-re-encode float WAV). ``device_source`` says
    whether ``device`` is what the sidecar reported (``"sidecar"``) or what
    this backend inferred from probing it (``"engine-probe"``).

    ``provider`` is ``demucs+larsnet`` only when LARSNET parts actually
    exist — a 12-stem run whose drum split fell back ran Demucs alone.
    """
    produced = _normalized_names(produced_names)
    for name, size in file_bytes.items():
        if not isinstance(size, int) or isinstance(size, bool) or size < 0:
            raise ValueError(
                f"file_bytes[{name!r}] must be a non-negative int, got {size!r}"
            )

    note = larsnet_note(produced)
    manifest: dict[str, Any] = {
        "manifest_version": MANIFEST_VERSION,
        "run_id": run_id,
        "separated_at": separated_at,
        "provider": "demucs+larsnet" if note else "demucs",
        "device": device,
        "device_source": device_source,
        "quality_requested": quality_requested,
        "quality_effective": quality_effective,
        "file_bytes": dict(file_bytes),
        "larsnet": note,
    }
    manifest.update(reconcile(requested_mode, produced))
    return manifest
