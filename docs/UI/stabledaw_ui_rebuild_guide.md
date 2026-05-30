# theDAW AI — UI Rebuild Guide

## Purpose

This document explains how to rebuild the four-panel audio-generation UI mockup as a production-ready interface. It is written so another AI, developer, or designer can reconstruct the system without needing the original image.

The interface is a dark, widescreen, professional audio-generation dashboard with four primary workspace tabs:

1. **Generate** — prompt-to-audio creation.
2. **Init / Modify** — audio-to-audio transformation, continuation, and region inpainting.
3. **Presets / Library** — saved presets, prompt templates, reusable settings, and preset details.
4. **Automation / Advanced** — automation curves, advanced generation settings, device/performance controls, and job queue/history.

The mockup shows all four tabs simultaneously in a 2×2 split-screen overview, but the actual app should normally display one tab at a time. The split mockup is useful as a product design reference because it shows the relationship between all major screens.

---

# 1. Overall Product Model

## Core Concept

The UI should feel like a professional audio tool, not a generic AI chat app. It should borrow visual language from:

- DAWs
- sampler plugins
- AI image-generation dashboards
- node-based creative tools
- GPU/control-panel utilities

The user should always know:

- What mode they are in.
- What audio source they are using.
- What the model will generate or transform.
- Which settings affect the output.
- What is queued, running, completed, or reusable.

## Primary User Workflows

### Workflow A — Generate from text

```text
Open Generate tab
→ Write Prompt
→ Write Negative Prompt if needed
→ Adjust seconds, steps, CFG, sampler, seed
→ Preview estimated runtime / VRAM
→ Click Generate Audio
→ Listen to output
→ Save, send to Init/Modify, or create preset
```

### Workflow B — Modify existing audio

```text
Open Init / Modify tab
→ Upload audio file
→ Choose Continue, Extend, Transform, or Region/Inpaint
→ Adjust strength, noise, preserve timing, crossfade
→ Apply Transform
→ Compare before/after
→ Send result back to Generate or save to Library
```

### Workflow C — Use or manage presets

```text
Open Presets / Library tab
→ Search or filter presets
→ Select preset
→ Review details
→ Preview audio sample if present
→ Load preset into Generate
→ Modify and optionally overwrite or duplicate
```

### Workflow D — Advanced automation

```text
Open Automation / Advanced tab
→ Select automation target, e.g. CFG scale
→ Edit curve over normalized generation timeline
→ Set output format, sample rate, normalization
→ Configure GPU/device/performance options
→ Monitor job queue/history
```

---

# 2. Application Shell

The shell is consistent across all tabs.

## Shell Regions

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ TOP BAR                                                                      │
│ Logo + App Name      Primary Tabs                         Help Settings User │
├───────────────┬──────────────────────────────────────────────────────────────┤
│ LEFT SIDEBAR  │ MAIN WORKSPACE                                               │
│               │                                                              │
│ Navigation    │ Active tab content                                           │
│ Projects      │                                                              │
│ History       │                                                              │
│ Settings      │                                                              │
│ Version/Plan  │                                                              │
└───────────────┴──────────────────────────────────────────────────────────────┘
```

## Top Bar

The top bar should be slim and fixed. It provides identity, tab switching, and global utilities.

### Contents

Left side:

- Vertical waveform logo mark.
- Product name: **theDAW AI**.

Center:

- Tab navigation:
  - Generate
  - Init / Modify
  - Presets / Library
  - Automation / Advanced

Right side:

- Help icon.
- Settings icon.
- User avatar circle.

### Behavior

- Active tab has a purple underline or glow.
- Hovered tab has a subtle background highlight.
- On small screens, top tabs collapse into a segmented dropdown or horizontal scroll area.

## Left Sidebar

The sidebar gives persistent navigation and mode awareness.

### Primary Items

```text
Generate
Init / Modify
Presets / Library
Automation / Advanced

Projects
History
Settings

v1.2.0      Pro
```

### Behavior

- Active item uses purple fill or purple left rail.
- Sidebar should not compete visually with the active workspace.
- It should be collapsible on narrower desktop widths.
- On mobile, it should become a drawer.

## Main Workspace

Each tab uses card-based layouts with consistent gutters, rounded panels, and subtle borders.

Design rule: every major setting group gets a card. Every card has a clear title. Advanced or secondary settings should be collapsible.

---

# 3. Global Visual Design System

## Visual Tone

The UI should feel:

- Dark
- Technical
- Clean
- Slightly futuristic
- Audio-focused
- Production-tool oriented

Avoid making it look like a crypto dashboard, gaming launcher, or generic admin panel.

## Color Tokens

Use semantic tokens rather than hard-coded colors.

```css
--bg-app: #05080d;
--bg-shell: #080d14;
--bg-panel: #0d131c;
--bg-panel-2: #111824;
--bg-panel-hover: #151f2d;
--border-soft: rgba(255,255,255,0.08);
--border-strong: rgba(168,85,247,0.45);
--text-primary: #f4f1ff;
--text-secondary: #b9b3c9;
--text-muted: #787286;
--accent: #8b5cf6;
--accent-bright: #a855f7;
--accent-dim: rgba(139,92,246,0.22);
--success: #35d07f;
--warning: #f8c14a;
--danger: #ff5d73;
--waveform: #8b5cf6;
```

## Typography

Use a modern sans-serif font.

Recommended stack:

```css
font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
```

### Type Scale

```text
App title:        14–16px, 600
Tab labels:       12–13px, 500
Panel title:      13–15px, 600
Control label:    12–13px, 500
Body text:        12–14px, 400
Muted helper:     11–12px, 400
Button text:      13–15px, 600
```

## Spacing

```text
Outer app padding:        16–20px desktop
Panel padding:            16–20px
Small panel padding:      12–14px
Gutter between cards:     12–16px
Control vertical gap:     10–14px
Section vertical gap:     16–20px
```

## Shape

```text
Main panels:       12px radius
Inputs:            8px radius
Buttons:           8–10px radius
Sidebar active:    8px radius
Cards:             10–12px radius
```

## Effects

Use restrained effects.

```css
box-shadow: 0 16px 40px rgba(0,0,0,0.28);
backdrop-filter: blur(12px); /* only if performance allows */
```

Avoid excessive glow. Purple should be used for hierarchy and focus, not everywhere.

---

# 4. Component Inventory

The full app can be built from a reusable set of components.

## Layout Components

```text
AppShell
TopBar
Sidebar
Workspace
PanelCard
SplitCard
SectionHeader
ToolbarRow
StatusFooter
```

## Input Components

```text
TextAreaWithCounter
NumericInput
SliderWithValue
SelectDropdown
ToggleSwitch
CheckboxRow
SegmentedControl
SearchInput
FileDropzone
CurveEditor
RangeSelector
WaveformViewer
```

## Audio Components

```text
WaveformPreview
MiniWaveformThumbnail
AudioTransport
BeforeAfterWaveform
SpectrogramPreview
UploadAudioCard
```

## Action Components

```text
PrimaryButton
SecondaryButton
IconButton
GhostButton
DangerButton
MenuButton
FavoriteButton
LoadPresetButton
```

## Data Display Components

```text
PresetList
PresetDetails
CategoryTree
JobQueueTable
GenerationHistoryList
SettingsSummary
PerformanceMeter
VRAMBar
RuntimeEstimate
```

---

# 5. Four-Panel Overview Diagram

The mockup shows the product as four separate tab states arranged in a 2×2 grid:

```text
┌───────────────────────────────────┬───────────────────────────────────┐
│ 1. GENERATE                       │ 2. INIT / MODIFY                  │
│ Prompt-to-audio workspace         │ Upload + transform workspace      │
│                                   │                                   │
│ Prompt / negative prompt          │ Source audio waveform             │
│ Generation settings               │ Transform modes                   │
│ Output preview                    │ Region/inpaint tools              │
│ Generate button                   │ Before/after comparison           │
├───────────────────────────────────┼───────────────────────────────────┤
│ 3. PRESETS / LIBRARY              │ 4. AUTOMATION / ADVANCED          │
│ Saved presets and templates       │ Curves, device, queue, output     │
│                                   │                                   │
│ Search + categories               │ Automation curve editor           │
│ Preset list                       │ Advanced toggles                  │
│ Preset details                    │ Performance controls              │
│ Load / preview buttons            │ Job queue / history               │
└───────────────────────────────────┴───────────────────────────────────┘
```

This is not the normal app layout. It is a product overview. The normal app shows one tab in the main workspace at a time.

---

# 6. Tab 1 — Generate

## Purpose

The Generate tab is the primary creation surface. It turns a prompt and settings into a new audio output.

## Layout

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Generate Tab                                                                 │
├───────────────────────────────────┬──────────────────────────────────────────┤
│ Prompt Card                       │ Generation Settings Card                 │
│ - Prompt textarea                 │ - Seconds                                │
│ - Negative prompt textarea        │ - Steps                                  │
│ - Enhance buttons                 │ - CFG scale                              │
│                                   │ - Sampler                                │
│                                   │ - Seed                                   │
├───────────────────────────────────┴──────────────────────────────────────────┤
│ Output Preview Card                                                          │
│ - Waveform                                                                   │
│ - Transport controls                                                         │
│ - Download / send / menu actions                                             │
├──────────────────────────────────────────────────────────────────────────────┤
│ Bottom Action Area                                                           │
│ - Generate Audio button                                                      │
│ - Estimated time                                                             │
│ - VRAM estimate                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Generate Tab Card Details

### Prompt Card

The prompt card contains two stacked prompt fields:

1. Prompt
2. Negative Prompt

Each field should include:

- Label
- Helper text
- Large textarea
- Character counter
- Optional **Enhance** action

### Prompt Field Example

```text
Prompt
Describe the audio you want
┌──────────────────────────────────────────────┐
│ Cinematic ambient soundscape, deep           │
│ atmosphere, evolving pads, distant drones,   │
│ subtle movement, wide stereo image.          │
└──────────────────────────────────────────────┘
                         94 / 1000   Enhance
```

### Negative Prompt Field Example

```text
Negative Prompt
Describe what you DON’T want
┌──────────────────────────────────────────────┐
│ Vocals, drums, percussion, harsh noise,      │
│ distortion, clipping, breaks, low quality.   │
└──────────────────────────────────────────────┘
                         60 / 1000   Enhance
```

### Generation Settings Card

This card controls the key generation settings.

Recommended fields:

```text
Seconds Total
Steps
CFG Scale
Sampler
Seed
Advanced toggle / collapsible row
```

### Settings Layout

```text
Generation Settings
┌──────────────────────────────────────────────┐
│ Seconds Total                 60.0 s         │
│ ━━━━━━━━━━━━━━━━━━━━━●━━━━━━                  │
│ Steps                         50             │
│ ━━━━━━━━━━━━━●━━━━━━━━━━━━━                   │
│ CFG Scale                     7.0            │
│ ━━━━━━━━━━━━━━━━━●━━━━━━━━━                   │
│ Sampler                       DPM++ 2M Karras│
│ Seed                          -1      [↻] [🎲]│
└──────────────────────────────────────────────┘
```

### Output Preview Card

The output preview should show the current or most recent generation.

Elements:

- Waveform
- Current time / total time
- Play button
- Loop button
- Previous / next controls if browsing generations
- Download button
- Send to Init / Modify
- More menu

### Output Preview Wireframe

```text
Output Preview
┌──────────────────────────────────────────────────────────────┐
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ waveform ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓   1:00 │
├──────────────────────────────────────────────────────────────┤
│ ● Play   ↻ Loop   ⏮ Prev   ⏭ Next   ↓ Download   ⋯          │
└──────────────────────────────────────────────────────────────┘
```

### Generate Action Area

The primary button should be visually dominant.

```text
┌──────────────────────────────────────────┐
│ ✨ Generate Audio                         │
└──────────────────────────────────────────┘
Est. time: ~35s
VRAM: Medium
```

## Generate Tab Interaction Rules

- Generate button is disabled if prompt is empty.
- Prompt counter turns warning color near max length.
- Seed `-1` means random seed.
- Randomize seed button sets a new integer seed.
- Reset seed returns to `-1`.
- After generation finishes, output preview auto-populates.
- User can send output to Init / Modify.
- User can save all current settings as a preset.

## Generate Tab State Model

```ts
type GenerateState = {
  prompt: string;
  negativePrompt: string;
  secondsTotal: number;
  steps: number;
  cfgScale: number;
  sampler: string;
  seed: number;
  isGenerating: boolean;
  estimatedSeconds?: number;
  estimatedVram?: "Low" | "Medium" | "High";
  latestOutput?: AudioOutput;
};
```

---

# 7. Tab 2 — Init / Modify

## Purpose

The Init / Modify tab lets users transform existing audio instead of generating from scratch.

It covers:

- Audio-to-audio restyling
- Continuation
- Extension
- Region/inpaint replacement
- Before/after comparison

## Layout

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Init / Modify Tab                                                            │
├──────────────────────────────┬───────────────────────────────────────────────┤
│ Upload Audio Card            │ Source Audio Card                             │
│ - Dropzone                   │ - Waveform                                    │
│ - File constraints           │ - Duration                                    │
│                              │ - Play source                                 │
├──────────────────────────────┴───────────────────────────────────────────────┤
│ Transform Mode Card                                                          │
│ - Continue | Extend | Transform                                               │
├──────────────────────────────┬───────────────────────────────────────────────┤
│ Transform Settings Card      │ Region / Inpaint Card                         │
│ - Strength                   │ - Use entire track / select region             │
│ - Noise / Sigma              │ - Start / end                                  │
│ - Preserve timing            │ - Crossfade                                    │
├──────────────────────────────┴───────────────────────────────────────────────┤
│ Before / After Comparison                                                    │
│ - Original waveform                                                          │
│ - Arrow                                                                      │
│ - Preview waveform                                                           │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Upload Audio Card

The upload card should accept click and drag/drop.

```text
Upload Audio
┌────────────────────────────────────┐
│              ⬆                     │
│        Drag & drop audio here       │
│           or click browse           │
│                                    │
│ Supports WAV, FLAC, MP3, OGG       │
│ Max 500 MB                         │
└────────────────────────────────────┘
```

## Source Audio Card

After upload, show:

- Filename
- Duration
- Waveform
- Play button
- Remove/replace action

```text
Source Audio
ambient_dreamscape.wav                                      03:24.187
┌────────────────────────────────────────────────────────────────────┐
│ ▶  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ waveform ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓              3:24 │
└────────────────────────────────────────────────────────────────────┘
```

## Transform Mode Card

Use a segmented control with three clear modes.

```text
Transform Mode
┌──────────────┬──────────────┬──────────────┐
│ Continue     │ Extend       │ Transform    │
│ Continue     │ Extend track │ Reimagine &  │
│ from end     │ seamlessly   │ transform    │
└──────────────┴──────────────┴──────────────┘
```

### Mode Meanings

#### Continue

Generate new material from the end of the audio. The original audio acts as context.

Use this for:

- outros
- longer loops
- continuing a song idea
- creating variations that naturally follow the source

#### Extend

Lengthen the track while preserving continuity. Similar to continue, but more structured around target duration.

Use this for:

- turning 30 seconds into 60 seconds
- extending ambient beds
- building loopable tracks

#### Transform

Re-style or reinterpret the uploaded audio.

Use this for:

- changing genre
- changing instruments
- creating variations
- turning a rough idea into polished output

## Transform Settings Card

Controls:

```text
Strength
Noise / Sigma
Preserve Timing
```

### Strength

Higher strength means stronger transformation.

```text
Strength                  0.65
━━━━━━━━━━━━━━●━━━━━━━━━━━━
```

### Noise / Sigma

Controls how much the source is disrupted before regeneration.

```text
Noise (Sigma)             0.20
━━━━━━●━━━━━━━━━━━━━━━━━━━
```

### Preserve Timing

Toggle. When enabled, try to keep rhythm, timing, transients, and structure closer to the original.

```text
Preserve Timing           ON
```

## Region / Inpaint Card

This card controls whether the whole track is used or only a selected segment is regenerated.

```text
Region / Inpaint
○ Use Entire Track
● Select Region

Start      00:45.000
End        01:30.000
Crossfade  0.20 s
```

### Region Selection Behavior

- When **Use Entire Track** is selected, start/end controls are disabled.
- When **Select Region** is selected, waveform selection handles become active.
- Region must be visually shown on the waveform.
- Crossfade controls how smoothly the generated region blends into surrounding audio.

## Before / After Comparison

Show side-by-side waveforms.

```text
Before (Original)                         After (Preview)
┌──────────────────────────┐      ┌──────────────────────────┐
│ ▓▓▓▓▓▓▓▓░░░░▓▓▓▓▓▓▓▓▓▓  │  →   │ ▓▓▓▓▓▓▓▓████▓▓▓▓▓▓▓▓▓▓  │
│       selected region     │      │       transformed region │
└──────────────────────────┘      └──────────────────────────┘
```

## Primary Action

```text
┌──────────────────────────────────────┐
│ ✨ Apply Transform                    │
└──────────────────────────────────────┘
Preview will use ~2x VRAM
```

## Init / Modify Interaction Rules

- Apply button is disabled until an audio file is loaded.
- Region values cannot exceed source duration unless mode supports continuation/extension.
- User should be warned if chosen settings require high VRAM.
- After transform completes, show after-preview waveform.
- User can accept, save, regenerate, or send result to Generate.

## Init / Modify State Model

```ts
type InitModifyState = {
  sourceFile?: AudioFile;
  mode: "continue" | "extend" | "transform";
  strength: number;
  sigma: number;
  preserveTiming: boolean;
  regionMode: "entire" | "selected";
  regionStartSec: number;
  regionEndSec: number;
  crossfadeSec: number;
  previewOutput?: AudioOutput;
  isProcessing: boolean;
};
```

---

# 8. Tab 3 — Presets / Library

## Purpose

The Presets / Library tab manages saved generation setups, prompt templates, source styles, and reusable workflows.

It should make the app feel professional and repeatable. Users should not need to remember settings manually.

## Layout

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Presets / Library Tab                                                        │
├───────────────┬──────────────────────────────┬───────────────────────────────┤
│ Library Panel │ Preset List                  │ Preset Details                │
│               │                              │                               │
│ Search        │ Sort dropdown                │ Cover image / waveform         │
│ Filter button │ Preset cards                 │ Name                           │
│ Add button    │ Tags                         │ Favorite                       │
│ Categories    │ Favorite star                │ Description                    │
│ Import button │                              │ Settings summary               │
│               │                              │ Tags                           │
│               │                              │ Preview / Load Preset          │
└───────────────┴──────────────────────────────┴───────────────────────────────┘
```

## Library Panel

This panel contains search, filtering, categories, and import.

```text
Library
┌──────────────────────────────┐
│ Search preset...        [≡] + │
├──────────────────────────────┤
│ Categories                   │
│ > All Presets        128     │
│ > Ambient             32     │
│ > Cinematic           24     │
│ > Electronic          18     │
│ > Nature              14     │
│ > Sci-Fi              10     │
│ > Horror               8     │
│ > My Presets          22     │
├──────────────────────────────┤
│ Import Preset                │
└──────────────────────────────┘
```

## Preset List

Preset cards should show enough information to browse quickly.

Each card includes:

- Thumbnail or mini-waveform
- Name
- Tags
- Duration
- Favorite star

```text
Presets (128)                                  Sort: Recently Used
┌─────────────────────────────────────────────────────────────────────┐
│ [thumb] Ethereal Drones      ambient  pad  evolving       60s   ★   │
│ [thumb] Deep Space           sci-fi   atmospheric         90s   ☆   │
│ [thumb] Night Forest         nature   calm mystery        45s   ★   │
│ [wave]  Dream Sequence       cinematic emotional          60s   ☆   │
│ [thumb] Oceanic Calm         nature   water               60s   ★   │
└─────────────────────────────────────────────────────────────────────┘
```

## Preset Details

The details panel shows the selected preset.

```text
Preset Details                                      ★
┌──────────┐ Ethereal Drones
│ thumbnail│ ambient  pad  evolving
└──────────┘

Wide, evolving drone pad with subtle movement and rich atmosphere.
Great for backgrounds and intros.

Model             AudioForge XL v1.0
Steps             50
CFG Scale         7.0
Sampler           DPM++
Duration          60s
Created           May 12, 2024
Author            You
Uses              24

Tags
[ambient] [pad] [atmosphere] [slow] [+]

[▶ Preview]   [⬇ Load Preset]   [⋯]
```

## Preset Data Model

```ts
type Preset = {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  negativePrompt?: string;
  tags: string[];
  categoryIds: string[];
  thumbnailUrl?: string;
  previewAudioUrl?: string;
  model: string;
  settings: GenerateSettings;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  author: "user" | "system" | string;
  favorite: boolean;
  useCount: number;
};
```

## Presets / Library Interaction Rules

- Search filters list live.
- Category selection filters list.
- Sort options include:
  - Recently Used
  - Recently Created
  - A–Z
  - Most Used
  - Favorites
- Favorite star toggles immediately.
- Load Preset sends values into Generate tab.
- Overwrite should require confirmation.
- Duplicate should create a new user preset.
- Import should accept `.json` or app-specific preset bundle.

---

# 9. Tab 4 — Automation / Advanced

## Purpose

This tab is for power users. It contains automation curves, output settings, optimization controls, performance controls, and job queue/history.

It should be powerful but visually contained. Avoid dumping every advanced control into a giant wall.

## Layout

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Automation / Advanced Tab                                                    │
├──────────────────────────────┬──────────────────────────────┬───────────────┤
│ Automation Curves            │ Advanced Options             │ Performance   │
│ - Curve target dropdown      │ - CFG rescale                │ - Device      │
│ - Add/remove curve           │ - Dynamic thresholding       │ - VRAM usage  │
│ - Curve graph                │ - Clip skip                  │ - CPU offload │
│ - Curve presets              │ - Attention slicing          │ - xFormers    │
│                              │ - Noise injection            │ - Precision   │
├──────────────────────────────┬───────────────────────────────────────────────┤
│ Output Settings              │ Job Queue / History                          │
│ - Format                     │ - queued/running/completed jobs               │
│ - Sample rate                │ - progress                                    │
│ - Bit depth                  │ - replay / menu                               │
│ - Channels                   │ - runtime / settings summary                  │
├──────────────────────────────┴───────────────────────────────────────────────┤
│ Footer Status: estimate, VRAM, running progress                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Automation Curves Card

Allows the user to automate values across the generation timeline.

### Controls

```text
Automation Curves
┌────────────────────────────────────────────────────┐
│ Target: CFG Scale     [+ Add Curve] [Remove]       │
├────────────────────────────────────────────────────┤
│ 10.0 ┤             ●                              │
│  7.5 ┤        ●        ●          ●               │
│  5.0 ┤   ●                 ●                       │
│  2.5 ┤●                                      ●      │
│  0.0 └──────┬──────┬──────┬──────┬──────┬───────  │
│            0.0    .15    .30    .45    .60    1.0 │
└────────────────────────────────────────────────────┘
```

### Curve Timeline

The x-axis should represent normalized generation time from 0 to 1.

- `0.0` = beginning of generation
- `1.0` = end of generation

Do not use actual seconds here unless the system supports time-based automation. Normalized automation is easier to transfer between durations.

### Curve Editing

User should be able to:

- Add point
- Drag point
- Delete point
- Choose interpolation type
- Select from curve presets

Curve preset examples:

```text
Flat
Slow Rise
Fast Rise
Fade Down
Pulse
Mid Boost
Late Detail
```

## Advanced Options Card

Controls that affect guidance and model behavior.

```text
Advanced Options
Classifier Free Guidance Rescale     0.70
Dynamic Thresholding                 OFF   0.95
Clip Skip                            2
Attention Slicing                    ON
Perlin Noise Injection               OFF
```

### Display Rules

- Show important advanced controls first.
- Keep rarely used controls collapsed.
- Each advanced control needs a tooltip.
- Dangerous or artifact-prone settings should show a small warning when extreme.

## Performance Card

Controls device and memory strategy.

```text
Performance
Device                 NVIDIA GeForce RTX 4090
VRAM Usage             High (90%)
CPU Offload            ON
xFormers               ON
Precision              FP16
```

### VRAM Display

Use a horizontal meter.

```text
VRAM 14.2 / 24 GB (59%)
━━━━━━━━━━━━━━●━━━━━━━━━━━━
```

### Performance Rules

- Device dropdown should list available devices.
- VRAM usage selector should map to internal memory strategy.
- CPU offload toggle should warn that generation may be slower.
- Precision should offer realistic options supported by the backend.

## Output Settings Card

Controls export format and audio file properties.

```text
Output Settings
Format             WAV
Sample Rate        48,000 Hz
Bit Depth          24-bit
Channels           Stereo
Normalize Output   ON
Dither             ON
```

## Optimization Card

Optional card if not merged into Advanced Options.

```text
Optimization
Enable Caching            ON
Parallel Generation       ON
Use Fast Math             ON
Memory Efficient Mode     OFF
Auto-Clear Between Jobs   ON
```

## Job Queue / History Card

Shows running and completed generations.

```text
Job Queue / History                                      Clear Completed
┌────┬──────────────────────┬───────────────┬──────────┬────────────┐
│ 1  │ Ethereal Drones      │ Completed     │ 10:24 AM │ ▶ ⋯        │
│ 2  │ Deep Space           │ Completed     │ 10:12 AM │ ▶ ⋯        │
│ 3  │ Night Forest         │ Completed     │ 09:58 AM │ ▶ ⋯        │
│ 4  │ Tension Builder      │ Running 45%   │ 10:28 AM │ ▓▓▓░░      │
│ 5  │ Ocean Calm           │ Queued        │ —        │ ⋯          │
└────┴──────────────────────┴───────────────┴──────────┴────────────┘
```

### Job Statuses

```ts
type JobStatus = "queued" | "running" | "completed" | "failed" | "canceled";
```

### Queue Rules

- Running jobs show progress.
- Completed jobs show play/reload actions.
- Failed jobs show error details.
- Queued jobs can be canceled or reordered if backend supports it.
- Selecting a job should reveal its settings.

## Automation / Advanced State Model

```ts
type AutomationAdvancedState = {
  curves: AutomationCurve[];
  advancedOptions: AdvancedOptions;
  outputSettings: OutputSettings;
  performanceSettings: PerformanceSettings;
  jobs: GenerationJob[];
};

type AutomationCurve = {
  id: string;
  target: "cfgScale" | "apgScale" | "sigmaMax" | "volume" | string;
  enabled: boolean;
  points: Array<{ x: number; y: number }>;
  interpolation: "linear" | "smooth" | "step";
};
```

---

# 10. Navigation and Information Architecture

## Primary Navigation

Use tabs for work mode. Use sidebar for global destinations.

```text
Top tabs = current creative mode
Sidebar = app-wide navigation
```

## Recommended Route Structure

```text
/generate
/init-modify
/presets
/automation
/projects
/history
/settings
```

## Tab Descriptions

| Tab | Purpose | User Question It Answers |
|---|---|---|
| Generate | Create new audio from text | “What do I want to make?” |
| Init / Modify | Transform existing audio | “What source am I changing?” |
| Presets / Library | Reuse saved setups | “What have I already saved?” |
| Automation / Advanced | Fine-tune system behavior | “How do I control the process deeply?” |

---

# 11. Recommended Component Hierarchy

```text
App
└── AppShell
    ├── TopBar
    │   ├── BrandMark
    │   ├── PrimaryTabs
    │   └── UtilityIcons
    ├── Sidebar
    │   ├── WorkspaceNav
    │   ├── GlobalNav
    │   └── PlanBadge
    └── Workspace
        ├── GenerateView
        ├── InitModifyView
        ├── PresetsLibraryView
        └── AutomationAdvancedView
```

## GenerateView

```text
GenerateView
├── PromptPanel
│   ├── PromptTextarea
│   └── NegativePromptTextarea
├── GenerationSettingsPanel
│   ├── SecondsControl
│   ├── StepsControl
│   ├── CfgScaleControl
│   ├── SamplerSelect
│   └── SeedControl
├── OutputPreviewPanel
│   ├── WaveformPreview
│   └── AudioTransport
└── GenerateActionPanel
    ├── GenerateButton
    ├── RuntimeEstimate
    └── VramEstimate
```

## InitModifyView

```text
InitModifyView
├── UploadAudioPanel
├── SourceAudioPanel
├── TransformModePanel
├── TransformSettingsPanel
├── RegionInpaintPanel
├── BeforeAfterPanel
└── ApplyTransformAction
```

## PresetsLibraryView

```text
PresetsLibraryView
├── LibrarySidebarPanel
│   ├── SearchInput
│   ├── FilterButton
│   ├── AddPresetButton
│   ├── CategoryList
│   └── ImportPresetButton
├── PresetListPanel
│   ├── SortSelect
│   └── PresetCard[]
└── PresetDetailsPanel
    ├── PresetHeader
    ├── PresetDescription
    ├── SettingsSummary
    ├── TagList
    └── PresetActions
```

## AutomationAdvancedView

```text
AutomationAdvancedView
├── AutomationCurvesPanel
│   ├── CurveTargetSelect
│   ├── CurveActions
│   └── CurveEditor
├── AdvancedOptionsPanel
├── PerformancePanel
├── OutputSettingsPanel
├── OptimizationPanel
└── JobQueueHistoryPanel
```

---

# 12. Detailed UI Layout Measurements

## Desktop Widescreen Target

Best target size:

```text
1920×1080
```

Minimum comfortable desktop width:

```text
1366×768
```

## Shell Dimensions

```text
Top bar height:        56px
Sidebar width:         160–180px
Workspace padding:     16px
Panel gap:             12px
Panel radius:          12px
```

## Generate Layout Grid

```css
.generate-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.45fr) minmax(320px, 0.9fr);
  grid-template-areas:
    "prompt settings"
    "preview preview"
    "footer footer";
  gap: 12px;
}
```

## Init / Modify Layout Grid

```css
.init-grid {
  display: grid;
  grid-template-columns: minmax(340px, 0.9fr) minmax(0, 1.3fr);
  grid-template-areas:
    "upload source"
    "mode mode"
    "transform region"
    "compare compare"
    "action action";
  gap: 12px;
}
```

## Presets Layout Grid

```css
.presets-grid {
  display: grid;
  grid-template-columns: 220px minmax(320px, 1fr) minmax(360px, 0.9fr);
  gap: 12px;
}
```

## Automation Layout Grid

```css
.automation-grid {
  display: grid;
  grid-template-columns: minmax(360px, 1fr) minmax(280px, 0.8fr) minmax(300px, 0.85fr);
  grid-template-areas:
    "curves advanced performance"
    "output queue queue";
  gap: 12px;
}
```

---

# 13. Responsive Behavior

## Desktop

- Full top bar.
- Sidebar visible.
- Multi-column layouts.
- Cards can sit side-by-side.
- Waveforms should be wide.

## Tablet

- Sidebar collapses to icons.
- Panels reduce to 2-column grids.
- Preset details may move below list.
- Automation cards stack into two rows.

## Mobile

- Sidebar becomes drawer.
- Top tabs become horizontal scroll or dropdown.
- All cards stack vertically.
- Primary action becomes sticky bottom button.
- Waveform controls simplify.

## Mobile Generate Layout

```text
Top Bar
Tabs
Prompt
Negative Prompt
Generation Settings
Output Preview
Sticky Generate Button
```

## Mobile Init / Modify Layout

```text
Top Bar
Tabs
Upload Audio
Source Audio
Transform Mode
Transform Settings
Region / Inpaint
Before / After
Sticky Apply Button
```

---

# 14. Interaction States

Every interactive element should define:

- Default
- Hover
- Focus
- Active
- Disabled
- Error
- Loading

## Button States

```text
Default: purple background, clear label
Hover: slightly brighter purple
Active: depressed / darker purple
Disabled: muted gray, no glow
Loading: spinner + label change
```

Example labels:

```text
Generate Audio
Generating…
Apply Transform
Processing…
Load Preset
Preset Loaded
```

## Input States

```text
Default: dark field, soft border
Focus: purple border and subtle glow
Error: red border and helper text
Disabled: reduced opacity
```

## Slider States

```text
Track: muted gray
Filled track: purple
Thumb: purple circular handle
Hover: larger thumb / brighter fill
Focus: keyboard-visible ring
```

## Audio Loading States

```text
No audio: empty waveform placeholder
Uploading: progress state
Processing: animated waveform shimmer
Ready: rendered waveform
Error: file issue message
```

---

# 15. Tooltip Strategy

Tooltips are essential because this UI contains advanced generation controls.

## Tooltip Rules

- Do not show walls of text.
- Keep tooltip body under 2–4 short lines.
- Advanced labels should include an info icon.
- Use plain language.

Example:

```text
CFG Scale ⓘ
Controls how strongly the model follows your prompt.
Higher values are stricter but can add artifacts.
```

## Where Tooltips Are Required

- CFG scale
- Steps
- Seed
- Sampler
- Strength
- Sigma/noise
- Preserve timing
- Crossfade
- Automation curve target
- Dynamic thresholding
- CPU offload
- Precision
- Normalize output
- Dither

---

# 16. Audio Visualization Requirements

## Waveform Style

- Purple waveform on dark background.
- Slight glow acceptable.
- Use muted gray for inactive regions.
- Selected regions should use translucent purple overlay.
- Inpaint region should have visible handles.

## Waveform States

```text
Empty         → placeholder text
Loading       → skeleton/shimmer
Playable      → waveform with playhead
Selected      → highlighted region
Processing    → animated status overlay
Error         → error message and retry
```

## Mini Waveforms

Use mini waveforms for:

- preset previews
- generation history
- queue items

## Spectrogram Optional

Spectrogram can be hidden behind a toggle or advanced preview mode. The four-panel mockup focuses on waveform more than spectrogram.

---

# 17. Data Flow

## Generate Data Flow

```text
User prompt/settings
        ↓
Validate inputs
        ↓
Create generation job
        ↓
Backend audio model
        ↓
Job queue updates
        ↓
Output audio file
        ↓
Waveform render
        ↓
Preview / save / send to modify
```

## Init / Modify Data Flow

```text
Upload source audio
        ↓
Analyze duration + waveform
        ↓
User selects transform mode/settings
        ↓
Create transform job
        ↓
Backend model processes source
        ↓
Preview output generated
        ↓
Before/after comparison
        ↓
Accept / regenerate / save
```

## Preset Data Flow

```text
Preset selected
        ↓
Load preset metadata
        ↓
Show details
        ↓
Preview optional audio
        ↓
User loads preset
        ↓
Populate Generate state
```

## Automation Data Flow

```text
User edits curves/settings
        ↓
Validate curve target ranges
        ↓
Attach automation to generation config
        ↓
Run job
        ↓
Queue/history updates
```

---

# 18. Recommended Unified App State

```ts
type AppState = {
  activeTab: "generate" | "initModify" | "presets" | "automation";
  generate: GenerateState;
  initModify: InitModifyState;
  presets: PresetsState;
  automation: AutomationAdvancedState;
  user: UserState;
  system: SystemState;
};

type AudioOutput = {
  id: string;
  name: string;
  url: string;
  durationSec: number;
  waveformData?: number[];
  createdAt: string;
  settingsSnapshot: Record<string, unknown>;
};

type AudioFile = {
  id: string;
  name: string;
  sizeBytes: number;
  durationSec: number;
  sampleRate?: number;
  channels?: number;
  url: string;
  waveformData?: number[];
};
```

---

# 19. Accessibility Requirements

This UI is dense. Accessibility needs to be designed in from the start.

## Keyboard Navigation

- All tabs reachable with keyboard.
- Sliders adjustable with arrow keys.
- File dropzone usable with Enter/Space.
- Curve editor needs keyboard alternatives for point editing.
- Modal confirmations must trap focus.

## Screen Reader Labels

Every icon-only control needs an accessible label.

Examples:

```text
Randomize seed
Reset seed
Play preview
Download output
Add automation curve
Remove selected curve
Favorite preset
Open preset menu
```

## Color Contrast

- Do not rely only on purple to communicate active state.
- Active state should include shape, border, icon, or text weight.
- Error states need icon + text, not only red border.

## Motion

- Animations should be subtle.
- Provide reduced-motion support.
- Waveform shimmer should disable when reduced motion is enabled.

---

# 20. Error Handling

## Generate Errors

Examples:

```text
Prompt is required.
Seconds total exceeds maximum for current model.
Not enough VRAM for selected duration/settings.
Generation failed. Retry or lower memory usage.
```

## Upload Errors

Examples:

```text
Unsupported file type.
File exceeds maximum size.
Could not read audio duration.
Audio is shorter than selected region.
```

## Preset Errors

Examples:

```text
Preset could not be loaded.
Preset references a missing model.
Preset file is invalid.
```

## Automation Errors

Examples:

```text
Curve point is outside valid range.
Selected target does not support automation.
Device is unavailable.
Job failed during processing.
```

---

# 21. Empty States

## Generate Empty State

```text
No output yet.
Write a prompt and generate audio to see the waveform here.
```

## Init / Modify Empty State

```text
Upload an audio file to transform, continue, or inpaint.
```

## Presets Empty State

```text
No presets match this search.
Clear filters or create a new preset from your current settings.
```

## Automation Empty State

```text
No automation curves yet.
Add a curve to change a parameter over the generation process.
```

---

# 22. Visual Priority Rules

The interface should guide the eye in this order:

## Generate Tab

```text
1. Prompt fields
2. Generate Audio button
3. Key generation settings
4. Output preview
5. Secondary controls
```

## Init / Modify Tab

```text
1. Source audio
2. Transform mode
3. Transform settings
4. Region selection
5. Apply Transform button
6. Before/after comparison
```

## Presets / Library Tab

```text
1. Search/filter
2. Preset list
3. Selected preset details
4. Preview/load buttons
```

## Automation / Advanced Tab

```text
1. Automation curve editor
2. Performance/device status
3. Job queue status
4. Output settings
5. Advanced toggles
```

---

# 23. Implementation Notes for an AI Rebuilder

## Build Order

Build the app in this order:

1. Create design tokens.
2. Build AppShell with top bar and sidebar.
3. Build reusable PanelCard component.
4. Build form controls: textareas, sliders, dropdowns, toggles.
5. Build Generate tab first.
6. Build audio waveform placeholder components.
7. Build Init / Modify tab.
8. Build Presets / Library tab.
9. Build Automation / Advanced tab.
10. Add responsive behavior.
11. Add real backend integration.
12. Add polish: tooltips, loading states, errors, transitions.

## Do Not Start With Backend

The UI can be rebuilt first with mock data. The app should support stubbed functions like:

```ts
generateAudio(config)
transformAudio(config)
loadPreset(id)
savePreset(preset)
getJobQueue()
```

## Mock Data Should Include

- 5 presets
- 5 generation history items
- 1 uploaded source audio example
- 1 running job
- 1 failed job
- 1 completed job
- 1 empty-state scenario

---

# 24. Suggested React File Structure

```text
src/
  app/
    App.tsx
    routes.tsx
  components/
    shell/
      AppShell.tsx
      TopBar.tsx
      Sidebar.tsx
    layout/
      PanelCard.tsx
      SectionHeader.tsx
      ToolbarRow.tsx
    controls/
      TextAreaWithCounter.tsx
      SliderWithValue.tsx
      SelectDropdown.tsx
      ToggleSwitch.tsx
      FileDropzone.tsx
      SegmentedControl.tsx
    audio/
      WaveformPreview.tsx
      AudioTransport.tsx
      BeforeAfterWaveform.tsx
      MiniWaveform.tsx
    presets/
      PresetCard.tsx
      PresetList.tsx
      PresetDetails.tsx
      CategoryList.tsx
    automation/
      CurveEditor.tsx
      JobQueueTable.tsx
      PerformancePanel.tsx
  views/
    GenerateView.tsx
    InitModifyView.tsx
    PresetsLibraryView.tsx
    AutomationAdvancedView.tsx
  state/
    appStore.ts
    mockData.ts
  styles/
    tokens.css
    globals.css
```

---

# 25. Suggested CSS Architecture

Use CSS variables for tokens and simple utility classes.

```css
:root {
  --bg-app: #05080d;
  --bg-panel: #0d131c;
  --border-soft: rgba(255,255,255,0.08);
  --accent: #8b5cf6;
  --text-primary: #f4f1ff;
  --text-secondary: #b9b3c9;
}

body {
  margin: 0;
  background: var(--bg-app);
  color: var(--text-primary);
  font-family: Inter, system-ui, sans-serif;
}

.panel {
  background: linear-gradient(180deg, rgba(255,255,255,0.035), rgba(255,255,255,0.015));
  border: 1px solid var(--border-soft);
  border-radius: 12px;
  padding: 16px;
}
```

---

# 26. Critical Design Decisions

## Keep Generate Simple

The Generate tab should not expose every advanced parameter. It should focus on prompt, duration, quality, and preview.

## Move Complexity to Automation / Advanced

Advanced controls should live in Automation / Advanced. This keeps the app usable for non-experts while preserving power-user control.

## Presets Are a First-Class Feature

Presets should not be an afterthought. They make the app repeatable and professional.

## Init / Modify Needs Strong Visual Feedback

Users need to see the relationship between original and transformed audio. Before/after waveform comparison is mandatory.

## Use Cards to Control Density

The UI can contain many controls without feeling chaotic if each control family is grouped into a titled card.

---

# 27. Final Four-Tab Rebuild Summary

## Generate

A focused creation screen with prompt, negative prompt, generation settings, output waveform preview, and a strong Generate Audio button.

## Init / Modify

A transformation screen with upload, source waveform, transform modes, strength/noise controls, region/inpaint settings, and before/after comparison.

## Presets / Library

A library management screen with categories, search, preset list, selected preset details, tags, preview, and load actions.

## Automation / Advanced

A power-user screen with automation curves, advanced model options, performance/device settings, output format controls, and job queue/history.

---

# 28. Minimal ASCII Master Blueprint

```text
APP SHELL
┌──────────────────────────────────────────────────────────────────────────────┐
│ theDAW AI        Generate | Init/Modify | Presets | Advanced      ? ⚙ A │
├───────────────┬──────────────────────────────────────────────────────────────┤
│ Generate      │ ACTIVE TAB VIEW                                              │
│ Init/Modify   │                                                              │
│ Presets       │  Cards arranged in responsive grid                           │
│ Automation    │  Shared controls and waveform components                     │
│               │                                                              │
│ Projects      │  Primary action always visually clear                         │
│ History       │                                                              │
│ Settings      │                                                              │
│               │                                                              │
│ v1.2.0   Pro  │                                                              │
└───────────────┴──────────────────────────────────────────────────────────────┘
```

The rebuilt UI should look like a serious audio-generation workstation: dark panels, purple audio accents, clean spacing, compact but readable controls, strong waveform previews, and a clear separation between creation, modification, library management, and advanced automation.


