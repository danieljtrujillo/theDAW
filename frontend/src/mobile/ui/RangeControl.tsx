/** A labeled range bound to one manifest control id. Wrapping <label> gives the
 *  native input an accessible name (HARD RULE 3). */
export function RangeControl({
  id,
  label,
  min,
  max,
  step,
  value,
  unit,
  display,
  compact,
  onChange,
}: {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  unit?: string;
  /** Overrides the numeric readout (e.g. a percentage). */
  display?: string;
  compact?: boolean;
  onChange: (v: number) => void;
}) {
  const readout = display ?? `${Math.round(value * 100) / 100}${unit ? ' ' + unit : ''}`;
  return (
    <label className={`m-field${compact ? ' m-field-compact' : ''}`}>
      <span className="m-field-label">
        <span>{label}</span>
        <span>{readout}</span>
      </span>
      <input
        id={`m-${id}`}
        name={id}
        className="m-range"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
