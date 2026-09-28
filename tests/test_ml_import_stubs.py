"""The stubs under ``stubs/`` for onnxruntime, basic_pitch,
piano_transcription_inference and mido describe the installed packages.

None of the four ships type information, and every import of them carried a
``# type: ignore[import]``. The stubs replace that suppression, so they must
match the real packages: every class, function, method and parameter they
declare exists on the installed package with those parameter names, and the
type checker's config points at them. librosa and pedalboard ship their own
``py.typed``, so their imports need neither stubs nor a suppression.

onnxruntime and mido are imported and inspected. basic_pitch and
piano_transcription_inference are read from their source with ``ast``: their
imports load TensorFlow probes, torch and librosa, and a type check needs
none of that.
"""

from __future__ import annotations

import ast
import importlib.util
import inspect
import json
import re
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
STUBS = ROOT / "stubs"
PACKAGES = ("onnxruntime", "basic_pitch", "piano_transcription_inference", "mido")


def _stub(package: str, module: str = "__init__") -> ast.Module:
    path = STUBS / package / f"{module}.pyi"
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _params(node: ast.FunctionDef) -> list[str]:
    a = node.args
    names = [x.arg for x in [*a.posonlyargs, *a.args]]
    if a.vararg:
        names.append("*" + a.vararg.arg)
    names += [x.arg for x in a.kwonlyargs]
    if a.kwarg:
        names.append("**" + a.kwarg.arg)
    return names


def _sig_params(fn: Any) -> list[str] | None:
    try:
        sig = inspect.signature(fn)
    except (TypeError, ValueError):  # a pybind11 builtin carries no signature
        return None
    out = []
    for p in sig.parameters.values():
        if p.kind is p.VAR_POSITIONAL:
            out.append("*" + p.name)
        elif p.kind is p.VAR_KEYWORD:
            out.append("**" + p.name)
        else:
            out.append(p.name)
    return out


def _source_module(package: str, module: str) -> ast.Module:
    spec = importlib.util.find_spec(package)
    assert spec and spec.submodule_search_locations, package
    path = Path(next(iter(spec.submodule_search_locations))) / f"{module}.py"
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _defs(tree: ast.Module) -> dict[str, ast.AST]:
    out: dict[str, ast.AST] = {}
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.ClassDef)):
            out[node.name] = node
        elif isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name):
                    out[t.id] = node
    return out


def test_the_type_checker_config_names_the_stub_folder() -> None:
    config = json.loads((ROOT / "pyrightconfig.json").read_text(encoding="utf-8"))
    for package in PACKAGES:
        assert (ROOT / config["stubPath"] / package / "__init__.pyi").is_file()


def _check_runtime(stub: ast.Module, real: Any) -> int:
    checked = 0
    for node in stub.body:
        if isinstance(node, ast.FunctionDef):
            fn = getattr(real, node.name)
            assert callable(fn), node.name
            got = _sig_params(fn)
            if got is not None:
                assert _params(node) == got, node.name
            checked += 1
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            assert hasattr(real, node.target.id), node.target.id
            checked += 1
        elif isinstance(node, ast.ClassDef) and node.name.startswith("_"):
            # A stub-only base (typeshed's convention): the fields its real
            # subclasses share, checked on their instances below.
            continue
        elif isinstance(node, ast.ClassDef):
            cls = getattr(real, node.name)
            assert inspect.isclass(cls), node.name
            for member in node.body:
                if isinstance(member, ast.FunctionDef):
                    attr = inspect.getattr_static(cls, member.name, None)
                    assert attr is not None or member.name == "__getattr__", (
                        node.name,
                        member.name,
                    )
                    if isinstance(attr, property) or attr is None:
                        checked += 1
                        continue
                    got = _sig_params(getattr(cls, member.name))
                    if got is not None:
                        assert _params(member) == got, (node.name, member.name)
                    checked += 1
            checked += 1
    return checked


def test_onnxruntime_stub_matches_the_package() -> None:
    import onnxruntime

    assert _check_runtime(_stub("onnxruntime"), onnxruntime) >= 8
    assert isinstance(onnxruntime.get_available_providers(), list)


def test_mido_stub_matches_the_package() -> None:
    import mido

    assert _check_runtime(_stub("mido"), mido) >= 12
    # The instance fields the stub declares are on real instances.
    f = mido.MidiFile()
    for name in ("filename", "type", "ticks_per_beat", "tracks"):
        assert name in vars(f), name
    m = mido.Message("note_on", note=60, velocity=90, time=5)
    assert (m.type, m.time, m.is_meta) == ("note_on", 5, False)
    meta = mido.MetaMessage("set_tempo", tempo=500000)
    assert (meta.type, meta.is_meta, meta.tempo) == ("set_tempo", True, 500000)
    assert isinstance(mido.bpm2tempo(120), int)
    assert isinstance(mido.second2tick(1.0, 480, 500000), int)


def _check_source(stub: ast.Module, source: ast.Module, where: str) -> int:
    real = _defs(source)
    checked = 0
    for node in stub.body:
        if isinstance(node, ast.FunctionDef):
            got = real.get(node.name)
            assert isinstance(got, ast.FunctionDef), (where, node.name)
            assert _params(node) == _params(got), (where, node.name)
            checked += 1
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            assert node.target.id in real, (where, node.target.id)
            checked += 1
        elif isinstance(node, ast.ClassDef):
            got = real.get(node.name)
            assert isinstance(got, ast.ClassDef), (where, node.name)
            members = {
                m.name: m
                for m in got.body
                if isinstance(m, (ast.FunctionDef, ast.ClassDef))
            }
            assigned = set(
                re.findall(r"self\.([A-Za-z_][A-Za-z0-9_]*)\s*=", ast.unparse(got))
            )
            for member in node.body:
                if isinstance(member, ast.FunctionDef):
                    real_member = members.get(member.name)
                    assert isinstance(real_member, ast.FunctionDef), (
                        where,
                        node.name,
                        member.name,
                    )
                    assert _params(member) == _params(real_member), (
                        where,
                        node.name,
                        member.name,
                    )
                elif isinstance(member, ast.ClassDef):
                    real_inner = members.get(member.name)
                    assert isinstance(real_inner, ast.ClassDef), (where, member.name)
                    real_names = {
                        t.id
                        for s in real_inner.body
                        if isinstance(s, ast.Assign)
                        for t in s.targets
                        if isinstance(t, ast.Name)
                    }
                    stub_names = {
                        t.id
                        for s in member.body
                        if isinstance(s, ast.Assign)
                        for t in s.targets
                        if isinstance(t, ast.Name)
                    }
                    assert stub_names == real_names, (where, member.name)
                elif isinstance(member, ast.AnnAssign) and isinstance(
                    member.target, ast.Name
                ):
                    assert member.target.id in assigned, (
                        where,
                        node.name,
                        member.target.id,
                    )
                checked += 1
            checked += 1
        elif isinstance(node, ast.ImportFrom) and node.level == 1:
            module = _source_module(where.split(".")[0], node.module or "")
            names = _defs(module)
            for alias in node.names:
                assert alias.asname == alias.name, alias.name
                assert alias.name in names, (node.module, alias.name)
                checked += 1
    return checked


def test_basic_pitch_stub_matches_the_source() -> None:
    assert (
        _check_source(
            _stub("basic_pitch"),
            _source_module("basic_pitch", "__init__"),
            "basic_pitch",
        )
        >= 3
    )
    assert (
        _check_source(
            _stub("basic_pitch", "inference"),
            _source_module("basic_pitch", "inference"),
            "basic_pitch.inference",
        )
        >= 5
    )


def test_piano_transcription_stub_matches_the_source() -> None:
    pkg = "piano_transcription_inference"
    assert _check_source(_stub(pkg), _source_module(pkg, "__init__"), pkg) == 3
    for module in ("inference", "utilities", "config"):
        assert (
            _check_source(
                _stub(pkg, module), _source_module(pkg, module), f"{pkg}.{module}"
            )
            >= 1
        )


def test_no_import_of_these_packages_is_suppressed() -> None:
    watched = r"\b(onnxruntime|basic_pitch|piano_transcription_inference|mido|librosa|pedalboard)\b"
    offenders = []
    for folder in ("backend", "tests", "scripts"):
        for path in (ROOT / folder).rglob("*.py"):
            lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
            for number, line in enumerate(lines, 1):
                if re.search(r"^\s*(import|from)\s", line) and re.search(watched, line):
                    if re.search(r"type:\s*ignore|pyright:\s*ignore", line):
                        offenders.append(f"{path.relative_to(ROOT)}:{number}")
    assert offenders == []
