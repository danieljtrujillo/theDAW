# StableDAW UI Screenshot Manifest (LLM-Ready)

Purpose: machine-readable human-friendly index for documentation generation models.

Capture context:
- App URL: http://127.0.0.1:5173
- Date: 2026-05-19
- Theme/state: default local dev state
- Notes: backend health showed API 500 in processing log during capture (UI still fully navigable)

## Screenshots

1. File: `01-create-tab-overview.png`
- Label: Create Tab Overview
- Area: Left panel CREATE tab + DAW center + processing log
- What it shows: Prompt section, generation accordions, run button, full shell layout
- Suggested docs section: Create workflow and generation controls

2. File: `02-edit-tab-overview.png`
- Label: Edit Tab Overview
- Area: Left panel EDIT tab + DAW center
- What it shows: Edit-focused left panel state and persistent DAW workspace
- Suggested docs section: Edit tab orientation

3. File: `03-train-tab-overview.png`
- Label: Train Tab Overview
- Area: Left panel TRAIN tab + DAW center
- What it shows: Training tab controls in the same shell context
- Suggested docs section: Training flow and LoRA setup

4. File: `04-library-tab-overview.png`
- Label: Library Tab Overview
- Area: Left panel LIBRARY tab + DAW center
- What it shows: Library surface and integration with editor workspace
- Suggested docs section: Library browsing and send-to-editor flow

5. File: `05-daw-waveform-editor.png`
- Label: DAW Waveform Editor Mode
- Area: Center DAW workspace mode toggle = Waveform Editor
- What it shows: Timeline, tracks lane, clip area, commit/edit controls
- Suggested docs section: Waveform editor usage

6. File: `06-daw-step-sequencer.png`
- Label: DAW Step Sequencer Mode
- Area: Center DAW workspace mode toggle = Step Sequencer
- What it shows: Sequencer grid and DAW mode switching context
- Suggested docs section: Step sequencing and pattern editing

7. File: `07-bottom-realtime-spectral.png`
- Label: Bottom Panel Real-time Spectral
- Area: Bottom dock tab = Real-time Spectral
- What it shows: Analyzer panel selected state
- Suggested docs section: Monitoring and spectral analysis

8. File: `08-bottom-details.png`
- Label: Bottom Panel Details
- Area: Bottom dock tab = Details
- What it shows: Details panel selected state and metadata context
- Suggested docs section: Clip/item detail inspection

9. File: `09-bottom-piano-roll-send-to-editor.png`
- Label: Bottom Panel Piano Roll (Send to Editor)
- Area: Bottom dock tab = Piano Roll
- What it shows: Piano Roll toolbar including SEND TO EDITOR action area
- Suggested docs section: MIDI composition and render-to-editor flow

10. File: `10-bottom-media-bucket.png`
- Label: Bottom Panel Media Bucket
- Area: Bottom dock tab = Media Bucket
- What it shows: Asset bucket view for media management
- Suggested docs section: Asset management and drag/drop workflows

11. File: `11-docs-modal.png`
- Label: In-App Docs Modal
- Area: Header docs trigger and modal overlay content
- What it shows: Embedded docs entry point and modal UX
- Suggested docs section: In-app help and user guide access

12. File: `12-header-stabledaw-branding.png`
- Label: Header Branding
- Area: Main top header
- What it shows: Centered StableDAW brand/title treatment
- Suggested docs section: Shell/header anatomy

## Suggested ingestion prompt for doc LLM

"Use INDEX.md and all PNG files in this folder. For each screenshot, produce:
1) concise user-facing caption,
2) 3-5 bullet callouts of controls visible,
3) cross-link to likely docs section,
4) any mismatch between UI wording and existing docs text."
