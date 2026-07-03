import type React from "react";
import type { UIElement } from "../../types";

/**
 * Ref forwarded from the InteractiveControl dispatcher to the interactive
 * controls (Knob, Slider, XYPad, Spatial3D). The dispatcher attaches the
 * pointer-drag listeners to `containerRef.current`, so the control must place
 * this ref on the DOM node that should receive drag interaction.
 */
export type ControlContainerRef = React.RefObject<HTMLDivElement | null>;

/**
 * Common props shared by the per-control render components. `variant` is the
 * normalized variant already resolved by the dispatcher (raw design-style names
 * mapped to canonical archetypes such as "Classic", "Minimal", "Neumorphic",
 * "Brutalist", "CellShaded", "3D").
 */
export interface BaseControlProps {
  el: UIElement;
  variant: string;
  isPreview: boolean;
}
