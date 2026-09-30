"""The two ports of the Quest MIDI bridge.

The headset app dials a port on its OWN loopback, the headset port. ``adb
reverse`` carries that connection across the USB cable to a port on this PC,
the host port, where theDAW's listener waits.

- ``theDAW_QUESTMIDI_PORT`` is the headset port, 8765 unless set. It has always
  named the port the headset dials; while theDAW mapped 8765 to 8765 it was the
  listener as well.
- ``theDAW_QUESTMIDI_DEVICE_PORT`` is a second name for the headset port and
  wins when both are set.
- ``theDAW_QUESTMIDI_HOST_PORT`` is the listener on this PC, 8766 unless set, so
  theDAW never listens on the port number a one-to-one bridge uses.

Empty, non-numeric, zero, negative and out-of-range values are skipped.
"""

from __future__ import annotations

import os
from typing import Optional

DEFAULT_HOST_PORT = 8766
DEFAULT_DEVICE_PORT = 8765

DEVICE_PORT_ENV = ("theDAW_QUESTMIDI_DEVICE_PORT", "theDAW_QUESTMIDI_PORT")
HOST_PORT_ENV = ("theDAW_QUESTMIDI_HOST_PORT",)


def _valid_port(raw: Optional[str]) -> Optional[int]:
    try:
        port = int(raw or "")
    except ValueError:
        return None
    return port if 1 <= port <= 65535 else None


def _env_port(names: tuple[str, ...], default: int) -> int:
    """The first of ``names`` that holds a usable port, else ``default``."""
    for name in names:
        port = _valid_port(os.getenv(name))
        if port is not None:
            return port
    return default


def host_port() -> int:
    """The port theDAW's listener binds on this PC."""
    return _env_port(HOST_PORT_ENV, DEFAULT_HOST_PORT)


def device_port() -> int:
    """The port the headset app dials on its own loopback."""
    return _env_port(DEVICE_PORT_ENV, DEFAULT_DEVICE_PORT)
