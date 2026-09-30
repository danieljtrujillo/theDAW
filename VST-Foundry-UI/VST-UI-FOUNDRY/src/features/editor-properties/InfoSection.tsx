import React from "react";
import type { UIElement } from "../../types";

export function InfoSection({ selectedElement }: { selectedElement: UIElement }) {
    let docs = { desc: "", wiring: "" };
    switch (selectedElement.type) {
      case "Knob":
        docs = {
          desc: "A rotational control typically used for continuous parameters like volume or filter cutoff.",
          wiring:
            "Bind to a state variable (0-100). Use onUpdate={(val) => setParam(val)}.",
        };
        break;
      case "Slider":
        docs = {
          desc: "A linear control for adjusting values along a single axis.",
          wiring:
            "Use for standard volume/pitch controls. Binds linearly to a 0-100 float.",
        };
        break;
      case "Button":
        docs = {
          desc: "A momentary or toggle switch.",
          wiring:
            "Use onClick or onMouseDown/onMouseUp for momentary actions. For toggles, track checked state.",
        };
        break;
      case "XYPad":
        docs = {
          desc: "A 2D control pad for adjusting two parameters simultaneously.",
          wiring:
            "Requires mapping (x, y) coordinates. Ideal for modulating effect chains or stereo panning.",
        };
        break;
      case "Spatial3D":
        docs = {
          desc: "A 3-dimensional spatial element or radar for positioning elements in space.",
          wiring:
            "Use polar coordinates (radius, angle) or Cartesian (x, y, z) for 3D panning and reverb parameters.",
        };
        break;
      case "Label":
        docs = {
          desc: "Static or dynamic text display.",
          wiring: "Feed with state variables for real-time readouts.",
        };
        break;
      default:
        docs = {
          desc: "Standard UI control element.",
          wiring: "Standard component integration.",
        };
    }

    return (
      <div className="p-4 space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-app-main mb-1">
            Documentation
          </h3>
          <p className="text-xs text-app-muted">{docs.desc}</p>
        </div>
        <div>
          <h3 className="text-sm font-semibold text-app-main mb-1">
            Backend Wiring
          </h3>
          <p className="text-xs text-app-muted font-mono bg-app-surface neu-panel-inset p-2 rounded">
            {docs.wiring}
          </p>
        </div>
        <div>
          <h3 className="text-sm font-semibold text-app-main mb-1">
            CSS Targeting
          </h3>
          <p className="text-xs text-app-muted font-mono bg-app-surface neu-panel-inset p-2 rounded">
            {`[data-element-id="${selectedElement.id}"]`}
          </p>
        </div>
      </div>
    );
}
