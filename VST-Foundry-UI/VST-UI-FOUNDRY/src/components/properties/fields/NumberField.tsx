import React from "react";

/**
 * Thin controlled numeric input shared by both properties panels. Renders
 * exactly a single native `<input type="number">`; parsing/validation is the
 * caller's responsibility (see `parseNumericInput` / the shared change handler)
 * so the mid-edit affordances remain identical to the original inline inputs.
 */
export interface NumberFieldProps {
  name?: string;
  value: number | string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  className?: string;
}

export default function NumberField({
  name,
  value,
  onChange,
  disabled,
  className,
}: NumberFieldProps) {
  return (
    <input
      type="number"
      name={name}
      value={value}
      onChange={onChange}
      disabled={disabled}
      className={className}
    />
  );
}
