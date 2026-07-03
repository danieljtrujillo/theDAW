import { useEffect, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import type { UIElement } from "../../types";
import { styleParam } from "./controlParams";

export interface KeyboardControlProps {
  el: UIElement;
  variant: string;
  isPreview: boolean;
}

// Thin red-felt strip along the very top of the housing (px).
const FELT = 4;
// Local white-key indices (C D E F G A B => 0..6) that have a black key to
// their right: C#, D#, F#, G#, A# — none after E (2) or B (6).
const BLACK_OFFSETS = [0, 1, 3, 4, 5];

/**
 * Piano-strip control. Renders `octaves` (1-4) of white keys with black keys
 * overlaid in the correct per-octave pattern. Pressing a key highlights it in
 * `--active-color` while held; the highlight is local visual state only (no
 * persistence) and clears on pointer release anywhere. Interaction is gated to
 * preview mode so the editor keeps its normal drag/select behavior.
 */
export default function KeyboardControl({ el, isPreview }: KeyboardControlProps) {
  const octaves = Math.min(4, Math.max(1, Math.round(styleParam<number>(el, "octaves", 2))));
  const showLabels = styleParam<boolean>(el, "showLabels", false);

  const [activeKey, setActiveKey] = useState<string | null>(null);

  // A key stays lit until the pointer is released — even if released outside the
  // key or the control — so a single global listener clears the highlight.
  useEffect(() => {
    const clear = () => setActiveKey(null);
    window.addEventListener("pointerup", clear);
    window.addEventListener("pointercancel", clear);
    return () => {
      window.removeEventListener("pointerup", clear);
      window.removeEventListener("pointercancel", clear);
    };
  }, []);

  const totalWhite = 7 * octaves;
  const whiteWidthPct = 100 / totalWhite;
  const blackWidthPct = whiteWidthPct * 0.62;

  const blackKeys: { id: string; leftPct: number }[] = [];
  for (let o = 0; o < octaves; o++) {
    for (const off of BLACK_OFFSETS) {
      // Center the black key on the boundary between two adjacent white keys.
      const boundaryPct = (o * 7 + off + 1) * whiteWidthPct;
      blackKeys.push({ id: `b-${o}-${off}`, leftPct: boundaryPct - blackWidthPct / 2 });
    }
  }

  const press = (e: ReactPointerEvent, id: string) => {
    if (!isPreview) return;
    e.stopPropagation();
    setActiveKey(id);
  };

  const whiteStyle: CSSProperties = {
    background: "linear-gradient(180deg, #fdfdff 0%, #f2f2f6 60%, #dedee6 100%)",
    boxShadow:
      "inset -1px 0 0 rgba(0,0,0,0.18), inset 1px 0 0 rgba(255,255,255,0.7), inset 0 -3px 5px rgba(0,0,0,0.12)",
  };
  const whiteActiveStyle: CSSProperties = {
    background: `linear-gradient(180deg,
      color-mix(in srgb, var(--active-color) 45%, #fff) 0%,
      color-mix(in srgb, var(--active-color) 85%, #fff) 60%,
      var(--active-color) 100%)`,
    boxShadow: `inset -1px 0 0 rgba(0,0,0,0.2),
      inset 0 -3px 6px color-mix(in srgb, var(--active-color) 60%, #000),
      0 0 8px color-mix(in srgb, var(--active-color) 50%, transparent)`,
  };
  const blackStyle: CSSProperties = {
    background: "linear-gradient(180deg, #3a3a42 0%, #17171c 55%, #050506 100%)",
    boxShadow:
      "inset 0 -2px 3px rgba(0,0,0,0.8), inset 0 2px 2px rgba(255,255,255,0.12), 1px 2px 4px rgba(0,0,0,0.6)",
  };
  const blackActiveStyle: CSSProperties = {
    background:
      "linear-gradient(180deg, color-mix(in srgb, var(--active-color) 70%, #000) 0%, var(--active-color) 100%)",
    boxShadow:
      "inset 0 2px 2px rgba(255,255,255,0.2), 0 0 8px color-mix(in srgb, var(--active-color) 60%, transparent)",
  };

  return (
    <div
      className="w-full h-full relative rounded-md overflow-hidden select-none"
      style={{
        background: `linear-gradient(180deg,
          color-mix(in srgb, var(--base-color) 55%, #000) 0%,
          color-mix(in srgb, var(--base-color) 30%, #000) 100%)`,
        boxShadow: "inset 0 0 0 1px rgba(0,0,0,0.5), inset 0 2px 4px rgba(0,0,0,0.5)",
      }}
    >
      {/* Felt strip. */}
      <div
        className="absolute top-0 left-0 right-0 z-30 pointer-events-none"
        style={{
          height: FELT,
          background: `linear-gradient(180deg,
            color-mix(in srgb, var(--active-color) 55%, #000),
            color-mix(in srgb, var(--active-color) 30%, #000))`,
          boxShadow: "0 1px 2px rgba(0,0,0,0.6)",
        }}
      />

      {/* White keys. */}
      <div className="absolute left-0 right-0 bottom-0 flex z-10" style={{ top: FELT }}>
        {Array.from({ length: totalWhite }, (_, i) => {
          const id = `w-${i}`;
          const isC = i % 7 === 0;
          const active = activeKey === id;
          return (
            <div
              key={id}
              role="button"
              aria-label={`White key ${i + 1}`}
              aria-pressed={active}
              className={`relative flex-1 h-full rounded-b-[3px] ${isPreview ? "cursor-pointer" : ""}`}
              onPointerDown={(e) => press(e, id)}
              style={active ? whiteActiveStyle : whiteStyle}
            >
              {showLabels && isC && (
                <span
                  className="absolute bottom-0.5 left-0 right-0 text-center text-[8px] font-mono pointer-events-none"
                  style={{ color: active ? "#fff" : "rgba(0,0,0,0.45)" }}
                >
                  C
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Black keys — overlaid, shorter, above the white layer. */}
      <div
        className="absolute left-0 right-0 z-20 pointer-events-none"
        style={{ top: FELT, bottom: 0 }}
      >
        {blackKeys.map((bk) => {
          const active = activeKey === bk.id;
          return (
            <div
              key={bk.id}
              role="button"
              aria-label="Black key"
              aria-pressed={active}
              className={`absolute top-0 rounded-b-[3px] pointer-events-auto ${isPreview ? "cursor-pointer" : ""}`}
              onPointerDown={(e) => press(e, bk.id)}
              style={{
                left: `${bk.leftPct}%`,
                width: `${blackWidthPct}%`,
                height: "62%",
                ...(active ? blackActiveStyle : blackStyle),
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
