# 2026-05-25 — `backend/server.py` Pylance cleanup log

Keeping this visible so future debugging has a reference if any of the
annotated areas misbehave.

## Context

While doing C1–C4 of the Chimera plan I moved one stdlib import
(`from collections import OrderedDict`) to the top of `backend/server.py`.
After that edit, Pylance surfaced 6 type warnings in the IDE Problems
panel. The patterns being flagged predated the edit (confirmed via
`git stash` round-trip), but Pylance had not been showing them — most
likely because its incremental analysis didn't re-scan that file until
something else touched it.

The fix here is intentional: widen a few annotations from `object` /
implicit-None to `Any` so static analysis stops complaining about
attribute access on values whose real types are only known at runtime.
None of these change runtime behavior; they only change what the static
checker can prove.

## What changed

| Location | Before | After | Why |
|---|---|---|---|
| `from typing import Optional` | — | `from typing import Any, Optional` | Need `Any` below |
| `pipeline = None` (module-level singleton) | implicit `None` | `pipeline: Any = None` | Reassigned at runtime to a `StableAudioModel`; without an annotation Pylance keeps it pinned as `None`, so `pipeline.model.diffusion_objective` (status route) and `pipeline.generate(...)` (generate route) light up red |
| `_generation_pipelines: dict[str, object] = {}` | `dict[str, object]` | `dict[str, Any]` | Values are `StableAudioModel` instances looked up by name. Importing the class at module top would early-load the model graph; keeping the local import inside `_get_generation_pipeline_for_model` is intentional. `Any` keeps that lazy import strategy intact while letting Pylance see `selected.model_config["sample_rate"]`. |
| `@dataclass LoraFormSlot.upload: object` | `object` | `Any` | `upload` is a FastAPI `UploadFile` at runtime; `slot.upload.read()` is correct, but `object` has no `.read`. Class lives in a `@dataclass(frozen=True)` so we can't use `UploadFile` directly without a circular import. |
| `audio_data = base64.b64decode(audio_base64)` (spectrogram endpoint) | bare call | preceded by `assert audio_base64 is not None` | The endpoint validates that `audio_base64` is non-None earlier via raise-and-return guards, but Pylance's flow analysis can't follow that chain. The assert is a narrowing hint for the type checker. It is also true at runtime by construction. |
| `_decode_audio_bytes` `except (ImportError, Exception) as e:` | redundant tuple | `except Exception as e:` | `Exception` already includes `ImportError`. The redundant tuple confused Pylance's flow analysis around the local `import soundfile as sf` inside the `try`, producing a spurious `"NoReturn" is not iterable` warning on `sf.read(buf)`. Simplifying the except clause fixes the warning and is semantically identical. |

## Things to watch for if any of this regresses

- If `pipeline` is ever set to `None` and then dereferenced via `pipeline.X`,
  Pylance will not catch it because we widened to `Any`. Runtime will
  `AttributeError`. If we hit that, narrow back to a Union and add explicit
  None guards. The trade-off was acceptable here because every site that
  dereferences `pipeline` is protected by `_ensure_model_loaded()` upstream.
- `_generation_pipelines[name]` returning `Any` means a typo in `.model_config`
  vs `.model_configs` would not be caught by Pylance. If we start adding more
  attribute access on these values, consider promoting the type to a Protocol
  or moving the import behind `TYPE_CHECKING`.
- `LoraFormSlot.upload: Any` allows passing in anything that quacks like a
  file. If a future call site forgets to use a real `UploadFile`, only runtime
  will catch it. If LORA upload bugs appear, this is the first place to look.
- The `_decode_audio_bytes` simplification means `ImportError` from a missing
  `soundfile` install now flows through the same handler as decode errors.
  That was already the de-facto behavior; the change just makes it explicit.
  If we see a regression where missing-soundfile installs silently fall back
  to torchaudio without any user-visible signal, restore an explicit
  `except ImportError` first.

## How I verified nothing broke

- `ruff check backend/server.py` — clean.
- Full Chimera test suite (`tests/test_chimera_*.py`, 28 tests) — all pass.
- `git diff backend/server.py` reviewed line-by-line; no logic changed, only
  type annotations + an `assert` narrowing + one `except` clause simplified.

## Why this note exists

User asked me not to hide non-breaking warnings even when I can argue they
were pre-existing. The fix-it-at-the-root rule is in
`memory/feedback_no_hidden_warnings.md`. This note is the artifact so the
next debugging session has a record of what was widened to `Any` and why.
