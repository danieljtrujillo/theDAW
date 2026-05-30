# Frontend Tooltips Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add informative hover tooltips to every control in the theDAW AI frontend so users understand what each parameter does, what values to use, and what the defaults are.

**Architecture:** Build a lightweight custom `<Tooltip>` React component (no library — the project has zero UI deps and we want to keep it that way). Inject it into the two existing helper components (`SF` and `Spin` in `StudioView.tsx`) via a new `tooltip` prop, then wrap all remaining bare controls (textareas, selects, checkboxes, inline sliders) with the same component. Tooltip content comes from the already-written `docs/UI/hover-text-guide.md`.

**Tech Stack:** React 19, plain CSS, no UI library, no Tailwind

---

## Codebase Orientation

| What | Where |
|------|-------|
| All generation controls | `frontend/src/views/StudioView.tsx` |
| Slider helper component | `StudioView.tsx:12-24` — `SF` component |
| Spinner helper component | `StudioView.tsx:26-38` — `Spin` component |
| Audio player action buttons | `frontend/src/components/audio/AudioPlayer.tsx` |
| All CSS | `frontend/src/index.css` (~594 lines) |
| Tooltip content reference | `docs/UI/hover-text-guide.md` |
| Design tokens | Dark theme: bg `#0b0914`, card `#13101f`, border `#231e38`, primary `#7c3aed`/`#8b5cf6`, text `#e2e0ea`, muted `#5a5470`, font: IBM Plex Sans/Mono |

**Existing "tooltip" patterns:** Only native `title=""` on ~13 buttons (Randomize, Weight, Loop, Mute, etc.). No tooltip component, no popover, no HoverCard. The `SF` component shows a range hint and default value as always-visible text — those stay; the tooltip adds the *explanation*.

---

## Task 1: Create the Tooltip Component + CSS

**Files:**
- Create: `frontend/src/components/ui/Tooltip.tsx`
- Modify: `frontend/src/index.css` (append tooltip styles at end)

**Step 1: Create the Tooltip component**

Create `frontend/src/components/ui/Tooltip.tsx`:

```tsx
import { useState, useRef, useEffect } from 'react';

interface TooltipProps {
  text: string;
  children: React.ReactNode;
  position?: 'top' | 'bottom';
  maxWidth?: number;
}

export function Tooltip({ text, children, position = 'top', maxWidth = 280 }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [flip, setFlip] = useState(false);
  const tipRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const timeout = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!visible || !tipRef.current) return;
    const rect = tipRef.current.getBoundingClientRect();
    if (position === 'top' && rect.top < 8) setFlip(true);
    if (position === 'bottom' && rect.bottom > window.innerHeight - 8) setFlip(true);
    if (rect.left < 8) tipRef.current.style.left = `${8 - rect.left}px`;
    if (rect.right > window.innerWidth - 8) tipRef.current.style.left = `${window.innerWidth - 8 - rect.right}px`;
  }, [visible, position]);

  const show = () => {
    clearTimeout(timeout.current);
    timeout.current = setTimeout(() => setVisible(true), 350);
  };
  const hide = () => {
    clearTimeout(timeout.current);
    setVisible(false);
    setFlip(false);
  };

  const pos = flip ? (position === 'top' ? 'bottom' : 'top') : position;

  return (
    <div className="tt-wrap" ref={wrapRef} onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {visible && (
        <div className={`tt tt-${pos}`} ref={tipRef} style={{ maxWidth }}>
          {text}
        </div>
      )}
    </div>
  );
}
```

**Step 2: Add tooltip CSS to index.css**

Append to `frontend/src/index.css`:

```css
/* === Tooltip === */
.tt-wrap { position: relative; display: inline-flex; width: 100%; }
.tt {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  background: #1e1a2e;
  border: 1px solid #3d3558;
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 10px;
  line-height: 1.5;
  color: #c4b5fd;
  font-family: 'IBM Plex Sans', sans-serif;
  white-space: pre-line;
  z-index: 200;
  pointer-events: none;
  box-shadow: 0 4px 16px rgba(0,0,0,0.4);
  animation: tt-in 0.12s ease-out;
}
.tt-top { bottom: calc(100% + 6px); }
.tt-bottom { top: calc(100% + 6px); }
@keyframes tt-in { from { opacity: 0; transform: translateX(-50%) translateY(3px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }
```

**Step 3: Verify it renders**

Run the dev server: `cd frontend && npm run dev`

Temporarily import and wrap any one element in StudioView to confirm the tooltip appears on hover. Remove the test wrapper after confirming.

**Step 4: Commit**

```bash
git add frontend/src/components/ui/Tooltip.tsx frontend/src/index.css
git commit -m "feat(frontend): add Tooltip component and styles"
```

---

## Task 2: Add `tooltip` Prop to SF and Spin Helpers

**Files:**
- Modify: `frontend/src/views/StudioView.tsx:12-38`

**Step 1: Import Tooltip and update SF**

Add import at top of StudioView.tsx:
```tsx
import { Tooltip } from '../components/ui/Tooltip';
```

Update `SF` component (lines 12-24) to accept and render tooltip:

```tsx
function SF({ label, range, value, onChange, min, max, step = 0.01, def, tooltip }: {
  label: string; range: string; value: number; onChange: (v: number) => void;
  min: number; max: number; step?: number; def: string; tooltip?: string;
}) {
  const content = (
    <div className="sf">
      <div className="fl">{label}</div>
      <div className="fh">{range}</div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(+e.target.value)} />
      <div className="cd">Default: {def}</div>
    </div>
  );
  return tooltip ? <Tooltip text={tooltip}>{content}</Tooltip> : content;
}
```

**Step 2: Update Spin to accept tooltip**

Update `Spin` component (lines 26-38). Spin is used inside `scf` rows that already have a label — the tooltip will be on the parent `scf` div, not on Spin itself. So Spin stays unchanged. Instead we'll wrap the `scf` divs in Task 5.

**Step 3: Commit**

```bash
git add frontend/src/views/StudioView.tsx
git commit -m "feat(frontend): add tooltip prop to SF helper component"
```

---

## Task 3: Wire Tooltips — Prompting + Main Controls

**Files:**
- Modify: `frontend/src/views/StudioView.tsx` — Prompting card and Controls row

**Step 1: Add tooltips to Prompt and Negative Prompt textareas**

Wrap each textarea's parent `<div>` with `<Tooltip>`. Around line 206-214:

```tsx
<Tooltip text="Describe the audio you want. Be specific: genre, instruments, tempo (BPM), mood, texture.&#10;Example: '120 BPM house loop, deep sub bass, crispy hi-hats, vinyl crackle'">
  <div>
    <div className="pl">Prompt</div>
    <textarea ... />
    <div className="cc">...</div>
  </div>
</Tooltip>
```

```tsx
<Tooltip text="Describe what you DON'T want. The model actively avoids these qualities.&#10;Example: 'poor quality, distortion, vocals, silence'&#10;Only active when CFG scale is above 1.0.">
  <div>
    <div className="pl">Negative Prompt</div>
    <textarea ... />
    <div className="cc">...</div>
  </div>
</Tooltip>
```

**Step 2: Add tooltips to Duration, Steps, CFG, Seed inline controls**

Wrap each control's `<span>` label. Around lines 222-243:

Duration label span:
```tsx
<Tooltip text="How long the generated audio will be, in seconds. Default: 120.&#10;Longer clips use more VRAM. Small model max: ~2 min. Medium max: ~4.75 min." position="bottom">
  <span style={{ fontSize: 9, color: '#8b7ca8' }}>Duration</span>
</Tooltip>
```

Steps label span:
```tsx
<Tooltip text="Refinement passes. ARC models: leave at 8 (optimized for it). RF models: start at 50.&#10;Going higher than 8 on ARC barely helps. Below 20 on RF sounds noticeably worse." position="bottom">
  <span style={{ fontSize: 9, color: '#8b7ca8' }}>Steps</span>
</Tooltip>
```

CFG label span:
```tsx
<Tooltip text="How strictly the model follows your prompt vs. improvising.&#10;1.0 = Freestyle (ARC default). 7.0 = Strong adherence (RF default).&#10;Above 15 = risk of artifacts. Lower = creative freedom. Higher = tighter prompt matching." position="bottom">
  <span style={{ fontSize: 9, color: '#8b7ca8' }}>CFG</span>
</Tooltip>
```

Seed label span:
```tsx
<Tooltip text="Random starting point. Same seed + same settings = identical output.&#10;-1 = random every time. Save the seed when you love a result." position="bottom">
  <span style={{ fontSize: 9, color: '#8b7ca8' }}>Seed</span>
</Tooltip>
```

**Step 3: Test in browser** — hover over each label and verify tooltip appears with correct text.

**Step 4: Commit**

```bash
git add frontend/src/views/StudioView.tsx
git commit -m "feat(frontend): add tooltips to prompting and main controls"
```

---

## Task 4: Wire Tooltips — Sampler Params (Core + Guidance)

**Files:**
- Modify: `frontend/src/views/StudioView.tsx` — Sampler Params card

**Step 1: Add tooltip to Sampler dropdown**

Wrap the sampler `<select>` parent (around line 486-493). The `fr` div that contains the label + select:

```tsx
<Tooltip text="Algorithm that builds audio from noise.&#10;• Pingpong — Fast, excellent at 8 steps. Default for ARC.&#10;• Euler — Fastest. Good for quick drafts and RF models.&#10;• DPM++ — Better quality per step. Best for RF.&#10;• RK4 — Slowest (4x Euler), most precise." position="bottom">
  <div className="fr">
    <div className="fr-info"><div className="fl">Sampler</div></div>
    <select ...>...</select>
  </div>
</Tooltip>
```

**Step 2: Add tooltip props to SF sliders in Core section**

Sigma max (line ~494):
```tsx
<SF label="Sigma max" range="[0-1]" value={s.sigmaMax} onChange={v => setField('sigmaMax', v)} min={0} max={1} def="1.0"
  tooltip="Starting noise level. 1.0 = generate from pure noise (normal).&#10;Below 1.0 with init audio = more original preserved.&#10;Leave at 1.0 for normal generation." />
```

Duration padding (line ~495):
```tsx
<SF label="Dur. pad" range="[0-30s]" value={s.durationPaddingSec} onChange={v => setField('durationPaddingSec', v)} min={0} max={30} step={0.1} def="6.0"
  tooltip="Extra seconds so reverb tails don't get cut off. Trimmed from output.&#10;Increase for ambient/reverb-heavy content. Decrease for tight loops.&#10;Default: 6 seconds." />
```

**Step 3: Add tooltip props to SF sliders in Guidance section**

APG (line ~500):
```tsx
tooltip="Anti-saturation filter for guidance. 'Tasteful guidance' knob.&#10;1.0 = removes harshness (recommended). 0.0 = raw guidance, may oversaturate.&#10;Only matters when CFG > 1."
```

CFG min (line ~501):
```tsx
tooltip="Skip guidance during noisiest stages. Try 0.2 to reduce artifacts.&#10;Only matters when CFG > 1. Default: 0.0."
```

CFG max (line ~502):
```tsx
tooltip="Skip guidance during cleanest stages. Try 0.8 to reduce over-processing.&#10;Only matters when CFG > 1. Default: 1.0."
```

Rescale (line ~505):
```tsx
tooltip="Tames volume/saturation boost from high CFG. Raise (0.3-0.7) if output sounds overblown.&#10;Only matters when CFG > 1. Default: 0.0 (off)."
```

Norm threshold (line ~506):
```tsx
tooltip="Caps guidance intensity. Raise if you hear random pops or distortion with high CFG.&#10;0.0 = disabled. Only matters when CFG > 1."
```

**Step 4: Test in browser** — hover over each sampler param.

**Step 5: Commit**

```bash
git add frontend/src/views/StudioView.tsx
git commit -m "feat(frontend): add tooltips to sampler params and guidance controls"
```

---

## Task 5: Wire Tooltips — Schedule Shift Cards

**Files:**
- Modify: `frontend/src/views/StudioView.tsx` — Schedule Shift section

**Step 1: Add tooltips to schedule type card headers**

Each schedule type (LogSNR, Flux, Full, None) is a clickable card div. Add a `<Tooltip>` wrapping each card's title div:

LogSNR title (line ~427):
```tsx
<Tooltip text="Rebalances effort using a log curve — more focus on stages where musical structure forms.&#10;Default and recommended for most use cases." position="bottom">
  <div style={{ fontSize: 10, fontWeight: 600, ... }}>LogSNR</div>
</Tooltip>
```

Flux title (line ~438):
```tsx
<Tooltip text="Extra effort at high-noise stages where broad musical structure is decided.&#10;Especially useful for longer audio (2+ minutes)." position="bottom">
  <div style={{ fontSize: 10, fontWeight: 600, ... }}>Flux</div>
</Tooltip>
```

Full title (line ~449):
```tsx
<Tooltip text="Combines both training-time and sampling-time shifts. Most aggressive schedule adjustment.&#10;Use if LogSNR alone isn't enough." position="bottom">
  <div style={{ fontSize: 10, fontWeight: 600, ... }}>Full</div>
</Tooltip>
```

None title (line ~460):
```tsx
<Tooltip text="No schedule adjustment. Equal effort at all denoising stages." position="bottom">
  <div style={{ fontSize: 10, fontWeight: 600, ... }}>None</div>
</Tooltip>
```

**Step 2: Add tooltips to schedule sub-parameter labels**

Each `scf` div has a `scl` label. Wrap each label with Tooltip:

LogSNR params (lines ~428-431):
```tsx
<div className="scf">
  <Tooltip text="Reference sequence length the shift curve is calibrated around. Default: 2000.&#10;Advanced — leave at default." position="bottom">
    <div className="scl">Anchor length</div>
  </Tooltip>
  <Spin ... />
</div>
```

Apply the same pattern to all 12 sub-parameter labels:

| Label | Tooltip |
|-------|---------|
| Anchor length | Reference sequence length for the shift curve. Default: 2000. Advanced. |
| Anchor logSNR | How much effort on structure-forming stages. Default: -6.2. More negative = more structure focus. |
| Rate | How quickly shift scales with duration. Default: 0.0. Advanced. |
| logSNR end | Where the shift tapers off. Default: 2.0. Advanced. |
| Min seq len | Shortest sequence the shift is calibrated for. Default: 256. Advanced. |
| Max seq len | Longest sequence the shift is calibrated for. Default: 4096. Advanced. |
| Alpha min | Shift strength at short durations. Default: 6.93. Advanced. |
| Alpha max | Shift strength at long durations. Default: 6.93. Advanced. |
| Base shift | Minimum shift at short sequences. Default: 0.5. Advanced. |
| Max shift | Maximum shift at long sequences. Default: 1.15. Advanced. |
| Min length | Sequence length where base shift applies. Default: 256. Advanced. |
| Max length | Sequence length where max shift applies. Default: 4096. Advanced. |

**Step 3: Test in browser.**

**Step 4: Commit**

```bash
git add frontend/src/views/StudioView.tsx
git commit -m "feat(frontend): add tooltips to schedule shift cards and sub-params"
```

---

## Task 6: Wire Tooltips — LoRA Card

**Files:**
- Modify: `frontend/src/views/StudioView.tsx` — LoRA card

**Step 1: Add tooltip to LoRA card header**

Wrap the "LoRA" text in the card header (line ~259):
```tsx
<Tooltip text="Style patches trained on specific audio. Steer the model toward a particular sound without retraining.&#10;Click + to add a LoRA file (.safetensors)." position="bottom">
  <span>LoRA</span>
</Tooltip>
```

**Step 2: Add tooltip to the Weight input**

Replace the existing `title="Weight"` (line ~270) with a Tooltip wrapper:
```tsx
<Tooltip text="How much this style patch influences output.&#10;0 = off. 1.0 = full effect. Above 1.0 = amplified/exaggerated.&#10;Start at 1.0. Too dominant? Try 0.3-0.7." position="bottom">
  <input type="number" className="si" ... />
</Tooltip>
```

Remove `title="Weight"` from the input since Tooltip replaces it.

**Step 3: Commit**

```bash
git add frontend/src/views/StudioView.tsx
git commit -m "feat(frontend): add tooltips to LoRA card"
```

---

## Task 7: Wire Tooltips — Output Settings Card

**Files:**
- Modify: `frontend/src/views/StudioView.tsx` — Output Settings card

**Step 1: Add tooltip to Format select**

Wrap the Format `<div>` (around line 284-289):
```tsx
<Tooltip text="Output audio format. Default: WAV.&#10;WAV = lossless, large. FLAC = lossless, smaller. OGG = lossy, small." position="bottom">
  <div style={{ flex: 1 }}>
    <div className="cl">Format</div>
    <select ...>...</select>
  </div>
</Tooltip>
```

**Step 2: Add tooltip to Naming select**

```tsx
<Tooltip text="How the file is named.&#10;Verbose = prompt + settings + seed. Best for experiments.&#10;Prompt = just prompt text. Seed = just the seed number." position="bottom">
  <div style={{ flex: 1 }}>
    <div className="cl">Naming</div>
    <select ...>...</select>
  </div>
</Tooltip>
```

**Step 3: Add tooltips to checkboxes**

Wrap each `<label>` with Tooltip:

Cut to duration:
```tsx
<Tooltip text="Trim output to exactly your requested duration, removing padding silence. Default: ON." position="bottom">
  <label ...><input type="checkbox" ... /> Cut to duration</label>
</Tooltip>
```

Autoplay:
```tsx
<Tooltip text="Play audio automatically when generation finishes. Default: OFF." position="bottom">
  <label ...><input type="checkbox" ... /> Autoplay</label>
</Tooltip>
```

Auto download:
```tsx
<Tooltip text="Save each generation to downloads automatically. Useful during long exploration sessions. Default: OFF." position="bottom">
  <label ...><input type="checkbox" ... /> Auto download</label>
</Tooltip>
```

**Step 4: Commit**

```bash
git add frontend/src/views/StudioView.tsx
git commit -m "feat(frontend): add tooltips to output settings"
```

---

## Task 8: Wire Tooltips — Init Audio Card

**Files:**
- Modify: `frontend/src/views/StudioView.tsx` — Init Audio card

**Step 1: Add tooltip to Init Audio card header**

Wrap the "Init Audio" text (line ~322):
```tsx
<Tooltip text="Upload a recording as a starting point. The model transforms it based on your prompt.&#10;Lower noise level = more of the original preserved." position="bottom">
  <span>Init Audio</span>
</Tooltip>
```

**Step 2: Add tooltip to Type select**

```tsx
<Tooltip text="Audio = adds noise then regenerates. Simple and effective.&#10;RF-Inversion = reverse-engineers audio into noise space more carefully. Better preserves timing. RF models only." position="bottom">
  <span>Type:</span>
</Tooltip>
```

**Step 3: Add tooltips to RF-Inversion controls**

Steps label (line ~352):
```tsx
<Tooltip text="How carefully the model analyzes your input. More = faithful to source structure. Default: 100." position="bottom">
  <span style={{ color: '#8b7ca8' }}>Steps </span>
</Tooltip>
```

Gamma label (line ~356):
```tsx
<Tooltip text="Creative freedom during analysis. 0 = faithful. 0.3 = slight liberty. 1.0 = max reinterpretation. Default: 0." position="bottom">
  <span style={{ color: '#8b7ca8' }}>Gamma </span>
</Tooltip>
```

Unconditional checkbox (line ~359):
```tsx
<Tooltip text="Ignore prompt during analysis — reconstruct purely from audio structure.&#10;Prompt only affects regeneration. Cleaner separation between what to keep and what to change." position="bottom">
  <label ...><input type="checkbox" ... /> Uncond</label>
</Tooltip>
```

**Step 4: Add tooltip to Init noise SF slider**

```tsx
<SF label="Init noise" range="[0-1]" ... def="0.7"
  tooltip="How much of the original survives.&#10;0.1 = subtle remix. 0.3 = loose cover. 0.5 = inspired by.&#10;0.9 = almost from scratch. 1.0 = original ignored entirely.&#10;Start at 0.7-0.9 for creative variations." />
```

**Step 5: Commit**

```bash
git add frontend/src/views/StudioView.tsx
git commit -m "feat(frontend): add tooltips to init audio card"
```

---

## Task 9: Wire Tooltips — Inpainting Card

**Files:**
- Modify: `frontend/src/views/StudioView.tsx` — Inpainting card

**Step 1: Add tooltip to Inpainting card header**

```tsx
<Tooltip text="Regenerate a specific time region while keeping everything else.&#10;Drag the purple region on the waveform to set the mask.&#10;For continuation: drag mask to the end and increase Duration." position="bottom">
  <span>Inpainting</span>
</Tooltip>
```

**Step 2: Add tooltip to mask start/end display**

Wrap the mask readout (line ~388-391):
```tsx
<Tooltip text="Start = where regeneration begins (everything before is preserved).&#10;End = where regeneration ends (everything after is preserved).&#10;Drag the purple region on the waveform to adjust." position="bottom">
  <div style={{ display: 'flex', gap: 8, fontSize: 9, color: '#a78bfa' }}>
    <span>Start: {s.maskStart.toFixed(2)}s</span>
    <span>End: {s.maskEnd.toFixed(2)}s</span>
  </div>
</Tooltip>
```

**Step 3: Commit**

```bash
git add frontend/src/views/StudioView.tsx
git commit -m "feat(frontend): add tooltips to inpainting card"
```

---

## Task 10: Final Polish — Card-Level Section Tooltips + AudioPlayer Buttons

**Files:**
- Modify: `frontend/src/views/StudioView.tsx` — card title tooltips
- Modify: `frontend/src/components/audio/AudioPlayer.tsx` — upgrade `title=` to `<Tooltip>`

**Step 1: Add tooltip to "Sampler Params" card title**

```tsx
<Tooltip text="Fine-tune how the model builds audio from noise.&#10;Defaults work great — only tweak if experimenting." position="bottom">
  <div className="ct">Sampler Params</div>
</Tooltip>
```

**Step 2: Add tooltip to "Sampling Schedule Shift" card title**

```tsx
<Tooltip text="Controls where the model focuses its denoising effort.&#10;Click a type to select it. Leave at LogSNR (default) unless experimenting." position="bottom">
  <div className="ct">Sampling Schedule Shift</div>
</Tooltip>
```

**Step 3: Upgrade AudioPlayer button titles**

In `AudioPlayer.tsx`, import Tooltip and replace `title="..."` attributes on action buttons with `<Tooltip text="...">` wrappers. Key buttons:

| Button | Tooltip text |
|--------|-------------|
| Send to Init Audio | Load this output as init audio for audio-to-audio. Generate a variation by adjusting noise level and prompt. |
| Send to Inpaint | Load this output for inpainting. Set a mask region to regenerate part of it, or extend it via continuation. |
| Download | Save this audio file to your computer. |
| Loop | Toggle looping playback. |

**Step 4: Test full UI in browser** — hover over every single control, verify text is correct, positioning doesn't clip off-screen, and tooltips dismiss properly.

**Step 5: Commit**

```bash
git add frontend/src/views/StudioView.tsx frontend/src/components/audio/AudioPlayer.tsx
git commit -m "feat(frontend): add tooltips to card headers and audio player buttons"
```

---

## Summary of All Tooltip Targets

| Section | # of tooltips | Controls covered |
|---------|--------------|------------------|
| Prompting | 2 | Prompt, Negative Prompt |
| Main Controls | 4 | Duration, Steps, CFG, Seed |
| Sampler Core | 3 | Sampler type, Sigma max, Duration padding |
| Guidance | 5 | APG, CFG min, CFG max, Rescale, Norm threshold |
| Schedule Shift | 16 | 4 type cards + 12 sub-params |
| LoRA | 2 | Card header, Weight |
| Output Settings | 5 | Format, Naming, Cut to duration, Autoplay, Auto download |
| Init Audio | 6 | Card header, Type, Init noise, RF Steps, Gamma, Unconditional |
| Inpainting | 2 | Card header, Mask readout |
| Card headers | 2 | Sampler Params, Schedule Shift |
| AudioPlayer | 4 | Send to Init, Send to Inpaint, Download, Loop |
| **Total** | **~51** | |

