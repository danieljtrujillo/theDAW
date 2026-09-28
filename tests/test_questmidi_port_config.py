from __future__ import annotations

from importlib import import_module

import pytest

_ALL = (
    "theDAW_QUESTMIDI_PORT",
    "theDAW_QUESTMIDI_DEVICE_PORT",
    "theDAW_QUESTMIDI_HOST_PORT",
)


def _port_config():
    return import_module("backend.modules.questmidi.port_config")


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch) -> None:
    for name in _ALL:
        monkeypatch.delenv(name, raising=False)


def test_default_ports_keep_host_and_quest_device_isolated() -> None:
    port_config = _port_config()

    assert port_config.host_port() == 8766
    assert port_config.device_port() == 8765


def test_questmidi_port_is_the_port_the_headset_dials(monkeypatch) -> None:
    """theDAW_QUESTMIDI_PORT keeps the meaning it has on main: the headset's
    port. A setup that set it for main keeps its headset reaching theDAW."""
    monkeypatch.setenv("theDAW_QUESTMIDI_PORT", "18765")

    port_config = _port_config()

    assert port_config.device_port() == 18765
    assert port_config.host_port() == 8766


def test_host_port_override_is_independent(monkeypatch) -> None:
    monkeypatch.setenv("theDAW_QUESTMIDI_HOST_PORT", "18766")

    port_config = _port_config()

    assert port_config.host_port() == 18766
    assert port_config.device_port() == 8765


def test_device_port_override_is_independent(monkeypatch) -> None:
    monkeypatch.setenv("theDAW_QUESTMIDI_DEVICE_PORT", "18765")

    port_config = _port_config()

    assert port_config.host_port() == 8766
    assert port_config.device_port() == 18765


def test_device_port_name_wins_over_questmidi_port(monkeypatch) -> None:
    monkeypatch.setenv("theDAW_QUESTMIDI_PORT", "18000")
    monkeypatch.setenv("theDAW_QUESTMIDI_DEVICE_PORT", "18765")

    assert _port_config().device_port() == 18765


@pytest.mark.parametrize("invalid_value", ["", "not-a-port", "0", "-1", "65536"])
def test_invalid_host_port_falls_back_to_default(
    monkeypatch, invalid_value: str
) -> None:
    monkeypatch.setenv("theDAW_QUESTMIDI_HOST_PORT", invalid_value)

    assert _port_config().host_port() == 8766


@pytest.mark.parametrize("invalid_value", ["", "not-a-port", "0", "-1", "65536"])
def test_invalid_device_port_falls_back_to_default(
    monkeypatch, invalid_value: str
) -> None:
    monkeypatch.setenv("theDAW_QUESTMIDI_DEVICE_PORT", invalid_value)

    assert _port_config().device_port() == 8765


@pytest.mark.parametrize("invalid_value", ["", "not-a-port", "0", "-1", "65536"])
def test_invalid_device_port_name_falls_back_to_questmidi_port(
    monkeypatch, invalid_value: str
) -> None:
    monkeypatch.setenv("theDAW_QUESTMIDI_DEVICE_PORT", invalid_value)
    monkeypatch.setenv("theDAW_QUESTMIDI_PORT", "18765")

    assert _port_config().device_port() == 18765
