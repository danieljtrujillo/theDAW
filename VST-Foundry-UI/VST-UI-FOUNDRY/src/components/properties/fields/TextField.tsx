import React from "react";

/**
 * Thin controlled text input shared by both properties panels. Renders exactly
 * a single native `<input type="text">`; all styling is supplied by the caller
 * via `className` so each panel keeps its own look and byte-identical output.
 */
export interface TextFieldProps {
  name?: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
}

export default function TextField({
  name,
  value,
  onChange,
  disabled,
  placeholder,
  className,
}: TextFieldProps) {
  return (
    <input
      type="text"
      name={name}
      value={value}
      onChange={onChange}
      disabled={disabled}
      placeholder={placeholder}
      className={className}
    />
  );
}
