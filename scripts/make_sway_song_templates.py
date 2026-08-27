"""Author per-song Sway Perform templates: Prologue, EACC, Just Give Up.

One .tasmo per song, each built from the library entry's 6-stem demucs
split (htdemucs_6s: drums/bass/guitar/piano/other/vocals). Every device
kind the .tasmo format can carry is present and reachable:

* BUILTIN rack effects — live in PERFORM, all pad/knob/XY routable.
* The Ares .gan — as the `ares` builtin composite on the Vox column
  (audible in PERFORM; its .gan control surface opens in EDIT/MIX).
* A real VST3 — TAL-Vocoder-2 on the Vox column with full vst_state
  (native GUI + offline render in EDIT/MIX; cleanly inert in PERFORM).

Pad layout (chromatic pad mode, notes 24..39):

* Pads 0-7  (notes 24..31): SCENE launches — an 8-row arc per song.
* Pads 8-15 (notes 32..39): FX PUNCHES — note-driven fx routes (momentary
  press/release, or latched where marked):
    8  KARGYRAA (latch)  Bass 'Kargyraa Sub' throat-growl engine in/out
    9  THROAT VOX        the same engine slammed onto the vocal stem
    10 GATER             tempo-synced trance gate, every column
    11 CRUSH             6-bit crush, every column
    12 ROBOT             ring-mod the keys column
    13 THROW             dub delay throw, every column
    14 FREEZE (latch)    Ares granular freeze + wash on the vox column
    15 SLAM              low-pass slam to 220 Hz, every column

* XY pad: X (CC 50) closes a resonant low-pass over every column while the
  delay blooms — and morphs the Kargyraa vowel (a->o->u->e) on bass + vox.
  Y (CC 38) drives filter resonance + delay feedback to the edge — and
  deepens the kargyraa growl + raises the sygyt whistle band on the bass.
* Knobs CC 20..25 are per-column volumes; CC 26/27 ride the delay time and
  tone across all columns (delay defaults to a dotted eighth at the song's
  analyzed tempo; the gater defaults to eighth-note rate).
* Gesture dims: pulse -> drums volume, strike -> bass volume, sway -> vox
  volume, press -> mute on the keys/texture columns.
* Transport authored on notes 40-43 + CC 19 (re-learnable on the deck).

The 'kargyraa' rack effect models Tuvan undertone singing welded to a
formant dubstep bass: an octave-divider sub + a period-doubling AM growl
gate (authored at HALF each song's fundamental, so the sidebands land on
the true subharmonic series), a morphing vowel formant bank, and a high-Q
sygyt "whistle" band. Authored with mix 0 — pads 8/9 punch it in.

Audio is LINKED, not embedded: the stems live under data/generations,
already inside a static media root.

Run from the repo root:  uv run python scripts/make_sway_song_templates.py
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
    VstPluginState,
)

GEN = REPO / "data" / "generations"

# The one real VST3 on this machine that suits the concept (vocoder = the
# electronic vocal tract). Only referenced if the file actually exists.
VOCODER_VST = Path(
    r"C:\Program Files\Common Files\VST3\TAL-Vocoder-2.vst3"
    r"\Contents\x86_64-win\TAL-Vocoder-2.vst3"
)

# Column layout: (track name, color, stem filename). Order fixes the
# knob (CC 20+col) and gesture-dim track indices below.
STEM_COLUMNS = [
    ("Drums", "#f59e0b", "drums.wav"),
    ("Bass", "#34d399", "bass.wav"),
    ("Gtr", "#a78bfa", "guitar.wav"),
    ("Keys", "#eab308", "piano.wav"),
    ("Tex", "#22d3ee", "other.wav"),
    ("Vox", "#f472b6", "vocals.wav"),
]
DRUMS, BASS, GTR, KEYS, TEX, VOX = range(6)

# Scene rows (pads 0-7): name -> set of active column indices.
SCENES: list[tuple[str, set[int]]] = [
    ("FULL MIX", {DRUMS, BASS, GTR, KEYS, TEX, VOX}),
    ("DRUMS + BASS", {DRUMS, BASS}),
    ("INSTRUMENTAL", {DRUMS, BASS, GTR, KEYS, TEX}),
    ("NO DRUMS", {BASS, GTR, KEYS, TEX, VOX}),
    ("VOX ONLY", {VOX}),
    ("STRIPPED — BASS + VOX", {BASS, VOX}),
    ("BREAKDOWN — KEYS TEX VOX", {KEYS, TEX, VOX}),
    ("DRUMS + VOX", {DRUMS, VOX}),
]

# (title, library entry id, analyzed tempo, key, length s, fundamental Hz).
# The fundamental drives the kargyraa growl rate (f0 / 2 = the true
# subharmonic AM rate): D#2 = 77.78 Hz, E2 = 82.41 Hz.
SONGS = [
    ("Prologue", "8e02e54d2a894bfe89e4e3d0f740eedb", 134.75, "D# minor", 196.0, 77.78),
    ("EACC", "19e259419ad94beab511d668650b32ef", 129.49, "E minor", 355.033, 82.41),
    (
        "Just Give Up",
        "b59f702915204c2b9543893d136ac196",
        147.55,
        "D# minor",
        373.401,
        77.78,
    ),
]

# Chain slots shared by every column (deviceIndex 0..3).
LP, DL, GT, BC = 0, 1, 2, 3
# Per-column extras (deviceIndex 4+, see build_chain).
KG = 4  # kargyraa on Bass and Vox
RM = 4  # ringmod on Keys
AR = 5  # ares on Vox


def build_chain(col: int, tempo: float, f0: float) -> list[EffectChainNode]:
    dotted8 = round(60000.0 / tempo * 0.75, 1)
    eighth_hz = round(tempo / 30.0, 2)
    growl = round(f0 / 2.0, 1)

    chain = [
        # 0: the XY pad's resonant low-pass (starts OPEN) / pad 15 SLAM.
        EffectChainNode(
            id=f"fx-{col}-lp",
            node_type="builtin",
            effect_name="lowpass",
            parameters={"frequency": 20000.0, "resonance": 0.7},
        ),
        # 1: dub delay — blooms on XY-X, throws on pad 13, K7/K8 ride it.
        EffectChainNode(
            id=f"fx-{col}-dl",
            node_type="builtin",
            effect_name="delay",
            parameters={
                "time": dotted8,
                "feedback": 0.35,
                "tone": 6000.0,
                "wet": 0.0,
            },
        ),
        # 2: trance gate at eighth-note rate, transparent until pad 10.
        EffectChainNode(
            id=f"fx-{col}-gt",
            node_type="builtin",
            effect_name="gater",
            parameters={"rate": eighth_hz, "depth": 0.0, "shape": 1.0, "sync": 0.0},
        ),
        # 3: 6-bit crush, dry until pad 11.
        EffectChainNode(
            id=f"fx-{col}-bc",
            node_type="builtin",
            effect_name="bitcrush",
            parameters={"bits": 6.0, "mix": 0.0},
        ),
    ]

    if col == BASS:
        chain.append(
            # 4: THE sound — subharmonic throat bass, punched in by pad 8.
            EffectChainNode(
                id=f"fx-{col}-kg",
                node_type="builtin",
                effect_name="kargyraa",
                parameters={
                    "mix": 0.0,
                    "subLevel": 1.0,
                    "deepLevel": 0.35,
                    "growlRate": growl,
                    "growlDepth": 0.65,
                    "drive": 16.0,
                    "vowel": 0.5,
                    "motionRate": 0.7,
                    "motionDepth": 0.3,
                    "whistleHz": 1500.0,
                    "whistleAmt": 0.4,
                },
            )
        )
    if col == KEYS:
        chain.append(
            # 4: ring-mod robotics, pad 12.
            EffectChainNode(
                id=f"fx-{col}-rm",
                node_type="builtin",
                effect_name="ringmod",
                parameters={"frequency": 140.0, "mix": 0.0},
            )
        )
    if col == VOX:
        chain.append(
            # 4: kargyraa on the vocal stem = actual throat-singing vox (pad 9).
            EffectChainNode(
                id=f"fx-{col}-kg",
                node_type="builtin",
                effect_name="kargyraa",
                parameters={
                    "mix": 0.0,
                    "subLevel": 0.6,
                    "deepLevel": 0.2,
                    "growlRate": growl,
                    "growlDepth": 0.7,
                    "drive": 12.0,
                    "vowel": 1.0,
                    "motionRate": 1.2,
                    "motionDepth": 0.45,
                    "whistleHz": 1700.0,
                    "whistleAmt": 0.5,
                },
            )
        )
        chain.append(
            # 5: Ares (.gan composite) — granular freeze + wash, pad 14.
            # Authored fully dry (wetDry 0); the FREEZE latch engages it.
            EffectChainNode(
                id=f"fx-{col}-ar",
                node_type="builtin",
                effect_name="ares",
                parameters={
                    "wetDry": 0.0,
                    "freeze": 0.0,
                    "filterOn": 0.0,
                    "delayOn": 1.0,
                    "delayTime": 0.55,
                    "delayFeedback": 0.45,
                    "delayMix": 0.25,
                    "reverbOn": 1.0,
                    "reverbSize": 0.6,
                    "reverbMix": 0.45,
                    "grainsOn": 1.0,
                    "grainsDensity": 0.5,
                    "grainsSize": 0.45,
                    "grainsSpread": 0.6,
                    "grainsMix": 0.85,
                    "gateOn": 0.0,
                    "gateRate": 0.33,
                    "gateDepth": 0.0,
                },
            )
        )
        if VOCODER_VST.is_file():
            chain.append(
                # 6: real VST3 with full vst_state — opens natively in EDIT/MIX,
                # cleanly inert in PERFORM's live graph.
                EffectChainNode(
                    id=f"fx-{col}-vst",
                    node_type="vst3",
                    effect_name="TAL-Vocoder-2",
                    parameters={},
                    vst_state=VstPluginState(
                        plugin_path=str(VOCODER_VST),
                        plugin_name="TAL-Vocoder-2",
                        parameters={},
                    ),
                )
            )
    return chain


def fx_mod(
    *,
    kind: str,
    number: int,
    is_note: bool,
    col: int,
    device: int,
    param: str,
    lo: float,
    hi: float,
    label: str,
    latch: bool = False,
) -> dict:
    mod: dict = {
        "id": f"{kind}:{number}:{col}:fx:{device}:{param}",
        "channel": -1,
        "number": number,
        "isNote": is_note,
        "trackIndex": col,
        "target": "fx",
        "deviceIndex": device,
        "paramKey": param,
        "min": lo,
        "max": hi,
        "label": label,
    }
    if latch:
        mod["latch"] = True
    return mod


def build_project(
    title: str, entry_id: str, tempo: float, length: float, f0: float
) -> TasmoProject:
    stems_dir = GEN / entry_id / "stems"
    for _, _, fname in STEM_COLUMNS:
        if not (stems_dir / fname).is_file():
            raise SystemExit(f"stem missing for {title}: {stems_dir / fname}")

    tracks: list[Track] = []
    for col, (name, color, fname) in enumerate(STEM_COLUMNS):
        path = stems_dir / fname
        clips: list[Clip] = []
        for row, (scene_name, cols) in enumerate(SCENES):
            if col not in cols:
                continue
            clips.append(
                Clip(
                    id=f"c-{col}-{row}",
                    name=f"{name} · {scene_name}",
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
                effect_chain=build_chain(col, tempo, f0),
            )
        )

    # ── perform_routing ──────────────────────────────────────────────────
    cc_mods: list[dict] = []
    for col, (name, _c, _f) in enumerate(STEM_COLUMNS):
        label = f"{col + 1:02d} {name}"
        # Knobs CC 20..25 -> column volume.
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
        # Knob CC 26/27 -> delay time / tone across every column.
        cc_mods.append(
            fx_mod(kind="deck", number=26, is_note=False, col=col, device=DL,
                   param="time", lo=100, hi=500, label=f"K7 {label} · Delay time"))  # fmt: skip
        cc_mods.append(
            fx_mod(kind="deck", number=27, is_note=False, col=col, device=DL,
                   param="tone", lo=2000, hi=12000, label=f"K8 {label} · Delay tone"))  # fmt: skip
        # XY X (CC 50): close the filter, bloom the delay.
        cc_mods.append(
            fx_mod(kind="deck", number=50, is_note=False, col=col, device=LP,
                   param="frequency", lo=20000, hi=160, label=f"XY·X {label} · Filter sweep"))  # fmt: skip
        cc_mods.append(
            fx_mod(kind="deck", number=50, is_note=False, col=col, device=DL,
                   param="wet", lo=0, hi=0.6, label=f"XY·X {label} · Echo bloom"))  # fmt: skip
        # XY Y (CC 38): resonance scream + feedback to the edge.
        cc_mods.append(
            fx_mod(kind="deck", number=38, is_note=False, col=col, device=LP,
                   param="resonance", lo=0.6, hi=14, label=f"XY·Y {label} · Scream"))  # fmt: skip
        cc_mods.append(
            fx_mod(kind="deck", number=38, is_note=False, col=col, device=DL,
                   param="feedback", lo=0.15, hi=0.9, label=f"XY·Y {label} · Dub tail"))  # fmt: skip

    # XY rides on the kargyraa engines (audible while pads 8/9 hold them in).
    for col in (BASS, VOX):
        cc_mods.append(
            fx_mod(kind="deck", number=50, is_note=False, col=col, device=KG,
                   param="vowel", lo=0.2, hi=3.2, label=f"XY·X {col + 1:02d} · Kargyraa vowel"))  # fmt: skip
        cc_mods.append(
            fx_mod(kind="deck", number=38, is_note=False, col=col, device=KG,
                   param="growlDepth", lo=0.3, hi=1.0, label=f"XY·Y {col + 1:02d} · Kargyraa growl"))  # fmt: skip
    cc_mods.append(
        fx_mod(kind="deck", number=38, is_note=False, col=BASS, device=KG,
               param="whistleAmt", lo=0.0, hi=0.9, label="XY·Y 02 · Sygyt whistle"))  # fmt: skip

    # ── FX punches: pads 8-15 = notes 32..39 ─────────────────────────────
    # Momentary punches push max on press, min on release; latch toggles.
    def punch_all(
        note: int, device: int, param: str, lo: float, hi: float, label: str
    ) -> None:
        for col in range(len(STEM_COLUMNS)):
            cc_mods.append(
                fx_mod(kind="pad", number=note, is_note=True, col=col,
                       device=device, param=param, lo=lo, hi=hi, label=label))  # fmt: skip

    cc_mods.append(
        fx_mod(kind="pad", number=32, is_note=True, col=BASS, device=KG,
               param="mix", lo=0, hi=1, label="KARGYRAA", latch=True))  # fmt: skip
    cc_mods.append(
        fx_mod(kind="pad", number=33, is_note=True, col=VOX, device=KG,
               param="mix", lo=0, hi=1, label="THROAT VOX"))  # fmt: skip
    punch_all(34, GT, "depth", 0, 0.92, "GATER")
    punch_all(35, BC, "mix", 0, 1, "CRUSH")
    cc_mods.append(
        fx_mod(kind="pad", number=36, is_note=True, col=KEYS, device=RM,
               param="mix", lo=0, hi=1, label="ROBOT"))  # fmt: skip
    punch_all(37, DL, "wet", 0, 0.72, "THROW")
    cc_mods.append(
        fx_mod(kind="pad", number=38, is_note=True, col=VOX, device=AR,
               param="freeze", lo=0, hi=1, label="FREEZE", latch=True))  # fmt: skip
    cc_mods.append(
        fx_mod(kind="pad", number=38, is_note=True, col=VOX, device=AR,
               param="wetDry", lo=0, hi=0.9, label="FREEZE", latch=True))  # fmt: skip
    punch_all(39, LP, "frequency", 20000, 220, "SLAM")

    track_mods = [
        # pulse -> drums, strike -> bass, sway -> vox (volume); press kills keys/tex.
        {
            "id": "pulse:0:volume",
            "dim": "pulse",
            "trackIndex": DRUMS,
            "target": "volume",
        },
        {
            "id": "strike:1:volume",
            "dim": "strike",
            "trackIndex": BASS,
            "target": "volume",
        },
        {"id": "sway:5:volume", "dim": "sway", "trackIndex": VOX, "target": "volume"},
        {"id": "press:3:mute", "dim": "press", "trackIndex": KEYS, "target": "mute"},
        {"id": "press:4:mute", "dim": "press", "trackIndex": TEX, "target": "mute"},
    ]

    # Pads 0-7 (notes 24..31) launch the 8 scenes.
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
        project_name=f"Sway Perform — {title}",
        author="GANTASMO",
        tempo=tempo,
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
    if not VOCODER_VST.is_file():
        print(f"note: {VOCODER_VST} not found — templates written without the VST node")
    for title, entry_id, tempo, key, length, f0 in SONGS:
        project = build_project(title, entry_id, tempo, length, f0)
        out = out_dir / f"Sway Perform - {title}.tasmo"
        manifest = TasmoFile.save(project, str(out), embed_audio=False)
        clips = sum(len(t.clips) for t in project.tracks)
        devices = sum(len(t.effect_chain) for t in project.tracks)
        routing = project.perform_routing or {}
        cc = routing.get("ccMods", [])
        punches = [m for m in cc if m.get("isNote")]
        print(f"wrote {out}")
        print(
            f"  {tempo} BPM {key} · tracks={manifest['total_tracks']} "
            f"clips={clips} scenes={len(project.scenes)} devices={devices}"
        )
        print(
            f"  routing: {len(routing.get('sceneCtrls', {}))} scene pads, "
            f"{len(punches)} punch routes on pads 8-15, "
            f"{len(cc) - len(punches)} knob/XY routes, "
            f"{len(routing.get('trackMods', []))} dim mods"
        )
        # Round-trip: what we wrote must load back intact.
        loaded, _ = TasmoFile.load(str(out))
        loaded_clips = sum(len(t.clips) for t in loaded.tracks)
        loaded_routes = len((loaded.perform_routing or {}).get("ccMods", []))
        loaded_vst = sum(
            1
            for t in loaded.tracks
            for n in t.effect_chain
            if n.node_type == "vst3" and n.vst_state is not None
        )
        assert loaded_clips == clips, f"round-trip clip loss: {loaded_clips} != {clips}"
        assert loaded_routes == len(cc), "round-trip ccMod loss"
        print(
            f"  round-trip OK ({loaded_clips} clips, {loaded_routes} routes, "
            f"{loaded_vst} vst node(s) with state)"
        )


if __name__ == "__main__":
    main()
