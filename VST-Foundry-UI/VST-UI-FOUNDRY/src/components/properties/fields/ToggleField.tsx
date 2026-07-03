import React from "react";

/**
 * Thin controlled checkbox shared by both properties panels. Renders exactly a
 * single native `<input type="checkbox">`; the surrounding label markup stays
 * with the caller so each panel keeps its own layout and byte-identical output.
 */
export interface ToggleFieldProps {
  id?: string;
  name?: string;
  checked: boolean;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  className?: string;
}

export default function ToggleField({
  id,
  name,
  checked,
  onChange,
  disabled,
  className,
}: ToggleFieldProps) {
  return (
    <input
      type="checkbox"
      id={id}
      name={name}
      checked={checked}
      onChange={onChange}
      disabled={disabled}
      className={className}
    />
  );
}
