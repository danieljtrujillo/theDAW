import React, { useEffect, useState } from 'react';
import { Scissors, X, Save } from 'lucide-react';
import { useFeatureToggleStore } from '../../state/featureToggleStore';

/**
 * Pre-run modal for stem separation.
 *
 * Lets the user pick stem-count / device / quality for THIS run, with the
 * Settings → Background features values used as defaults. Optionally saves
 * the chosen values back as the new defaults so the next right-click runs
 * with the same prefs without re-prompting.
 */

export type StemsRunOptions = {
  stems: 2 | 4 | 6 | 12;
  device: 'cuda' | 'cpu' | 'auto';
  quality: 'fast' | 'balanced' | 'hq';
  /** If true, also PATCH /api/settings so these become the new defaults. */
  persistAsDefault: boolean;
};

interface Props {
  open: boolean;
  entryLabel?: string;
  onCancel: () => void;
  onConfirm: (opts: StemsRunOptions) => void;
}

const STEM_OPTIONS: Array<{ value: 2 | 4 | 6 | 12; label: string; hint: string }> = [
  { value: 2,  label: '2 stems',  hint: 'vocals + accompaniment (mdx_extra)' },
  { value: 4,  label: '4 stems',  hint: 'vocals, drums, bass, other (htdemucs)' },
  { value: 6,  label: '6 stems',  hint: '+ guitar, piano (htdemucs_6s)' },
  { value: 12, label: '12 stems', hint: '6 base + drum sub-stems via LARSNET (kick/snare/hihat/cymbals/toms)' },
];

const DEVICE_OPTIONS: Array<{ value: 'cuda' | 'cpu' | 'auto'; label: string }> = [
  { value: 'cuda', label: 'GPU (cuda)' },
  { value: 'cpu',  label: 'CPU' },
  { value: 'auto', label: 'Auto' },
];

const QUALITY_OPTIONS: Array<{ value: 'fast' | 'balanced' | 'hq'; label: string; hint: string }> = [
  { value: 'fast',     label: 'Fast',     hint: 'shifts=1, overlap=0.25 — ~30s per track' },
  { value: 'balanced', label: 'Balanced', hint: 'shifts=2, overlap=0.5 — ~1-2 min per track' },
  { value: 'hq',       label: 'HQ',       hint: 'shifts=10, overlap=0.9 — 5-15 min per track' },
];

export const StemsRunModal: React.FC<Props> = ({ open, entryLabel, onCancel, onConfirm }) => {
  const settings = useFeatureToggleStore((s) => s.settings.stems);
  // Local working copy so the user can mash buttons without persisting
  // anything until they hit Run.
  const [stems, setStems] = useState<2 | 4 | 6 | 12>(() => (settings.default_count as 2 | 4 | 6 | 12) || 4);
  const [device, setDevice] = useState<'cuda' | 'cpu' | 'auto'>(() => (settings.device as 'cuda' | 'cpu' | 'auto') || 'cuda');
  const [quality, setQuality] = useState<'fast' | 'balanced' | 'hq'>(() => (settings.quality as 'fast' | 'balanced' | 'hq') || 'balanced');
  const [persist, setPersist] = useState(false);

  // Reload defaults whenever the modal opens (settings may have changed
  // while it was closed).
  useEffect(() => {
    if (!open) return;
    setStems((settings.default_count as 2 | 4 | 6 | 12) || 4);
    setDevice((settings.device as 'cuda' | 'cpu' | 'auto') || 'cuda');
    setQuality((settings.quality as 'fast' | 'balanced' | 'hq') || 'balanced');
    setPersist(false);
  }, [open, settings.default_count, settings.device, settings.quality]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter' && !e.shiftKey)
        onConfirm({ stems, device, quality, persistAsDefault: persist });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel, onConfirm, stems, device, quality, persist]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-[#0c0a14] border border-purple-500/30 rounded-lg w-[420px] shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
          <div className="flex items-center gap-2">
            <Scissors className="w-3.5 h-3.5 text-purple-400" />
            <span className="text-[10px] font-black uppercase tracking-widest text-purple-300">
              Run Stem Separation
            </span>
          </div>
          <button
            onClick={onCancel}
            className="p-1 text-zinc-500 hover:text-white transition-colors rounded hover:bg-white/5"
            title="Cancel"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="px-4 py-3 flex flex-col gap-3">
          {entryLabel && (
            <p className="text-[10px] font-mono text-zinc-400 truncate" title={entryLabel}>
              Target: <span className="text-zinc-100">{entryLabel}</span>
            </p>
          )}

          <PickerRow label="Stems">
            <div className="grid grid-cols-2 gap-1">
              {STEM_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setStems(opt.value)}
                  className={`text-[9px] font-mono uppercase tracking-widest px-2 py-1 rounded border text-left ${
                    stems === opt.value
                      ? 'bg-purple-500/25 border-purple-400/60 text-purple-100'
                      : 'border-white/10 text-zinc-400 hover:text-zinc-100 hover:bg-white/5'
                  }`}
                  title={opt.hint}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </PickerRow>

          <PickerRow label="Device">
            <div className="flex items-center gap-1 flex-wrap">
              {DEVICE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setDevice(opt.value)}
                  className={`text-[8px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded border ${
                    device === opt.value
                      ? 'bg-purple-500/25 border-purple-400/60 text-purple-100'
                      : 'border-white/10 text-zinc-400 hover:text-zinc-100 hover:bg-white/5'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </PickerRow>

          <PickerRow label="Quality">
            <div className="flex items-center gap-1 flex-wrap">
              {QUALITY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setQuality(opt.value)}
                  className={`text-[8px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded border ${
                    quality === opt.value
                      ? 'bg-purple-500/25 border-purple-400/60 text-purple-100'
                      : 'border-white/10 text-zinc-400 hover:text-zinc-100 hover:bg-white/5'
                  }`}
                  title={opt.hint}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </PickerRow>

          <label className="flex items-center gap-2 text-[9px] font-mono uppercase tracking-widest text-zinc-400 cursor-pointer mt-1">
            <input
              type="checkbox"
              className="accent-purple-500"
              checked={persist}
              onChange={(e) => setPersist(e.target.checked)}
            />
            <Save className="w-3 h-3" />
            Save as default for next run
          </label>

          <p className="text-[8px] font-mono text-zinc-600 leading-relaxed">
            Defaults come from Settings → Background features. Toggle the checkbox above
            to overwrite those defaults from this dialog.
          </p>
        </div>

        <div className="px-4 py-3 border-t border-white/5 flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="text-[9px] font-mono uppercase tracking-widest px-3 py-1.5 rounded border border-white/10 text-zinc-400 hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm({ stems, device, quality, persistAsDefault: persist })}
            className="text-[9px] font-mono uppercase tracking-widest px-3 py-1.5 rounded border border-purple-400/60 bg-purple-500/25 text-purple-100 hover:bg-purple-500/40 flex items-center gap-1.5"
          >
            <Scissors className="w-3 h-3" />
            Run separation
          </button>
        </div>
      </div>
    </div>
  );
};

const PickerRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex flex-col gap-1">
    <span className="text-[9px] font-mono uppercase tracking-widest text-zinc-400">{label}</span>
    {children}
  </div>
);

