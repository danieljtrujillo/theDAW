"""
Shared theDAW tool catalog — ONE source of truth for every provider surface.

These declarations were moved here VERBATIM from ``backend/assistant_routes.py``
(the inline ``theDAW_TOOLS`` list). Nothing about them was renamed, reordered, or
re-described: the OpenAI / Gemini / Anthropic function-calling paths and the
Claude Code MCP path must advertise the identical tools, or the browser-side
handlers in ``frontend/src/orb-kit/actionHandlers.ts`` stop matching.

Two views of the same data:

* ``PROVIDER_TOOLS`` — OpenAI function-calling shape
  ``{"type": "function", "function": {name, description, parameters}}``.
* ``thedaw_mcp_tools()`` — MCP ``tools/list`` shape
  ``{name, description, inputSchema}``. Names stay UNPREFIXED here; the Claude
  Code CLI namespaces them itself as ``mcp__thedaw__<name>``.
"""

from __future__ import annotations

import copy
from typing import Any

__all__ = ["PROVIDER_TOOLS", "thedaw_mcp_tools"]


# ---------------------------------------------------------------------------
# Provider (OpenAI function-calling) declarations — moved verbatim.
# ---------------------------------------------------------------------------
PROVIDER_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "navigate",
            "description": (
                "Switch the active workspace tab in theDAW. 'library' opens the "
                "library rail; 'perform' is the session/clip-launch grid. Legacy "
                "names create/advanced (MAKE) and train (UNDERFIT) still resolve."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "tab": {
                        "type": "string",
                        "enum": [
                            "make",
                            "edit",
                            "mix",
                            "perform",
                            "session",
                            "dj",
                            "vj",
                            "sway",
                            "foundry",
                            "underfit",
                            "nodefi",
                            "loom",
                            "learn",
                            "tour",
                            "library",
                            "create",
                            "advanced",
                            "train",
                            "audimate",
                        ],
                        "description": "Workspace to navigate to",
                    }
                },
                "required": ["tab"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "open_docs",
            "description": "Open the theDAW documentation modal",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "close_docs",
            "description": "Close the theDAW documentation modal",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "open_left_panel",
            "description": "Open the left app panel that contains the generation tabs",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "close_left_panel",
            "description": "Collapse the left app panel",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_prompt",
            "description": "Set the audio generation prompt text",
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {
                        "type": "string",
                        "description": "The text prompt for audio generation",
                    }
                },
                "required": ["prompt"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "append_prompt",
            "description": "Append descriptive text to the current audio prompt",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {
                        "type": "string",
                        "description": "Text to append to the current prompt",
                    }
                },
                "required": ["text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "improve_prompt",
            "description": "Replace the current prompt with an improved production-ready audio prompt",
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "Improved prompt"},
                    "negative_prompt": {
                        "type": "string",
                        "description": "Optional negative prompt",
                    },
                },
                "required": ["prompt"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_negative_prompt",
            "description": "Set the negative prompt (what to avoid in generation)",
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "Negative prompt text"}
                },
                "required": ["prompt"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_model",
            "description": "Set the audio generation model",
            "parameters": {
                "type": "object",
                "properties": {
                    "model": {
                        "type": "string",
                        "enum": ["small", "medium", "small-rf", "medium-rf"],
                        "description": "Model name",
                    }
                },
                "required": ["model"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_duration",
            "description": "Set audio generation duration in seconds (1-180)",
            "parameters": {
                "type": "object",
                "properties": {
                    "duration": {"type": "number", "description": "Duration in seconds"}
                },
                "required": ["duration"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_steps",
            "description": "Set diffusion sampling steps",
            "parameters": {
                "type": "object",
                "properties": {
                    "steps": {
                        "type": "integer",
                        "description": "Number of diffusion steps",
                    }
                },
                "required": ["steps"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_cfg",
            "description": "Set classifier-free guidance scale",
            "parameters": {
                "type": "object",
                "properties": {
                    "cfg": {"type": "number", "description": "CFG scale value"}
                },
                "required": ["cfg"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_seed",
            "description": "Set generation seed (-1 for random)",
            "parameters": {
                "type": "object",
                "properties": {
                    "seed": {
                        "type": "integer",
                        "description": "Seed value, -1 for random",
                    }
                },
                "required": ["seed"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_batch",
            "description": "Set batch size for generation",
            "parameters": {
                "type": "object",
                "properties": {
                    "batch": {"type": "integer", "description": "Batch size"}
                },
                "required": ["batch"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_sampler",
            "description": "Set the diffusion sampler type",
            "parameters": {
                "type": "object",
                "properties": {
                    "sampler": {
                        "type": "string",
                        "enum": ["pingpong", "euler", "rk4", "dpmpp"],
                        "description": "Sampler type",
                    }
                },
                "required": ["sampler"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_shift_mode",
            "description": "Set timestep shift mode",
            "parameters": {
                "type": "object",
                "properties": {
                    "mode": {
                        "type": "string",
                        "enum": ["LogSNR", "Flux", "Full", "None"],
                        "description": "Shift mode",
                    }
                },
                "required": ["mode"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_init_noise",
            "description": "Set init noise level for audio-to-audio (0=keep original, 1=full noise)",
            "parameters": {
                "type": "object",
                "properties": {
                    "noise": {"type": "number", "description": "Noise level 0.0-1.0"}
                },
                "required": ["noise"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "set_params",
            "description": "Set multiple generation parameters at once, including advanced settings",
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {"type": "string"},
                    "negative_prompt": {"type": "string"},
                    "model": {"type": "string"},
                    "duration": {"type": "number"},
                    "steps": {"type": "integer"},
                    "cfg": {"type": "number"},
                    "seed": {"type": "integer"},
                    "batch": {"type": "integer"},
                    "sampler": {"type": "string"},
                    "sigma_max": {"type": "number"},
                    "duration_padding_sec": {"type": "number"},
                    "apg_scale": {"type": "number"},
                    "cfg_rescale": {"type": "number"},
                    "cfg_norm_threshold": {"type": "number"},
                    "cfg_interval_min": {"type": "number"},
                    "cfg_interval_max": {"type": "number"},
                    "shift_mode": {"type": "string"},
                    "logsnr_anchor_length": {"type": "number"},
                    "logsnr_anchor_logsnr": {"type": "number"},
                    "logsnr_rate": {"type": "number"},
                    "logsnr_end": {"type": "number"},
                    "flux_min_len": {"type": "number"},
                    "flux_max_len": {"type": "number"},
                    "flux_alpha_min": {"type": "number"},
                    "flux_alpha_max": {"type": "number"},
                    "full_base_shift": {"type": "number"},
                    "full_max_shift": {"type": "number"},
                    "full_min_len": {"type": "number"},
                    "full_max_len": {"type": "number"},
                    "init_noise": {"type": "number"},
                    "inversion_steps": {"type": "number"},
                    "inversion_gamma": {"type": "number"},
                    "inversion_unconditional": {"type": "boolean"},
                    "file_format": {"type": "string"},
                    "file_naming": {"type": "string"},
                    "cut_to_duration": {"type": "boolean"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "generate",
            "description": "Start audio generation with current parameters",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "abort",
            "description": "Cancel the current audio generation",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_status",
            "description": "Get current generation status and parameters",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    # ── EDIT arrangement vocabulary (editor_*) ──────────────────────────────
    # The frontend executes these against the editor store; current tracks /
    # clips / playhead / selection arrive in the editorState block of the app
    # context, so the model can reference real ids. Destructive ops
    # (remove_track / remove_clip) are confirmation-gated client-side.
    {
        "type": "function",
        "function": {
            "name": "editor_get_state",
            "description": "The full EDIT arrangement: every track (id, name, kind midi/audio/mixed/empty, instrumentProgram, fxChain, mute/solo/armed/frozen) and clip (id, label, kind midi/audio, start, duration, noteCount, instrumentProgram), plus bpm, snap, tool, loop, markers, playhead",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "editor_add_track",
            "description": "Add a new track to the EDIT arrangement",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Track name"},
                },
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "editor_remove_track",
            "description": "Remove an EDIT track and all of its clips (user confirms in the UI)",
            "parameters": {
                "type": "object",
                "properties": {
                    "track_id": {
                        "type": "string",
                        "description": "Track id or exact track name",
                    },
                },
                "required": ["track_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "editor_set_track",
            "description": (
                "Update an EDIT track's volume, pan, mute, solo, name, record "
                "arm, or default MIDI instrument. Freezing is UI-only (there is "
                "no offline renderer here) — frozen=true is refused with the "
                "path to the freeze button; frozen=false DOES unfreeze."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "track_id": {
                        "type": "string",
                        "description": "Track id or exact name",
                    },
                    "volume": {"type": "number", "description": "Linear gain 0..1"},
                    "pan": {"type": "number", "description": "-1 (left) .. 1 (right)"},
                    "mute": {"type": "boolean"},
                    "solo": {"type": "boolean"},
                    "name": {"type": "string", "description": "New track name"},
                    "armed": {
                        "type": "boolean",
                        "description": "Record-arm the track",
                    },
                    "instrument_program": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 127,
                        "description": (
                            "Default General MIDI program for this track's MIDI "
                            "clips. A clip with its own instrumentProgram wins."
                        ),
                    },
                    "frozen": {
                        "type": "boolean",
                        "description": (
                            "false unfreezes a frozen track. true is refused — "
                            "freeze from the EDIT track header."
                        ),
                    },
                },
                "required": ["track_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "editor_move_clip",
            "description": "Move an EDIT clip to a new start time and/or another track",
            "parameters": {
                "type": "object",
                "properties": {
                    "clip_id": {
                        "type": "string",
                        "description": "Clip id (from editorState)",
                    },
                    "start_sec": {
                        "type": "number",
                        "description": "New timeline start (seconds)",
                    },
                    "track_id": {
                        "type": "string",
                        "description": "Destination track id or name",
                    },
                },
                "required": ["clip_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "editor_remove_clip",
            "description": "Delete an EDIT clip from the arrangement (user confirms in the UI)",
            "parameters": {
                "type": "object",
                "properties": {
                    "clip_id": {
                        "type": "string",
                        "description": "Clip id (from editorState)",
                    },
                },
                "required": ["clip_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "editor_split_clip",
            "description": "Split an EDIT clip at a timeline position inside the clip",
            "parameters": {
                "type": "object",
                "properties": {
                    "clip_id": {
                        "type": "string",
                        "description": "Clip id (from editorState)",
                    },
                    "at_sec": {
                        "type": "number",
                        "description": "Timeline seconds inside the clip",
                    },
                },
                "required": ["clip_id", "at_sec"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "editor_select_clip",
            "description": "Select an EDIT clip (drives clip-scoped UI actions)",
            "parameters": {
                "type": "object",
                "properties": {
                    "clip_id": {
                        "type": "string",
                        "description": "Clip id (from editorState)",
                    },
                },
                "required": ["clip_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "editor_set_playhead",
            "description": "Move the EDIT playhead to a timeline position",
            "parameters": {
                "type": "object",
                "properties": {
                    "seconds": {
                        "type": "number",
                        "description": "Timeline seconds (>= 0)",
                    },
                },
                "required": ["seconds"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "editor_set_bpm",
            "description": "Set the EDIT arrangement tempo",
            "parameters": {
                "type": "object",
                "properties": {
                    "bpm": {
                        "type": "number",
                        "description": "Beats per minute, 20-400",
                    },
                },
                "required": ["bpm"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "editor_set_loop",
            "description": "Enable/disable the EDIT loop and optionally set its region",
            "parameters": {
                "type": "object",
                "properties": {
                    "enabled": {"type": "boolean"},
                    "start_sec": {"type": "number"},
                    "end_sec": {"type": "number"},
                },
                "required": ["enabled"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "editor_add_marker",
            "description": "Add a named marker to the EDIT timeline",
            "parameters": {
                "type": "object",
                "properties": {
                    "seconds": {
                        "type": "number",
                        "description": "Timeline seconds (>= 0)",
                    },
                    "name": {"type": "string", "description": "Marker label"},
                },
                "required": ["seconds"],
            },
        },
    },
]


# ---------------------------------------------------------------------------
# Overdrive tools — the editor capabilities T09-T12 built, plus the five DJ
# actions that already had handlers and were never declared.
#
# Written here rather than moved, so unlike the block above they use a builder.
# The literals above are archaeology (moved verbatim out of assistant_routes so
# the diff could be proved empty); these are new text, and 51 hand-rolled
# ``{"type": "function", "function": {...}}`` wrappers would bury the part a
# reviewer actually has to check — the names, the enums and the required lists.
#
# Every tool here is executed by ``frontend/src/orb-kit/actionHandlers.ts``
# through the facade in ``frontend/src/state/editorTools.ts`` (or, for the four
# that need DSP, ``orb-kit/editorToolBridge.ts`` → ``/api/editor-tools/*``), and
# tiered in ``frontend/src/orb-kit/tool-tiers.ts``. ``tests/
# test_assistant_provider_tools.py`` fails if any of those three fall out of
# step with this list.
# ---------------------------------------------------------------------------


def _fn(
    name: str,
    description: str,
    properties: dict[str, Any] | None = None,
    required: list[str] | None = None,
) -> dict[str, Any]:
    parameters: dict[str, Any] = {"type": "object", "properties": properties or {}}
    if required:
        parameters["required"] = required
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": parameters,
        },
    }


#: Every ``*_id`` argument accepts an id OR the object's label/name, matched
#: case-insensitively; an ambiguous name is refused with its candidates rather
#: than resolved to a guess.
_CLIP_ID = {
    "type": "string",
    "description": "Clip id from editorState, or the clip's exact label",
}
_TRACK_ID = {
    "type": "string",
    "description": "Track id from editorState, or the track's exact name",
}

#: ``editorStore.SNAP_DIVISIONS``. Quantize cannot use 'off' (there is no grid
#: to snap to), so the two enums differ by exactly that member.
_SNAP_DIVISIONS = [
    "off",
    "1/1",
    "1/2",
    "1/4",
    "1/8",
    "1/16",
    "1/32",
    "1/64",
    "1/4T",
    "1/8T",
    "1/16T",
    "1/32T",
    "1/16Q",
    "1/16S",
    "1/4D",
    "1/8D",
    "1/16D",
]
_GRID_DIVISIONS = [d for d in _SNAP_DIVISIONS if d != "off"]

_MIDI_ONLY = (
    " Piano-roll (MIDI) clips only — it edits the note list and re-bounces the "
    "clip's audio, so the blob every export reads never falls behind the notes."
)
_LENGTH_WARNING = (
    " A re-bounce writes the full rendered length, so a previously trimmed clip "
    "grows back; the result says so when the length moved."
)

_OVERDRIVE_TOOLS: list[dict[str, Any]] = [
    # ── notes ───────────────────────────────────────────────────────────────
    _fn(
        "editor_quantize_clip",
        "Snap a MIDI clip's notes toward a grid." + _MIDI_ONLY + _LENGTH_WARNING,
        {
            "clip_id": _CLIP_ID,
            "grid": {
                "type": "string",
                "enum": _GRID_DIVISIONS,
                "description": "Grid to snap to. T = triplet, Q = quintuplet (five in a beat), S = septuplet (seven in a beat), D = dotted.",
            },
            "strength": {
                "type": "number",
                "minimum": 0,
                "maximum": 1,
                "description": "0 = no move, 1 = hard on the grid. Default 1.",
            },
            "swing": {
                "type": "number",
                "minimum": -1,
                "maximum": 1,
                "description": "Delays off-beat grid slots. Default 0.",
            },
            "quantize_ends": {
                "type": "boolean",
                "description": "Also snap note ends (lengths). Default false.",
            },
        },
        ["clip_id", "grid"],
    ),
    _fn(
        "editor_get_notes",
        "Read a MIDI clip's note list: every note as {id, note (pitch 0-127), "
        "step (16ths from the clip start), length (steps), velocity (1-127)}, "
        "plus the clip's total steps and source BPM. Read this before writing "
        "notes back with editor_set_notes.",
        {"clip_id": _CLIP_ID},
        ["clip_id"],
    ),
    _fn(
        "editor_set_notes",
        "Replace a MIDI clip's note list wholesale and re-render its audio. The "
        "list you pass becomes the clip — notes you omit are gone." + _LENGTH_WARNING,
        {
            "clip_id": _CLIP_ID,
            "notes": {
                "type": "array",
                "description": "The complete new note list (may not be empty).",
                "items": {
                    "type": "object",
                    "properties": {
                        "note": {
                            "type": "integer",
                            "minimum": 0,
                            "maximum": 127,
                            "description": "MIDI pitch (60 = middle C)",
                        },
                        "step": {
                            "type": "number",
                            "minimum": 0,
                            "description": "Start, in 16th-note steps from the clip start",
                        },
                        "length": {
                            "type": "number",
                            "exclusiveMinimum": 0,
                            "description": "Length in steps",
                        },
                        "velocity": {
                            "type": "integer",
                            "minimum": 1,
                            "maximum": 127,
                        },
                        "id": {
                            "type": "string",
                            "description": "Keep an existing note's id, or omit for a new one",
                        },
                    },
                    "required": ["note", "step", "length", "velocity"],
                },
            },
        },
        ["clip_id", "notes"],
    ),
    _fn(
        "editor_nudge_notes",
        "Shift every note of a MIDI clip in time. Pass EXACTLY ONE unit — two "
        "units, or none, is refused rather than guessed." + _LENGTH_WARNING,
        {
            "clip_id": _CLIP_ID,
            "steps": {
                "type": "number",
                "description": "16th-note steps (may be fractional)",
            },
            "ms": {
                "type": "number",
                "description": (
                    "Milliseconds, converted at the clip's source BPM. This is "
                    "the unit editor_compare_timing's answer is given in."
                ),
            },
            "ticks": {"type": "number", "description": "MIDI ticks at 480 PPQ"},
        },
        ["clip_id"],
    ),
    _fn(
        "editor_transpose_clip",
        "Transpose a MIDI clip's notes, clamped to the MIDI pitch range."
        + _LENGTH_WARNING,
        {
            "clip_id": _CLIP_ID,
            "semitones": {
                "type": "integer",
                "description": "Negative moves down. 12 = one octave up.",
            },
        },
        ["clip_id", "semitones"],
    ),
    _fn(
        "editor_scale_velocity",
        "Scale and/or shift a MIDI clip's velocities. Pass factor, offset, or "
        "both (factor first, then offset); min/max clamp the result." + _LENGTH_WARNING,
        {
            "clip_id": _CLIP_ID,
            "factor": {
                "type": "number",
                "minimum": 0,
                "description": "Multiplier, e.g. 0.8",
            },
            "offset": {"type": "number", "description": "Added after the factor"},
            "min": {"type": "integer", "minimum": 1, "maximum": 127},
            "max": {"type": "integer", "minimum": 1, "maximum": 127},
        },
        ["clip_id"],
    ),
    _fn(
        "editor_humanize_clip",
        "Scatter a MIDI clip's timing and velocity so it stops sounding "
        "drawn-in. Pass a seed to make the same scatter reproducible."
        + _LENGTH_WARNING,
        {
            "clip_id": _CLIP_ID,
            "timing_steps": {
                "type": "number",
                "description": "Maximum timing jitter in steps, +/-. Default 0.1.",
            },
            "velocity": {
                "type": "number",
                "description": "Maximum velocity jitter, +/-. Default 8.",
            },
            "seed": {"type": "integer", "description": "Repeatable randomisation"},
        },
        ["clip_id"],
    ),
    _fn(
        "editor_fix_overlaps",
        "Resolve same-pitch collisions inside a MIDI clip." + _LENGTH_WARNING,
        {
            "clip_id": _CLIP_ID,
            "mode": {
                "type": "string",
                "enum": ["legato", "trim", "dedupe"],
                "description": (
                    "legato = stretch each note to the next; trim = cut the "
                    "earlier note where the later one starts; dedupe = drop the "
                    "duplicate."
                ),
            },
        },
        ["clip_id", "mode"],
    ),
    _fn(
        "editor_filter_notes",
        "Strip junk notes from a MIDI clip (blips, near-silent notes, "
        "out-of-range notes, stranded ones). Pass at least one threshold. "
        "Thresholds that would remove every note are refused." + _LENGTH_WARNING,
        {
            "clip_id": _CLIP_ID,
            "min_length_steps": {
                "type": "number",
                "description": "Drop notes shorter than this",
            },
            "min_velocity": {
                "type": "integer",
                "description": "Drop notes quieter than this",
            },
            "min_pitch": {"type": "integer", "minimum": 0, "maximum": 127},
            "max_pitch": {"type": "integer", "minimum": 0, "maximum": 127},
            "max_gap_steps": {
                "type": "number",
                "description": "Drop notes isolated by a bigger gap than this",
            },
        },
        ["clip_id"],
    ),
    _fn(
        "editor_set_clip_instrument",
        "Point a MIDI clip at a General MIDI program and re-render its audio "
        "through it. Use this rather than editor_set_clip for instrument "
        "changes — it re-bounces, so exports match playback." + _LENGTH_WARNING,
        {
            "clip_id": _CLIP_ID,
            "program": {
                "type": "integer",
                "minimum": 0,
                "maximum": 127,
                "description": "GM program (0 = Acoustic Grand Piano, 33 = Electric Bass)",
            },
        },
        ["clip_id", "program"],
    ),
    # ── tempo and time ──────────────────────────────────────────────────────
    _fn(
        "editor_set_clip_source_bpm",
        "Declare the tempo a clip's media was recorded or rendered at. This "
        "does NOT stretch anything — it is the reference editor_stretch_clip "
        "needs to turn a target tempo into a ratio, and the first thing to fix "
        "when a tempo match lands off the beat. Get the number from "
        "editor_detect_tempo.",
        {
            "clip_id": _CLIP_ID,
            "bpm": {"type": "number", "minimum": 40, "maximum": 240},
        },
        ["clip_id", "bpm"],
    ),
    _fn(
        "editor_stretch_clip",
        "Time-stretch a clip. A MIDI clip is re-rendered at the new tempo in "
        "the browser; an AUDIO clip goes to the backend for a pitch-preserving "
        "stretch (ratio 0.25x-4x). Pass exactly one target. target_bpm needs "
        "the clip's sourceBpm set.",
        {
            "clip_id": _CLIP_ID,
            "target_bpm": {
                "type": "number",
                "minimum": 40,
                "maximum": 240,
                "description": "Play the clip as if it were authored at this tempo",
            },
            "target_duration_sec": {
                "type": "number",
                "exclusiveMinimum": 0,
                "description": "Make the clip last exactly this long",
            },
            "ratio": {
                "type": "number",
                "minimum": 0.25,
                "maximum": 4,
                "description": "new_duration / old_duration. 2 = twice as long (half speed).",
            },
        },
        ["clip_id"],
    ),
    _fn(
        "editor_detect_tempo",
        "Detect a clip's tempo on the backend: returns {bpm, confidence, "
        "beats}. bpm is null when nothing periodic was found. Feed the answer "
        "to editor_set_clip_source_bpm before any tempo match.",
        {"clip_id": _CLIP_ID},
        ["clip_id"],
    ),
    _fn(
        "editor_set_time_signature",
        "Set the project meter. Bars, and therefore editor_seek_bar, are "
        "counted from it.",
        {
            "num": {
                "type": "integer",
                "minimum": 1,
                "maximum": 32,
                "description": "Beats per bar (the 7 of 7/8)",
            },
            "den": {
                "type": "integer",
                "enum": [1, 2, 4, 8, 16, 32],
                "description": "Beat unit (the 8 of 7/8)",
            },
        },
        ["num", "den"],
    ),
    _fn(
        "editor_nudge_clip",
        "Move a clip along the timeline. Pass exactly one distance; beats and "
        "bars are converted at the project tempo and meter. The clip is "
        "clamped at the timeline origin.",
        {
            "clip_id": _CLIP_ID,
            "delta_sec": {
                "type": "number",
                "description": "Seconds, negative moves earlier",
            },
            "beats": {"type": "number"},
            "bars": {"type": "number"},
        },
        ["clip_id"],
    ),
    # ── transport ───────────────────────────────────────────────────────────
    _fn(
        "editor_play",
        "Start playback on the EDIT timeline from the playhead. Fails with a "
        "reason when the EDIT workspace is not open — there is no transport to "
        "drive until it is.",
    ),
    _fn("editor_stop", "Stop playback on the EDIT timeline."),
    _fn(
        "editor_seek_bar",
        "Put the playhead at the top of a bar. Bars are 1-based, exactly as "
        "they are numbered on screen: bar 1 is the start of the song.",
        {"bar": {"type": "integer", "minimum": 1}},
        ["bar"],
    ),
    _fn(
        "editor_loop_selection",
        "Set the loop region to span some clips: the given clip_ids, or the "
        "current selection when none are given.",
        {
            "clip_ids": {
                "type": "array",
                "items": _CLIP_ID,
                "description": "Defaults to the current selection",
            }
        },
    ),
    # ── clips ───────────────────────────────────────────────────────────────
    _fn(
        "editor_set_clip",
        "Set a clip's playback properties. Fades longer than the clip, or a "
        "duration past the end of the clip's source media, are refused rather "
        "than clamped. For instrument_program use editor_set_clip_instrument.",
        {
            "clip_id": _CLIP_ID,
            "gain": {
                "type": "number",
                "minimum": 0,
                "description": "Linear gain, 1 = unity",
            },
            "fade_in_sec": {"type": "number", "minimum": 0},
            "fade_out_sec": {"type": "number", "minimum": 0},
            "muted": {"type": "boolean"},
            "duration_sec": {
                "type": "number",
                "exclusiveMinimum": 0,
                "description": "New length; the in point stays put",
            },
            "label": {"type": "string"},
        },
        ["clip_id"],
    ),
    _fn(
        "editor_trim_clip",
        "Move a clip's in and/or out point, in TIMELINE seconds (not seconds "
        "into the clip). Trimming the in point moves the clip's start and its "
        "window into the source together, so the audio under the remaining "
        "part does not shift.",
        {
            "clip_id": _CLIP_ID,
            "in_sec": {"type": "number", "description": "New start, timeline seconds"},
            "out_sec": {"type": "number", "description": "New end, timeline seconds"},
        },
        ["clip_id"],
    ),
    _fn(
        "editor_duplicate_clip",
        "Copy a clip onto the same track. Without at_sec the copy is "
        "butt-joined onto the end of the original.",
        {
            "clip_id": _CLIP_ID,
            "at_sec": {
                "type": "number",
                "minimum": 0,
                "description": "Where to put the copy",
            },
        },
        ["clip_id"],
    ),
    _fn(
        "editor_merge_clips",
        "Concatenate two or more clips on ONE track into a single audio clip. "
        "Each part's fades, gain and mute are baked into the samples first, "
        "then the originals are removed — this is not reversible except by "
        "editor_undo.",
        {
            "clip_ids": {
                "type": "array",
                "items": _CLIP_ID,
                "minItems": 2,
                "description": "At least two clips, all on the same track",
            }
        },
        ["clip_ids"],
    ),
    _fn(
        "editor_crossfade_clips",
        "Crossfade two touching or overlapping clips on the same track: "
        "symmetric fades across the overlap, and the later clip slides back to "
        "where the overlap begins. Clips with a gap between them, or on "
        "different tracks, are refused.",
        {
            "clip_id_a": _CLIP_ID,
            "clip_id_b": _CLIP_ID,
            "overlap_sec": {
                "type": "number",
                "exclusiveMinimum": 0,
                "description": "Shortened to fit the clips if it does not",
            },
        },
        ["clip_id_a", "clip_id_b", "overlap_sec"],
    ),
    _fn(
        "editor_reverse_clip",
        "Play a clip's audio backwards. Audio clips only: a MIDI clip is "
        "re-synthesised from its notes at playback, so reversing its rendered "
        "blob would only change exports — bounce it with flatten first.",
        {"clip_id": _CLIP_ID},
        ["clip_id"],
    ),
    _fn(
        "editor_normalize_clip",
        "Scale a clip's audio so its loudest sample lands on peak_db. Audio "
        "clips only, for the same reason as editor_reverse_clip.",
        {
            "clip_id": _CLIP_ID,
            "peak_db": {
                "type": "number",
                "maximum": 0,
                "description": "Target peak in dBFS. Default -1.",
            },
        },
        ["clip_id"],
    ),
    _fn(
        "editor_bounce_clip",
        "Make a clip's audio equal what the clip actually sounds like: a MIDI "
        "clip is re-synthesised from its notes, an audio clip has its fade "
        "envelope and gain printed into the samples. Use flatten to turn a "
        "MIDI clip into a plain audio clip (its notes are dropped).",
        {
            "clip_id": _CLIP_ID,
            "flatten": {
                "type": "boolean",
                "description": "MIDI only: drop the note list afterwards. Default false.",
            },
        },
        ["clip_id"],
    ),
    # ── selection and grid ──────────────────────────────────────────────────
    _fn(
        "editor_select_clips",
        "Replace the timeline's clip selection. An empty array clears it.",
        {"clip_ids": {"type": "array", "items": _CLIP_ID}},
        ["clip_ids"],
    ),
    _fn(
        "editor_select_range",
        "Select every clip that overlaps a span of the timeline, optionally "
        "restricted to some tracks.",
        {
            "start_sec": {"type": "number"},
            "end_sec": {"type": "number"},
            "track_ids": {
                "type": "array",
                "items": _TRACK_ID,
                "description": "Defaults to every track",
            },
        },
        ["start_sec", "end_sec"],
    ),
    _fn(
        "editor_select_notes",
        "Select notes inside a MIDI clip, by id or by a pitch/step window. "
        "Pass note_ids, or at least one of the filters.",
        {
            "clip_id": _CLIP_ID,
            "note_ids": {"type": "array", "items": {"type": "string"}},
            "min_pitch": {"type": "integer", "minimum": 0, "maximum": 127},
            "max_pitch": {"type": "integer", "minimum": 0, "maximum": 127},
            "start_step": {"type": "number"},
            "end_step": {"type": "number"},
        },
        ["clip_id"],
    ),
    _fn(
        "editor_set_snap",
        "Set the grid that timeline clip edits snap to. 'off' disables "
        "snapping. T = triplet, Q = quintuplet, S = septuplet, D = dotted.",
        {"snap": {"type": "string", "enum": _SNAP_DIVISIONS}},
        ["snap"],
    ),
    _fn(
        "editor_set_tool",
        "Set the timeline's active mouse tool.",
        {
            "tool": {
                "type": "string",
                "enum": ["move", "cut", "split"],
                "description": "move drags clips; cut and split divide them",
            }
        },
        ["tool"],
    ),
    # ── tracks ──────────────────────────────────────────────────────────────
    _fn(
        "editor_reorder_tracks",
        "Reorder tracks, top first. A partial list moves just those tracks to "
        "the top in that order and leaves the rest below in their current "
        "order.",
        {"track_ids": {"type": "array", "items": _TRACK_ID, "minItems": 1}},
        ["track_ids"],
    ),
    _fn(
        "editor_duplicate_track",
        "Copy a track together with all of its clips.",
        {"track_id": _TRACK_ID},
        ["track_id"],
    ),
    _fn(
        "editor_freeze_track",
        "Freeze a track to a printed stem. NOT AVAILABLE from here: freezing "
        "runs the offline renderer inside the EDIT timeline component, which "
        "the tool layer cannot reach, so this returns the path to the freeze "
        "button in the track header instead of pretending. Unfreezing IS "
        "supported — editor_set_track with frozen=false.",
        {"track_id": _TRACK_ID},
        ["track_id"],
    ),
    # ── analysis ────────────────────────────────────────────────────────────
    _fn(
        "editor_analyze_clip",
        "Measure a clip on the backend: duration, sample rate, channels, peak "
        "and RMS dBFS, detected tempo with its beats, onset times, and key. "
        "Onsets and beats are in the clip's own source time. Use it before "
        "deciding a gain, a tempo, or where the transients are.",
        {"clip_id": _CLIP_ID},
        ["clip_id"],
    ),
    _fn(
        "editor_compare_timing",
        "Measure how far a MIDI clip's notes sit from an audio clip's "
        "transients, and say which way to move them. Returns medianOffsetSec "
        "(audio minus MIDI: positive means the MIDI is EARLY and should move "
        "later) plus the exact editor_nudge_notes ms value to apply.",
        {
            "midi_clip_id": {
                "type": "string",
                "description": "The piano-roll clip whose notes are being aligned",
            },
            "audio_clip_id": {
                "type": "string",
                "description": "The audio clip to align them to (the reference)",
            },
            "max_match_sec": {
                "type": "number",
                "minimum": 0,
                "description": "Furthest a note may be from an onset to count as the same hit. Default 0.25.",
            },
        },
        ["midi_clip_id", "audio_clip_id"],
    ),
    _fn(
        "editor_get_waveform_peaks",
        "Downsample a clip's audio to absolute peak values in [0, 1], one per "
        "bucket, so the shape of the clip can be reasoned about without "
        "listening to it.",
        {
            "clip_id": _CLIP_ID,
            "buckets": {
                "type": "integer",
                "minimum": 8,
                "maximum": 2048,
                "description": "Number of buckets across the clip's source. Default 200.",
            },
        },
        ["clip_id"],
    ),
    # ── markers ─────────────────────────────────────────────────────────────
    _fn(
        "editor_remove_marker",
        "Delete a timeline marker.",
        {
            "marker_id": {
                "type": "string",
                "description": "Marker id from editorState, or its exact current label",
            }
        },
        ["marker_id"],
    ),
    _fn(
        "editor_rename_marker",
        "Rename a timeline marker. BOTH arguments are required: marker_id "
        "picks the marker (its id, or its exact CURRENT label) and name is the "
        "NEW label it gets. name never identifies the marker.",
        {
            "marker_id": {
                "type": "string",
                "description": (
                    "Required. Which marker: its id from editorState, or its "
                    "exact current label"
                ),
            },
            "name": {
                "type": "string",
                "description": "Required. The NEW label — not the current one",
            },
        },
        ["marker_id", "name"],
    ),
    # ── automation ──────────────────────────────────────────────────────────
    _fn(
        "editor_add_automation_lane",
        "Create an automation lane for a parameter, or report the one that "
        "already exists. A new lane is born holding the parameter's current "
        "value, so adding it changes nothing about how the mix sounds. Write "
        "the shape with editor_set_automation_points.",
        {
            "kind": {
                "type": "string",
                "enum": ["trackVolume", "trackPan", "trackFx", "masterFx"],
                "description": "What is being automated",
            },
            "track_id": {
                **_TRACK_ID,
                "description": "Required for trackVolume / trackPan / trackFx",
            },
            "entry_id": {
                "type": "string",
                "description": "FX chain entry id, required for trackFx / masterFx",
            },
            "param_key": {
                "type": "string",
                "description": "Numeric parameter on that FX entry, required for trackFx / masterFx",
            },
        },
        ["kind"],
    ),
    _fn(
        "editor_set_automation_points",
        "Replace a lane's breakpoints. Identify the lane by lane_id, or by the "
        "same kind/track_id/entry_id/param_key that created it. Breakpoints "
        "closer together than 20ms are merged, and the result says how many "
        "actually landed.",
        {
            "lane_id": {
                "type": "string",
                "description": "From editor_add_automation_lane",
            },
            "kind": {
                "type": "string",
                "enum": ["trackVolume", "trackPan", "trackFx", "masterFx"],
            },
            "track_id": _TRACK_ID,
            "entry_id": {"type": "string"},
            "param_key": {"type": "string"},
            "points": {
                "type": "array",
                "minItems": 1,
                "description": "The complete new breakpoint list",
                "items": {
                    "type": "object",
                    "properties": {
                        "t": {
                            "type": "number",
                            "minimum": 0,
                            "description": "Timeline seconds",
                        },
                        "v": {"type": "number", "description": "Parameter value at t"},
                    },
                    "required": ["t", "v"],
                },
            },
        },
        ["points"],
    ),
    # ── safety net ──────────────────────────────────────────────────────────
    _fn(
        "editor_undo",
        "Step one edit backwards on the EDIT timeline. Every tool that writes "
        "through this catalog is undoable.",
    ),
    _fn("editor_redo", "Step one edit forwards again."),
    _fn(
        "editor_snapshot",
        "Bookmark the whole arrangement under a name, outside undo history. "
        "Take one before any run of destructive edits; editor_restore puts it "
        "back. Re-using a name replaces that snapshot.",
        {"name": {"type": "string", "description": "What to call it"}},
        ["name"],
    ),
    _fn(
        "editor_restore",
        "Put a named snapshot back, replacing the current arrangement. The "
        "restore is itself undoable.",
        {
            "name": {
                "type": "string",
                "description": "A name from a previous editor_snapshot",
            }
        },
        ["name"],
    ),
    # ── DJ performance control ──────────────────────────────────────────────
    # Handlers have existed since the DJ tab shipped; these declarations are
    # what finally let a tool-calling provider reach them instead of writing
    # <action> blocks that only the scraper could see.
    _fn(
        "dj_get_state",
        "What is on in the DJ tab: the active set's name, the now-playing "
        "track, the running order, and every setlist that exists.",
    ),
    _fn(
        "dj_load_set",
        "Make a setlist active and switch to the DJ tab.",
        {
            "name": {
                "type": "string",
                "description": "Set name, case-insensitive; a substring matches",
            }
        },
        ["name"],
    ),
    _fn(
        "dj_automix",
        "Start or stop the automated set. Starting also switches to the DJ tab.",
        {"on": {"type": "boolean", "description": "true starts, false stops"}},
        ["on"],
    ),
    _fn(
        "dj_transition_now",
        "Blend into the next track at the next automix tick, instead of "
        "waiting for the prepared mix point.",
    ),
    _fn(
        "dj_set_next",
        "Reorder the live set so the named track plays next, straight after "
        "the one currently playing.",
        {
            "label": {
                "type": "string",
                "description": "Track title or label; a substring matches",
            }
        },
        ["label"],
    ),
]

PROVIDER_TOOLS.extend(_OVERDRIVE_TOOLS)


# ---------------------------------------------------------------------------
# MCP view
# ---------------------------------------------------------------------------
def thedaw_mcp_tools() -> list[dict[str, Any]]:
    """Return ``PROVIDER_TOOLS`` in the MCP ``tools/list`` shape.

    ``parameters`` becomes ``inputSchema``; everything else is carried over
    unchanged. The result is a deep copy so a caller that mutates it (e.g. the
    stdio server clamping a schema) cannot corrupt the shared catalog.

    ``description`` and ``parameters`` are read defensively: this runs at IMPORT
    time inside the stdio MCP child, so one half-written declaration must not
    take the whole tool surface down with a KeyError. ``name`` stays required —
    a nameless tool is unusable and has to fail loudly.
    """
    tools: list[dict[str, Any]] = []
    for tool in PROVIDER_TOOLS:
        fn = tool["function"]
        tools.append(
            {
                "name": fn["name"],
                "description": fn.get("description", ""),
                # Deep-copied per tool, so the fallback is never a shared dict.
                "inputSchema": copy.deepcopy(
                    fn.get("parameters", {"type": "object", "properties": {}})
                ),
            }
        )
    return tools
