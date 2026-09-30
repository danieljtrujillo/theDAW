from __future__ import annotations

import asyncio

from backend.modules.questmidi import bridge


def test_bridge_delegates_host_and_device_port_policy(monkeypatch) -> None:
    monkeypatch.setattr(bridge.port_config, "host_port", lambda: 18766)
    monkeypatch.setattr(bridge.port_config, "device_port", lambda: 18765)

    assert bridge._port() == 18766
    assert bridge._device_port() == 18765


def test_adb_maps_device_port_to_distinct_host_port(monkeypatch) -> None:
    calls: list[tuple[str, ...]] = []

    def fake_adb(*args: str) -> str:
        calls.append(args)
        return ""  # an empty reverse table, and every reverse succeeds

    monkeypatch.setattr(bridge, "_s", bridge._State())
    monkeypatch.setattr(bridge, "_adb", fake_adb)
    monkeypatch.setattr(bridge, "_holder_of", lambda port: None)  # nobody else listens
    monkeypatch.setattr(bridge, "_port", lambda: 8766)
    monkeypatch.setattr(bridge, "_device_port", lambda: 8765)
    monkeypatch.setattr(bridge, "_http_port", lambda: 8600)

    assert asyncio.run(bridge.reattach_adb()) is True
    assert calls == [
        ("reverse", "--list"),
        ("reverse", "tcp:8765", "tcp:8766"),
        ("reverse", "tcp:8600", "tcp:8600"),
    ]
    assert bridge.status()["device_port"] == 8765


def test_reverse_list_parsing_reads_the_pc_side_of_the_headset_port(
    monkeypatch,
) -> None:
    listing = (
        "UsbFfs tcp:8600 tcp:8600\n"
        "UsbFfs tcp:8765 tcp:51234\n"
        "UsbFfs localabstract:foo tcp:9000\n"
    )
    monkeypatch.setattr(bridge, "_adb", lambda *args: listing)

    assert bridge._reverse_target(8765) == 51234
    assert bridge._reverse_target(8600) == 8600
    assert bridge._reverse_target(8940) is None


def test_no_headset_means_no_mapping(monkeypatch) -> None:
    monkeypatch.setattr(bridge, "_adb", lambda *args: None)

    assert bridge._reverse_target(8765) is None
