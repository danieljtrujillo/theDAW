"""The pretty_midi stubs under ``stubs/`` describe the installed package.

pretty_midi ships no type information, and every import of it carried a
``# type: ignore[import]``. The stubs replace that suppression, so they must
match the real package: every name, class attribute, method and parameter
they declare exists on the installed pretty_midi, and the type checker's
config points at them. music21 ships its own ``py.typed``, so its imports need
neither stubs nor a suppression.
"""

from __future__ import annotations

import ast
import inspect
import json
import re
from pathlib import Path

import pretty_midi

ROOT = Path(__file__).resolve().parents[1]
STUBS = ROOT / "stubs" / "pretty_midi"


def _stub_modules() -> dict[str, ast.Module]:
    return {
        p.stem: ast.parse(p.read_text(encoding="utf-8"), filename=str(p))
        for p in sorted(STUBS.glob("*.pyi"))
    }


def _params(node: ast.FunctionDef) -> list[str]:
    args = node.args
    return [a.arg for a in [*args.posonlyargs, *args.args, *args.kwonlyargs]]


def test_the_type_checker_config_names_the_stub_folder() -> None:
    config = json.loads((ROOT / "pyrightconfig.json").read_text(encoding="utf-8"))
    assert (ROOT / config["stubPath"] / "pretty_midi" / "__init__.pyi").is_file()
    # The editor's own exclude (.vscode/settings.json) is carried over: a
    # pyrightconfig.json replaces python.analysis.exclude.
    assert "integration-package" in config["exclude"]


def test_every_stubbed_name_exists_with_its_parameters() -> None:
    modules = _stub_modules()
    assert set(modules) == {
        "__init__",
        "constants",
        "containers",
        "instrument",
        "pretty_midi",
        "utilities",
    }
    checked = 0
    for name, tree in modules.items():
        real_module = pretty_midi if name == "__init__" else getattr(pretty_midi, name)
        for node in tree.body:
            if isinstance(node, ast.ClassDef):
                real = getattr(real_module, node.name)
                assert inspect.isclass(real), node.name
                instance_attrs = _instance_attributes(real)
                for member in node.body:
                    if isinstance(member, ast.FunctionDef):
                        attr = getattr(real, member.name)
                        if isinstance(attr, property):
                            continue
                        real_params = list(inspect.signature(attr).parameters)
                        assert _params(member) == real_params, (
                            node.name,
                            member.name,
                        )
                        checked += 1
                    elif isinstance(member, ast.AnnAssign):
                        field = member.target
                        assert isinstance(field, ast.Name)
                        assert field.id in instance_attrs, (node.name, field.id)
                        checked += 1
            elif isinstance(node, ast.FunctionDef):
                if any(
                    isinstance(d, ast.Name) and d.id == "overload"
                    for d in node.decorator_list
                ):
                    assert callable(getattr(real_module, node.name)), node.name
                    continue
                real_params = list(
                    inspect.signature(getattr(real_module, node.name)).parameters
                )
                assert _params(node) == real_params, node.name
                checked += 1
            elif isinstance(node, ast.AnnAssign):
                assert isinstance(node.target, ast.Name)
                assert hasattr(real_module, node.target.id), node.target.id
                checked += 1
            elif isinstance(node, ast.ImportFrom) and name == "__init__":
                for alias in node.names:
                    assert alias.asname == alias.name, alias.name
                    assert hasattr(pretty_midi, alias.name), alias.name
                    checked += 1
    assert checked > 80


def _instance_attributes(cls: type) -> set[str]:
    """The attributes an instance of ``cls`` gets in ``__init__`` (or later
    ``self.x =`` assignments), read from the class source, and its properties."""
    source = inspect.getsource(cls)
    found = set(re.findall(r"self\.([A-Za-z][A-Za-z0-9_]*)\s*=", source))
    found |= {k for k, v in vars(cls).items() if isinstance(v, property)}
    return found


def test_no_music21_or_pretty_midi_import_is_suppressed() -> None:
    offenders = []
    for folder in ("backend", "tests", "scripts"):
        for path in (ROOT / folder).rglob("*.py"):
            for number, line in enumerate(
                path.read_text(encoding="utf-8", errors="replace").splitlines(), 1
            ):
                if re.search(r"\b(music21|pretty_midi)\b", line) and re.search(
                    r"type:\s*ignore|pyright:\s*ignore", line
                ):
                    offenders.append(f"{path.relative_to(ROOT)}:{number}")
    assert offenders == []
