"""Read a sound bank's name and preset list from its RIFF chunks.

SF2 and SF3 share one layout: ``RIFF sfbk`` holding ``LIST INFO`` (the bank's
name in ``INAM``), ``LIST sdta`` (the samples) and ``LIST pdta``, whose
``phdr`` chunk lists every preset in 38-byte records: a 20-byte name, the
program, the bank, a bag index and three reserved words, ended by an ``EOP``
record. Bank 128 is the percussion bank: its presets are drum kits.

DLS is ``RIFF DLS `` holding ``LIST lins``, one ``LIST ins `` per instrument,
each with an ``insh`` chunk (region count, then the bank word and the program
word) and a ``LIST INFO`` naming it. The bank word carries the bank select MSB
in bits 8-14, the LSB in bits 0-6 and the drum flag in bit 31.

Only chunk headers and the preset records are read: the sample data is
skipped with a seek, so a bank of a gigabyte lists in milliseconds.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from typing import BinaryIO

__all__ = ["BankFileError", "BankInfo", "Preset", "read_bank", "SUPPORTED_FORMATS"]

SUPPORTED_FORMATS = ("sf2", "sf3", "dls")

# The SF2 percussion bank.
SF2_DRUM_BANK = 128
PHDR_RECORD = 38
DLS_DRUM_FLAG = 0x80000000


class BankFileError(ValueError):
    """The bytes are not a sound bank this module can read."""


@dataclass(frozen=True)
class Preset:
    """One preset: the bank select it answers to inside its own file (MSB and
    LSB), its program, its name, and whether it is a drum kit."""

    bank: int
    program: int
    name: str
    drum: bool = False
    bank_lsb: int = 0

    def as_dict(self) -> dict:
        return {
            "bank": self.bank,
            "bank_lsb": self.bank_lsb,
            "program": self.program,
            "name": self.name,
            "drum": self.drum,
        }


@dataclass
class BankInfo:
    format: str
    name: str
    presets: list[Preset] = field(default_factory=list)

    @property
    def melodic_span(self) -> int:
        """How many bank select MSBs the melodic presets use, counted from 0:
        the width of the offset range the bank needs."""
        banks = [p.bank for p in self.presets if not p.drum]
        return (max(banks) + 1) if banks else 1


def _read_header(f: BinaryIO) -> tuple[bytes, int] | None:
    head = f.read(8)
    if len(head) < 8:
        return None
    return head[:4], struct.unpack("<I", head[4:])[0]


def _text(raw: bytes) -> str:
    return raw.split(b"\x00", 1)[0].decode("latin-1").strip()


def _skip(f: BinaryIO, size: int) -> None:
    # Chunks are word-aligned: an odd size is followed by one pad byte.
    f.seek(size + (size & 1), 1)


def _info_name(f: BinaryIO, end: int) -> str:
    """The INAM text of the LIST INFO whose body runs to ``end``."""
    name = ""
    while f.tell() + 8 <= end:
        hdr = _read_header(f)
        if hdr is None:
            break
        cid, size = hdr
        if cid == b"INAM":
            name = _text(f.read(size))
            if size & 1:
                f.seek(1, 1)
        else:
            _skip(f, size)
    f.seek(end)
    return name


def _read_phdr(f: BinaryIO, size: int) -> list[Preset]:
    raw = f.read(size)
    presets: list[Preset] = []
    count = len(raw) // PHDR_RECORD
    # The last record is the EOP terminal.
    for i in range(max(0, count - 1)):
        rec = raw[i * PHDR_RECORD : (i + 1) * PHDR_RECORD]
        name = _text(rec[:20])
        program, bank = struct.unpack("<HH", rec[20:24])
        drum = bank == SF2_DRUM_BANK
        presets.append(
            Preset(
                bank=0 if drum else bank & 0x7F,
                program=program & 0x7F,
                name=name or f"Preset {program + 1}",
                drum=drum,
            )
        )
    return presets


def _read_sfbk(f: BinaryIO, riff_end: int, fmt: str) -> BankInfo:
    info = BankInfo(format=fmt, name="")
    while f.tell() + 8 <= riff_end:
        hdr = _read_header(f)
        if hdr is None:
            break
        cid, size = hdr
        body_end = f.tell() + size
        if cid != b"LIST":
            _skip(f, size)
            continue
        kind = f.read(4)
        if kind == b"INFO":
            info.name = _info_name(f, body_end)
        elif kind == b"pdta":
            while f.tell() + 8 <= body_end:
                sub = _read_header(f)
                if sub is None:
                    break
                sid, ssize = sub
                if sid == b"phdr":
                    info.presets = _read_phdr(f, ssize)
                    if ssize & 1:
                        f.seek(1, 1)
                else:
                    _skip(f, ssize)
            f.seek(body_end)
        else:
            f.seek(body_end + (size & 1))
    return info


def _read_dls_ins(f: BinaryIO, end: int) -> Preset | None:
    bank_word = program_word = None
    name = ""
    while f.tell() + 8 <= end:
        hdr = _read_header(f)
        if hdr is None:
            break
        cid, size = hdr
        body_end = f.tell() + size
        if cid == b"insh" and size >= 12:
            _regions, bank_word, program_word = struct.unpack("<III", f.read(12))
            f.seek(body_end + (size & 1))
        elif cid == b"LIST":
            kind = f.read(4)
            if kind == b"INFO":
                name = _info_name(f, body_end)
            f.seek(body_end + (size & 1))
        else:
            _skip(f, size)
    f.seek(end)
    if bank_word is None or program_word is None:
        return None
    drum = bool(bank_word & DLS_DRUM_FLAG)
    program = program_word & 0x7F
    return Preset(
        bank=0 if drum else (bank_word >> 8) & 0x7F,
        bank_lsb=0 if drum else bank_word & 0x7F,
        program=program,
        name=name or f"Instrument {program + 1}",
        drum=drum,
    )


def _read_dls(f: BinaryIO, riff_end: int) -> BankInfo:
    info = BankInfo(format="dls", name="")
    while f.tell() + 8 <= riff_end:
        hdr = _read_header(f)
        if hdr is None:
            break
        cid, size = hdr
        body_end = f.tell() + size
        if cid != b"LIST":
            _skip(f, size)
            continue
        kind = f.read(4)
        if kind == b"INFO":
            info.name = _info_name(f, body_end)
        elif kind == b"lins":
            while f.tell() + 8 <= body_end:
                sub = _read_header(f)
                if sub is None:
                    break
                sid, ssize = sub
                sub_end = f.tell() + ssize
                if sid == b"LIST" and f.read(4) == b"ins ":
                    preset = _read_dls_ins(f, sub_end)
                    if preset is not None:
                        info.presets.append(preset)
                f.seek(sub_end + (ssize & 1))
        f.seek(body_end + (size & 1))
    return info


def read_bank(f: BinaryIO) -> BankInfo:
    """The bank in ``f`` (open for binary reading, at its start). Raises
    BankFileError for anything that is not an SF2, SF3 or DLS bank, or a bank
    that lists no presets."""
    hdr = _read_header(f)
    if hdr is None or hdr[0] != b"RIFF":
        raise BankFileError("not a RIFF file")
    riff_end = 8 + hdr[1]
    form = f.read(4)
    if form == b"sfbk":
        info = _read_sfbk(f, riff_end, "sf2")
        # An SF3 is an SF2 whose samples are Ogg Vorbis; its version word
        # (ifil major 3) is the only marker, and the samples are what differ,
        # so the preset list reads the same.
    elif form == b"DLS ":
        info = _read_dls(f, riff_end)
    else:
        raise BankFileError(f"unknown RIFF form {form!r}")
    if not info.presets:
        raise BankFileError("the bank lists no presets")
    info.presets.sort(key=lambda p: (p.drum, p.bank, p.bank_lsb, p.program))
    return info
