import React, { useState, useRef, useEffect } from "react";

interface CustomSelectProps {
  value: string;
  onChange: (val: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  className?: string;
  /**
   * Accessible name for this custom button-dropdown. Required whenever the
   * control has no adjacent visible <label htmlFor> association (custom
   * controls can't be wrapped in <label>). Applied as aria-label on the
   * focusable trigger.
   */
  ariaLabel?: string;
}

export default function CustomSelect({
  value,
  onChange,
  options,
  disabled,
  className = "",
  ariaLabel,
}: CustomSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  const handleWheel = (e: React.WheelEvent) => {
    if (disabled) return;
    if (isOpen) return;
    if (!isFocused) return;

    e.preventDefault();
    e.stopPropagation();

    // Cycle through options
    const currentIndex = options.findIndex((o) => o.value === value);
    if (e.deltaY > 0) {
      // scroll down -> next item
      if (currentIndex < options.length - 1) {
        onChange(options[currentIndex + 1].value);
      }
    } else if (e.deltaY < 0) {
      // scroll up -> prev item
      if (currentIndex > 0) {
        onChange(options[currentIndex - 1].value);
      }
    }
  };

  const selectedOption = options.find((o) => o.value === value);

  return (
    <div
      className={`relative text-xs ${className} ${disabled ? "opacity-50 pointer-events-none" : ""}`}
      ref={containerRef}
      onWheel={handleWheel}
      tabIndex={disabled ? -1 : 0}
      onFocus={() => setIsFocused(true)}
      onBlur={() => setIsFocused(false)}
      role="button"
      aria-haspopup="listbox"
      aria-expanded={isOpen}
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
    >
      <div
        className="w-full bg-app-surface neu-panel-inset border border-app-border rounded-md px-2 py-1.5 flex items-center justify-between cursor-pointer"
        onClick={() => !disabled && setIsOpen(!isOpen)}
      >
        <span className="truncate pr-2 text-app-main">
          {selectedOption?.label || value}
        </span>
        <svg
          className="w-3 h-3 text-app-muted shrink-0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d={isOpen ? "M5 15l7-7 7 7" : "M19 9l-7 7-7-7"}
          />
        </svg>
      </div>

      {isOpen && (
        <div className="absolute top-full left-0 w-full mt-1 bg-app-surface border border-app-border rounded-md shadow-[0_4px_20px_rgba(0,0,0,0.5)] z-9999 max-h-48 overflow-y-auto">
          {options.map((opt) => (
            <div
              key={opt.value}
              className={`px-2 py-1.5 cursor-pointer hover:bg-app-accent hover:text-white transition-colors ${opt.value === value ? "bg-app-accent/20 text-app-accent" : "text-app-main"}`}
              onClick={(e) => {
                e.stopPropagation();
                onChange(opt.value);
                // Keep open per user instruction
              }}
            >
              {opt.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
