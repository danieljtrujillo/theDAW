# Quest Colocation Plan — 2026-06-18

Make the `QuestMIDI.unity` scene (GANTASMO-MIDI Unity project) co-located:
several Meta Quest headsets in the same physical room share one world frame, so
the floating MIDI control surface and the GANTASMO visuals appear locked to the
same real-world spot for everyone, and each performer is visible to the others
as networked presence (head plus two hands) with synced control-surface
interactions.

Companion to the master action plan (section 3). Execution runs through the
Unity MCP bridge once the Editor is open and connected; the goal is the fewest
possible hand-operations for the developer.

---

## Locked decisions

- **Scope:** full multiplayer presence (shared world frame plus visible peers
  plus synced object interaction), not shared-frame-only.
- **Netcode:** Unity Netcode for GameObjects (NGO) over Unity Transport,
  LAN-direct. No cloud relay, no Photon, no external account. Fits the
  same-room case and keeps the stack FOSS.
- **Matchmaking and alignment:** Meta Colocation Discovery via the Local
  Matchmaking building block carries the host IP plus the colocation group UUID
  over Bluetooth/WiFi; group-shared spatial anchors align the shared world
  frame. The Colocation building block owns the alignment math.
- **Content transport stays as-is:** MIDI surface state and visuals keep
  flowing from the theDAW backend through the existing `QuestMidiSender` socket,
  so heavy per-frame state never touches the netcode.
- **Presence visuals for v1:** lightweight networked head plus two hand proxies.
  Full Meta Avatars are deferred (the project runs the OpenXR loader, and Meta
  Avatars historically prefer the Oculus loader; the proxy route avoids a loader
  swap and is cheaper to render).

---

## Verified current state

- **Project:** `d:\Dev\Unity\GANTASMO-MIDI\GANTASMO-MIDI`, scene
  `Assets/Scenes/QuestMIDI.unity`.
- **Rig:** the Meta OVR building-block camera rig (`[BuildingBlock] Camera Rig`
  with the full OVR anchor tree: CenterEyeAnchor, Left/RightHandAnchor, and so
  on). OVRManager drives Quest features.
- **SDK:** `com.meta.xr.sdk.all` 203.0.0 on Horizon OS SDK 203. Colocation
  Discovery, group-shared spatial anchors, and Space Sharing are all present at
  this version, so nothing in the Meta stack needs upgrading.
- **XR loader:** OpenXR (`Assets/XR/Loaders/OpenXRLoader.asset`), Meta XR Core
  SDK running over the OpenXR backend.
- **Render:** URP 17.4.0, XRI 3.5.1, XR Hands, Meta Interaction SDK 203 samples.
- **Netcode:** none installed. `com.unity.multiplayer.center` 1.0.1 is present
  (Unity's helper for adding a netcode), which eases the NGO install.
- **Android manifest** (`Assets/Plugins/Android/AndroidManifest.xml`) already
  grants `com.oculus.permission.USE_ANCHOR_API`, `com.oculus.permission.USE_SCENE`,
  `com.oculus.permission.HAND_TRACKING`, the passthrough feature, and targets
  HorizonOS SDK 203. Missing for colocation: the Colocation Discovery permission
  and an Internet permission for the LAN socket.
- **Existing content to anchor:** the `MidiControlSurface` (built by
  `GantasmoControlSurfaceBuilder`), the GANTASMO Visor (`GantasmoVisor`), and the
  `GANTASMO Passthrough Stitch` object.
- **Convention to mirror:** the repo already ships one-click editor wizards
  (`QuestMidiSetupWizard`, `GantasmoVisorSetup`, `GantasmoControlSurfaceBuilder`).
  The colocation setup will follow the same single-window pattern.

---

## Target architecture

```
Host headset                              Guest headset(s)
------------                              ----------------
Colocation BB: create anchor at origin
  -> OVRSpatialAnchor.ShareAsync(group)
Local Matchmaking BB (Colocation
  Discovery): advertise payload
  = { groupUuid, hostIp, ngoPort }   ->  discover session, read payload
NGO: NetworkManager.StartHost()           Colocation BB: LoadUnboundShared
                                            AnchorsAsync(groupUuid) -> localize
                                          align tracking space to the anchor
                                          NGO: StartClient(hostIp, ngoPort)

Both ends, once aligned + connected:
  - world-space NetworkObjects share one physical frame (BB alignment)
  - each device spawns a presence proxy (head + 2 hands) -> replicated
  - MIDI surface controls = NetworkObjects (NetworkTransform + ownership
    transfer on grab); slider/knob values still emit MIDI to the backend
  - audio/visual content keeps arriving over the existing backend socket
```

The shared spatial anchor establishes a common physical origin. The netcode
replicates only light presence and interaction events. The backend socket keeps
carrying the actual creative payload, exactly as it does today.

---

## Build steps (driven through Unity MCP)

Grouped so the developer-facing surface collapses into a single wizard button at
the end. Ordering matters because several items need a domain reload before the
next can reference new types.

### 1. Packages
- Install `com.unity.netcode.gameobjects` (via `manage_packages add_package`).
- Install `com.unity.transport` if it does not arrive as an NGO dependency.
- Confirm `com.unity.multiplayer.center` stays, since it registers the netcode
  for the Meta multiplayer building blocks.
- Poll `editor_state.isCompiling` and `read_console` for a clean reload before
  step 4.

### 2. Android manifest
Patch `Assets/Plugins/Android/AndroidManifest.xml` to add:
- `com.oculus.permission.USE_COLOCATION_DISCOVERY_API` (required for Colocation
  Discovery and Local Matchmaking).
- `com.oculus.permission.IMPORT_EXPORT_IOT_MAP_DATA` with `required="false"`
  (shared-anchor map data exchange).
- `android.permission.INTERNET` (NGO LAN socket). Equivalent to setting
  `PlayerSettings.Android.forceInternetPermission = true`, the same toggle the
  MIDI wizard already flips.

### 3. OVRManager Quest features
On the OVR rig's OVRManager, set to Supported/Enabled:
- Shared Spatial Anchors.
- Colocation Session Support.
- Anchor Support and Scene Support (already implied by `USE_SCENE`; verify).
- Passthrough (already enabled; verify).

Drive via `manage_components set_property` on the OVRManager, or via
`execute_code` against the OVRProjectConfig so the change persists to the asset.

### 4. Meta colocation building blocks
Add, preferring the programmatic building-block installer through `execute_code`
so no drag is required; fall back to one drag each in
`Meta > Tools > Building Blocks` only if the installer API is unavailable:
- **Colocation** (Use Colocation Session = ON; Share Space To Guests optional,
  enables Space Sharing so guests inherit the host room mesh for occlusion).
- **Local Matchmaking** (Colocation Discovery transport for host IP exchange).
- **Networked Grabbable Object** (template for the synced surface controls).
- **Player Name Tag** (optional, shows each performer's headset name).

These blocks generate the `ColocationDriverNetObj` and the NGO `NetworkManager`
wiring. They depend on the netcode from step 1, which is why packages come first.

### 5. Presence and content adaptation (custom scripts via `create_script`)
- `ColocationBootstrap`: single entry point that starts host or guest, owns the
  Colocation building block handshake, surfaces state (advertising, discovering,
  localizing, aligned, connected) for the in-VR HUD, and exposes a manual
  re-align action.
- `NetworkedPresence`: a small NetworkObject prefab carrying head plus two hand
  transforms. The local device writes its CenterEyeAnchor and hand-anchor poses;
  NetworkTransform replicates to peers. Reuses a single shared material per the
  XR-efficiency rule (no per-instance material spawning).
- `ColocationRoot`: an empty transform that parents the MIDI surface, the Visor,
  and the Passthrough Stitch. Keeps shared content under one node so alignment
  and any future re-origin is a single reparent.
- Adapt `MidiControlSurface` controls to NetworkObjects: add NetworkObject plus
  NetworkTransform, transfer ownership on hand-grab, and keep the existing
  `QuestMidiSender` MIDI emission so the DAW still receives control changes from
  whoever holds the control. The grab interactable already exists on sliders and
  knobs (the MIDI wizard's Repair step guarantees it).

### 6. In-VR trigger
Add a "Start / Join colocated set" affordance to the existing in-VR menu (the
microgesture or surface-button path already in the scene), wired to
`ColocationBootstrap`. No headset menu-diving to begin a session.

### 7. One-click `ColocationSetupWizard` (the minimal-steps payoff)
An `EditorWindow` mirroring `QuestMidiSetupWizard` that performs steps 1 to 6 in
order with status rows, plus:
- A readiness panel that checks the netcode package, the manifest permissions,
  the OVRManager features, the building blocks, and the LAN reachability.
- A "Wire colocation into this scene" button that creates `ColocationRoot`,
  reparents the content, drops the bootstrap and presence prefabs, and validates.
- A "Save scene" reminder so the wiring persists into the build (the master plan
  already flags unsaved scene state as a recurring trap).

---

## Manual steps that remain (Meta platform constraints, not automatable)

These exist because Meta gates spatial-data sharing on explicit user and account
consent. They are one-time and minimal.

1. **Enhanced Spatial Services** must be enabled once per headset
   (`Settings > Privacy and Safety > Device Permissions`). Required for shared
   spatial anchors.
2. **A verified Meta developer account or test users**, since group-anchor
   sharing requires a verified developer team member, a test user, or an invite
   to a non-production release channel. Sideloaded developer builds from a
   verified account satisfy this.
3. **Two or more headsets on the same WiFi**, for the LAN-direct NGO transport.
4. **First build deployed to each headset** through the wizard's build path.
   After that, Build and Run iterates.

Everything else (packages, manifest, OVRManager features, building blocks,
scripts, scene wiring, validation) runs through MCP with no manual clicks.

---

## Phasing and per-phase verification

Per the project rule that visual and on-device behavior is confirmed by the
developer's own eyes on real hardware, each phase ends with a live two-headset
test, never a headless or compile-only sign-off.

- **C1 — Shared frame.** Packages, manifest, OVRManager features, Colocation and
  Local Matchmaking blocks, `ColocationRoot` reparent. Verify: two headsets,
  host then guest, both see the MIDI surface and visuals in the same physical
  spot, alignment drift stays small, frame rate holds at or above 24 fps (the
  target from the stitch work).
- **C2 — Presence.** NGO host/client over LAN, `NetworkedPresence` proxy. Verify:
  each headset sees the other's head and hands move in real time, correctly
  placed in the shared frame.
- **C3 — Interaction sync.** Surface controls as NetworkObjects with ownership
  transfer; optional Player Name Tag. Verify: a slider moved on one headset
  moves on the other and the DAW receives the MIDI from the holder.
- **C4 — Optional upgrades.** Full Meta Avatars (requires resolving the
  OpenXR-vs-Oculus-loader question at SDK 203), voice talkback (would reintroduce
  Photon, since Photon Voice is Photon-only), and Space Sharing for a shared
  occlusion mesh.

---

## Open risks and unknowns

- **Building-block installer via MCP.** Whether the Meta building blocks can be
  added purely programmatically through `execute_code` is unconfirmed; if not,
  each block is one drag in the Building Blocks window. Will confirm against the
  live Editor before promising zero drags.
- **NGO ownership against the OVR rig.** The local OVR rig is not a NetworkObject;
  only the presence proxy and surface controls are. Ownership transfer on grab
  needs testing so the holder drives the synced transform without fighting the
  building block alignment.
- **Anchor localize time.** Guests may wait several seconds to download and
  localize the shared anchor; the in-VR HUD must show that state rather than
  appear frozen.
- **Avatars on OpenXR.** Deferred precisely because of this; revisit only if
  richer presence than head-plus-hands is wanted.
- **Coexistence with the stitch and questcast features.** Colocation reparents
  content under `ColocationRoot`; confirm the `GantasmoStream` layer and the
  passthrough stitch still composite correctly after the reparent.

---

## Immediate next action

Open the GANTASMO-MIDI project in Unity with the MCP bridge connected (it
reported zero instances during planning). With the Editor live, execute steps 1
to 7 in order, pausing for a clean recompile between the package install and the
building-block additions, then run the C1 two-headset verification.
