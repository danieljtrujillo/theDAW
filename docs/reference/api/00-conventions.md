# API conventions

theDAW's backend is a FastAPI app (`backend/server.py`) plus a set of
auto-discovered feature modules. Everything below is how the API is wired, so the
per-cluster pages that follow only have to list routes.

## Module auto-discovery and the `/api/<module>` prefix

`backend/modules/loader.py` walks `backend/modules/*/router.py`, imports each
file's `APIRouter`, and mounts it (`loader.py:12`, `:39`, `:42`):

```python
prefix = config.get("api_prefix", f"/api/{module_dir.name}")
app.include_router(router, prefix=prefix)
```

- **Default prefix** is `/api/<directory name>` — the `tour` module's routes live
  under `/api/tour`, `stems` under `/api/stems`, and so on (`loader.py:41`).
- A module may override that by setting `api_prefix` in its own `module.json`
  (`loader.py:23`, `:41`).
- Routes declared inside a module's router are therefore written **relative** to
  the prefix: `@router.get("/status")` in `backend/modules/tour/router.py` is
  served at `GET /api/tour/status`.

## Enabling and disabling modules

Each module ships a `module.json`. A module whose config marks it disabled is
skipped at load time and none of its routes exist until it is re-enabled and the
backend restarts (`loader.py:29`, `:36`). Toggling is done through the modules
admin route referenced there (`PATCH /api/modules/{name}/enabled`).

This is why a route can 404 on one machine and work on another: the module is
off in Settings. It is not a missing endpoint.

## The shared tool contract

Modules in the effect/tool families are built with `build_router(family, tools)`
from `backend/core/module_base.py:45`, which gives every such module the same
three routes:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/tools` | List the tools this module exposes (`module_base.py:49`) |
| `GET` | `/tools/{tool_id}` | One tool's spec/parameters (`module_base.py:57`) |
| `POST` | `/process` | Run a tool over audio (`module_base.py:64`) |

So `GET /api/effects/tools` and `GET /api/mastering/tools` behave identically —
learn the contract once and it applies across the DSP modules.

## Long-running work: jobs

Work that outlives a request (training, separation, batch renders) uses the job
registry in `backend/core/jobs.py` rather than blocking the HTTP call: the submit
route returns a job id, and the client polls a jobs route for
`{status, progress, message, result}` until it completes. Individual module pages
note where this applies.

## Keys never reach the browser

Modules that call a third-party service (Suno, the LLM providers, the TOUR map and
routing providers, OpenChargeMap) resolve their key **server-side**, environment
first and then an in-app key file, and make the outbound call from the backend.
No third-party key is sent to the frontend; endpoints report only
`configured: true/false` booleans. See
[Assistant, LLMs, Suno](../features/13-assistant-llm-suno.md) and
[TOUR](../features/12-tour-planner.md).

## Reading the endpoint tables

Each cluster page lists `method`, the **full** path (prefix included), what it
does, and the source line it was read from. Endpoints were enumerated by reading
the route decorators in each router; treat any per-cluster totals as a count of
what was found at that read, not a guarantee of exhaustiveness.
