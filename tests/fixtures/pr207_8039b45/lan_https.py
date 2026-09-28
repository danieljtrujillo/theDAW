"""One decision, shared by both launchers: is there a LAN HTTPS listener?

A browser hands out ``AudioContext.audioWorklet``, the microphone, Web MIDI,
the clipboard and ``crypto.subtle`` only in a SECURE CONTEXT -- ``https://`` or
``localhost``. A second computer opening theDAW at ``http://<lan-ip>:5173`` is
neither, so its EDIT tab dies on ``ctx.audioWorklet`` being undefined. The fix
is a second Vite listener, the same app over TLS, on
:data:`backend.ports.LAN_HTTPS_PORT`.

Two launchers start theDAW -- ``backend/_devstack.py`` (web mode) and
``electron-ui/main/index.ts`` (desktop mode) -- and they must agree about
whether that listener runs, on which port, and why not when it does not.
:func:`plan_lan_https` is that agreement: pure, so both the table of cases and
the exact wording of the reason are testable without a certificate, a network
interface or a subprocess. The launchers differ only in how they collect the
three inputs (:func:`resolve_plan` does it for Python; the desktop shell reads
the same plan as JSON from ``python -m backend.lib.lan_https --json``).

Nothing here starts, kills or probes anything, and no failure it meets is
fatal: the LAN listener is a convenience, and theDAW must launch without it.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional, Protocol

from backend import ports
from backend.lib import paths

log = logging.getLogger(__name__)

__all__ = [
    "ENV_CERT",
    "ENV_ENABLED",
    "ENV_KEY",
    "ENV_PORT",
    "LISTENER_ARGS",
    "NO_FRONTEND_REASON",
    "LanHttpsPlan",
    "blocking_reason",
    "detect_lan_ips",
    "lan_address",
    "listener_binary",
    "listener_command",
    "listener_env",
    "listener_port",
    "plan_lan_https",
    "read_settings",
    "resolve_plan",
]

#: The environment the listener itself reads (``frontend/vite.lan.config.ts``).
#: These three names are the contract with that file; do not rename one side.
ENV_CERT = "theDAW_HTTPS_CERT"
ENV_KEY = "theDAW_HTTPS_KEY"
ENV_PORT = "theDAW_HTTPS_PORT"
#: An explicit yes/no that beats the stored setting, for a launcher wrapper or
#: a one-off run: ``theDAW_LAN_HTTPS=0`` turns the listener off for this launch.
ENV_ENABLED = "theDAW_LAN_HTTPS"

#: ``settings.json`` -> ``app.lan_https``. Absent means ON: the whole point is
#: that a second device works without anyone configuring anything.
SETTING_SECTION = "app"
SETTING_KEY = "lan_https"

#: What the listener is started WITH, after the binary, from ``frontend/``.
LISTENER_ARGS: tuple[str, ...] = ("--config", "vite.lan.config.ts")

#: Why there is no listener when the frontend has never been installed. Said
#: once, by whichever launcher is running, instead of spawning something that
#: cannot work.
NO_FRONTEND_REASON = (
    "frontend dependencies not installed - the LAN https listener is skipped "
    '(run "npm install" in frontend/)'
)

_FALSE = frozenset({"0", "false", "no", "off"})
_TRUE = frozenset({"1", "true", "yes", "on"})


class CertPathsLike(Protocol):
    """The shape :func:`backend.lib.lan_cert.ensure_lan_cert` returns."""

    cert: Path
    key: Path


@dataclass(frozen=True)
class LanHttpsPlan:
    """What the launchers do about the LAN listener this launch.

    ``reason`` is set only when ``enabled`` is False, and it is written to be
    read by the person looking at the log: it says which of the four things
    was missing, not that "something" was.
    """

    enabled: bool
    port: int
    url: Optional[str] = None
    cert_paths: Optional[CertPathsLike] = None
    #: The vite executable to run, resolved once by :func:`listener_binary`.
    #: Carried in the plan so the desktop shell runs the very file this module
    #: checked for, rather than searching for it again in TypeScript.
    vite: Optional[str] = None
    reason: Optional[str] = None

    def log_line(self) -> str:
        """The one line a launcher prints about the LAN listener."""
        if self.enabled and self.url:
            return f"LAN (https): {self.url}"
        return f"LAN (https): off - {self.reason or 'unavailable'}"

    def as_json(self) -> dict[str, Any]:
        """The plan as the desktop shell reads it (``--json``)."""
        return {
            "enabled": self.enabled,
            "port": self.port,
            "url": self.url,
            "cert": str(self.cert_paths.cert) if self.cert_paths else None,
            "key": str(self.cert_paths.key) if self.cert_paths else None,
            "vite": self.vite,
            "reason": self.reason,
        }


def _flag(raw: object) -> Optional[bool]:
    """A yes/no setting, or None when the value says nothing.

    ``settings.json`` is hand-editable and the environment carries strings
    only, so ``false`` and ``"false"`` and ``"0"`` all have to mean off.
    """
    if isinstance(raw, bool):
        return raw
    if isinstance(raw, str):
        text = raw.strip().lower()
        if text in _FALSE:
            return False
        if text in _TRUE:
            return True
    return None


def listener_port(env: Mapping[str, str]) -> int:
    """The port the LAN listener uses: ``theDAW_HTTPS_PORT`` or the default.

    A value that is not a usable TCP port is ignored rather than obeyed --
    ``vite.lan.config.ts`` falls back to the same default, so a typo must not
    leave the launcher and the listener disagreeing about the address.
    """
    raw = (env.get(ENV_PORT) or "").strip()
    if raw:
        try:
            port = int(raw)
        except ValueError:
            port = 0
        if 0 < port < 65536:
            return port
    return ports.LAN_HTTPS_PORT


def lan_address(lan_ips: Sequence[str]) -> Optional[str]:
    """The address other devices are told to use: the first real one."""
    return next((ip for ip in lan_ips if ip), None)


def blocking_reason(
    settings: Mapping[str, Any],
    env: Mapping[str, str],
    lan_ips: Sequence[str],
) -> Optional[str]:
    """Why the LAN listener cannot run, *ignoring the certificate*, or None.

    Split out from :func:`plan_lan_https` so a launcher can ask the cheap
    question first: minting a certificate shells out to openssl, and a launch
    that is switched off or has no network must never pay for that.
    """
    override = _flag(env.get(ENV_ENABLED))
    if override is False:
        return f"turned off for this launch by {ENV_ENABLED}"

    if override is None:
        section = settings.get(SETTING_SECTION)
        stored = section.get(SETTING_KEY) if isinstance(section, Mapping) else None
        if _flag(stored) is False:
            return (
                f"turned off in data/settings.json "
                f"({SETTING_SECTION}.{SETTING_KEY}) - set {ENV_ENABLED}=1 "
                f"for one launch"
            )

    if lan_address(lan_ips) is None:
        return (
            "no LAN address - connect this machine to Wi-Fi or Ethernet "
            "for other devices to reach it"
        )
    return None


def plan_lan_https(
    settings: Mapping[str, Any],
    env: Mapping[str, str],
    lan_ips: Sequence[str],
    cert: Optional[CertPathsLike],
    vite: Optional[str] = None,
) -> LanHttpsPlan:
    """Whether to start the LAN HTTPS listener, where, and why not.

    Pure. Three things have to be true, and each failure names itself:

    * the user has not turned it off (``theDAW_LAN_HTTPS``, then
      ``settings.app.lan_https``; absent means on),
    * this machine has a LAN address to be reached at,
    * a certificate exists for it.
    """
    port = listener_port(env)

    blocked = blocking_reason(settings, env, lan_ips)
    if blocked is not None:
        return LanHttpsPlan(enabled=False, port=port, reason=blocked)

    if cert is None:
        return LanHttpsPlan(
            enabled=False,
            port=port,
            reason=(
                "no certificate - install openssl (Git for Windows ships one) "
                "and restart theDAW"
            ),
        )

    return LanHttpsPlan(
        enabled=True,
        port=port,
        url=f"https://{lan_address(lan_ips)}:{port}",
        cert_paths=cert,
        vite=vite,
    )


def listener_env(plan: LanHttpsPlan, base: Mapping[str, str]) -> dict[str, str]:
    """The child environment for the LAN listener, on top of ``base``.

    ``base`` is the caller's already-sanitised environment --
    :func:`backend.lib.launch_token.child_env` in the backend's launcher -- so
    the desktop shell's launch token never reaches a vite process. Only the
    three names the listener actually reads are added.

    ``ENABLE_HMR`` is deliberately NOT one of them: it is passed through from
    ``base`` like everything else. Setting it starts a watcher over the whole
    repository; the web launcher sets it for its own http dev server, and the
    desktop shell does not want a second one.
    """
    if not plan.enabled or plan.cert_paths is None:
        raise ValueError("listener_env is for an enabled plan with a certificate")
    env = dict(base)
    env[ENV_CERT] = str(plan.cert_paths.cert)
    env[ENV_KEY] = str(plan.cert_paths.key)
    env[ENV_PORT] = str(plan.port)
    return env


def listener_binary(repo_root: Optional[Path] = None) -> Optional[Path]:
    """The frontend's OWN vite executable, or None when it is not installed.

    Not ``npx``: on Windows ``cmd`` searches the current directory before PATH,
    and a non-interactive ``npx`` with no ``node_modules`` present downloads a
    copy of vite from the registry in the middle of a launch. The path is
    resolved here, once, and carried in the plan, so both launchers run the
    same file and neither has to look for it.
    """
    root = paths.PROJECT_ROOT if repo_root is None else Path(repo_root)
    name = "vite.cmd" if os.name == "nt" else "vite"
    candidate = root / "frontend" / "node_modules" / ".bin" / name
    return candidate if candidate.is_file() else None


def listener_command(plan: LanHttpsPlan) -> list[str]:
    """argv for the listener, to be run from ``frontend/``.

    A list rather than a shell string: the path can contain a space, and there
    is nothing here for a shell to do.
    """
    if not plan.enabled or not plan.vite:
        raise ValueError("listener_command is for an enabled plan with a vite binary")
    return [plan.vite, *LISTENER_ARGS]


def detect_lan_ips() -> list[str]:
    """This machine's LAN IPv4 addresses, best effort, most useful first.

    Imported where it is used: ``backend.modules.vj.sidecar`` owns the
    UDP-connect detection, and a launcher that merely asks about HTTPS should
    not pay for that module at import time.
    """
    try:
        from backend.modules.vj.sidecar import detect_lan_ip
    except Exception as exc:  # pragma: no cover - the module is part of the app
        log.debug("lan-https: LAN address detection unavailable (%s)", exc)
        return []
    ip = detect_lan_ip()
    return [ip] if ip else []


def read_settings() -> dict[str, Any]:
    """``settings.json`` as it is on disk, or ``{}`` when it cannot be read.

    Deliberately the raw file rather than ``SettingsStore``: a launcher runs
    before the backend exists, and building a store would create the file and
    take its lock. An unreadable or half-written file means "no preference
    recorded", which is the default -- on.
    """
    try:
        from backend.modules.settings.store import default_settings_path

        raw = json.loads(Path(default_settings_path()).read_text(encoding="utf-8"))
    except Exception as exc:
        log.debug("lan-https: no readable settings (%s) - using the defaults", exc)
        return {}
    return raw if isinstance(raw, dict) else {}


def resolve_plan(env: Optional[Mapping[str, str]] = None) -> LanHttpsPlan:
    """The plan for this machine, right now: settings, address, certificate.

    Never raises. Minting the certificate is the only slow step and it is
    skipped entirely once the listener has been turned off or there is nobody
    to serve, so the common "no network" launch costs one UDP socket.
    """
    environment = os.environ if env is None else env
    settings = read_settings()
    lan_ips = detect_lan_ips()

    # Ask for a certificate only when everything else already says yes, so a
    # disabled or address-less launch never shells out to openssl.
    blocked = blocking_reason(settings, environment, lan_ips)
    if blocked is not None:
        return LanHttpsPlan(
            enabled=False, port=listener_port(environment), reason=blocked
        )

    # Before openssl, for the same reason: a clone that has never run
    # ``npm install`` has no listener to start, so nothing is minted for it.
    vite = listener_binary()
    if vite is None:
        return LanHttpsPlan(
            enabled=False,
            port=listener_port(environment),
            reason=NO_FRONTEND_REASON,
        )

    cert: Optional[CertPathsLike] = None
    try:
        from backend.lib.lan_cert import ensure_lan_cert

        cert = ensure_lan_cert(list(lan_ips))
    except Exception as exc:
        log.warning(
            "lan-https: no certificate for the LAN (%s). theDAW still runs; "
            "other devices reach it over plain http, where browsers block "
            "audio, mic and MIDI.",
            exc,
        )
        cert = None
    return plan_lan_https(settings, environment, lan_ips, cert, str(vite))


def _main(argv: Optional[list[str]] = None) -> int:
    """``python -m backend.lib.lan_https --json``.

    How the desktop shell asks the same question the Python launcher asks,
    without reimplementing the answer in TypeScript. Always exits 0 and always
    prints one JSON object: a shell that cannot read a plan must fall back to
    "no LAN listener", not to a crash dialog.
    """
    parser = argparse.ArgumentParser(
        prog="python -m backend.lib.lan_https",
        description="Report whether theDAW serves the LAN over HTTPS.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="print the plan as JSON (the desktop shell reads this)",
    )
    args = parser.parse_args(argv)

    try:
        plan = resolve_plan()
    except Exception as exc:
        plan = LanHttpsPlan(
            enabled=False,
            port=ports.LAN_HTTPS_PORT,
            reason=f"could not be worked out ({exc})",
        )
    if args.json:
        print(json.dumps(plan.as_json()))
    else:
        print(plan.log_line())
    return 0


if __name__ == "__main__":
    sys.exit(_main())
