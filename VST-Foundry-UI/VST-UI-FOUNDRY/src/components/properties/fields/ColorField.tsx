import React from "react";

/**
 * The color-swatch + hex-text input pair shared by both properties panels. This
 * two-input structure was duplicated many times across both files. All classes,
 * values and disabled flags are supplied per-instance so the rendered output
 * stays byte-identical to the original inline markup (including cases where the
 * text input is intentionally not disabled while the swatch is).
 */
export interface ColorFieldProps {
  /** Shared `name` applied to both inputs (omit for inputs updated via a custom onChange). */
  name?: string;
  /** Value bound to the `<input type="color">` swatch. */
  colorValue: string;
  /** Value bound to the `<input type="text">` hex field. */
  textValue: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  colorDisabled?: boolean;
  textDisabled?: boolean;
  placeholder?: string;
  wrapperClassName?: string;
  colorClassName?: string;
  textClassName?: string;
}

export default function ColorField({
  name,
  colorValue,
  textValue,
  onChange,
  colorDisabled,
  textDisabled,
  placeholder,
  wrapperClassName,
  colorClassName,
  textClassName,
}: ColorFieldProps) {
  return (
    <div className={wrapperClassName}>
      <input
        type="color"
        name={name}
        value={colorValue}
        onChange={onChange}
        disabled={colorDisabled}
        className={colorClassName}
      />
      <input
        type="text"
        name={name}
        value={textValue}
        onChange={onChange}
        placeholder={placeholder}
        disabled={textDisabled}
        className={textClassName}
      />
    </div>
  );
}
