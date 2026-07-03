import type { CSSProperties } from "react";
import type { UIElement } from "../../types";
import { styleParam } from "./controlParams";

export interface StepSequencerControlProps {
  el: UIElement;
  variant: string;
  isPreview: boolean;
  onStyleParams?: (patch: Record<string, number | string | boolean>) => void;
}

/**
 * Hardware-style step-sequencer grid. Pads are laid out as `rows` x `steps`
 * LED cells; the on/off state is stored as a row-major string of "0"/"1" in
 * `styleParams.pattern` (index = r * steps + c). The stored string is tolerant
 * of length drift — shorter strings read as unlit past their end, longer ones
 * are truncated to the current grid size on the next write. Clicking a pad
 * toggles a single cell and emits one `onStyleParams({ pattern })` write in
 * both preview and editor modes.
 */
export default function StepSequencerControl({
  el,
  isPreview,
  onStyleParams,
}: StepSequencerControlProps) {
  const rows = Math.max(1, Math.round(styleParam<number>(el, "rows", 4)));
  const steps = Math.max(1, Math.round(styleParam<number>(el, "steps", 16)));
  const cellGap = Math.max(0, styleParam<number>(el, "cellGap", 2));
  const accentEvery = Math.max(1, Math.round(styleParam<number>(el, "accentEvery", 4)));
  const pattern = styleParam<string>(el, "pattern", "");
  const total = rows * steps;

  const handleToggle = (idx: number) => {
    // Normalize to the current grid size (tolerating short/long stored strings),
    // flip one cell, and write the whole pattern back in a single update.
    const chars: string[] = new Array(total);
    for (let i = 0; i < total; i++) chars[i] = pattern[i] === "1" ? "1" : "0";
    chars[idx] = chars[idx] === "1" ? "0" : "1";
    onStyleParams?.({ pattern: chars.join("") });
  };

  const padStyle = (lit: boolean, accent: boolean): CSSProperties => {
    if (lit) {
      return {
        background: `linear-gradient(180deg,
          color-mix(in srgb, var(--active-color) 85%, #fff) 0%,
          var(--active-color) 45%,
          color-mix(in srgb, var(--active-color) 75%, #000) 100%)`,
        boxShadow: `
          0 0 5px var(--active-color),
          0 0 10px color-mix(in srgb, var(--active-color) 45%, transparent),
          inset 0 1px 0 rgba(255,255,255,0.55),
          inset 0 -1px 2px rgba(0,0,0,0.4)`,
      };
    }
    if (accent) {
      // Beat-mark column: a slightly brighter unlit shade.
      return {
        backgroundColor: "rgba(0,0,0,0.5)",
        background: "linear-gradient(180deg, rgba(255,255,255,0.10) 0%, rgba(0,0,0,0.35) 100%)",
        boxShadow: "inset 0 1px 2px rgba(0,0,0,0.7), inset 0 0 0 1px rgba(255,255,255,0.06)",
      };
    }
    return {
      backgroundColor: "rgba(0,0,0,0.5)",
      background: "linear-gradient(180deg, rgba(255,255,255,0.02) 0%, rgba(0,0,0,0.45) 100%)",
      boxShadow: "inset 0 1px 2px rgba(0,0,0,0.85), inset 0 0 0 1px rgba(255,255,255,0.03)",
    };
  };

  return (
    <div
      className="w-full h-full relative rounded-md overflow-hidden select-none"
      style={{
        background: `linear-gradient(180deg,
          color-mix(in srgb, var(--base-color) 78%, #000) 0%,
          color-mix(in srgb, var(--base-color) 58%, #000) 100%)`,
        boxShadow: `
          inset 0 1px 0 rgba(255,255,255,0.08),
          inset 0 -1px 2px rgba(0,0,0,0.6),
          inset 0 0 0 1px rgba(0,0,0,0.4)`,
      }}
    >
      <div
        className="absolute inset-0"
        style={{ padding: 6, paddingBottom: el.label ? 16 : 6 }}
      >
        <div className="relative w-full h-full">
          {/* Subtle row separators — sit in the inter-row gaps behind the pads. */}
          {Array.from({ length: rows - 1 }, (_, i) => (
            <div
              key={`sep-${i}`}
              className="absolute left-0 right-0 pointer-events-none"
              style={{
                top: `${((i + 1) / rows) * 100}%`,
                height: 1,
                backgroundColor: "var(--text-color)",
                opacity: 0.06,
              }}
            />
          ))}

          {/* Pad grid. */}
          <div
            className="absolute inset-0 grid"
            style={{
              gridTemplateColumns: `repeat(${steps}, 1fr)`,
              gridTemplateRows: `repeat(${rows}, 1fr)`,
              gap: `${cellGap}px`,
            }}
          >
            {Array.from({ length: rows }, (_, r) =>
              Array.from({ length: steps }, (_, c) => {
                const idx = r * steps + c;
                const lit = pattern[idx] === "1";
                const accent = c % accentEvery === 0;
                return (
                  <div
                    key={idx}
                    role="button"
                    aria-label={`Step ${c + 1}, row ${r + 1}`}
                    aria-pressed={lit}
                    className="rounded-[3px] cursor-pointer"
                    onClick={(e) => {
                      if (isPreview) e.stopPropagation();
                      handleToggle(idx);
                    }}
                    style={padStyle(lit, accent)}
                  />
                );
              }),
            )}
          </div>
        </div>
      </div>

      {/* Label — consistent with the existing control label style. */}
      {el.label && (
        <div
          className="absolute bottom-1 left-1.5 text-[9px] font-mono tracking-widest uppercase truncate pointer-events-none max-w-[80%]"
          style={{ color: "var(--text-color)", opacity: 0.7 }}
        >
          {el.label}
        </div>
      )}
    </div>
  );
}
