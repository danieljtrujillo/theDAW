"""Write the concert-hall impulse responses EDIT's Reverb plays, under frontend/public/irs/.

Source: "Open Database of Spatial Room Impulse Responses at Detmold University
of Music" (Amengual Gari, Sahin, Eddy, Kob; AES 149th Convention, 2020),
Zenodo record 4116247, licensed CC BY 4.0. Its Set C measures the Detmold
Konzerthaus with a loudspeaker orchestra of eight sources on stage (S1-S8) and
a Neumann KU100 dummy head in the audience. Seen from the audience, S1-S4 are
the front row from left to right (x = -4, -2, 2 and 4 m) and S5-S8 the row
2 m behind it (x = -3, -1, 1 and 3 m).

The archive is about 1 GB, so the script reads only the files it needs from it
with HTTP range requests (the zip's central directory, then each member).

For each listening seat the eight binaural responses are:
  - trimmed to start LEAD_SEC before the earliest direct sound of the seat's
    eight, so the arrival-time differences between the rows are kept;
  - scaled by one gain for the whole seat (the loudest peak to PEAK), so the
    level differences between the positions are kept;
  - faded out over the last FADE_SEC with a cosine, and written as 16-bit FLAC
    at the source's 48 kHz.
A ninth file, stage.flac, is the mean of the eight: the hall excited by the
whole stage at once, scaled to PEAK on its own.

Run from the repo root (network access needed):

    python scripts/build_hall_irs.py
"""

from __future__ import annotations

import io
import sys
import urllib.request
import zipfile
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "frontend" / "public" / "irs" / "detmold-konzerthaus"
ARCHIVE_URL = "https://zenodo.org/records/4116247/files/DetmoldSRIR_v01.zip?download=1"
MEMBER = "SetC_DenseKH_LSOrchestra/Data/DummyHead/S{source}R{seat}.wav"
SOURCES = range(1, 9)
# Seat 211: the centre of the fixed stalls' front rows. Seat 372: the centre
# of the rear stalls (DetmoldKH_POSITIONS_Dense.png in the archive).
SEATS = (211, 372)

LEAD_SEC = 0.0015
FADE_SEC = 0.05
PEAK = 0.89
ONSET_FRACTION = 0.1


class _RangeFile(io.RawIOBase):
    """A read-only, seekable file over an HTTP resource that answers Range requests."""

    def __init__(self, url: str) -> None:
        self.url = url
        self.pos = 0
        with urllib.request.urlopen(urllib.request.Request(url, method="HEAD")) as r:
            self.size = int(r.headers["Content-Length"])

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.pos

    def seek(self, offset: int, whence: int = 0) -> int:
        base = {0: 0, 1: self.pos, 2: self.size}[whence]
        self.pos = base + offset
        return self.pos

    def readinto(self, buffer: memoryview) -> int:
        want = min(len(buffer), self.size - self.pos)
        if want <= 0:
            return 0
        headers = {"Range": f"bytes={self.pos}-{self.pos + want - 1}"}
        with urllib.request.urlopen(
            urllib.request.Request(self.url, headers=headers)
        ) as r:
            data = r.read()
        buffer[: len(data)] = data
        self.pos += len(data)
        return len(data)


def onset_index(ir: np.ndarray, fraction: float = ONSET_FRACTION) -> int:
    """The first frame where either ear reaches `fraction` of the response's peak."""
    level = np.abs(ir).max(axis=1)
    return int(np.argmax(level >= fraction * level.max()))


def fade_out(ir: np.ndarray, frames: int) -> np.ndarray:
    """`ir` with a quarter-cosine-squared fade over its last `frames` frames."""
    out = ir.copy()
    frames = min(frames, len(out))
    if frames > 0:
        out[-frames:] *= (np.cos(np.linspace(0.0, np.pi / 2, frames)) ** 2)[:, None]
    return out


def prepare_seat(irs: dict[int, np.ndarray], sample_rate: int) -> dict[str, np.ndarray]:
    """The files for one seat: "s1".."s8" and "stage", as float32 (frames, 2) arrays."""
    start = max(
        0, min(onset_index(ir) for ir in irs.values()) - round(LEAD_SEC * sample_rate)
    )
    gain = PEAK / max(float(np.abs(ir[start:]).max()) for ir in irs.values())
    fade = round(FADE_SEC * sample_rate)
    out = {
        f"s{k}": fade_out(ir[start:] * gain, fade).astype(np.float32)
        for k, ir in sorted(irs.items())
    }
    stage = np.mean([ir[start:] for ir in irs.values()], axis=0)
    out["stage"] = fade_out(stage * (PEAK / float(np.abs(stage).max())), fade).astype(
        np.float32
    )
    return out


def main() -> int:
    import soundfile as sf

    archive = zipfile.ZipFile(
        io.BufferedReader(_RangeFile(ARCHIVE_URL), buffer_size=1 << 20)
    )
    for seat in SEATS:
        irs: dict[int, np.ndarray] = {}
        rate = 0
        for source in SOURCES:
            data, rate = sf.read(
                io.BytesIO(archive.read(MEMBER.format(source=source, seat=seat))),
                always_2d=True,
            )
            irs[source] = data
        folder = OUT / f"seat-{seat}"
        folder.mkdir(parents=True, exist_ok=True)
        for name, ir in prepare_seat(irs, rate).items():
            target = folder / f"{name}.flac"
            sf.write(target, ir, rate, subtype="PCM_16", format="FLAC")
            print(target, target.stat().st_size)
    return 0


if __name__ == "__main__":
    sys.exit(main())
