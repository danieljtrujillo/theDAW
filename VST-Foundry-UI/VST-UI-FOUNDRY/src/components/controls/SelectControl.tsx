import React, { useState } from "react";
import { BaseControlProps } from "./shared";
import { styleParam } from "./controlParams";

interface SelectControlProps extends BaseControlProps {
  isOpen: boolean;
  setIsOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

export default function SelectControl({
  el,
  variant,
  isPreview,
  isOpen,
  setIsOpen,
}: SelectControlProps) {
  // Local selection index for the Segmented bank. Mirrors the interaction
  // contract of the other variants: interactive only in preview, otherwise
  // static. (The dropdown variants likewise keep selection state in-session.)
  const [selectedIndex, setSelectedIndex] = useState(0);

  const fontSize = styleParam(el, "fontSize", 12);
  const chevronSize = styleParam(el, "chevronSize", 8);

  if (variant === "Segmented") {
    const options =
      el.options && el.options.length > 0
        ? el.options
        : ["Seg 1", "Seg 2", "Seg 3"];
    return (
      <div
        role="radiogroup"
        aria-label={el.label || "Segmented control"}
        className="w-full h-full flex items-stretch rounded overflow-hidden border select-none"
        style={{
          borderColor: "rgba(255,255,255,0.1)",
          fontSize: `${fontSize}px`,
        }}
      >
        {options.map((opt, i) => {
          const selected = i === selectedIndex;
          return (
            <button
              key={`${opt}-${i}`}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={opt}
              tabIndex={isPreview ? 0 : -1}
              className={`flex-1 min-w-0 flex items-center justify-center px-2 truncate transition-colors ${
                i > 0 ? "border-l" : ""
              } ${isPreview ? "cursor-pointer" : "cursor-default"}`}
              style={{
                borderColor: "rgba(0,0,0,0.4)",
                backgroundColor: selected
                  ? "var(--active-color)"
                  : "color-mix(in srgb, var(--base-color) 88%, #000)",
                color: selected
                  ? "var(--base-color)"
                  : "color-mix(in srgb, var(--text-color) 70%, transparent)",
                boxShadow: selected
                  ? "inset 0 1px 3px rgba(0,0,0,0.55), 0 0 8px color-mix(in srgb, var(--active-color) 60%, transparent)"
                  : "inset 0 1px 0 rgba(255,255,255,0.04)",
              }}
              onClick={(e) => {
                if (isPreview) {
                  e.stopPropagation();
                  setSelectedIndex(i);
                }
              }}
            >
              <span className="truncate">{opt}</span>
            </button>
          );
        })}
      </div>
    );
  }

  if (variant === "Brutalist") {
    return (
      <div
        className={`w-full h-full px-2 py-1 border-[3px] border-black font-bold uppercase flex justify-between items-center relative shadow-[4px_4px_0_0_#000] ${isPreview ? "cursor-pointer hover:opacity-90" : ""}`}
        style={{
          backgroundColor: "var(--base-color)",
          color: "var(--active-color)",
          fontSize: `${fontSize}px`,
        }}
        onClick={(e) => {
          if (isPreview) {
            e.stopPropagation();
            setIsOpen(!isOpen);
          }
        }}
      >
        <span className="truncate">{el.label || "CHOOSE"}</span>
        <div
          className={`w-0 h-0 transition-transform ${isOpen ? "rotate-180" : ""}`}
          style={{
            borderLeftWidth: `${chevronSize * 0.625}px`,
            borderRightWidth: `${chevronSize * 0.625}px`,
            borderTopWidth: `${chevronSize}px`,
            borderLeftColor: "transparent",
            borderRightColor: "transparent",
            borderLeftStyle: "solid",
            borderRightStyle: "solid",
            borderTopStyle: "solid",
            borderTopColor: "var(--active-color)",
          }}
        />

        {isOpen && isPreview && (
          <div
            className="absolute top-[calc(100%+4px)] left-[-3px] w-[calc(100%+6px)] border-[3px] border-black shadow-[4px_4px_0_0_#000] z-50 flex flex-col"
            style={{ backgroundColor: "var(--base-color)" }}
          >
            {["Option 1", "Option 2", "Option 3"].map((opt) => (
              <div
                key={opt}
                className="px-2 py-1.5 font-bold uppercase border-b-2 border-black last:border-b-0 transition-colors hover:bg-black hover:text-white"
                onClick={() => setIsOpen(false)}
              >
                {opt}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  if (variant === "Blank") {
    // Minimal neutral select: plain rect in --base-color (hairline border),
    // current value text in --text-color, and a simple filled triangle chevron.
    // fontSize + chevronSize are wired; the open/select contract mirrors the
    // Dropdown default exactly (toggle open, item click closes).
    return (
      <div
        className={`w-full h-full px-2 py-1.5 border rounded flex justify-between items-center relative ${isPreview ? "cursor-pointer" : ""}`}
        style={{
          backgroundColor: "var(--base-color)",
          borderColor: "color-mix(in srgb, var(--text-color) 15%, transparent)",
          color: "var(--text-color)",
          fontSize: `${fontSize}px`,
        }}
        onClick={(e) => {
          if (isPreview) {
            e.stopPropagation();
            setIsOpen(!isOpen);
          }
        }}
      >
        <span className="truncate">{el.label || "Select..."}</span>
        <div
          className={`w-0 h-0 transition-transform ${isOpen ? "rotate-180" : ""}`}
          style={{
            borderLeftWidth: `${chevronSize * 0.625}px`,
            borderRightWidth: `${chevronSize * 0.625}px`,
            borderTopWidth: `${chevronSize}px`,
            borderLeftColor: "transparent",
            borderRightColor: "transparent",
            borderLeftStyle: "solid",
            borderRightStyle: "solid",
            borderTopStyle: "solid",
            borderTopColor: "var(--text-color)",
          }}
        />

        {isOpen && isPreview && (
          <div
            className="absolute top-full left-0 w-full mt-1 border rounded z-50 flex flex-col overflow-hidden"
            style={{
              backgroundColor: "var(--base-color)",
              borderColor: "color-mix(in srgb, var(--text-color) 15%, transparent)",
            }}
          >
            {["Option 1", "Option 2", "Option 3"].map((opt) => (
              <div
                key={opt}
                className="px-2 py-1.5 hover:bg-black/20 transition-colors"
                onClick={() => setIsOpen(false)}
              >
                {opt}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  // Default (Dropdown)
  return (
    <div
      className={`w-full h-full px-2 py-1.5 border rounded flex justify-between items-center relative ${isPreview ? "cursor-pointer" : ""}`}
      style={{
        backgroundColor: "var(--base-color)",
        borderColor: "rgba(255,255,255,0.1)",
        color: "var(--active-color)",
        fontSize: `${fontSize}px`,
      }}
      onClick={(e) => {
        if (isPreview) {
          e.stopPropagation();
          setIsOpen(!isOpen);
        }
      }}
    >
      <span className="truncate">{el.label || "Select..."}</span>
      <div
        className={`border-r border-b transition-transform ${isOpen ? "-rotate-135" : "rotate-45 mb-1"}`}
        style={{
          width: `${chevronSize}px`,
          height: `${chevronSize}px`,
          borderColor: "var(--active-color)",
        }}
      />

      {isOpen && isPreview && (
        <div
          className="absolute top-full left-0 w-full mt-1 border rounded shadow-lg z-50 flex flex-col overflow-hidden"
          style={{
            backgroundColor: "var(--base-color)",
            borderColor: "rgba(255,255,255,0.1)",
          }}
        >
          {["Option 1", "Option 2", "Option 3"].map((opt) => (
            <div
              key={opt}
              className="px-2 py-1.5 hover:bg-black/20 transition-colors"
              onClick={() => setIsOpen(false)}
            >
              {opt}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
