import React from 'react';

/* ── RoundToggle: circular LED-style toggle that echoes the SLIDE knobs.
   Label ABOVE; the button sits in a fixed-height box so its center aligns
   with a knob's dial center when laid out in a row. Shared by the MAKE
   (AdvancedGenPanel) and MIX (MixPanel) control surfaces. ─────────────── */
export function RoundToggle({ label, icon: Icon, on, onChange, box = 46 }: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  on: boolean;
  onChange: (v: boolean) => void;
  box?: number;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      title={label}
      className="flex flex-col items-center gap-1 group shrink-0"
    >
      <span className={`text-[8px] font-bold uppercase tracking-wider leading-none transition-colors ${on ? 'text-purple-200' : 'text-zinc-400'}`}>{label}</span>
      <span className="grid place-items-center" style={{ height: box }}>
        <span
          className={`grid place-items-center rounded-full border-2 transition-all duration-200 ${
            on
              ? 'border-purple-400/70 bg-purple-600/30 text-purple-100 shadow-[0_0_12px_rgba(168,85,247,0.65)]'
              : 'border-white/15 bg-black/40 text-zinc-500 group-hover:text-zinc-300 group-hover:border-white/30'
          }`}
          style={{ width: 34, height: 34 }}
        >
          <Icon className="w-3.5 h-3.5" />
        </span>
      </span>
    </button>
  );
}
