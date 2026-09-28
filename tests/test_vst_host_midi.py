"""MIDI stage 4.7: the live host plays the notes the client sends.

The native host (``native/vst-host``) takes a ``midi`` op of messages stamped
with timeline positions and hands each to the plugin inside the audio block
that holds its position, at its sample offset; ``midi_panic`` drops what is
waiting and releases every sounding note. The null plugin makes MIDI audible
for exactly this: a note-on adds velocity / 127 at its sample, a note-off adds
-0.25 (``src/engine/NullPlugin.cpp``). Everything here drives the real process
over a real loopback WebSocket, as ``test_vst_host_native.py`` does.

Skipped as a whole when the binary has not been built.
"""

from __future__ import annotations

import pytest

from tests.vst_host_client import HostProcess, host_exe

pytestmark = pytest.mark.skipif(
    host_exe() is None,
    reason="native/vst-host/bin/thedaw-vst-host.exe not built",
)

SAMPLE_RATE = 48000
BLOCK = 512
SILENCE = [[0.0] * BLOCK, [0.0] * BLOCK]


def null_args() -> list[str]:
    return [
        "--null-plugin",
        "--sample-rate",
        str(SAMPLE_RATE),
        "--block-size",
        str(BLOCK),
        "--channels",
        "2",
        "--port",
        "0",
    ]


def send_midi(client, events: list[dict], token: float) -> None:
    """Send a ``midi`` op and wait until the host has queued it.

    The op is read on the host's message thread and the blocks on its audio
    thread; a ping answered after it proves the op is in the queue first.
    """
    client.control("midi", events=events)
    client.ping(token)


def marks(planes: list[list[float]]) -> list[tuple[int, float]]:
    """Every sample the null plugin marked, with its value (channel 0)."""
    return [(i, round(v, 4)) for i, v in enumerate(planes[0]) if v != 0.0]


def test_ready_says_the_host_accepts_midi():
    with HostProcess(null_args()) as host, host.connect() as client:
        assert client.hello()["accepts_midi"] is True


def test_a_note_lands_on_its_sample_inside_the_block_that_holds_it():
    with HostProcess(null_args()) as host, host.connect() as client:
        client.hello()
        # Block 0 covers 0-511, block 1 covers 512-1023: the note at 700 is block 1, offset 188.
        send_midi(
            client,
            [
                {"pos": 700, "data": [0x90, 60, 127]},
                {"pos": 900, "data": [0x80, 60, 0]},
            ],
            1,
        )
        _, out0 = client.block(0, SILENCE, position=0)
        _, out1 = client.block(1, SILENCE, position=BLOCK)
        assert marks(out0) == []
        assert marks(out1) == [(188, 1.0), (388, -0.25)]
        assert out1[1] == out1[0], "every output channel carries the note"


def test_a_block_without_midi_stays_a_bit_exact_passthrough():
    with HostProcess(null_args()) as host, host.connect() as client:
        client.hello()
        send_midi(client, [{"pos": 5 * BLOCK + 3, "data": [0x90, 64, 64]}], 1)
        planes = [[0.25] * BLOCK, [-0.5] * BLOCK]
        _, out = client.block(0, planes, position=0)
        assert out == planes
        _, later = client.block(5, SILENCE, position=5 * BLOCK)
        assert marks(later) == [(3, round(64 / 127, 4))]


def test_a_late_message_plays_at_the_start_of_the_next_block():
    with HostProcess(null_args()) as host, host.connect() as client:
        client.hello()
        _, _ = client.block(0, SILENCE, position=0)
        # Position 100 is already behind the stream (block 1 starts at 512): it plays at offset 0.
        send_midi(client, [{"pos": 100, "data": [0x90, 62, 127]}], 2)
        _, out = client.block(1, SILENCE, position=BLOCK)
        assert marks(out) == [(0, 1.0)]


def test_pos_minus_one_plays_now():
    with HostProcess(null_args()) as host, host.connect() as client:
        client.hello()
        send_midi(client, [{"pos": -1, "data": [0x90, 48, 127]}], 3)
        _, out = client.block(0, SILENCE, position=123456)
        assert marks(out) == [(0, 1.0)]


def test_messages_at_one_sample_keep_their_order_and_controllers_play_nothing():
    with HostProcess(null_args()) as host, host.connect() as client:
        client.hello()
        send_midi(
            client,
            [
                {"pos": 10, "data": [0xB0, 64, 127]},
                {"pos": 10, "data": [0x90, 60, 127]},
                {"pos": 20, "data": [0xE0, 0, 72]},
                {"pos": 30, "data": [0xD0, 50]},
            ],
            4,
        )
        _, out = client.block(0, SILENCE, position=0)
        assert marks(out) == [(10, 1.0)]


def test_panic_drops_what_waits_and_releases_what_sounds():
    with HostProcess(null_args()) as host, host.connect() as client:
        client.hello()
        send_midi(
            client,
            [
                {"pos": 5, "data": [0x90, 60, 127]},
                {"pos": 6, "data": [0x90, 67, 127]},
                # Never played: the panic below comes before the block that holds it.
                {"pos": 3 * BLOCK, "data": [0x90, 72, 127]},
            ],
            5,
        )
        _, out = client.block(0, SILENCE, position=0)
        assert marks(out) == [(5, 1.0), (6, 1.0)]
        client.control("midi_panic")
        client.ping(6)
        # A seek: the next block is anywhere. Both held notes are released at its start, once.
        _, released = client.block(1, SILENCE, position=3 * BLOCK, discontinuity=True)
        assert marks(released) == [(0, -0.5)]
        _, after = client.block(2, SILENCE, position=4 * BLOCK)
        assert marks(after) == []


def test_malformed_messages_are_dropped_with_a_warning_and_the_rest_play():
    with HostProcess(null_args()) as host, host.connect() as client:
        client.hello()
        client.control(
            "midi",
            events=[
                {"pos": 1, "data": [0xF0, 1, 2]},  # SysEx: not a channel message
                {"pos": 2, "data": [0x90, 200, 1]},  # a data byte past 127
                {"pos": 3, "data": [0x90, 60]},  # a note-on without its velocity
                {"data": [0x90, 60, 1]},  # no position
                {"pos": 4, "data": [0x90, 61, 127]},
            ],
        )
        warning = client.recv_event("warning")
        assert "4 message(s)" in warning["text"]
        client.ping(7)
        _, out = client.block(0, SILENCE, position=0)
        assert marks(out) == [(4, 1.0)]


def test_midi_without_an_events_array_is_a_survivable_error():
    with HostProcess(null_args()) as host, host.connect() as client:
        client.hello()
        client.control("midi", events="nope")
        err = client.recv_event("error")
        assert err["fatal"] is False
        assert "events" in err["text"]
        header, _ = client.block(0, SILENCE, position=0)
        assert header["seq"] == 0
