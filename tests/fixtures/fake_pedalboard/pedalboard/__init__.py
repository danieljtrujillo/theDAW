"""A stand-in for the pedalboard package, for processes started with
``tests/fixtures/fake_pedalboard`` on PYTHONPATH (tests/test_vst_plugin_crash.py).

The plugin a path loads is chosen by words in its file name, so one module can
be a healthy instrument, a healthy effect, or a plugin that takes its process
down the way MT-PowerDrumKit 2.1.5.1 does:

- ``Segfault``: loading reads address 0, a real access violation (0xC0000005
  on Windows, SIGSEGV elsewhere).
- ``Vanish``: loading ends the process with ``os._exit(0)``, a clean exit code
  and no answer.
- ``Hang``: loading sleeps for ten minutes.
- ``RenderCrash``: loads, then reads address 0 when asked to play or process.
- ``Chatty``: prints to stdout, from Python and straight to fd 1, while it
  loads and while it processes.
- ``Synth``: an instrument; anything else is an effect.
"""

from __future__ import annotations

import ctypes
import os
import time
from pathlib import Path

import numpy as np


def _crash() -> None:
    """Read address 0 outside any ctypes call, so nothing catches the fault."""
    _ = ctypes.c_int.from_address(0).value


def _chatter(when: str) -> None:
    print(f"chatty plugin: {when}", flush=True)
    os.write(1, f"chatty plugin native output: {when}\n".encode("ascii"))


class Plugin:
    """Base class, as pedalboard exports it."""


class VST3Plugin(Plugin):
    @staticmethod
    def get_plugin_names_for_file(path: str) -> list[str]:
        return []


class FakeParameter:
    def __init__(self, name: str) -> None:
        self.name = name
        self.python_name = name
        self.raw_value = 0.5
        self.min_value = 0.0
        self.max_value = 1.0
        self.units = ""


class FakePlugin(VST3Plugin):
    def __init__(self, path: str) -> None:
        self.file_name = Path(path).name
        self.is_instrument = "Synth" in self.file_name
        self.gain = 0.5
        self.parameters = {"gain": FakeParameter("gain")}
        self._state = b"default"

    @property
    def raw_state(self) -> bytes:
        return self._state

    @raw_state.setter
    def raw_state(self, value: bytes) -> None:
        self._state = bytes(value)

    def reset(self) -> None:
        pass

    def __call__(self, *args, **kwargs):
        if "RenderCrash" in self.file_name:
            _crash()
        if "Chatty" in self.file_name:
            _chatter("process")
        if self.is_instrument:
            midi_messages = args[0]
            duration = float(kwargs["duration"])
            sample_rate = float(kwargs["sample_rate"])
            num_channels = int(kwargs.get("num_channels", 2))
            frames = int(round(duration * sample_rate))
            out = np.zeros((num_channels, frames), dtype=np.float32)
            for data, t in midi_messages:
                if data[0] & 0xF0 == 0x90 and data[2] > 0:
                    out[:, int(round(t * sample_rate))] = data[2] / 127.0
            return out
        audio = np.asarray(args[0], dtype=np.float32)
        return audio * np.float32(self.gain)


def load_plugin(path: str, plugin_name: str | None = None) -> FakePlugin:
    name = Path(path).name
    if "Segfault" in name:
        _crash()
    if "Vanish" in name:
        os._exit(0)
    if "Hang" in name:
        time.sleep(600)
    if "Chatty" in name:
        _chatter("load")
    return FakePlugin(path)
