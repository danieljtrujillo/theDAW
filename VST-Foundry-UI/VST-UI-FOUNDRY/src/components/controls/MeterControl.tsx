import React from "react";
import type { UIElement } from "../../types";
import { styleParam } from "./controlParams";

interface MeterControlProps {
  el: UIElement;
  variant: string;
  val: number;
}

export default function MeterControl({ el, variant, val }: MeterControlProps) {
  const bezelWidth = styleParam(el, "bezelWidth", 1);

  // Image-face branch: when el.faceSrc is set the meter wears a cutout. Two
  // modes (C2): "fill" reveals the image bottom-up to val% (clip-path inset from
  // the top) over a dimmed full copy, so the unlit region reads as a ghost;
  // "static" just shows the image. Meters are display-only — val is driven by
  // routes / LISTEN, so there's no drag wiring here. Both honor faceFit /
  // faceOpacity. Gated on faceSrc so every default (unset) render below stays
  // byte-identical to today.
  if (el.faceSrc) {
    const faceMode = styleParam<string>(el, "faceMode", "fill");
    const faceFit = styleParam(
      el,
      "faceFit",
      "contain",
    ) as React.CSSProperties["objectFit"];
    const faceOpacity = styleParam(el, "faceOpacity", 100) / 100;
    if (faceMode === "static") {
      return (
        <div className="w-full h-full relative overflow-hidden">
          <img
            src={el.faceSrc}
            alt=""
            draggable={false}
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{ objectFit: faceFit, opacity: faceOpacity }}
          />
        </div>
      );
    }
    // "fill" (default): a dimmed full copy underneath so the unlit region shows,
    // and the lit copy clipped from the top to reveal only the bottom val%.
    return (
      <div className="w-full h-full relative overflow-hidden">
        {/* dimmed unlit ghost */}
        <img
          src={el.faceSrc}
          alt=""
          draggable={false}
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{ objectFit: faceFit, opacity: faceOpacity * 0.25 }}
        />
        {/* lit fill clipped bottom-up to val% */}
        <img
          src={el.faceSrc}
          alt=""
          draggable={false}
          className="absolute inset-0 w-full h-full pointer-events-none"
          style={{
            objectFit: faceFit,
            opacity: faceOpacity,
            clipPath: `inset(${100 - val}% 0 0 0)`,
          }}
        />
      </div>
    );
  }

  if (variant === "Blank") {
    // Unbranded hardware blank: a plain vertical bar. Flat --base-color track,
    // an --active-color fill proportional to val (anchored at the bottom), and a
    // hairline border driven by bezelWidth. No zones/segments, gradients, or
    // shadows — flat colors only so the skin and texture systems supply all
    // material. Label rendered the same way its LED Segments sibling does.
    return (
      <div
        className="w-full h-full flex flex-col overflow-hidden"
        style={{
          backgroundColor: "var(--base-color)",
          borderColor: "color-mix(in srgb, var(--text-color) 30%, transparent)",
          borderWidth: `${bezelWidth}px`,
          borderStyle: "solid",
        }}
      >
        <div className="w-full flex-1 min-h-0 flex flex-col justify-end">
          <div
            className="w-full pointer-events-none"
            style={{
              height: `${val}%`,
              backgroundColor: "var(--active-color)",
            }}
          />
        </div>
        {el.label ? (
          <div
            className="w-full shrink-0 text-center text-[8px] leading-none uppercase tracking-wider truncate"
            style={{ color: "var(--text-color)", opacity: 0.6 }}
          >
            {el.label}
          </div>
        ) : null}
      </div>
    );
  }
  if (variant === "VU Meter") {
    const needleThickness = styleParam(el, "needleThickness", 2);
    return (
      <div
        className="w-full h-full bg-[#fdf5e6] border-app-border rounded relative overflow-hidden flex flex-col pt-2 px-2"
        style={{
          backgroundColor: "var(--base-color)",
          // VU historically had a 2px bezel; the shared schema default is now 1
          // (to match the 1px LED Segments / default-bar look), so double it here
          // to keep VU pixel-identical at the default.
          borderWidth: `${bezelWidth * 2}px`,
          borderStyle: "solid",
        }}
      >
        <div className="w-full h-1 flex gap-px">
          <div className="flex-1 bg-black/20" />
          <div className="flex-1 bg-black/20" />
          <div className="flex-1 bg-black/20" />
          <div className="flex-1 bg-black/20" />
          <div
            className="flex-1"
            style={{ backgroundColor: "var(--active-color)" }}
          />
        </div>
        <div
          className="h-full bg-black absolute bottom-0 left-1/2 origin-bottom transition-transform"
          style={{
            width: `${needleThickness}px`,
            transform: `rotate(${val * 0.6 - 30}deg)`,
          }}
        />
      </div>
    );
  }
  if (variant === "LED Segments") {
    // Classic segmented level meter: discrete segments lit bottom-to-top,
    // green -> amber -> red zones, dark housing with thin bezel. Segment count,
    // gap, zone boundaries and colors are all param-driven; the defaults
    // reproduce the previous 14-segment / 60% / 85% layout.
    const SEG = styleParam(el, "segmentCount", 14);
    const segmentGap = styleParam(el, "segmentGap", 1);
    const yellowStart = styleParam(el, "yellowStart", 60);
    const redStart = styleParam(el, "redStart", 85);
    // Green zone historically inherited the element's activeColor. Preserve that:
    // when the user hasn't explicitly set zoneGreen, fall back to activeColor
    // (then the schema-default green); once set, honor the stored value.
    const greenColor =
      el.styleParams?.zoneGreen !== undefined
        ? (el.styleParams.zoneGreen as string)
        : el.activeColor || "#22c55e";
    const amberColor = styleParam(el, "zoneAmber", "#f59e0b");
    const redColor = styleParam(el, "zoneRed", "#ef4444");
    const litCount = Math.round((val / 100) * SEG);
    const greenMax = Math.round(SEG * (yellowStart / 100)); // bottom green zone
    const amberMax = Math.round(SEG * (redStart / 100)); // green+amber zone
    return (
      <div
        className="w-full h-full flex flex-col items-center gap-1 rounded-md p-1"
        style={{
          background: "linear-gradient(180deg, #1a1a1e 0%, #0b0b0e 100%)",
          border: `${bezelWidth}px solid rgba(0,0,0,0.6)`,
          boxShadow:
            "inset 0 0 6px rgba(0,0,0,0.8), 0 0 0 1px rgba(255,255,255,0.06)",
        }}
      >
        <div
          className="w-full flex-1 min-h-0 flex flex-col-reverse"
          style={{ gap: `${segmentGap}px` }}
        >
          {Array.from({ length: SEG }).map((_, i) => {
            const lit = i < litCount;
            const color =
              i < greenMax ? greenColor : i < amberMax ? amberColor : redColor;
            return (
              <div
                key={i}
                className="w-full flex-1 pointer-events-none"
                style={{
                  borderRadius: "1px",
                  background: lit
                    ? `linear-gradient(180deg, color-mix(in srgb, ${color} 65%, #fff) 0%, ${color} 45%, color-mix(in srgb, ${color} 70%, #000) 100%)`
                    : `color-mix(in srgb, ${color} 14%, #050506)`,
                  boxShadow: lit
                    ? `0 0 5px color-mix(in srgb, ${color} 70%, transparent), inset 0 0 1px rgba(255,255,255,0.4)`
                    : "inset 0 0 2px rgba(0,0,0,0.6)",
                  opacity: lit ? 1 : 0.5,
                }}
              />
            );
          })}
        </div>
        {el.label ? (
          <div
            className="w-full shrink-0 text-center text-[8px] leading-none uppercase tracking-wider truncate"
            style={{ color: "var(--text-color)", opacity: 0.6 }}
          >
            {el.label}
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div
      className="w-full h-full p-1 flex flex-col gap-0.5"
      style={{
        backgroundColor: "var(--base-color)",
        borderColor: "rgba(255,255,255,0.1)",
        borderWidth: `${bezelWidth}px`,
        borderStyle: "solid",
      }}
    >
      {[...Array(8)].map((_, i) => (
        <div
          key={i}
          className={`flex-1 ${i < Math.floor(val / 12.5) ? "" : "opacity-20"}`}
          style={{ backgroundColor: "var(--active-color)" }}
        />
      ))}
    </div>
  );
}
