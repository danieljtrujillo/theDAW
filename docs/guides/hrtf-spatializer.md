# HRTF Spatializer — Complete Reference

The HRTF Spatializer is a rack insert effect on the EDIT timeline. It positions a
track in 3D around the listener's head (azimuth / elevation / distance) and can add
audio-rate motion — orbits, ping-pong, figure-8, plus two "smart" modes (Teleport,
Autopilot) that are driven by analysis of the audio itself.

Effect id `spatializer`, group `Spatial`, factory `makeSpatializer`.

## Where it lives

| Concern | File |
|---|---|
| **UI editor** (pad, motion select, presets, sliders) | `frontend/src/components/audio/SpatializerPad.tsx` |
| **Audio engine** (factory, DSP graph, motion, autopilot) | `frontend/src/lib/rackEffects.ts` (section 5, lines 285–720) |
| **Effect registration** (declared params) | `frontend/src/lib/rackEffects.ts:1113–1127` |
| **Card host** (decides pad vs. generic sliders) | `frontend/src/components/audio/FxRack.tsx:139–145` |
| **Teleport scheduler** (data-driven motion) | `frontend/src/state/liveMixer.ts:364–411` |

---

## 1. The parameters (the data contract)

These six numeric params are the *entire* state of the effect. They live on
`ChainEntry.params` and are read identically by the live engine and the offline
bounce.

`rackEffects.ts:1118–1125`:

```ts
params: [
  { key: 'azimuth',    label: 'Azimuth',   min: -180, max: 180, step: 1,    default: 0,   unit: 'deg' },
  { key: 'elevation',  label: 'Elevation', min: -90,  max: 90,  step: 1,    default: 0,   unit: 'deg' },
  { key: 'distance',   label: 'Distance',  min: 0.5,  max: 10,  step: 0.1,  default: 1.5 },
  { key: 'motion',     label: 'Motion',    min: 0,    max: 11,  step: 1,    default: 0 },
  { key: 'motionRate', label: 'Rate',      min: 0,    max: 4,   step: 0.01, default: 0.3, unit: 'Hz' },
  { key: 'motionDepth',label: 'Depth',     min: 0,    max: 8,   step: 0.1,  default: 1.5 },
],
```

| Param | Range | Meaning | UI element |
|---|---|---|---|
| `azimuth` | −180…180° | Horizontal angle. 0 = front, +90 = right, ±180 = behind | **Pad drag** + **slider** |
| `elevation` | −90…90° | Vertical angle. + = above, − = below | **slider only** |
| `distance` | 0.5…10 | Metres from listener (drives level rolloff) | **Pad drag** + **slider** |
| `motion` | 0…11 | Motion-mode index (see §4) | **`<select>` dropdown** |
| `motionRate` | 0…4 Hz | LFO speed of the motion | **slider** ("Rate") |
| `motionDepth` | 0…8 | LFO amplitude / orbit radius (also `spread` for Teleport) | **slider** ("Depth") |

> Note: the **pad only writes `azimuth` + `distance`** (it's a top-down XZ view).
> `elevation` is reachable only via its slider or a preset.

---

## 2. UI wiring — what each control is bound to

### a) The XY pad → azimuth + distance

An SVG `role="application"` surface. Pointer drag maps pixel → polar → params.
`SpatializerPad.tsx:55–67`:

```ts
const fromPointer = (clientX, clientY) => {
  // map client px into the 140×140 viewport, then to normalized -1..1
  const nx = (px - C) / R;
  const nz = -(py - C) / R;                 // up = front = +z
  const dist = clamp(Math.hypot(nx, nz) * MAX_DIST, min, MAX_DIST);
  const az = (Math.atan2(nx, nz) * 180) / Math.PI;   // 0 = front, +90 = right
  onChange({ ...params, azimuth: Math.round(az), distance: +dist.toFixed(2) });
};
```

The pad also **draws** the current source dot, the listener at center, distance
rings, and a live preview of the chosen motion path (`renderMotionPath()`,
`SpatializerPad.tsx:85–192` — a different glyph per motion mode).

### b) Motion mode → `<select>` dropdown

`SpatializerPad.tsx:231–242`, options come straight from `SPATIAL_MOTIONS`:

```tsx
<select id={motionId} value={motion}
        onChange={(e) => set('motion', Number(e.target.value))}>
  {SPATIAL_MOTIONS.map((label, i) => <option key={label} value={i}>{label}</option>)}
</select>
```

### c) Presets → button grid

`SpatializerPad.tsx:244–253`. Each button **merges** a partial param set onto
current params:

```tsx
{SPATIAL_PRESETS.map((preset) => (
  <button onClick={() => merge(preset.values)} title={`Apply the ${preset.label} motion preset`}>
    {preset.label}
  </button>
))}
```

### d) Five precise sliders → `SlideTrack`

`SpatializerPad.tsx:259–286`. Accessible labelled `SlideTrack` controls for
`azimuth`, `elevation`, `distance`, `motionRate`, `motionDepth`. Each calls
`set(key, v)`:

```tsx
<SlideTrack value={p.value} min={p.min} max={p.max} step={p.step}
            ariaLabelledBy={labelId} onChange={(v) => set(p.key, v)} />
```

`set` / `merge` (`SpatializerPad.tsx:49–50`) are the only two write paths — both
call the `onChange` prop, which `FxRack` binds to the store update:

```tsx
// FxRack.tsx:141-145
<SpatializerPad params={shown} idPrefix={...} onChange={(p) => onUpdateParams(entry.id, p)} />
```

`shown` (`FxRack.tsx:93`) overlays sampled automation values during playback, so
the pad follows FX-param lanes while playing, but edits still write the stored
params.

---

## 3. The audio engine — signal graph

`makeSpatializer` (`rackEffects.ts:392–409`):

```ts
const panner = ctx.createPanner();
panner.panningModel  = 'HRTF';
panner.distanceModel = 'inverse';
panner.refDistance   = 1.2;   // hold full level a touch farther out
panner.rolloffFactor = 0.5;   // gentler level falloff vs default 1
input.connect(panner).connect(output);

const pos = azElToXYZ(params.azimuth, params.elevation, params.distance);
panner.positionX.value = pos.x;
panner.positionY.value = pos.y;
panner.positionZ.value = pos.z;
```

**Spherical → Cartesian** (`rackEffects.ts:333–341`) — note front of the listener
is **−z**:

```ts
export const azElToXYZ = (azDeg, elDeg, dist) => {
  const az = azDeg*Math.PI/180, el = elDeg*Math.PI/180;
  return {
    x:  dist*Math.cos(el)*Math.sin(az),
    y:  dist*Math.sin(el),
    z: -dist*Math.cos(el)*Math.cos(az),
  };
};
```

**Motion is added by 3 oscillators**, one per axis, summed into the panner's
position params via per-axis depth gains (`rackEffects.ts:415–427`):

```ts
const cosWave = ctx.createPeriodicWave(new Float32Array([0,1]), new Float32Array([0,0]));
const lfoX = ctx.createOscillator(); // + lfoY, lfoZ (sine by default)
lfoX.connect(depthX).connect(panner.positionX);
lfoY.connect(depthY).connect(panner.positionY);
lfoZ.connect(depthZ).connect(panner.positionZ);
```

Because motion comes from oscillators (not a JS timer), it renders **identically in
live preview and offline bounce**. An axis can be switched to a **cosine** wave —
pairing a sine axis with a cosine axis at the same rate traces a circle, which is
how any orbit plane is produced.

---

## 4. Motion modes (`motion` = 0…11)

Labels (`rackEffects.ts:293–306`):

```ts
export const SPATIAL_MOTIONS = [
  'Static','Orbit H CW','Orbit H CCW','Orbit Frontal','Orbit Sagittal',
  'Spherical','Ping-Pong','Up / Down','Figure-8','Expand / Collapse',
  'Teleport','Autopilot',
] as const;
```

`motionConfig` (`rackEffects.ts:365–390`) turns the mode into per-axis (frequency,
depth, cosine-flag):

| # | Mode | Axes driven | How |
|---|---|---|---|
| 0 | Static | none | base position only |
| 1 | Orbit H CW | X sine + Z cos | horizontal circle (XZ) |
| 2 | Orbit H CCW | X sine + Z cos (−) | reversed spin |
| 3 | Orbit Frontal | X sine + Y cos | vertical wheel facing you (XY) |
| 4 | Orbit Sagittal | Z sine + Y cos | over-the-top circle (YZ) |
| 5 | Spherical | X+Z orbit + slow Y | orbit with vertical precession (`fy = rate*0.6`) |
| 6 | Ping-Pong | X only | side-to-side |
| 7 | Up / Down | Y only | elevation bob |
| 8 | Figure-8 | X sine + Z sine @2× | lemniscate |
| 9 | Expand / Collapse | X+Y+Z in phase | radial breathing along source vector |
| 10 | **Teleport** | none (LFO depth 0) | position driven by schedule → §5 |
| 11 | **Autopilot** | none statically | rAF "brain" drives position → §6 |

Example — the orbit / spherical / figure-8 / breathing configs
(`rackEffects.ts:372–388`):

```ts
case 1: dx = depth; dz = depth; zCos = true; break;   // orbit horizontal CW (XZ)
case 5: dx = depth; dz = depth; zCos = true;          // spherical
        dy = depth*0.7; fy = rate*0.6; break;
case 8: dx = depth; dz = depth; fz = rate*2; break;   // figure-8 (Z at 2×)
case 9: { const u = azElToXYZ(p.azimuth, p.elevation, 1);   // breathe along source dir
          dx = depth*u.x; dy = depth*u.y; dz = depth*u.z; break; }
```

Presets that one-click these (`rackEffects.ts:318–331`), e.g.:

```ts
{ label: 'Spherical',       values: { motion: 5, motionRate: 0.3,  motionDepth: 2.5 } },
{ label: 'Expand/Collapse', values: { motion: 9, motionRate: 0.25, motionDepth: 3, distance: 2.5 } },
{ label: 'Teleport',        values: { motion: 10, motionDepth: 5 } },
```

---

## 5. Teleport (mode 10) — data-driven jumps

Position isn't an LFO; it's a **transport-synced schedule** computed from onset
analysis. The mapping (`rackEffects.ts:347–358`):

```ts
export function teleportXYZ(index, loudness, brightness, spread) {
  const reach = clamp(spread,0,8)/8;
  const az = (((index*137.508)%360)-180)*reach;       // golden-angle scatter
  const el = (-25 + clamp(brightness,0,1)*70)*reach;  // brighter -> higher
  const dist = clamp(3.0 - clamp(loudness,0,1)*1.6, 1.2, 6); // louder -> closer
  return azElToXYZ(az, el, dist);
}
```

`liveMixer.scheduleTeleports` (`liveMixer.ts:364–411`) walks each clip's analyzed
chunks, builds `{when,x,y,z}` events, and calls the instance's `scheduleTeleport`,
which lays down hard `setValueAtTime` jumps (`rackEffects.ts:698–713`).
`motionDepth` doubles as **spread** here. The golden-angle index advances across
passed chunks too, so a mid-timeline start lands the same positions a from-zero
play would.

---

## 6. Autopilot (mode 11) — the "spatial choreographer"

Live-only. An `AnalyserNode` taps the signal and a `requestAnimationFrame` loop
(`autopilotTick`, `rackEffects.ts:523–658`) extracts MIR features and **plays the
source with the music**:

- **Onset + beat clock** — adaptive spectral-flux onset detection with refractory
  gate, IOI-based tempo estimate, beat confidence (`rackEffects.ts:569–590`).
- **Mood weights** — soft groove / intense / calm / ethereal scoring with
  asymmetric slew, commit fast and linger slow (`rackEffects.ts:592–603`).
- **Drop detection** — bass-flux + crest + energy-jump latch snaps the source in
  then blooms out (`rackEffects.ts:605–611`).
- **Motion** — beat-quantized azimuth orbit + slow elevation (brightness) &
  distance (bass) followers, angular-velocity capped to avoid seasickness
  (`rackEffects.ts:614–637`), plus a mood-weighted LFO texture layer and
  onset-fired accents (`rackEffects.ts:639–655`).

Offline can't run rAF, so the bounce **falls back to a bake-correct Spherical**
(`rackEffects.ts:404, 672–674, 689`):

```ts
const isOffline = 'startRendering' in ctx;
...
if (motion0 === SPATIAL_AUTOPILOT) {
  if (isOffline) applyMotion(motionConfig({ ...params, motion: 5, motionRate: 0.3, motionDepth: 2.5 }));
  else { applyMotion(motionConfig({ motion: 0 })); startAutopilot(); }
}
```

---

## 7. The instance interface (live control surface)

Every rack effect returns this (`rackEffects.ts:30–42`); the spatializer implements
all of it, including the optional `scheduleTeleport`:

```ts
interface RackEffectInstance {
  input: AudioNode;
  output: AudioNode;
  setParams: (p) => void;              // live param moves, no rebuild
  scheduleTeleport?: (events) => void; // spatializer-only
  dispose: () => void;                 // stop LFOs + autopilot, disconnect
}
```

`setParams` (`rackEffects.ts:685–697`) is what slider/pad edits ultimately hit: it
routes to autopilot start, leaves Teleport's scheduled position alone, otherwise
re-applies static position + motion config with click-free ramps (`ramp` →
`setTargetAtTime`, `rackEffects.ts:73–76`). `dispose` (`rackEffects.ts:714–718`)
stops the LFOs, cancels the autopilot rAF, and disconnects the analyser.

---

## Mental model (one paragraph)

The pad/sliders write 6 numbers onto `ChainEntry.params`. `makeSpatializer` turns
`azimuth/elevation/distance` into a 3D `PannerNode` position (HRTF), and
`motion/rate/depth` into three position-modulating oscillators. Modes 1–9 are pure
LFO geometry; mode 10 (Teleport) hands position to a beat-aligned schedule from
onset analysis; mode 11 (Autopilot) hands it to a live MIR brain. Same factory,
same graph, runs live and at bounce — the only divergence is Autopilot, which bakes
as Spherical offline.
