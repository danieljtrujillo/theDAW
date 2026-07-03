import React from "react";
import { BaseControlProps, ControlContainerRef } from "./shared";
import { styleParam } from "./controlParams";

interface KnobControlProps extends BaseControlProps {
  val: number;
  containerRef: ControlContainerRef;
}

/**
 * Static tick ring rendered on top of any knob variant when `tickCount > 0`.
 * Ticks are laid out across the (adjustable) sweep angle so they stay aligned
 * with the value travel. Rendered last so the marks sit above the cap face.
 */
function KnobTicks({ count, sweep }: { count: number; sweep: number }) {
  if (count <= 0) return null;
  const start = -sweep / 2;
  const span = count > 1 ? sweep / (count - 1) : 0;
  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none"
      viewBox="0 0 100 100"
    >
      {Array.from({ length: count }, (_, i) => {
        const a = ((start + i * span) * Math.PI) / 180;
        const outer = 48;
        const inner = 42;
        return (
          <line
            key={i}
            x1={50 + outer * Math.sin(a)}
            y1={50 - outer * Math.cos(a)}
            x2={50 + inner * Math.sin(a)}
            y2={50 - inner * Math.cos(a)}
            stroke="var(--text-color)"
            strokeWidth={1.5}
            strokeLinecap="round"
            opacity={0.5}
          />
        );
      })}
    </svg>
  );
}

export default function KnobControl({
  el,
  variant,
  val,
  isPreview,
  containerRef,
}: KnobControlProps) {
  // --- Universal adjustable params (schema-default aware; defaults reproduce
  // the pre-parameterization look exactly). ---
  const sweep = styleParam<number>(el, "sweepAngle", 270);
  const capFactor = styleParam<number>(el, "capSize", 100) / 100;
  const lenFactor = styleParam<number>(el, "indicatorLength", 60) / 60;
  const thickFactor = styleParam<number>(el, "indicatorThickness", 3) / 3;
  const tickCount = Math.round(styleParam<number>(el, "tickCount", 0));

  // Rotation replaces the old hard-coded `val * 2.7 - 135` (sweep 270 -> same).
  const rot = -sweep / 2 + (val / 100) * sweep;
  // Cap scaling is applied via transform on the full-bleed "classic" variants
  // whose cap fills the control; omitted at 1x so the transform string (and
  // therefore the rasterization) is byte-identical to before at defaults.
  const capScale = capFactor !== 1 ? ` scale(${capFactor})` : "";

  // Rim-arc geometry (Encoder / Aluminum). arcLen/gap follow the sweep angle.
  const arcGeom = (r: number) => {
    const c = 2 * Math.PI * r;
    return { c, len: (sweep / 360) * c, rot: 270 - sweep / 2 };
  };

  // Shared renderer for the full-bleed "classic" archetypes: a static outer
  // container (holds the drag ref + tick overlay) wrapping the rotating cap.
  const simpleKnob = (
    knobClass: string,
    knobStyle: React.CSSProperties,
    indClass: string,
    baseWidthRem: number,
    baseHeightPct: number,
  ) => (
    <div
      ref={containerRef}
      className={`w-full h-full relative ${isPreview ? "cursor-ns-resize" : ""}`}
    >
      <div
        className={`absolute inset-0 ${knobClass}`}
        style={{ transform: `rotate(${rot}deg)${capScale}`, ...knobStyle }}
      >
        <div
          className={indClass}
          style={{
            width: `${baseWidthRem * thickFactor}rem`,
            height: `${baseHeightPct * lenFactor}%`,
            backgroundColor: "var(--active-color)",
          }}
        />
      </div>
      <KnobTicks count={tickCount} sweep={sweep} />
    </div>
  );

  // --- Image face (opt-in). When el.faceSrc is set the knob wears the supplied
  // cutout, reusing the same drag wiring and `rot` value math so the control
  // still turns. faceMode "rotate" spins the image by the identical rot the
  // variants use (value travel reads the same); "static" pins it flat.
  // faceShowIndicator overlays the Blank variant's hairline indicator on top,
  // rotated by rot — useful for a static face with no printed pointer.
  // faceHideBase (default true) swaps the image IN PLACE OF the variant (the
  // drag ref + value aria live on the face container); false composites the
  // image OVER a full re-render of the variant (drag lives on that variant, the
  // face floats inert above it — the C2 "composites over" path). Absent faceSrc
  // this branch never runs, so the variant output below is byte-identical.
  if (el.faceSrc) {
    const faceFit = styleParam<string>(el, "faceFit", "contain");
    const faceOpacity = styleParam<number>(el, "faceOpacity", 100);
    const faceHideBase = styleParam<boolean>(el, "faceHideBase", true);
    const faceMode = styleParam<string>(el, "faceMode", "rotate");
    const faceShowIndicator = styleParam<boolean>(el, "faceShowIndicator", false);
    // The cutout (+ optional hairline indicator), authored as absolutely
    // positioned layers so it drops in unchanged whether it replaces the variant
    // or composites over it. Inert to pointer events either way — drag lives on
    // the container below (replace) or the re-rendered variant beneath.
    const faceLayer = (
      <>
        <img
          src={el.faceSrc}
          alt=""
          draggable={false}
          className="absolute inset-0 w-full h-full select-none pointer-events-none"
          style={{
            objectFit: faceFit as React.CSSProperties["objectFit"],
            opacity: faceOpacity / 100,
            transform: faceMode === "rotate" ? `rotate(${rot}deg)` : undefined,
          }}
        />
        {faceShowIndicator && (
          <div
            className="absolute inset-0 rounded-full flex items-start justify-center pt-1 pointer-events-none"
            style={{ transform: `rotate(${rot}deg)` }}
          >
            <div
              style={{
                width: `${0.25 * thickFactor}rem`,
                height: `${30 * lenFactor}%`,
                backgroundColor: "var(--indicator-color)",
              }}
            />
          </div>
        )}
      </>
    );
    // Composite path: re-render the variant sans face for its full programmatic
    // look + drag wiring (containerRef rides that render), then float the cutout
    // over it. The wrapper takes no ref — the variant root fills it 1:1.
    if (!faceHideBase) {
      return (
        <div className="w-full h-full relative">
          <KnobControl
            el={{ ...el, faceSrc: undefined }}
            variant={variant}
            val={val}
            isPreview={isPreview}
            containerRef={containerRef}
          />
          {faceLayer}
        </div>
      );
    }
    // Replace path (default): the image stands in for the variant, so the drag
    // ref lives here; role=slider keeps the swapped-in cutout an announced value
    // control even though the printed variant markup is gone.
    return (
      <div
        ref={containerRef}
        className={`w-full h-full relative ${isPreview ? "cursor-ns-resize" : ""}`}
        role="slider"
        aria-label={el.label || "Knob"}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(val)}
      >
        {faceLayer}
      </div>
    );
  }
  if (variant === "Blank") {
    // Unbranded hardware blank: a flat --base-color disc with a single hairline
    // border (--text-color, low opacity) and one straight --indicator-color
    // line. Every universal param is wired (sweepAngle -> rot + tick sweep,
    // capSize -> capScale, indicatorLength -> lenFactor, indicatorThickness ->
    // thickFactor, tickCount -> KnobTicks). No gradients/shadows — the skin and
    // texture systems supply all material.
    return (
      <div
        ref={containerRef}
        className={`w-full h-full relative ${isPreview ? "cursor-ns-resize" : ""}`}
      >
        <div
          className="absolute inset-0 rounded-full border flex items-start justify-center pt-1"
          style={{
            transform: `rotate(${rot}deg)${capScale}`,
            backgroundColor: "var(--base-color)",
            borderColor: "color-mix(in srgb, var(--text-color) 30%, transparent)",
          }}
        >
          <div
            style={{
              width: `${0.25 * thickFactor}rem`,
              height: `${30 * lenFactor}%`,
              backgroundColor: "var(--indicator-color)",
            }}
          />
        </div>
        <KnobTicks count={tickCount} sweep={sweep} />
      </div>
    );
  }
  if (variant === "Classic") {
    return simpleKnob(
      "rounded-full border-4 flex items-start justify-center shadow-inner",
      { backgroundColor: "var(--base-color)", borderColor: "rgba(0,0,0,0.5)" },
      "rounded-sm mt-1",
      0.375,
      30,
    );
  }
  if (variant === "Minimal") {
    return simpleKnob(
      "rounded-full border-2 bg-transparent flex items-start justify-center",
      { borderColor: "var(--base-color)" },
      "rounded-full mt-1",
      0.25,
      25,
    );
  }
  if (variant === "Neumorphic") {
    return simpleKnob(
      "rounded-full shadow-[inset_3px_3px_6px_rgba(0,0,0,0.6),inset_-3px_-3px_6px_rgba(255,255,255,0.05)] flex items-start justify-center pt-2",
      { backgroundColor: "var(--base-color)" },
      "rounded-full shadow-[0_0_3px_rgba(0,0,0,0.8)]",
      0.375,
      20,
    );
  }
  if (variant === "Brutalist") {
    return simpleKnob(
      "rounded-none border-[3px] flex items-start justify-center pt-2",
      { backgroundColor: "var(--base-color)", borderColor: "var(--active-color)" },
      "",
      0.625,
      30,
    );
  }
  if (variant === "CellShaded") {
    return simpleKnob(
      "rounded-full border-4 border-black flex items-start justify-center pt-1.5 shadow-[4px_4px_0_0_#000]",
      { backgroundColor: "var(--base-color)" },
      "border-2 border-black rounded-full",
      0.5,
      25,
    );
  }
  if (variant === "3D") {
    return simpleKnob(
      "rounded-full border flex items-start justify-center pt-1.5 shadow-[0_6px_10px_rgba(0,0,0,0.5),inset_0_2px_4px_rgba(255,255,255,0.1)]",
      { backgroundColor: "var(--base-color)", borderColor: "rgba(0,0,0,0.3)" },
      "rounded-full shadow-sm border border-black/20",
      0.5,
      25,
    );
  }
  if (variant === "Encoder") {
    const arc = arcGeom(42);
    const dotRem = 0.375 * thickFactor;
    return (
      <div
        ref={containerRef}
        className={`w-full h-full rounded-full border flex items-center justify-center shadow-inner relative ${isPreview ? "cursor-ns-resize" : ""}`}
        style={{
          backgroundColor: "var(--base-color)",
          borderColor: "rgba(0,0,0,0.5)",
        }}
      >
        {/* LED Ring */}
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none"
          viewBox="0 0 100 100"
        >
          <circle
            cx="50"
            cy="50"
            r="42"
            fill="none"
            stroke="rgba(255,255,255,0.1)"
            strokeWidth="6"
            strokeDasharray={`${arc.len} ${arc.c}`}
            strokeLinecap="round"
            transform={`rotate(${arc.rot} 50 50)`}
          />
          <circle
            cx="50"
            cy="50"
            r="42"
            fill="none"
            stroke="var(--active-color)"
            strokeWidth="6"
            strokeDasharray={`${(val / 100) * arc.len} ${arc.c}`}
            strokeLinecap="round"
            transform={`rotate(${arc.rot} 50 50)`}
          />
        </svg>
        {/* Knob Cap */}
        <div
          className="rounded-full bg-app-surface shadow-[0_4px_6px_rgba(0,0,0,0.5)] border border-app-border flex items-start justify-center pt-2"
          style={{
            width: `${70 * capFactor}%`,
            height: `${70 * capFactor}%`,
            transform: `rotate(${rot}deg)`,
          }}
        >
          <div
            className="rounded-full"
            style={{
              width: `${dotRem}rem`,
              height: `${dotRem}rem`,
              backgroundColor: "var(--active-color)",
            }}
          />
        </div>
        <KnobTicks count={tickCount} sweep={sweep} />
      </div>
    );
  }
  if (variant === "Aluminum") {
    // Brushed machined-aluminum cap with a thin LED value arc around the rim.
    const arcThickness = styleParam<number>(el, "arcThickness", 3);
    const showValueArc = styleParam<boolean>(el, "showValueArc", true);
    const brushIntensity = styleParam<number>(el, "brushIntensity", 50);
    const bezelWidth = styleParam<number>(el, "bezelWidth", 4);
    const arc = arcGeom(47);
    const arcW = 3.5 * (arcThickness / 3);
    const brushA = Math.min(1, Math.max(0, 0.1 * (brushIntensity / 50)));
    const capPct = 80 * capFactor;
    return (
      <div
        ref={containerRef}
        className={`w-full h-full rounded-full relative ${isPreview ? "cursor-ns-resize" : ""}`}
        style={{ boxShadow: "0 6px 14px rgba(0,0,0,0.55)" }}
      >
        {/* LED value arc (rim) */}
        {showValueArc && (
          <svg
            className="absolute inset-0 w-full h-full pointer-events-none"
            viewBox="0 0 100 100"
          >
            <circle
              cx="50"
              cy="50"
              r="47"
              fill="none"
              stroke="rgba(255,255,255,0.08)"
              strokeWidth={arcW}
              strokeDasharray={`${arc.len} ${arc.c}`}
              strokeLinecap="round"
              transform={`rotate(${arc.rot} 50 50)`}
            />
            <circle
              cx="50"
              cy="50"
              r="47"
              fill="none"
              stroke="var(--active-color)"
              strokeWidth={arcW}
              strokeDasharray={`${(val / 100) * arc.len} ${arc.c}`}
              strokeLinecap="round"
              transform={`rotate(${arc.rot} 50 50)`}
              style={{ filter: "drop-shadow(0 0 1.5px var(--active-color))" }}
            />
          </svg>
        )}
        {/* Machined metal cap (static) — spun/anisotropic brushing + domed metal + top light */}
        <div
          className="absolute inset-0 m-auto rounded-full"
          style={{
            width: `${capPct}%`,
            height: `${capPct}%`,
            background: `repeating-conic-gradient(from 0deg at 50% 50%, rgba(255,255,255,${brushA}) 0deg 0.5deg, rgba(0,0,0,${brushA}) 0.5deg 1deg), radial-gradient(circle at 50% 32%, color-mix(in srgb, var(--base-color) 30%, #f4f6f8) 0%, color-mix(in srgb, var(--base-color) 55%, #b7bcc4) 48%, color-mix(in srgb, var(--base-color) 70%, #2a2d33) 100%)`,
            boxShadow:
              "inset 0 2px 3px rgba(255,255,255,0.4), inset 0 -4px 7px rgba(0,0,0,0.55), 0 2px 4px rgba(0,0,0,0.45)",
            border: `${bezelWidth / 4}px solid rgba(0,0,0,0.5)`,
          }}
        />
        {/* Recessed indicator line (rotates) */}
        <div
          className="absolute inset-0 m-auto rounded-full flex items-start justify-center pt-[9%]"
          style={{
            width: `${capPct}%`,
            height: `${capPct}%`,
            transform: `rotate(${rot}deg)`,
          }}
        >
          <div
            className="rounded-full"
            style={{
              width: `${0.25 * thickFactor}rem`,
              height: `${30 * lenFactor}%`,
              backgroundColor: "var(--indicator-color)",
              boxShadow:
                "inset 0 0 1px rgba(0,0,0,0.9), 0 1px 0 rgba(255,255,255,0.3)",
            }}
          />
        </div>
        <KnobTicks count={tickCount} sweep={sweep} />
      </div>
    );
  }
  if (variant === "Vintage") {
    // Bakelite chicken-head pointer with a printed tick scale ring.
    const pointerWidth = styleParam<number>(el, "pointerWidth", 30);
    const bodyPct = 74 * capFactor;
    const tickSpan = sweep / 10;
    return (
      <div
        ref={containerRef}
        className={`w-full h-full rounded-full relative ${isPreview ? "cursor-ns-resize" : ""}`}
        style={{ boxShadow: "0 5px 12px rgba(0,0,0,0.5)" }}
      >
        {/* Printed tick scale ring (static, spans the sweep angle) */}
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none"
          viewBox="0 0 100 100"
        >
          {Array.from({ length: 11 }, (_, i) => {
            const a = ((-sweep / 2 + i * tickSpan) * Math.PI) / 180;
            const outer = 48;
            const inner = i % 5 === 0 ? 40 : 43.5;
            return (
              <line
                key={i}
                x1={50 + outer * Math.sin(a)}
                y1={50 - outer * Math.cos(a)}
                x2={50 + inner * Math.sin(a)}
                y2={50 - inner * Math.cos(a)}
                stroke="var(--text-color)"
                strokeWidth={i % 5 === 0 ? 2 : 1.2}
                strokeLinecap="round"
                opacity={0.6}
              />
            );
          })}
        </svg>
        {/* Bakelite body + tapered pointer (rotates) */}
        <div
          className="absolute inset-0 m-auto rounded-full"
          style={{
            width: `${bodyPct}%`,
            height: `${bodyPct}%`,
            transform: `rotate(${rot}deg)`,
          }}
        >
          {/* Bakelite hub */}
          <div
            className="absolute inset-0 rounded-full"
            style={{
              background:
                "radial-gradient(circle at 40% 30%, color-mix(in srgb, var(--base-color) 78%, #ffffff) 0%, var(--base-color) 55%, color-mix(in srgb, var(--base-color) 55%, #000000) 100%)",
              boxShadow:
                "inset 0 2px 3px rgba(255,226,180,0.18), inset 0 -5px 9px rgba(0,0,0,0.6), 0 1px 2px rgba(0,0,0,0.4)",
            }}
          />
          {/* Cream/ivory chicken-head pointer */}
          <div
            className="absolute left-1/2 -translate-x-1/2 -top-[6%] h-[56%]"
            style={{
              width: `${26 * (pointerWidth / 30)}%`,
              clipPath: "polygon(50% 0%, 88% 100%, 12% 100%)",
              background:
                "linear-gradient(to bottom, #f7f0dc 0%, #e7dcbc 55%, #cdbf95 100%)",
              boxShadow: "0 1px 2px rgba(0,0,0,0.45)",
            }}
          />
          {/* Color-honoring indicator stripe */}
          <div
            className="absolute left-1/2 -translate-x-1/2 top-[2%] rounded-full"
            style={{
              width: `${4 * thickFactor}%`,
              height: `${42 * lenFactor}%`,
              backgroundColor: "var(--indicator-color)",
              opacity: 0.85,
            }}
          />
        </div>
        <KnobTicks count={tickCount} sweep={sweep} />
      </div>
    );
  }
  if (variant === "LED Ring") {
    // DJ-style dark matte cap ringed by discrete LED segments lit by value.
    const ledSegments = Math.max(
      2,
      Math.round(styleParam<number>(el, "ledSegments", 15)),
    );
    const ledUnlitOpacity = styleParam<number>(el, "ledUnlitOpacity", 15) / 100;
    const glowStrength = styleParam<number>(el, "glowStrength", 50);
    const litCount = Math.round((val / 100) * ledSegments);
    const step = ledSegments > 1 ? sweep / (ledSegments - 1) : 0;
    const glowPx = 1.5 * (glowStrength / 50);
    const capPct = 68 * capFactor;
    const dotPct = 10 * thickFactor;
    return (
      <div
        ref={containerRef}
        className={`w-full h-full rounded-full relative ${isPreview ? "cursor-ns-resize" : ""}`}
        style={{ boxShadow: "0 5px 12px rgba(0,0,0,0.5)" }}
      >
        {/* Discrete LED segment ring */}
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none"
          viewBox="0 0 100 100"
        >
          {Array.from({ length: ledSegments }, (_, i) => {
            const a = ((-sweep / 2 + i * step) * Math.PI) / 180;
            const lit = i < litCount;
            return (
              <line
                key={i}
                x1={50 + 40 * Math.sin(a)}
                y1={50 - 40 * Math.cos(a)}
                x2={50 + 47 * Math.sin(a)}
                y2={50 - 47 * Math.cos(a)}
                stroke="var(--active-color)"
                strokeWidth={4.5}
                strokeLinecap="round"
                opacity={lit ? 1 : ledUnlitOpacity}
                style={
                  lit
                    ? { filter: `drop-shadow(0 0 ${glowPx}px var(--active-color))` }
                    : undefined
                }
              />
            );
          })}
        </svg>
        {/* Dark matte cap (rotates) with bright dot indicator */}
        <div
          className="absolute inset-0 m-auto rounded-full flex items-start justify-center pt-[12%]"
          style={{
            width: `${capPct}%`,
            height: `${capPct}%`,
            transform: `rotate(${rot}deg)`,
            background:
              "radial-gradient(circle at 50% 35%, color-mix(in srgb, var(--base-color) 92%, #ffffff) 0%, var(--base-color) 55%, color-mix(in srgb, var(--base-color) 70%, #000000) 100%)",
            boxShadow:
              "0 3px 6px rgba(0,0,0,0.55), inset 0 1px 1px rgba(255,255,255,0.06), inset 0 -3px 5px rgba(0,0,0,0.4)",
            border: "1px solid rgba(0,0,0,0.6)",
          }}
        >
          <div
            className="rounded-full"
            style={{
              width: `${dotPct}%`,
              height: `${dotPct}%`,
              backgroundColor: "var(--indicator-color)",
              boxShadow:
                "0 0 4px var(--indicator-color), 0 0 8px color-mix(in srgb, var(--indicator-color) 60%, transparent)",
            }}
          />
        </div>
        <KnobTicks count={tickCount} sweep={sweep} />
      </div>
    );
  }
  if (variant === "Glass") {
    // Translucent glass dome with value-driven inner glow and specular highlight.
    const domeOpacity = styleParam<number>(el, "domeOpacity", 60);
    const glowStrength = styleParam<number>(el, "glowStrength", 50);
    const bezelWidth = styleParam<number>(el, "bezelWidth", 4);
    const bezelVisible = 7 * (bezelWidth / 4);
    const domeSize = (100 - 2 * bezelVisible) * capFactor;
    const domeMix = Math.min(100, 78 * (domeOpacity / 60));
    const glowMix = Math.min(100, val * (glowStrength / 50));
    return (
      <div
        ref={containerRef}
        className={`w-full h-full rounded-full relative ${isPreview ? "cursor-ns-resize" : ""}`}
        style={{ boxShadow: "0 6px 14px rgba(0,0,0,0.5)" }}
      >
        {/* Thin metallic bezel */}
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background:
              "conic-gradient(from 90deg, #8a8f99, #e9edf2, #6b7079, #d7dbe2, #8a8f99, #e9edf2, #6b7079)",
            boxShadow: "0 1px 2px rgba(0,0,0,0.5)",
          }}
        />
        {/* Glass dome */}
        <div
          className="absolute inset-0 m-auto rounded-full overflow-hidden"
          style={{
            width: `${domeSize}%`,
            height: `${domeSize}%`,
            background: `radial-gradient(circle at 50% 30%, rgba(255,255,255,0.32) 0%, rgba(255,255,255,0.06) 42%, rgba(0,0,0,0.18) 100%), radial-gradient(circle at 50% 58%, color-mix(in srgb, var(--active-color) ${glowMix}%, transparent) 0%, transparent 62%), color-mix(in srgb, var(--base-color) ${domeMix}%, transparent)`,
            boxShadow:
              "inset 0 2px 6px rgba(255,255,255,0.45), inset 0 -7px 13px rgba(0,0,0,0.4), 0 2px 5px rgba(0,0,0,0.4)",
            border: "1px solid rgba(255,255,255,0.15)",
          }}
        >
          {/* Refraction-ish inner ring */}
          <div
            className="absolute inset-0 m-auto w-[62%] h-[62%] rounded-full"
            style={{
              border: "1px solid rgba(255,255,255,0.18)",
              boxShadow:
                "inset 0 0 6px rgba(255,255,255,0.12), inset 0 2px 4px rgba(0,0,0,0.25)",
            }}
          />
          {/* Rotating light-streak indicator */}
          <div
            className="absolute inset-0 flex items-start justify-center pt-[10%]"
            style={{ transform: `rotate(${rot}deg)` }}
          >
            <div
              className="rounded-full"
              style={{
                width: `${3 * thickFactor}%`,
                height: `${34 * lenFactor}%`,
                backgroundColor: "var(--indicator-color)",
                boxShadow: "0 0 4px var(--indicator-color)",
                opacity: 0.9,
              }}
            />
          </div>
          {/* Specular highlight ellipse */}
          <div
            className="absolute left-[20%] top-[10%] w-[46%] h-[28%] pointer-events-none"
            style={{
              background:
                "linear-gradient(to bottom, rgba(255,255,255,0.85) 0%, rgba(255,255,255,0) 100%)",
              borderRadius: "50%",
              filter: "blur(1px)",
            }}
          />
        </div>
        <KnobTicks count={tickCount} sweep={sweep} />
      </div>
    );
  }
  if (variant === "Jog Wheel") {
    // DJ endless encoder: a large flat platter with concentric machined rings,
    // a dotted position marker that maps the full 360° (no sweep limits), a
    // touch-surface center disc in the base color, and a thin active-color glow
    // rim. No drag/pressed state is exposed to this control, so the rim is
    // rendered statically rather than only-while-dragging.
    const jogRot = val * 3.6;
    const platterPct = 92 * capFactor;
    const discPct = 46 * capFactor;
    const dotPct = 6 * thickFactor;
    return (
      <div
        ref={containerRef}
        className={`w-full h-full rounded-full relative ${isPreview ? "cursor-ns-resize" : ""}`}
        style={{ boxShadow: "0 6px 16px rgba(0,0,0,0.55)" }}
      >
        {/* Thin glow rim (active color) */}
        <div
          className="absolute inset-0 rounded-full"
          style={{
            border: "2px solid color-mix(in srgb, var(--active-color) 70%, transparent)",
            boxShadow:
              "0 0 6px var(--active-color), inset 0 0 4px color-mix(in srgb, var(--active-color) 60%, transparent)",
          }}
        />
        {/* Flat platter with concentric machined rings */}
        <div
          className="absolute inset-0 m-auto rounded-full"
          style={{
            width: `${platterPct}%`,
            height: `${platterPct}%`,
            background:
              "repeating-radial-gradient(circle at 50% 50%, rgba(255,255,255,0.06) 0px, rgba(255,255,255,0.06) 1px, rgba(0,0,0,0.22) 1px, rgba(0,0,0,0.22) 4px), radial-gradient(circle at 50% 38%, color-mix(in srgb, var(--base-color) 55%, #2a2d33) 0%, color-mix(in srgb, var(--base-color) 78%, #14161a) 70%, #0b0c0f 100%)",
            boxShadow:
              "inset 0 2px 4px rgba(255,255,255,0.08), inset 0 -6px 12px rgba(0,0,0,0.6), 0 2px 4px rgba(0,0,0,0.5)",
            border: "1px solid rgba(0,0,0,0.6)",
          }}
        />
        {/* Rotating dotted position marker (full 360° mapping) */}
        <div
          className="absolute inset-0"
          style={{ transform: `rotate(${jogRot}deg)` }}
        >
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="absolute left-1/2 -translate-x-1/2 rounded-full"
              style={{
                top: `${5 + i * 7}%`,
                width: `${dotPct}%`,
                height: `${dotPct}%`,
                backgroundColor: "var(--active-color)",
                boxShadow: "0 0 4px var(--active-color)",
                opacity: 1 - i * 0.25,
              }}
            />
          ))}
        </div>
        {/* Touch-surface center disc (base color) */}
        <div
          className="absolute inset-0 m-auto rounded-full"
          style={{
            width: `${discPct}%`,
            height: `${discPct}%`,
            background:
              "radial-gradient(circle at 50% 35%, color-mix(in srgb, var(--base-color) 88%, #ffffff) 0%, var(--base-color) 55%, color-mix(in srgb, var(--base-color) 72%, #000000) 100%)",
            boxShadow:
              "inset 0 1px 2px rgba(255,255,255,0.15), inset 0 -3px 6px rgba(0,0,0,0.5), 0 2px 4px rgba(0,0,0,0.5)",
            border: "1px solid rgba(0,0,0,0.5)",
          }}
        />
        <KnobTicks count={tickCount} sweep={sweep} />
      </div>
    );
  }
  // Default (Modern)
  return simpleKnob(
    "rounded-full border-2 flex items-start justify-center pt-1",
    {
      backgroundColor: "var(--base-color)",
      borderColor: "var(--active-color)",
      boxShadow:
        "0 0 15px color-mix(in srgb, var(--active-color) 30%, transparent)",
    },
    "rounded-full",
    0.25,
    25,
  );
}
