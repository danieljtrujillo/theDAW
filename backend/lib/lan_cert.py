"""The self-signed certificate that makes theDAW a SECURE CONTEXT on the LAN.

A browser hands out ``AudioContext.audioWorklet``, the microphone, Web MIDI,
the clipboard and ``crypto.subtle`` only to a secure context: ``https://`` or
``localhost``. A second PC opening the app at ``http://<lan-ip>:5173`` is
neither, so the EDIT tab dies on ``Cannot read properties of undefined
(reading 'addModule')`` -- there is no audio engine to load a worklet into.
The fix is a TLS listener beside the plain one, and a TLS listener needs a
certificate. Nobody is going to buy one for ``192.168.1.34``, so the app makes
its own and the first visit from each device shows the usual "not private"
interstitial once.

Everything here goes through the ``openssl`` command line rather than a Python
library. ``cryptography`` is not a dependency of this project and adding one
for a handful of subprocess calls would be a poor trade: ``openssl`` ships with Git
for Windows (which every Windows install of theDAW already has, because the
launcher uses git) and is standard everywhere else.

What that costs is that reading a certificate back is also a subprocess, so
the decision "is the certificate on disk still good?" is split in two:
:func:`cert_matches` is a pure function over the TEXT ``openssl x509 -noout
-ext subjectAltName -enddate`` prints, and :func:`ensure_lan_cert` is the part
that shells out. The interesting logic -- every address covered, more than a
month of life left -- is therefore testable on a machine with no openssl at
all.

Nothing in this module ever logs, prints or returns key material. The private
key is written by ``openssl`` straight into a file this module creates at
mode ``0o600`` first (see :func:`_ensure_key_placeholder`), so it is never on
disk at the umask's permissions, not even for the instant between write and
chmod -- the same reasoning as ``backend/lib/atomic.py``'s ``mode`` argument
for the pairing token.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import socket
import subprocess
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from backend.lib import paths
from backend.lib.atomic import atomic_replace, temp_sibling
from backend.lib.launch_token import child_env

log = logging.getLogger(__name__)

__all__ = [
    "CertPaths",
    "cert_dir",
    "cert_file",
    "key_file",
    "desired_sans",
    "cert_matches",
    "ensure_lan_cert",
    "find_openssl",
    "CERT_DAYS",
    "MIN_DAYS_LEFT",
]

#: How long a generated certificate is valid. 397 days is the maximum a
#: public CA may issue and what browsers accept without complaint; there is no
#: reason to be more generous than the ecosystem's own ceiling.
CERT_DAYS = 397

#: Regenerate once the certificate has less than this left, so a machine that
#: is only launched occasionally never serves an expired one.
MIN_DAYS_LEFT = 30

# A DNS SAN openssl will accept and a browser will match. Anything else (a
# hostname with a space, a trailing dot, a non-ASCII label as the OS reports
# it) is dropped rather than passed to -addext, where it would fail the whole
# generation and leave the LAN with no listener at all.
_DNS_LABEL = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")

# Where Git for Windows puts openssl when it is not on PATH. A backend started
# from Explorer, Electron or a service wrapper inherits a PATH that has never
# seen a Git Bash profile, so shutil.which() alone finds nothing on exactly the
# machines this feature exists for.
_WINDOWS_OPENSSL_FALLBACKS = (
    r"C:\Program Files\Git\usr\bin\openssl.exe",
    r"C:\Program Files\Git\mingw64\bin\openssl.exe",
    r"C:\Program Files (x86)\Git\usr\bin\openssl.exe",
)

_HOW_TO_FIX = (
    (
        "install openssl (it ships with Git for Windows: "
        "C:\\Program Files\\Git\\usr\\bin\\openssl.exe) or put it on PATH"
    )
    if os.name == "nt"
    else "install openssl with your package manager or put it on PATH"
)


@dataclass(frozen=True)
class CertPaths:
    """A usable certificate/key pair on disk."""

    cert: Path
    key: Path


def cert_dir() -> Path:
    """Directory holding the LAN certificate. Gitignored (``data/lan-cert/``).

    A function rather than a module constant because ``theDAW_DATA_DIR`` is
    read on every call (see ``backend/lib/paths.py``): a packaged install that
    landed in a read-only directory relocates the whole data tree at startup,
    and a test points it at a temp directory without reimporting anything.
    """
    return paths.data_path("lan-cert")


def cert_file() -> Path:
    return cert_dir() / "lan-cert.pem"


def key_file() -> Path:
    return cert_dir() / "lan-key.pem"


def desired_sans(lan_ips: list[str], hostname: str) -> list[str]:
    """Every name the certificate has to cover, in openssl's ``-addext`` form.

    ``["IP:192.168.1.34", "IP:127.0.0.1", "DNS:localhost", "DNS:<hostname>"]``.
    Loopback and ``localhost`` are always there so the same certificate serves
    the machine's own browser, which is what the desktop shell points at.
    """
    sans: list[str] = []

    def add(entry: str) -> None:
        if entry.lower() not in {existing.lower() for existing in sans}:
            sans.append(entry)

    for ip in lan_ips:
        ip = (ip or "").strip()
        if ip:
            add(f"IP:{ip}")
    add("IP:127.0.0.1")
    add("DNS:localhost")
    host = (hostname or "").strip().rstrip(".")
    if host and all(_DNS_LABEL.match(label) for label in host.split(".")):
        add(f"DNS:{host}")
    return sans


def _normalise_san(entry: str) -> str:
    """One SAN in a comparable form.

    ``openssl x509 -ext subjectAltName`` prints ``IP Address:127.0.0.1`` where
    ``-addext`` takes ``IP:127.0.0.1``, and DNS names are case-insensitive.
    """
    entry = entry.strip()
    if entry.lower().startswith("ip address:"):
        entry = "IP:" + entry.split(":", 1)[1].strip()
    return entry.lower()


def _parse_not_after(text: str) -> datetime | None:
    """The ``notAfter=...`` line of ``openssl x509 -enddate``, as UTC."""
    match = re.search(r"^notAfter=(.+)$", text, re.MULTILINE)
    if not match:
        return None
    # openssl pads a single-digit day with a second space ("Oct  4 ...").
    stamp = " ".join(match.group(1).split())
    for fmt in ("%b %d %H:%M:%S %Y %Z", "%b %d %H:%M:%S %Y"):
        try:
            parsed = datetime.strptime(stamp, fmt)
        except ValueError:
            continue
        return parsed.replace(tzinfo=timezone.utc)
    return None


def _parse_sans(text: str) -> set[str]:
    """The SANs in ``openssl x509 -ext subjectAltName`` output, normalised."""
    found: set[str] = set()
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.endswith(":") or stripped.startswith("notAfter"):
            continue
        if "X509v3" in stripped or "Subject Alternative Name" in stripped:
            continue
        for entry in stripped.split(","):
            entry = entry.strip()
            if ":" in entry:
                found.add(_normalise_san(entry))
    return found


def cert_matches(
    cert_pem: bytes | str,
    sans: list[str],
    now: datetime,
    min_days_left: int = MIN_DAYS_LEFT,
) -> bool:
    """Is the certificate described by ``cert_pem`` still the one we want?

    ``cert_pem`` is the TEXT ``openssl x509 -noout -ext subjectAltName
    -enddate`` printed for the certificate on disk -- see the module docstring
    for why the parsing lives in the CLI and the judgement lives here. Bytes
    are accepted because that is what ``subprocess`` hands back.

    True only when every entry in ``sans`` is covered AND at least
    ``min_days_left`` days remain. A certificate missing the LAN address the
    machine got from DHCP this morning is no more useful than an expired one,
    so both answers are the same: regenerate.
    """
    if isinstance(cert_pem, (bytes, bytearray)):
        text = bytes(cert_pem).decode("utf-8", errors="replace")
    else:
        text = cert_pem

    not_after = _parse_not_after(text)
    if not_after is None:
        return False
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    if not_after - now < timedelta(days=min_days_left):
        return False

    present = _parse_sans(text)
    return all(_normalise_san(entry) in present for entry in sans)


def _openssl_candidates() -> list[str]:
    """Every openssl on this machine, in the order they are tried.

    Each PATH directory in PATH order, then the Git for Windows locations.
    Taking only the first hit on PATH was the bug: Miniconda puts an openssl
    on PATH that starts fine and answers ``openssl version``, but it was built
    to read an ``openssl.cnf`` that the install does not ship, so every
    ``openssl req`` exits with "Can't open ... openssl.cnf for reading". The
    certificate was never made and LAN HTTPS never started, while a working
    Git openssl sat a few PATH entries further on.
    """
    found: list[str] = []
    seen: set[str] = set()

    def add(path: str) -> None:
        key = os.path.normcase(os.path.abspath(path))
        if key not in seen:
            seen.add(key)
            found.append(path)

    for directory in os.environ.get("PATH", "").split(os.pathsep):
        if not directory.strip():
            continue
        hit = shutil.which("openssl", path=directory)
        if hit:
            add(hit)
    if os.name == "nt":
        for candidate in _WINDOWS_OPENSSL_FALLBACKS:
            if Path(candidate).is_file():
                add(candidate)
    return found


def _req_argv(
    binary: str, subject: str, sans: list[str], key: Path, cert: Path
) -> list[str]:
    """The ``openssl req`` that makes a self-signed LAN certificate.

    One definition for the real generation and the probe in
    :func:`_openssl_works`, so a binary that passes the probe is known to
    accept every option the generation uses.
    """
    return [
        binary,
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-sha256",
        "-days",
        str(CERT_DAYS),
        "-subj",
        subject,
        "-addext",
        "subjectAltName=" + ",".join(sans),
        "-addext",
        "keyUsage=digitalSignature,keyEncipherment",
        "-addext",
        "extendedKeyUsage=serverAuth",
        "-keyout",
        str(key),
        "-out",
        str(cert),
    ]


def _openssl_works(binary: str) -> bool:
    """True when ``binary`` can make a LAN certificate.

    ``openssl version`` proves nothing here: the Miniconda build answers it and
    still fails every ``req``. So the test is the generation itself, into a
    throwaway directory: the same options, loopback-only SANs, and the probe's
    key and certificate are deleted with the directory. Nothing is logged.
    """
    with tempfile.TemporaryDirectory(prefix="thedaw-openssl-probe-") as tmp:
        key = Path(tmp) / "probe-key.pem"
        cert = Path(tmp) / "probe-cert.pem"
        argv = _req_argv(
            binary, "/CN=theDAW openssl probe", ["IP:127.0.0.1"], key, cert
        )
        try:
            done = _run(argv, timeout=60.0)
        except (OSError, subprocess.SubprocessError):
            return False
        return done.returncode == 0 and cert.is_file() and cert.stat().st_size > 0


def find_openssl(explicit: str | None = None) -> str | None:
    """The first openssl on this machine that can make a certificate, or None.

    ``explicit`` is used as given when it exists: the caller chose it. Without
    it, every candidate from :func:`_openssl_candidates` is tried in order and
    the first that passes :func:`_openssl_works` wins; a broken one is skipped
    with a debug line naming it.
    """
    if explicit:
        return explicit if Path(explicit).exists() or shutil.which(explicit) else None
    for candidate in _openssl_candidates():
        if _openssl_works(candidate):
            return candidate
        log.debug("lan-cert: skipping %s - it cannot make a certificate", candidate)
    return None


def _run(argv: list[str], timeout: float = 60.0) -> subprocess.CompletedProcess[str]:
    """Run openssl with no console, no inherited stdin and no launch token.

    ``stdin=DEVNULL`` for the same reason ``backend/lib/ffmpeg.py`` uses it:
    the backend does not always own a real console, and an inherited handle
    makes a console-input reader block forever.
    """
    return subprocess.run(
        argv,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        env=child_env(),
    )


def _describe_existing(openssl: str, cert: Path) -> str | None:
    """``openssl x509`` output for ``cert``, or None if it cannot be read."""
    try:
        done = _run(
            [
                openssl,
                "x509",
                "-in",
                str(cert),
                "-noout",
                "-ext",
                "subjectAltName",
                "-enddate",
            ]
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if done.returncode != 0:
        return None
    return done.stdout


def _ensure_key_placeholder(path: Path) -> None:
    """Create ``path`` empty at mode 0o600 for openssl to write into.

    openssl's ``-keyout`` opens the file with ``fopen(..., "w")``, which
    truncates an existing file and leaves its mode alone. Creating it first
    means the key is never on disk at the umask's permissions, not even
    briefly. ``O_EXCL`` guarantees this call owns the name.
    """
    fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_EXCL, 0o600)
    os.close(fd)


def _key_is_pem(key: Path) -> bool:
    """True when ``key`` is non-empty and starts with a PEM header.

    The reuse path validates the certificate with ``openssl x509`` and nothing
    ever looked at the key beside it, so an empty or truncated key -- a crashed
    write, a half-synced folder, a file someone cleared -- was handed to the
    listener at every launch and vite died on it every time. Regenerating the
    pair costs one openssl call and needs nobody in the loop.

    Only the first bytes are read, and they are never logged: no key material
    leaves this function.
    """
    try:
        with key.open("rb") as handle:
            head = handle.read(64)
    except OSError:
        return False
    return head.startswith(b"-----BEGIN ")


def _pem_body(text: str) -> str:
    """``text`` with blank lines dropped and every line stripped.

    So a PEM written with CRLF compares equal to the same PEM with LF: openssl
    on Windows is not consistent about which it emits.
    """
    return "\n".join(line.strip() for line in text.splitlines() if line.strip())


def _pair_matches(openssl: str, cert: Path, key: Path) -> bool:
    """True when ``key`` is the private key belonging to ``cert``.

    The two files are replaced one after the other, so a crash, a kill or a
    power cut between the two leaves a key from one pair beside a certificate
    from another. :func:`cert_matches` reads only the certificate and
    :func:`_key_is_pem` reads only the key's first bytes, so both went on
    passing for the life of the installation while vite died on the mismatch at
    every single launch, and nothing ever regenerated the pair.

    The comparison is between PUBLIC keys -- ``openssl x509 -noout -pubkey``
    from the certificate against ``openssl pkey -pubout`` from the key -- so no
    private material is read into this process. Neither PEM is logged either;
    a public key is not a secret, but nothing here needs to print one.
    """
    try:
        from_cert = _run([openssl, "x509", "-noout", "-pubkey", "-in", str(cert)])
        from_key = _run([openssl, "pkey", "-pubout", "-in", str(key)])
    except (OSError, subprocess.SubprocessError):
        return False
    if from_cert.returncode != 0 or from_key.returncode != 0:
        return False
    from_cert_pem = _pem_body(from_cert.stdout)
    return bool(from_cert_pem) and from_cert_pem == _pem_body(from_key.stdout)


def _cleanup(*items: Path) -> None:
    for item in items:
        try:
            item.unlink(missing_ok=True)
        except OSError:
            log.debug("lan-cert: leftover temp file %s", item)


def _reusable_pair(
    candidates: list[str], cert: Path, key: Path, sans: list[str], now: datetime
) -> bool:
    """True when the pair on disk covers ``sans``, has life left and belongs
    together, read with the first candidate that can read it.

    Reading a certificate needs no openssl.cnf, so this runs before any
    candidate is probed with a key generation: a launch that keeps its
    certificate, which is almost every launch, generates no key at all. A
    candidate that cannot read the certificate is skipped. Once one can,
    what the certificate says settles it; a key that one binary cannot open
    is tried with the next before the pair counts as mismatched, since
    replacing the pair makes every device on the LAN show the certificate
    warning again.
    """
    if not (cert.exists() and key.exists()) or not _key_is_pem(key):
        return False
    read = False
    for candidate in candidates:
        described = _describe_existing(candidate, cert)
        if described is None:
            continue
        if not read:
            if not cert_matches(described, sans, now):
                return False
            read = True
        # The pair is replaced in two steps, and an interrupted launch leaves
        # two halves that every other check here accepts forever.
        if _pair_matches(candidate, cert, key):
            return True
    return False


def ensure_lan_cert(
    lan_ips: list[str],
    *,
    openssl: str | None = None,
    now: datetime | None = None,
) -> CertPaths | None:
    """The certificate covering ``lan_ips``, generating one if need be.

    Returns the existing pair untouched when it already covers every address,
    has more than a month left, and still has its own PEM key beside it; that
    check reads files and generates no key. Otherwise generates a fresh
    self-signed certificate into ``data/lan-cert/`` with the first openssl
    that can (:func:`find_openssl`).

    Returns None -- never raises -- when openssl is missing or fails, after
    logging exactly one warning that names the fix. A LAN listener is a
    convenience: the app must start without it.
    """
    now = now or datetime.now(timezone.utc)
    hostname = ""
    try:
        hostname = socket.gethostname()
    except OSError:
        pass
    sans = desired_sans(lan_ips, hostname)
    cert, key = cert_file(), key_file()

    if openssl:
        readers = [openssl] if find_openssl(openssl) else []
    else:
        readers = _openssl_candidates()
    if _reusable_pair(readers, cert, key, sans, now):
        return CertPaths(cert=cert, key=key)

    binary = find_openssl(openssl)
    if binary is None:
        tried = [] if openssl else _openssl_candidates()
        if tried:
            log.warning(
                "lan-cert: no HTTPS certificate for the LAN because no openssl "
                "on this machine could make one (tried %s) - %s. theDAW still "
                "runs; other devices will reach it over plain http, where "
                "browsers block audio, mic and MIDI.",
                ", ".join(tried),
                _HOW_TO_FIX,
            )
        else:
            log.warning(
                "lan-cert: no HTTPS certificate for the LAN because openssl was "
                "not found - %s. theDAW still runs; other devices will reach it "
                "over plain http, where browsers block audio, mic and MIDI.",
                _HOW_TO_FIX,
            )
        return None

    tmp_cert = temp_sibling(cert)
    tmp_key = temp_sibling(key)
    try:
        cert_dir().mkdir(parents=True, exist_ok=True)
        _ensure_key_placeholder(tmp_key)
        done = _run(
            _req_argv(
                binary,
                f"/CN=theDAW LAN ({hostname or 'this computer'})",
                sans,
                tmp_key,
                tmp_cert,
            ),
            timeout=120.0,
        )
        if done.returncode != 0 or not tmp_cert.exists():
            # stderr carries openssl's progress dots and its error text; the
            # key went to -keyout, so nothing secret can be in here.
            _cleanup(tmp_cert, tmp_key)
            log.warning(
                "lan-cert: openssl could not create the LAN certificate "
                "(exit %s: %s). theDAW still runs; other devices will reach "
                "it over plain http, where browsers block audio, mic and MIDI.",
                done.returncode,
                (done.stderr or "").strip()[-300:] or "no output",
            )
            return None
        # Belt and braces: the placeholder already set the mode, but a
        # filesystem that ignored it (or an openssl that replaced the file
        # rather than truncating it) gets corrected here.
        try:
            os.chmod(tmp_key, 0o600)
        except OSError:
            pass
        atomic_replace(tmp_key, key)
        atomic_replace(tmp_cert, cert)
        return CertPaths(cert=cert, key=key)
    except (OSError, subprocess.SubprocessError) as exc:
        _cleanup(tmp_cert, tmp_key)
        log.warning(
            "lan-cert: could not create the LAN certificate (%s) - %s. theDAW "
            "still runs; other devices will reach it over plain http, where "
            "browsers block audio, mic and MIDI.",
            exc,
            _HOW_TO_FIX,
        )
        return None
