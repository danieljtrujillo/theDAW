"""Author the Sway performance template .tasmo (Madman Returns x Et Tu Machina).

Builds a Perform-grid set that exercises EVERYTHING the Sway can reach:

* 8 stem columns (Madman Returns drums/bass/tex/vox + Et Tu Machina
  drums/bass/keys/vox), every clip a full-length LOOP so launches sustain.
* 16 scenes on the 16 pads (notes 24..39): full mixes, stem subsets, and
  cross-song CLASH rows.
* The XY pad is the headline effect: X (CC 50) sweeps a resonant low-pass
  down from 20 kHz to 160 Hz across every column while the delay blooms in
  (amount applied); Y (CC 38) drives the tone — resonance up to a scream and
  delay feedback to the edge of self-oscillation.
* Knobs CC 20..27 are per-column volume faders.
* Gesture dims: pulse -> drum volumes, strike -> bass volumes, sway -> vox
  volumes, press -> mute on the texture/keys columns.
* Transport authored on notes 40-43 + CC 19 (re-learnable on the deck).

Audio is LINKED, not embedded: the demucs stems live under data/generations,
already inside a static media root, and embedding ~340 MB of WAVs would bloat
the file for nothing.

Run from the repo root:  uv run python scripts/make_sway_template.py
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))

from backend.modules.project.tasmo_file import TasmoFile  # noqa: E402
from backend.modules.project.tasmo_project import (  # noqa: E402
    Clip,
    EffectChainNode,
    TasmoProject,
    Track,
)

GEN = REPO / "data" / "generations"
MAD = GEN / "e14968078c13406b8c5888a35ec5f36f" / "stems"  # Madman Returns
MAC = GEN / "68006988e370427d9108e5c5d724a9f5" / "stems"  # Et Tu Machina
MAD_LEN = 157.0
MAC_LEN = 160.026

# Column layout: (track name, color, default stem path, length).
COLUMNS = [
    ("MAD Drums", "#f59e0b", MAD / "drums.wav", MAD_LEN),
    ("MAD Bass", "#34d399", MAD / "bass.wav", MAD_LEN),
    ("MAD Tex", "#a78bfa", MAD / "other.wav", MAD_LEN),
    ("MAD Vox", "#f472b6", MAD / "vocals.wav", MAD_LEN),
    ("MAC Drums", "#fb923c", MAC / "drums.wav", MAC_LEN),
    ("MAC Bass", "#22d3ee", MAC / "bass.wav", MAC_LEN),
    ("MAC Keys", "#eab308", MAC / "guitar.wav", MAC_LEN),
    ("MAC Vox", "#ec4899", MAC / "vocals.wav", MAC_LEN),
]

# Scene rows: name -> {column: stem-path-override or True for the default}.
SCENES: list[tuple[str, dict[int, Path | bool]]] = [
    ("MADMAN — FULL", {0: True, 1: True, 2: True, 3: True}),
    ("MADMAN — DRUMS+BASS", {0: True, 1: True}),
    ("MADMAN — INSTRUMENTAL", {0: True, 1: True, 2: True}),
    ("MADMAN — VOX+TEX", {2: True, 3: True}),
    ("MACHINA — FULL", {4: True, 5: True, 6: True, 7: True}),
    ("MACHINA — DRUMS+BASS", {4: True, 5: True}),
    ("MACHINA — KEYS+VOX", {6: MAC / "piano.wav", 7: True}),
    ("MACHINA — INSTRUMENTAL", {4: True, 5: True, 6: True}),
    ("CLASH — MAD DRUMS x MAC VOX", {0: True, 1: True, 7: True}),
    ("CLASH — MAC DRUMS x MAD VOX", {4: True, 5: True, 3: True}),
    ("CLASH — DOUBLE DRUMS", {0: True, 4: True}),
    (
        "FULL COLLISION",
        {0: True, 1: True, 2: True, 3: True, 4: True, 5: True, 6: True, 7: True},
    ),
    ("MAD — VOX ONLY", {3: True}),
    ("MAC — VOX ONLY", {7: True}),
    ("TEXTURES", {2: True, 6: MAC / "other.wav"}),
    ("BASS DUEL", {1: True, 5: True}),
]


def build_project() -> TasmoProject:
    for _, _, p, _ in COLUMNS:
        if not p.is_file():
            raise SystemExit(f"stem missing: {p}")

    tracks: list[Track] = []
    for col, (name, color, _default, _length) in enumerate(COLUMNS):
        clips: list[Clip] = []
        for row, (scene_name, cols) in enumerate(SCENES):
            spec = cols.get(col)
            if spec is None:
                continue
            path = _default if spec is True else spec
            length = MAD_LEN if MAD in path.parents else MAC_LEN
            stem_label = path.stem
            clips.append(
                Clip(
                    id=f"c-{col}-{row}",
                    name=f"{name} · {stem_label} · {scene_name}",
                    clip_type="audio",
                    track_id=f"t-{col}",
                    audio_file=str(path),
                    start_time=0.0,
                    end_time=length,
                    loop_start=0.0,
                    loop_end=length,
                    track_index=col,
                    scene_index=row,
                    slot_index=row,
                )
            )
        tracks.append(
            Track(
                id=f"t-{col}",
                name=name,
                type="audio",
                color=color,
                order=col,
                clips=clips,
                effect_chain=[
                    # Device 0: the XY pad's resonant low-pass (starts OPEN).
                    EffectChainNode(
                        id=f"fx-{col}-lp",
                        node_type="builtin",
                        effect_name="lowpass",
                        parameters={"frequency": 20000.0, "resonance": 0.7},
                    ),
                    # Device 1: dub delay that blooms in as X closes the filter.
                    EffectChainNode(
                        id=f"fx-{col}-dl",
                        node_type="builtin",
                        effect_name="delay",
                        parameters={
                            "time": 375.0,
                            "feedback": 0.35,
                            "tone": 6000.0,
                            "wet": 0.0,
                        },
                    ),
                ],
            )
        )

    # ── perform_routing: every pad, knob, gesture and the XY pad mapped ──
    cc_mods: list[dict] = []
    for col, (name, _c, _p, _l) in enumerate(COLUMNS):
        label = f"{col + 1:02d} {name}"
        # Knobs CC 20..27 -> column volume.
        cc_mods.append(
            {
                "id": f"deck:{20 + col}:{col}:volume",
                "channel": -1,
                "number": 20 + col,
                "isNote": False,
                "trackIndex": col,
                "target": "volume",
                "label": f"{label} · Vol",
            }
        )
        # XY X (CC 50) = AMOUNT: close the filter, bloom the delay.
        cc_mods.append(
            {
                "id": f"deck:50:{col}:fx:0:frequency",
                "channel": -1,
                "number": 50,
                "isNote": False,
                "trackIndex": col,
                "target": "fx",
                "deviceIndex": 0,
                "paramKey": "frequency",
                "min": 20000,
                "max": 160,
                "label": f"XY·X {label} · Filter sweep",
            }
        )
        cc_mods.append(
            {
                "id": f"deck:50:{col}:fx:1:wet",
                "channel": -1,
                "number": 50,
                "isNote": False,
                "trackIndex": col,
                "target": "fx",
                "deviceIndex": 1,
                "paramKey": "wet",
                "min": 0,
                "max": 0.6,
                "label": f"XY·X {label} · Echo bloom",
            }
        )
        # XY Y (CC 38) = TONE: resonance scream + feedback to the edge.
        cc_mods.append(
            {
                "id": f"deck:38:{col}:fx:0:resonance",
                "channel": -1,
                "number": 38,
                "isNote": False,
                "trackIndex": col,
                "target": "fx",
                "deviceIndex": 0,
                "paramKey": "resonance",
                "min": 0.6,
                "max": 14,
                "label": f"XY·Y {label} · Scream",
            }
        )
        cc_mods.append(
            {
                "id": f"deck:38:{col}:fx:1:feedback",
                "channel": -1,
                "number": 38,
                "isNote": False,
                "trackIndex": col,
                "target": "fx",
                "deviceIndex": 1,
                "paramKey": "feedback",
                "min": 0.15,
                "max": 0.9,
                "label": f"XY·Y {label} · Dub tail",
            }
        )

    track_mods = [
        # pulse -> drums, strike -> bass, sway -> vox (volume); press kills tex/keys.
        {"id": "pulse:0:volume", "dim": "pulse", "trackIndex": 0, "target": "volume"},
        {"id": "pulse:4:volume", "dim": "pulse", "trackIndex": 4, "target": "volume"},
        {"id": "strike:1:volume", "dim": "strike", "trackIndex": 1, "target": "volume"},
        {"id": "strike:5:volume", "dim": "strike", "trackIndex": 5, "target": "volume"},
        {"id": "sway:3:volume", "dim": "sway", "trackIndex": 3, "target": "volume"},
        {"id": "sway:7:volume", "dim": "sway", "trackIndex": 7, "target": "volume"},
        {"id": "press:2:mute", "dim": "press", "trackIndex": 2, "target": "mute"},
        {"id": "press:6:mute", "dim": "press", "trackIndex": 6, "target": "mute"},
    ]

    scene_ctrls = {
        str(i): {"isNote": True, "channel": -1, "number": 24 + i}
        for i in range(len(SCENES))
    }

    transport = {
        "launch": {"isNote": True, "channel": -1, "number": 40},
        "stop": {"isNote": True, "channel": -1, "number": 41},
        "next": {"isNote": True, "channel": -1, "number": 42},
        "prev": {"isNote": True, "channel": -1, "number": 43},
        "select": {"isNote": False, "channel": -1, "number": 19},
    }

    return TasmoProject(
        project_name="Sway Live Template - Madman x Machina",
        author="GANTASMO",
        tempo=96.0,
        time_signature=[4, 4],
        sample_rate=44100,
        scenes=[name for name, _ in SCENES],
        tracks=tracks,
        source_daw="thedaw-template",
        perform_routing={
            "transport": transport,
            "sceneCtrls": scene_ctrls,
            "trackMods": track_mods,
            "ccMods": cc_mods,
        },
    )


def main() -> None:
    out_dir = Path.home() / "Documents" / "theDAW Projects"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / "Sway Live Template - Madman x Machina.tasmo"
    project = build_project()
    manifest = TasmoFile.save(project, str(out), embed_audio=False)
    clips = sum(len(t.clips) for t in project.tracks)
    print(f"wrote {out}")
    print(
        f"  tracks={manifest['total_tracks']} clips={clips} scenes={len(project.scenes)}"
    )
    routing = project.perform_routing or {}
    print(
        f"  routing: {len(routing.get('sceneCtrls', {}))} pads, "
        f"{len(routing.get('ccMods', []))} direct routes, "
        f"{len(routing.get('trackMods', []))} dim mods, "
        f"{len(routing.get('transport', {}))} transport fns"
    )


if __name__ == "__main__":
    main()
