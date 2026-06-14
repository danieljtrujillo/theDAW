# VJ Watch-Link / Live Broadcast Plan

**Date:** 2026-06-14
**Why:** AWE next week. Ship a shareable link that plays the **live VJ output with audio**, on the **venue LAN** (low-latency, high quality) and **publicly** (user has domains + hosting). Audio must be flexible: the VJ and DJ are often the same person, so the DJ mix (SA3 player) should stream through with the visuals, but VJ-side audio (loaded clip / mic) must also work.

## Source vision (user, verbatim, 2026-06-14)
> often, the VJ and DJ could be the same person and the DJ audio SHOULD be streaming through the VJ and sound essentially the same… If the DJ mixes could be playing through the VJ / 'sent to VJ' why can't we just use that audio? Maybe default to the DJ if there's something playing through them, if not default to whatever VJ plays. Either way, allow both, and options to choose between them, and also override the other.
>
> everyone needs to view it. I have domains and hosting… Venue quality through LAN is a must, but so is the streaming externally.

## The core architectural fact
- **VJ output VIDEO** is rendered in the VJ app **iframe** (`localhost:5187`) — a `<canvas>` we can `captureStream()`.
- **DJ/SA3 AUDIO** is in the **host** page (`localhost:5173`) — the player's `AudioContext`. The VJ app today only receives audio *levels* over the postMessage bridge, not the signal.
- These are **different origins**, so to put DJ audio + VJ video in ONE outgoing stream, the audio has to physically reach the same context as the video.

**Decision:** marry them in the **VJ app** (it already owns the video canvas + has its own clip/mic audio). Get the DJ audio INTO the VJ app via a tiny **host→iframe WebRTC audio hop** (localhost ICE, postMessage signaling). Then the VJ app holds: `djAudioTrack` (from host) + `vjAudioTrack` (clip/mic) + `videoTrack` (canvas) and chooses/mixes per the rules below.

## Audio selection rules (the user's logic)
- Sources: `dj` (SA3 player, arrives via the host→iframe hop) and `vj` (the VJ app's existing clip/mic audio).
- Default: **DJ if it's currently producing audio**, else **VJ**. (Detect via an AnalyserNode RMS gate on the dj track.)
- Manual override: user can force `dj`, `vj`, or `mix` (both summed via a small WebAudio graph), from the VJ controls.
- The chosen result is a single `MediaStreamTrack` (audio) added to every viewer peer.

## Transport
- **Signaling:** new backend module `backend/modules/broadcast/` — a WebSocket signaling relay with rooms (`/api/broadcast/ws?room=...`), plus `GET /api/broadcast/link` returning the LAN + public URLs and a room id. No media touches the backend for LAN (pure peer-to-peer); keeps venue quality + low latency.
- **LAN:** viewer ↔ VJ app direct WebRTC, host candidates only → 1-hop, full quality. Viewer page served by the backend at `/watch/<room>` (a tiny self-contained HTML/JS player, no SA3 bundle).
- **Public:** same signaling but add **STUN + TURN** (user-hosted coturn or a provider) so peers traverse NAT; the public viewer URL is `https://<user-domain>/watch/<room>` reverse-proxied to the backend signaling + the TURN. If many concurrent public viewers, a later phase swaps peer-per-viewer for an **SFU** (mediasoup / LiveKit) — defer until needed.

## Phases
- **Phase 1 (LAN, VJ-side audio) — START HERE, de-risks the whole pipe.**
  - Backend `broadcast` module: WS signaling rooms + `/api/broadcast/link` + a static `/watch/<room>` viewer page.
  - VJ app `useBroadcast.ts`: on "Go Live", `captureStream` the output canvas + attach the VJ-side audio track, create a peer per joining viewer, answer offers via the signaling WS.
  - VJControls: a **GO LIVE** toggle + the generated LAN link (copy button) + live viewer count.
  - Validate: a phone on the LAN opens the link, sees the visuals + hears the VJ clip/mic audio.
- **Phase 2 (DJ audio into VJ).**
  - Host: capture the SA3 player audio (`MediaStreamAudioDestinationNode` on the player AudioContext) → host→iframe RTCPeerConnection (postMessage signaling) → VJ app receives `djAudioTrack`.
  - VJ app: audio-source selector (`dj`/`vj`/`mix`) with the smart default + override; feed the chosen track into the broadcast.
  - "Send DJ audio to VJ" surfaces in the host UI too (doubles as VJ monitoring of the DJ feed).
- **Phase 3 (public).**
  - Add STUN/TURN config (env-driven: `theDAW_TURN_URL/USER/PASS`), public link from `/api/broadcast/link`, docs for the reverse proxy on the user's domain.
  - Load-test concurrent viewers; if peer-per-viewer is too heavy, introduce an SFU (separate task).

## Constraints / guardrails
- VJ app is a SEPARATE repo working tree (`D:/StableAudio/GANTASMO-LIVE-VJ`) — its commits are separate.
- Don't regress the now-working Quest/Cymatics sources or the layout. The broadcast reuses the SAME output canvas captureStream pattern already proven.
- A11y on any new form controls; Tailwind v4 canonical classes in SA3 frontend (VJ app matches its own conventions).
- Visual/▶ live verification with the user's eyes+ears before any PR; no PR before live test.
