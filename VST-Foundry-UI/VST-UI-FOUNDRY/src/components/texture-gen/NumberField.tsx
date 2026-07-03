import { labelCls, inputCls } from './constants';

// Numeric input with clamping. On empty/NaN input it restores the previous
// value; otherwise it clamps the parsed value into [min, max]. Extracted
// verbatim from the original TextureGenerateModal.tsx — do not alter the
// clamp behavior.
const NumberField = ({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) => (
  <div>
    <div className={labelCls}>{label}</div>
    <input
      type="number"
      className={inputCls}
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        const raw = e.target.value;
        const parsed = Number(raw);
        if (raw === '' || Number.isNaN(parsed)) {
          onChange(value);
          return;
        }
        let n = parsed;
        if (min !== undefined && n < min) n = min;
        if (max !== undefined && n > max) n = max;
        onChange(n);
      }}
    />
  </div>
);

export default NumberField;
