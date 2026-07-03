import React from "react";
import { BaseControlProps } from "./shared";
import { styleParam } from "./controlParams";

// Decorative Frame control. ONE element type spans BOTH flavors:
//   - FILLED backplate looks (a surface that sits BEHIND controls): Backplate,
//     Plate, Glass, Titled.
//   - HOLLOW frame looks (trim AROUND things, transparent center): Border, Bezel.
// The flavor is carried by the VARIANT and can be flipped per-instance via the
// frameFill styleParam (variant-scoped defaults live in CONTROL_PARAMS.Frame:
// filled -> true, hollow -> false), so any variant can switch. Frames are pure
// chrome: no containerRef, no pointer handlers — the whole render is
// pointer-events-none so controls placed over a backplate stay clickable. All
// materials come from the shared control CSS vars (--base-color / --border-color
// / --text-color) so theming, skins and textures apply exactly as for every
// other control. Absent styleParams every variant renders from its schema
// defaults, keeping the palette look stable.
export default function FrameControl({ el, variant }: BaseControlProps) {
  const borderWidth = styleParam<number>(el, "frameBorderWidth", 1);
  // frameFill's per-variant defaults live in CONTROL_PARAMS.Frame (filled -> true,
  // hollow -> false); this fallback only covers an unforeseen variant.
  const fill = styleParam<boolean>(el, "frameFill", true);
  const titleHeight = styleParam<number>(el, "frameTitleHeight", 22);

  // Filled variants paint the --base-color surface; hollow variants (or any
  // variant with frameFill toggled off) leave the center transparent.
  const surface = fill ? "var(--base-color)" : "transparent";

  const edge: React.CSSProperties = {
    borderWidth: `${borderWidth}px`,
    borderStyle: "solid",
    borderColor: "var(--border-color)",
    borderRadius: "inherit",
  };

  if (variant === "Plate") {
    // Filled surface with four corner screw dots.
    return (
      <div
        className="w-full h-full relative pointer-events-none"
        style={{ ...edge, background: surface }}
      >
        {["top-1 left-1", "top-1 right-1", "bottom-1 left-1", "bottom-1 right-1"].map(
          (pos) => (
            <div
              key={pos}
              className={`absolute ${pos} w-1.5 h-1.5 rounded-full`}
              style={{
                background: "color-mix(in srgb, var(--text-color) 25%, transparent)",
                boxShadow: "inset 0 1px 1px rgba(0,0,0,0.6)",
              }}
            />
          ),
        )}
      </div>
    );
  }

  if (variant === "Glass") {
    // Translucent frosted fill with a soft top highlight.
    return (
      <div
        className="w-full h-full relative overflow-hidden pointer-events-none"
        style={{
          borderWidth: `${borderWidth}px`,
          borderStyle: "solid",
          borderColor: "color-mix(in srgb, var(--border-color) 60%, transparent)",
          borderRadius: "inherit",
          background: fill
            ? "color-mix(in srgb, var(--base-color) 55%, transparent)"
            : "transparent",
          backdropFilter: "blur(2px)",
        }}
      >
        <div
          className="absolute inset-x-0 top-0 h-1/3 pointer-events-none"
          style={{
            background:
              "linear-gradient(180deg, rgba(255,255,255,0.18), rgba(255,255,255,0))",
          }}
        />
      </div>
    );
  }

  if (variant === "Titled") {
    // Top title strip (renders el.label) over a filled body.
    return (
      <div
        className="w-full h-full flex flex-col overflow-hidden pointer-events-none"
        style={{ ...edge, background: surface }}
      >
        <div
          className="w-full shrink-0 flex items-center px-2 text-[11px] font-semibold uppercase tracking-wider truncate"
          style={{
            height: `${titleHeight}px`,
            background: "color-mix(in srgb, var(--border-color) 45%, transparent)",
            color: "var(--text-color)",
            borderBottom: "1px solid var(--border-color)",
          }}
        >
          {el.label || "Module"}
        </div>
        <div className="flex-1 min-h-0" />
      </div>
    );
  }

  if (variant === "Border") {
    // Plain border ring, transparent center (hollow by default).
    return (
      <div
        className="w-full h-full pointer-events-none"
        style={{ ...edge, background: surface }}
      />
    );
  }

  if (variant === "Bezel") {
    // Double border + inner inset shadow, transparent center (hollow by default).
    return (
      <div
        className="w-full h-full pointer-events-none"
        style={{
          ...edge,
          background: surface,
          boxShadow:
            "inset 0 0 0 2px color-mix(in srgb, var(--border-color) 50%, transparent), inset 0 2px 6px rgba(0,0,0,0.5)",
        }}
      />
    );
  }

  // Default (Backplate): plain --base-color surface with a hairline edge.
  return (
    <div
      className="w-full h-full pointer-events-none"
      style={{ ...edge, background: surface }}
    />
  );
}
