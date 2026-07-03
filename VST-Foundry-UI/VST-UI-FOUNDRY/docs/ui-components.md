# UI Components

VST Foundry provides a rich library of components tailored for audio applications. Each component comes with multiple stylistic variants.

## Component Types

### Knob
The quintessential audio control.
- **Properties:** Value, Min, Max, Rotation limits.
- **Variants:** Classic, Modernism, Neumorphic, Brutalist, Minimal, Outline.

### Slider
Linear control for volume, pitch, or macros.
- **Properties:** Value, Min, Max. Can be oriented horizontally or vertically based on dimensions.

### Button / Toggle
For bypass switches, mode selectors, etc.
- **Variants:** Checkbox, Solid, Outline, Brutalist.

### Meter
Visual feedback for audio levels.
- **Properties:** Value (simulated in preview), Segments.

### XY Pad
Two-dimensional control for modulating multiple parameters simultaneously.
- **Properties:** X Value, Y Value.

### Waveform
Visualizer for audio signals.
- **Variants:** Oscilloscope, Filled, Bar.

### ValueBox
Displays exact numerical values, often paired with a knob or slider.

### Label
Text elements for naming sections or controls.

### Group / Panel
Container elements for organizing the UI visually.

### Image
Displays static images or backgrounds. Includes local background removal processing functionality.
- **Properties:** Background Removal (Tolerance, Feathering, Target Color).
- **Behavior:** Dropping an image from the Asset Manager scales it proportionally if it exceeds the canvas dimensions.

## Shared Properties

All elements share these core properties in the Properties Panel:
- **Geometry:** X, Y, Width, Height, Rotation, Corner Radius.
- **Data:** Export Name (ID for your code), Label.
- **Style:** Variant, Opacity, Base Color, Active Color, Text Color, Border Color, Glow.
- **Raw:** Monaco-powered JSON editor for real-time deep configuration editing.

## Saving Custom Elements

You can customize any element and save it as a "Preset" directly from the Raw tab. This saves the element's configuration to the **Saved Presets** category in the left sidebar, allowing you to reuse your custom knobs, sliders, and layouts across your project.
