"""scripts/build_orchestra_sf3.py: zone mapping and modulator writing.

Everything runs on a tiny synthetic sample set (a few sine tones written by
the test), so nothing here touches the network or the sample cache.
"""

from __future__ import annotations

import importlib.util
import io
import math
import sys
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

_SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "build_orchestra_sf3.py"


def _load():
    spec = importlib.util.spec_from_file_location("build_orchestra_sf3", _SCRIPT)
    module = importlib.util.module_from_spec(spec)
    sys.modules["build_orchestra_sf3"] = module
    spec.loader.exec_module(module)
    return module


B = _load()

SFZ = r"""
<control>
default_path=Strings\Violin Section\susVib\

<global>
ampeg_attack=0.001
ampeg_release=0.8 // trailing comment
volume=0

<group> //Begin Group 1
lorand=0.0 hirand=0.5

<region>
sample=VlnEns_susVib_A2_v1.wav
lokey=56
hikey=57
pitch_keycenter=57
lovel=0
hivel=62
volume=20

<region>
sample=VlnEns_susVib_A2_v2.wav
lokey=56
hikey=57
pitch_keycenter=57
lovel=63
hivel=127
volume=17

<group>
lorand=0.5 hirand=1.0

<region>
sample=VlnEns_susVib_A2_v1_rr2.wav
lokey=56
hikey=57
pitch_keycenter=57
"""


def test_note_names_use_c4_as_middle_c():
    assert B.note_to_midi("C4") == 60
    assert B.note_to_midi("A#0") == 22
    assert B.note_to_midi("F#3") == 54
    assert B.note_to_midi("Eb3") == 51
    assert B.note_to_midi("c-1") == 0


def test_parse_sfz_inherits_opcodes_and_joins_default_path():
    regions = B.parse_sfz(SFZ)
    assert len(regions) == 3
    first = regions[0]
    assert first.sample == "Strings/Violin Section/susVib/VlnEns_susVib_A2_v1.wav"
    assert (first.lokey, first.hikey, first.keycenter) == (56, 57, 57)
    assert (first.lovel, first.hivel) == (0, 62)
    assert first.volume == 20
    assert first.release == pytest.approx(0.8)
    assert first.opcodes["lorand"] == "0.0"
    # Two opcodes on one line are both read.
    assert regions[2].opcodes["hirand"] == "1.0"


def test_first_round_robin_drops_later_groups_and_refuses_keyswitches():
    kept = B.first_round_robin(B.parse_sfz(SFZ))
    assert [r.sample.rsplit("/", 1)[-1] for r in kept] == [
        "VlnEns_susVib_A2_v1.wav",
        "VlnEns_susVib_A2_v2.wav",
    ]
    seq = B.parse_sfz(
        "<group>seq_position=2\n<region>sample=a.wav\n<group>seq_position=1\n<region>sample=b.wav"
    )
    assert [r.sample for r in B.first_round_robin(seq)] == ["b.wav"]
    with pytest.raises(ValueError):
        B.first_round_robin(B.parse_sfz("<group>sw_last=24\n<region>sample=a.wav"))


def _region(name, lo, hi, center, lovel=0, hivel=127, volume=0.0):
    return B.Region(
        sample=name,
        lokey=lo,
        hikey=hi,
        keycenter=center,
        lovel=lovel,
        hivel=hivel,
        volume=volume,
    )


def test_cc1_zones_follow_the_layer_stack_per_key_run():
    regions = [
        # keys 40-47: two layers with the same split
        _region("low_p", 40, 47, 43, 0, 62),
        _region("low_f", 40, 47, 43, 63, 127),
        # keys 48-55: the f layer covers only 52-55, so 48-51 is one layer
        _region("mid_p", 48, 55, 50, 0, 41),
        _region("mid_mf", 48, 55, 50, 42, 83),
        _region("mid_f", 52, 55, 53, 84, 127),
    ]
    plans = B.plan_zones(regions, "cc1")
    got = [(p.region.sample, p.lokey, p.hikey, p.layer, p.layers) for p in plans]
    assert got == [
        ("low_p", 40, 47, 0, 2),
        ("low_f", 40, 47, 1, 2),
        ("mid_p", 48, 51, 0, 2),
        ("mid_mf", 48, 51, 1, 2),
        ("mid_p", 52, 55, 0, 3),
        ("mid_mf", 52, 55, 1, 3),
        ("mid_f", 52, 55, 2, 3),
    ]
    for p in plans:
        assert (p.lovel, p.hivel) == (0, 127)
        assert p.modulators == [
            *B.cc1_layer_modulators(p.layer, p.layers),
            *([B.cc1_level_modulator()] if p.layers == 1 else []),
        ]
        assert B.NO_MOD_WHEEL_VIBRATO in p.modulators


def test_cc1_keeps_softest_middle_and_loudest_of_four_layers():
    regions = [_region(f"v{i}", 60, 62, 61, 32 * i, 32 * i + 31) for i in range(4)]
    plans = B.plan_zones(regions, "cc1")
    assert [p.region.sample for p in plans] == ["v0", "v2", "v3"]
    assert {p.layers for p in plans} == {3}


def test_single_layer_zone_swells_on_cc1_without_mod_wheel_vibrato():
    plans = B.plan_zones([_region("solo", 0, 127, 60)], "cc1", level_db=12)
    assert len(plans) == 1
    assert plans[0].modulators == [B.NO_MOD_WHEEL_VIBRATO, B.cc1_level_modulator(12)]
    level = B.cc1_level_modulator(12)
    assert level.amount == 120
    assert B.layer_attenuation_cb([level], 0) == pytest.approx(120)
    assert B.layer_attenuation_cb([level], 127) == pytest.approx(120 / 128, abs=1e-6)
    assert B.NO_MOD_WHEEL_VIBRATO.src == 0x0081
    assert B.NO_MOD_WHEEL_VIBRATO.dest == B.GEN_VIB_LFO_TO_PITCH
    assert B.NO_MOD_WHEEL_VIBRATO.amount == 0


def test_velocity_zones_keep_the_sfz_ranges():
    regions = [
        _region("hit_p", 36, 38, 37, 0, 80),
        _region("hit_f", 36, 38, 37, 81, 127),
    ]
    plans = B.plan_zones(regions, "velocity")
    assert [(p.lokey, p.hikey, p.lovel, p.hivel, p.modulators) for p in plans] == [
        (36, 38, 0, 80, []),
        (36, 38, 81, 127, []),
    ]


def _gain(layer, layers, cc):
    return 10 ** (
        -B.layer_attenuation_cb(B.cc1_layer_modulators(layer, layers), cc) / 200
    )


@pytest.mark.parametrize("layers", [2, 3])
def test_cc1_crossfade_ends_on_the_outer_layers(layers):
    assert _gain(0, layers, 0) == pytest.approx(1.0)
    assert _gain(layers - 1, layers, 0) < 10 ** (-40 / 20)
    assert _gain(layers - 1, layers, 127) > 0.98
    assert _gain(0, layers, 127) < 10 ** (-40 / 20)


def test_two_layer_crossfade_is_a_linear_gain_ramp():
    for cc in range(0, 128, 4):
        x = (cc << 7) / 16384
        assert _gain(0, 2, cc) == pytest.approx(1 - x, abs=5e-3)
        assert _gain(1, 2, cc) == pytest.approx(x, abs=5e-3)


def test_three_layer_crossfade_splits_at_the_midpoint():
    # Midpoint: the middle layer alone, at full level, with the outer two muted
    # even though a "> 0.5" switch reads CC1 = 64 as neither half.
    assert _gain(1, 3, 64) == pytest.approx(1.0)
    assert _gain(0, 3, 64) < 1e-6
    assert _gain(2, 3, 64) < 1e-6
    for cc in range(0, 64, 4):
        x = (cc << 7) / 16384
        assert _gain(0, 3, cc) + _gain(1, 3, cc) == pytest.approx(1.0, abs=5e-3)
        assert _gain(2, 3, cc) < 1e-6
        assert _gain(0, 3, cc) == pytest.approx(1 - 2 * x, abs=5e-3)
    for cc in range(68, 128, 4):
        assert _gain(1, 3, cc) + _gain(2, 3, cc) == pytest.approx(1.0, abs=5e-3)
        assert _gain(0, 3, cc) < 1e-6


def test_three_layer_modulators_are_distinct_per_zone():
    for layer in range(3):
        mods = B.cc1_layer_modulators(layer, 3)
        keys = [(m.src, m.dest, m.amt_src, m.trans) for m in mods]
        assert len(keys) == len(set(keys)), (
            "identical modulators in one zone replace each other"
        )


def test_modulator_source_words_follow_the_spec():
    assert B.mod_source(1) == 0x0081
    assert B.mod_source(1, negative=True, curve=B.CURVE_CONCAVE) == 0x0581
    assert B.mod_source(1, bipolar=True, curve=B.CURVE_CONVEX) == 0x0A81
    assert B.mod_source(1, negative=True, bipolar=True, curve=B.CURVE_SWITCH) == 0x0F81
    assert B.Modulator(0x0581, 48, 480).pack() == bytes.fromhex(
        "81053000e0010000 0000".replace(" ", "")
    )


def test_regions_from_files_maps_names_to_keys_and_velocity_bands():
    fmap = B.FileMap(
        folder="Harp",
        pattern=r"^KSHarp_(?P<note>[A-G]#?-?\d)_(?P<dyn>p|mf|f)\d*\.wav$",
        dynamics=("p", "mf", "f"),
    )
    names = [
        "KSHarp_A2_mf1.wav",
        "KSHarp_A2_f1.wav",
        "KSHarp_C3_f2.wav",
        "KSHarp_E3_f1.wav",
        "notes.txt",
    ]
    regions = B.regions_from_files(names, fmap)
    got = [(r.sample, r.lokey, r.hikey, r.keycenter, r.lovel, r.hivel) for r in regions]
    assert got == [
        ("Harp/KSHarp_A2_mf1.wav", 0, 46, 45, 0, 63),
        ("Harp/KSHarp_A2_f1.wav", 0, 46, 45, 64, 127),
        ("Harp/KSHarp_C3_f2.wav", 47, 50, 48, 0, 127),
        ("Harp/KSHarp_E3_f1.wav", 51, 127, 52, 0, 127),
    ]
    shifted = B.regions_from_files(
        ["KSHarp_A2_f1.wav"], B.FileMap("Harp", fmap.pattern, fmap.dynamics, 12)
    )
    assert shifted[0].keycenter == 57


# --------------------------------------------------------------------------
# Writing a bank from a synthetic sample set


def _tone(freq, seconds=0.3, rate=22050, amp=0.1):
    t = np.arange(int(seconds * rate)) / rate
    tone = amp * np.sin(2 * np.pi * freq * t).astype(np.float32)
    return np.stack([tone, tone], axis=1), rate  # stereo, like VSCO


def _synthetic_plan(attack_spike=False):
    names = ["Violins", "Violas", "Celli", "Contrabass"]
    specs = [
        B.PresetSpec(n, "strings", "sustain", 0, 40 + i, "cc1", "vsco", f"{n}.sfz")
        for i, n in enumerate(names)
    ]
    specs.append(
        B.PresetSpec(
            "Pizz",
            "strings",
            "pizzicato",
            2,
            40,
            "velocity",
            "vsco",
            "Pizz.sfz",
            aliases=((0, 45),),
        )
    )
    specs.append(
        B.PresetSpec(
            "Violas Loud", "strings", "sustain", 4, 41, "velocity", "vsco", "Loud.sfz"
        )
    )
    sfz = {
        "Violins.sfz": "<region>sample=v_p.wav lokey=55 hikey=70 pitch_keycenter=62 lovel=0 hivel=62 volume=20\n"
        "<region>sample=v_f.wav lokey=55 hikey=70 pitch_keycenter=62 lovel=63 hivel=127 volume=17",
        "Violas.sfz": "<region>sample=va.wav lokey=48 hikey=70 pitch_keycenter=60",
        "Celli.sfz": "<region>sample=vc.wav lokey=36 hikey=60 pitch_keycenter=48",
        "Contrabass.sfz": "<region>sample=cb.wav lokey=24 hikey=50 pitch_keycenter=36",
        "Loud.sfz": "<region>sample=va.wav lokey=48 hikey=70 pitch_keycenter=60 volume=10",
        "Pizz.sfz": "<region>sample=pz_p.wav lokey=55 hikey=80 pitch_keycenter=62 lovel=0 hivel=63 volume=6\n"
        "<region>sample=pz_f.wav lokey=55 hikey=80 pitch_keycenter=62 lovel=64 hivel=127 tune=-7",
    }
    planned = B.plan_presets(specs, lambda name: sfz[name], lambda folder: [])
    freqs = {
        "v_p.wav": 293.7,
        "v_f.wav": 293.7,
        "va.wav": 261.6,
        "vc.wav": 130.8,
        "cb.wav": 65.4,
        "pz_p.wav": 293.7,
        "pz_f.wav": 293.7,
    }

    # The soft violin layer is recorded 12 dB below the loud one.
    amps = {"v_p.wav": 0.05, "v_f.wav": 0.2}

    def load_audio(spec, path):
        data, rate = _tone(freqs[path], amp=amps.get(path, 0.1))
        if attack_spike:
            # A bow attack four times the body, the way VSCO recordings peak.
            data[200:260] *= 4.0
        return data, rate

    return B.assemble(planned, load_audio)


def _peak(sample):
    return float(np.max(np.abs(sample.data)))


def _gens(zone):
    return {g[0]: g[1] for g in zone.generators}


def test_assemble_levels_presets_and_ensemble_split():
    samples, instruments, presets, manifest = _synthetic_plan()
    by_name = {s.name: s for s in samples}
    assert len(samples) == 7
    assert all(s.data.ndim == 1 for s in samples), "samples are mixed to mono"

    # CC1 preset: the recordings keep their own levels (the SFZ volume that
    # levels p against f is not applied), and one make-up gain brings the
    # loudest to the peak target.
    assert _peak(by_name["v_f"]) == pytest.approx(B.PEAK_TARGET, abs=2e-3)
    assert _peak(by_name["v_p"]) == pytest.approx(B.PEAK_TARGET / 4, abs=2e-3)
    violins = instruments[0]
    assert all(B.GEN_INITIAL_ATTENUATION not in _gens(z) for z in violins.zones)

    # Velocity preset: the SFZ volumes hold relative to each other.
    assert _peak(by_name["pz_p"]) == pytest.approx(B.PEAK_TARGET, abs=2e-3)
    assert 20 * math.log10(_peak(by_name["pz_p"]) / _peak(by_name["pz_f"])) == (
        pytest.approx(6.0, abs=0.05)
    )

    # A preset that reuses a stored sample at another level attenuates it.
    loud = next(i for i in instruments if i.name == "Violas Loud")
    stored_db = 20 * math.log10(B.PEAK_TARGET / 0.1)
    want = round((stored_db - 10) * 10 / B.EMU_ATTENUATION_FACTOR)
    assert abs(_gens(loud.zones[0])[B.GEN_INITIAL_ATTENUATION] - want) <= 1

    slots = sorted((p.bank, p.program, p.name) for p in presets)
    assert (0, 45, "Pizz") in slots and (2, 40, "Pizz") in slots
    ensemble = [p for p in presets if (p.bank, p.program) == (0, 48)]
    assert len(ensemble) == 1 and len(ensemble[0].zones) == 4
    assert [m["name"] for m in manifest][-1] == "String Ensemble"
    assert manifest[0]["dynamics"] == "cc1" and manifest[0]["cc1_layers"] == [2]


@pytest.mark.parametrize("compress", [False, True])
def test_written_bank_reads_back_with_its_modulators(tmp_path, compress):
    samples, instruments, presets, _ = _synthetic_plan()
    out = tmp_path / ("bank.sf3" if compress else "bank.sf2")
    size = B.write_soundfont(
        out,
        samples,
        instruments,
        presets,
        {"INAM": "Test", "ICOP": "CC0"},
        compress=compress,
    )
    assert size == out.stat().st_size
    bank = B.read_soundfont(out)
    assert bank["version"] == ((3, 1) if compress else (2, 4))
    assert bank["info"]["INAM"] == "Test"
    assert [(p["bank"], p["program"]) for p in bank["presets"]] == sorted(
        (p.bank, p.program) for p in presets
    )
    assert len(bank["instruments"]) == len(instruments)

    violins = bank["instruments"][0]
    assert violins["name"] == "Violins"
    for zone, written in zip(violins["zones"], instruments[0].zones):
        opers = [g[0] for g in zone["generators"]]
        assert opers[0] == B.GEN_KEY_RANGE and opers[1] == B.GEN_VEL_RANGE
        assert opers[-1] == B.GEN_SAMPLE_ID
        assert zone["modulators"] == written.modulators
    assert dict(violins["zones"][0]["generators"])[B.GEN_KEY_RANGE] == (55, 70)
    assert violins["zones"][0]["modulators"] == B.cc1_layer_modulators(0, 2)
    assert violins["zones"][1]["modulators"] == B.cc1_layer_modulators(1, 2)

    pizz = next(i for i in bank["instruments"] if i["name"] == "Pizz")
    assert [dict(z["generators"])[B.GEN_VEL_RANGE] for z in pizz["zones"]] == [
        (0, 63),
        (64, 127),
    ]
    assert dict(pizz["zones"][1]["generators"])[B.GEN_FINE_TUNE] == -7
    assert all(z["modulators"] == [] for z in pizz["zones"])

    for sample, written in zip(bank["samples"], samples):
        assert sample["root"] == written.root
        assert sample["rate"] == written.rate
        if compress:
            assert sample["type"] == B.SAMPLE_TYPE_MONO | B.SAMPLE_TYPE_VORBIS
            blob = bank["smpl"][sample["start"] : sample["end"]]
            assert blob[:4] == b"OggS"
            decoded, rate = sf.read(io.BytesIO(blob), dtype="float32")
            assert rate == written.rate
            assert len(decoded) == len(written.data)
        else:
            assert sample["type"] == B.SAMPLE_TYPE_MONO
            assert sample["end"] - sample["start"] == len(written.data)


def test_prepare_audio_trims_the_silent_tail():
    rate = 1000
    x = np.concatenate(
        [np.ones(500, dtype=np.float32) * 0.5, np.zeros(2000, dtype=np.float32)]
    )
    y = B.prepare_audio(x, rate)
    assert len(y) == 500 + int(B.TAIL_KEEP_S * rate)
    assert y[-1] == 0.0


def test_timecents():
    assert B.seconds_to_timecents(1.0) == 0
    assert B.seconds_to_timecents(0.001) == -11959
    assert B.seconds_to_timecents(2.0) == 1200


def test_git_blob_sha_matches_git():
    # `printf 'hello\n' | git hash-object --stdin`
    assert B.git_blob_sha(b"hello\n") == "ce013625030ba8dba906f756967f9e9ca394464a"


def test_every_preset_slot_is_unique():
    slots = [(p.bank, p.program) for p in B.PRESETS]
    slots += [a for p in B.PRESETS for a in p.aliases]
    slots.append((0, 48))  # the ensemble split
    assert len(slots) == len(set(slots))


def test_max_download_guard_stops_before_fetching(monkeypatch, tmp_path):
    snap = B.RepoSnapshot(B.VSCO, "abc", {"big.sfz": ("0" * 40, 10)})
    monkeypatch.setattr(B, "snapshot", lambda source, cache: snap)
    sfz = "<region>sample=a.wav lokey=60 hikey=60 pitch_keycenter=60"
    snap.blobs["a.wav"] = ("0" * 40, 5_000_000_000)
    monkeypatch.setattr(B, "fetch", lambda cache, s, path: tmp_path / "x.sfz")
    (tmp_path / "x.sfz").write_text(sfz)
    fetched = []
    monkeypatch.setattr(
        B, "is_cached", lambda cache, s, path: fetched.append(path) or False
    )
    with pytest.raises(SystemExit, match="over --max-download-mb"):
        B.main(
            [
                "--preset",
                "Violins",
                "--cache",
                str(tmp_path),
                "--out",
                str(tmp_path / "o.sf3"),
            ]
        )


def test_encode_vorbis_takes_a_long_sample_in_blocks():
    # One libsndfile write of a long buffer overflowed the Windows main-thread
    # stack inside libvorbis; the encoder feeds it VORBIS_BLOCK frames at a time.
    rate = 48000
    tone = (0.2 * np.sin(2 * np.pi * 220 * np.arange(rate * 20) / rate)).astype(
        np.float32
    )
    blob = B.encode_vorbis(tone, rate, 0.5)
    decoded, got_rate = sf.read(io.BytesIO(blob), dtype="float32")
    assert got_rate == rate
    assert len(decoded) == len(tone)


# --------------------------------------------------------------------------
# Levelling against the reference bank, on the strings subset


def test_peak_limit_holds_the_ceiling_and_leaves_quiet_audio_alone():
    rate = 8000
    t = np.arange(rate) / rate
    body = 0.2 * np.sin(2 * np.pi * 110 * t).astype(np.float32)
    body[800:840] += 0.75  # a bow-attack spike
    out = B.peak_limit(body, 0.5, rate)
    assert float(np.max(np.abs(out))) <= 0.5 + 1e-6
    # Away from the spike (beyond two limiter windows) nothing changes.
    far = int(2.5 * B.LIMITER_WINDOW_S * rate)
    assert np.allclose(out[840 + far :], body[840 + far :])
    # The gain moves smoothly: no step bigger than a few percent per sample.
    mask = np.abs(body) > 0.05
    ratio = out[mask] / body[mask]
    assert float(np.max(np.abs(np.diff(ratio)))) < 0.05
    quiet = 0.1 * np.sin(2 * np.pi * 220 * t).astype(np.float32)
    assert np.array_equal(B.peak_limit(quiet, 0.5, rate), quiet)


def _strings_bank():
    samples, instruments, presets, manifest = _synthetic_plan(attack_spike=True)
    return list(samples), instruments, presets, manifest


def _window_rms_db(x, rate):
    win = int(0.1 * rate)
    if len(x) < win:
        return 10 * math.log10(float(np.mean(x**2)) + 1e-20)
    c = np.cumsum(np.concatenate([[0.0], x.astype(np.float64) ** 2]))
    return 10 * math.log10(float(np.max(c[win:] - c[:-win]) / win) + 1e-20)


def _fake_synth(samples, instruments, presets, reference_db):
    """Stands in for SpessaSynth: the level of a note is the loudest 100 ms RMS
    of the sample its playing zone holds, less the zone's attenuation."""

    def measure(banks, jobs):
        out = {}
        for job in jobs:
            if job["bankKey"] == "ref":
                out[job["id"]] = {
                    "rmsDb": reference_db[job["program"]],
                    "peak": 0.2,
                    "preset": f"GM {job['program']}",
                    "presetBank": job["bank"],
                    "presetProgram": job["program"],
                }
                continue
            preset = next(
                p
                for p in presets
                if (p.bank, p.program) == (job["bank"], job["program"])
            )
            inst = instruments[dict(preset.zones[0].generators)[B.GEN_INSTRUMENT]]
            zones = [
                z
                for z in inst.zones
                if B._zone_keys(z)[0] <= job["note"] <= B._zone_keys(z)[1]
                and B._zone_vels(z)[0] <= job["velocity"] <= B._zone_vels(z)[1]
                and B.layer_attenuation_cb(z.modulators, job["cc1"]) < 60
            ]
            gens = dict(zones[-1].generators)
            s = samples[gens[B.GEN_SAMPLE_ID]]
            att_db = (
                gens.get(B.GEN_INITIAL_ATTENUATION, 0) * B.EMU_ATTENUATION_FACTOR / 10
            )
            out[job["id"]] = {
                "rmsDb": _window_rms_db(s.data, s.rate) - att_db,
                "peak": float(np.max(np.abs(s.data))) * 10 ** (-att_db / 20) * 0.26,
                "preset": preset.name,
                "presetBank": preset.bank,
                "presetProgram": preset.program,
            }
        return out

    return measure


def test_level_targets_cover_each_primary_slot_once():
    samples, instruments, presets, manifest = _strings_bank()
    targets = B.level_targets(presets, instruments, manifest)
    # Aliases (0:45 for Pizz) and the key-split ensemble are not levelled on
    # their own; everything else is, against its program in the reference.
    assert sorted(t.name for t in targets) == sorted(
        ["Violins", "Violas", "Celli", "Contrabass", "Pizz", "Violas Loud"]
    )
    pizz = next(t for t in targets if t.name == "Pizz")
    assert (pizz.bank, pizz.program, pizz.ref_bank, pizz.ref_program) == (2, 40, 0, 40)
    violins = next(t for t in targets if t.name == "Violins")
    assert 55 <= violins.note <= 70


def _level(tmp_path, reference_db, **kw):
    samples, instruments, presets, manifest = _strings_bank()
    measure = _fake_synth(samples, instruments, presets, reference_db)
    run = B.level_bank(
        samples,
        instruments,
        presets,
        manifest,
        {"INAM": "t"},
        tmp_path / "bank.sf3",
        tmp_path / "gm.sf3",
        measure,
        **kw,
    )
    out = tmp_path / "bank.sf3"
    B.write_soundfont(out, samples, instruments, presets, {"INAM": "t"}, compress=False)
    table = B.verify_levels(
        out, tmp_path / "gm.sf3", run, instruments, samples, measure
    )
    return run, samples, {row["name"]: row for row in table}


def test_levelling_brings_the_strings_within_tolerance(tmp_path):
    # The reference sits over the violins by more than their headroom (so
    # they are peak limited), and under the violas (a cut).
    run, samples, rows = _level(tmp_path, {40: -12.0, 41: -35.0, 42: -20.0, 43: -22.0})
    assert not list(tmp_path.glob("*.level-probe.sf2")), "the probe bank is removed"
    assert all(
        float(np.max(np.abs(s.data))) <= B.SAMPLE_CEILING + 1e-6 for s in samples
    )
    for name in ("Violins", "Violas", "Celli", "Contrabass"):
        row = rows[name]
        assert abs(row["after_minus_reference_db"]) <= B.LEVEL_TOLERANCE_DB, row
        assert row["within_tolerance"]
        assert not row["clip_check"]["clips"]
    assert rows["Violas"]["gain_db"] < 0
    assert rows["Violas"]["peak_limited_db"] == 0
    assert rows["Violins"]["gain_db"] > 0
    assert rows["Violins"]["peak_limited_db"] > 0
    for row in rows.values():
        assert row["peak_limited_max_db"] >= row["peak_limited_db"]
    assert {"before_db", "after_db", "reference", "clip_check"} <= set(rows["Celli"])


def test_levelling_caps_the_boost_at_the_limit_depth(tmp_path):
    run, samples, rows = _level(
        tmp_path, {40: 10.0, 41: -20.0, 42: -10.0, 43: -11.0}, max_limit_db=6.0
    )
    assert run.limited_db["Violins"] <= 6.0 + 1e-6
    # The cap is on the measured note's sample, the violins' f layer.
    targets = {x.name: x for x in run.targets}
    assert B.level_sample(targets["Violins"], _strings_bank()[1]) is not None
    assert not rows["Violins"]["within_tolerance"]


def test_a_shared_sample_takes_the_larger_gain_and_the_other_zone_attenuates():
    samples, instruments, presets, manifest = _strings_bank()
    targets = B.level_targets(presets, instruments, manifest)
    violas = next(t for t in targets if t.name == "Violas")
    loud = next(t for t in targets if t.name == "Violas Loud")
    shared = B.instrument_samples(instruments[violas.instrument])[0]
    assert shared in B.instrument_samples(instruments[loud.instrument])
    peak_before = float(np.max(np.abs(samples[shared].data)))
    zone = instruments[loud.instrument].zones[0]
    att_before = dict(zone.generators).get(B.GEN_INITIAL_ATTENUATION, 0)
    gains = {t.name: 0.0 for t in targets}
    gains["Violas"] = -2.0
    gains["Violas Loud"] = -8.0
    B.apply_level_gains(targets, gains, instruments, samples)
    assert float(np.max(np.abs(samples[shared].data))) == pytest.approx(
        peak_before * 10 ** (-2 / 20), rel=1e-4
    )
    att_after = dict(zone.generators)[B.GEN_INITIAL_ATTENUATION]
    assert att_after - att_before == round(6.0 * 10 / B.EMU_ATTENUATION_FACTOR)
    assert zone.generators[-1][0] == B.GEN_SAMPLE_ID


def test_loudest_key_renders_the_playing_layer():
    samples, instruments, presets, manifest = _strings_bank()
    # Both violin layers share one key range rooted on 62; at full CC1 only
    # the f layer plays.
    assert B.loudest_key(instruments[0], samples) == 62
