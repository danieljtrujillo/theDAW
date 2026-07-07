# theDAW companion control contract (v1)

The single wire contract shared by the web-mobile client (Phase 3) and the
Flutter companion (Phase 4). Both are LAN clients of the desktop app running on
the GPU host. The desktop browser is the audio/visual host; companions are thin
remote surfaces plus a standalone REST reader.

This document is the source of truth. Change it here first, bump the version,
then update every client.

## Topology

```
 phone / Flutter (controller peer)          theDAW-XR headset (controller peer)
              |                                          |
              +----------------+       +-----------------+
                               v       v
                    backend relay  /api/xr/control/ws
                               ^
                               |
                    desktop browser (HOST peer)
                    owns the control manifest + wired setters
```

- The relay (`backend/modules/xrcontrol/router.py`) forwards JSON frames between
  peers. It holds only the session pairing posture and the set of authenticated
  peers; it does not understand control semantics.
- The desktop browser is the HOST: it aggregates `XrControlSource`s into one
  manifest and applies inbound `control-set` frames. A control surfaces on any
  companion the moment its source contributes a manifest entry, with no
  companion-side code.
- Companions (phone, Flutter, headset) are CONTROLLER peers: they request the
  manifest, render widgets from it, and send `control-set`.

## Two companion roles

1. **Standalone REST reader** (works with no desktop browser open): Library
   browse and playback, MAKE generate. Talks the REST surface below directly and
   plays audio on the companion's own player. Not gated by pairing.
2. **Remote surface** (requires the desktop app open as host): transport remote,
   DJ remote, VJ remote. Sends control frames over the WebSocket bus. Gated by
   the pairing posture.

## REST surface (standalone reader)

Origin-relative from the LAN address the companion loaded from, so the shared
`lib/backendBase.ts` helpers resolve it with no companion-specific config.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/library/entries` | List library entries. |
| GET | `/api/library/audio/{id}` | Stream one entry's audio. |
| GET | `/api/library/media/{id}` | Stream non-audio media. |
| POST | `/api/generate-jobs` | Submit a MAKE job. |
| GET | `/api/jobs/{id}` | Poll a job to completion. |
| POST | `/api/magenta/generate` | Magenta generation path. |
| GET | `/api/vj/lan-ip` | This host's LAN IPv4 (for QR building). |
| GET | `/api/xr/control/status` | `{clients}` peer count. Drives the "desktop host offline" state on remote tabs. |

## WebSocket bus (`/api/xr/control/ws`)

All frames are JSON objects with a `type` field.

### Pairing handshake (relay-handled, not forwarded)

The relay intercepts these; they never reach other peers.

Host to relay, on connect and whenever posture changes:
```json
{ "type": "host-hello", "posture": { "mode": "open" | "code", "code": "1234" | null } }
```
Relay replies:
```json
{ "type": "host-ack", "posture": {...}, "peers": [ { "peerId": 7, "label": "Pixel" } ] }
```

Controller to relay, on connect:
```json
{ "type": "controller-hello", "label": "Pixel 8", "code": "1234" | null }
```
Relay replies with exactly one of:
```json
{ "type": "pair-ok", "peerId": 7 }
{ "type": "pair-rejected", "reason": "code" }
```

Relay to host, as peers come and go:
```json
{ "type": "peer-joined", "peerId": 7, "label": "Pixel 8" }
{ "type": "peer-left", "peerId": 7 }
```

Host to relay, to revoke a controller:
```json
{ "type": "kick", "peerId": 7 }
```

### Pairing posture semantics

- Default posture is `open` (preserves the pre-v1 relay behavior). A peer that
  never sends a hello is a legacy peer and is authenticated under the current
  posture at connect time (so the existing theDAW-XR headset keeps working while
  posture is `open`).
- In `open` mode any controller is authenticated immediately.
- In `code` mode a controller is authenticated only if its `code` matches the
  host's posture code. The host sets the posture BEFORE handing out the QR; the
  QR carries `?pair=<code>` so scanning auto-fills it.
- The REST surface is never gated. Only the control bus is. A companion can
  browse Library without pairing; transport/DJ/VJ remotes require it.
- Only authenticated peers exchange control frames. Frames from an
  unauthenticated peer are dropped.
- The host role is privileged (it sets the posture). The relay accepts
  `host-hello` only from a localhost origin, and never lets a second peer seize
  an established host. In the shipped topology the desktop browser is
  co-located with the backend, so it is localhost; a LAN companion cannot claim
  the host role and reset the posture to open. A remote-host deployment (a
  container served to a browser on another machine) opts in with the
  `THEDAW_XR_ALLOW_REMOTE_HOST=1` environment variable.

### Control frames (relayed between authenticated peers)

Host to controllers:
```json
{ "type": "manifest", "version": 12, "entries": [ XrManifestEntry, ... ] }
{ "type": "control-changed", "id": "transport.playpause", "value": true }
```

Controller to host:
```json
{ "type": "request-controls" }
{ "type": "control-set", "id": "transport.seek", "value": 0.42 }
{ "type": "pad", "id": "...", ... }
{ "type": "jog", "id": "...", ... }
{ "type": "trigger", "id": "...", ... }
```

`XrManifestEntry` (from `frontend/src/state/xrControlClient.ts`):
```ts
{ id, area, group, label, kind, min?, max?, step?, options?, unit?, value?, readonly? }
// kind in: knob | fader | button | toggle | crossfader | select | xy | xyz | jog | grid
```

Id namespacing: `"<area>.<name>[.<suffix>]"`. The leading segment is the source
area (`transport`, `dj`, `make`, `vj`, ...). The host routes an inbound
`control-set` to the source that owns that area.

### Value types

- `button`: any truthy `value` triggers the action.
- `toggle`: boolean.
- `knob` / `fader` / `crossfader`: number within `[min, max]` (transport uses
  `0..1` fractions).
- `select`: one of `options`.

## URL / serving

- Dev: the companion loads at `http://<lan-ip>:5173/mobile.html`; Vite proxies
  `/api` to `:8600`.
- Packaged (Electron/Docker): the backend serves `frontend/dist` at `/` when it
  exists, so `http://<lan-ip>:8600/mobile.html` (and its root-relative
  `/assets/*`) resolve. `GET /m` redirects to `/mobile.html` as a short,
  phone-typeable alias.
- WebSocket URL is derived from `window.location` when served over http from the
  LAN, and falls back to `ws://localhost:8600` only for the `app://` desktop
  renderer.

## Areas defined in v1

| Area | Source file | Role |
|---|---|---|
| `transport` | `frontend/src/state/transportControlSource.ts` | play/pause/seek/volume/loop/stop of the desktop footer player. Shared with Phase 7 B1. |
| `dj` | `frontend/src/state/xrControlDjSource.ts` | existing DJ controls (Phase 3 Slice 2 consumes them). |
| `make` | `frontend/src/state/makeControlSource.ts` | existing MAKE params (Phase 3 Slice 3). |

## Versioning

Bump the `manifest.version` on any manifest-shape change and this document's
title version on any frame-protocol change. Clients tolerate unknown `kind`
values by skipping the widget, and unknown frame `type`s by ignoring them.
