# Architecture

theDAW is a React frontend over a FastAPI backend that wraps the Stable Audio 3 pipeline, a plugin module system, and a set of spawned sidecars and companion apps. The frontend on port 5173 proxies `/api/*` to the backend on port 8600.

## System map

```mermaid
flowchart LR
  subgraph Client["Browser or Electron desktop"]
    UI["theDAW UI, React 19 and Vite 7<br/>MAKE, EDIT, MIX, DJ, VJ, TRAIN, LEARN"]
  end
  subgraph Server["FastAPI backend on port 8600"]
    API["Job queue, FFmpeg, model introspection"]
    SA3["Stable Audio 3<br/>DiT plus SAME autoencoder"]
    MODS["Plugin modules<br/>chimera, stems, notation, vj, suno, magenta, xr, ..."]
  end
  subgraph Sidecars["Spawned sidecars and companions"]
    MRT2["magenta-rt2-nvidia<br/>WSL2 plus JAX"]
    VJ["VJ-9000<br/>WebGL visual engine"]
    XR["theDAW-XR<br/>Meta Quest 3"]
  end
  UI -->|"/api/*"| API
  API --> SA3
  API --> MODS
  MODS -. spawn .-> MRT2
  MODS -. iframe .-> VJ
  XR <-->|"ADB, MIDI, video"| MODS
```

## Generation pipeline

Several inputs condition one generation. A DiT diffusion transformer renders SAME latents, the SAME autoencoder decodes them to audio, every render saves to the library, and LEARN draws the lineage between pieces.

```mermaid
flowchart LR
  P["Text prompt"] --> GEN
  INIT["Init audio<br/>voice, file, library, pattern"] --> GEN
  MASK["Painted inpaint region"] --> GEN
  CHI["Chimera fusion<br/>blend and beat-align clips"] --> GEN
  GEN["DiT diffusion transformer"] --> LAT["SAME latents"]
  LAT --> DEC["SAME autoencoder decode"]
  DEC --> WAV["44.1 kHz stereo audio"]
  WAV --> LIB["Library, auto-saved"]
  LIB --> LRN["LEARN lineage graph"]
```

## Live rig signal flow

Player audio, a microphone, MIDI, and the SLIDE surface drive the VJ engine and the DJ console, and theDAW-XR feeds hand-tracked MIDI and passthrough video into the same buses.

```mermaid
flowchart LR
  DJ["DJ console<br/>2 decks, FX, live stems"] --> AUD
  AUD["Master player audio levels, ~30 fps"] --> VJ
  MIC["Microphone"] --> VJ
  MIDI["MIDI controller<br/>~110 profiles, learn-by-capture"] --> VJ
  MIDI --> DJ
  SLIDE["SLIDE control surface"] <-->|two-way sync| VJ
  XR["theDAW-XR<br/>hand-tracked MIDI, passthrough"] --> MIDI
  XR -->|passthrough video| VJ
  VJ["VJ-9000<br/>sources, GPU effects, shaders"] --> OUT["Live output, second screen"]
  VJ -->|WebRTC watch-link| WEB["Remote viewers"]
```

## Two-stage model

The Stable Audio 3 pipeline runs in two stages. The DiT generates compressed SAME latents from the conditioning, and the same autoencoder decodes those latents to 44.1 kHz stereo audio. Duration is set directly, so a request produces exactly the requested length with no wasted padding. See [Models](Models) and the [model overview](https://github.com/gantasmo/theDAW/blob/main/docs/guides/model-overview.md).

## Where to go next

- [Modules and Sidecars](Modules-and-Sidecars) lists the plugin modules and the spawned processes.
- [User Guide §2 Architecture](https://github.com/gantasmo/theDAW/blob/main/docs/USER_GUIDE.md#2-architecture) has the full technical description.
