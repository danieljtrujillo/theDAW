import React, { useEffect, useId, useRef, useState } from 'react';
import { Scissors, X } from 'lucide-react';
import { useFeatureToggleStore } from '../../state/featureToggleStore';
import { FLYOUT_CARD } from '../audio/midiDockKit';
import { QUALITY_TIERS, STEM_MODES, qualityDetail } from './stemModes';
import type { QualityValue, StemModeValue } from './stemModes';

/**
 * Pre-run dialog for stem separation.
 *
 * Lets the user pick stem count, device and quality for this run, with the
 * Settings, Background features values as the defaults. Optionally saves the
 * chosen values as the new defaults so the next run starts from them.
 *
 * Opened from the library, from EDIT and from the footer track menu. Every key
 * pressed inside stops at the dialog, so EDIT's window hotkeys never act behind
 * it; focus starts on Run separation.
 */

export type StemsRunOptions = {
  /** Wire value, not a file count: 12 yields ten parts. See stemModes.ts. */
  stems: StemModeValue;
  device: 'cuda' | 'cpu' | 'auto';
  quality: QualityValue;
  /** If true, also PATCH /api/settings so these become the new defaults. */
  persistAsDefault: boolean;
};

interface Props {
  open: boolean;
  entryLabel?: string;
  onCancel: () => void;
  onConfirm: (opts: StemsRunOptions) => void;
}

const DEVICE_OPTIONS: Array<{ value: 'cuda' | 'cpu' | 'auto'; label: string }> = [
  { value: 'cuda', label: 'GPU' },
  { value: 'cpu', label: 'CPU' },
  { value: 'auto', label: 'Auto' },
];

const LEGEND = 'font-display text-xs font-bold uppercase tracking-wider et-ink-2';
const BUTTON =
  'h-8 px-3 flex items-center gap-2 rounded-xs text-xs font-bold uppercase tracking-wider bg-white/10 et-ink shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] hover:shadow-[inset_0_0_0_100px_rgb(var(--et-tint)/0.1)]';

const Option: React.FC<{ selected: boolean; label: string; hint?: string; title?: string; onSelect: () => void }> = ({
  selected,
  label,
  hint,
  title,
  onSelect,
}) => (
  <button
    type="button"
    aria-pressed={selected}
    title={title}
    onClick={onSelect}
    className={`min-h-8 px-2 py-1 flex flex-col items-start justify-center gap-0.5 rounded-xs border text-left ${
      selected
        ? 'border-[rgb(var(--et-accent))] bg-white/5 text-[rgb(var(--et-accent))]'
        : 'border-white/10 et-ink-2 hover:bg-white/5'
    }`}
  >
    <span className="text-xs font-bold">{label}</span>
    {hint && <span className="text-xs font-semibold et-ink-3">{hint}</span>}
  </button>
);

const COLUMNS: Record<1 | 2 | 3, string> = { 1: 'grid-cols-1', 2: 'grid-cols-2', 3: 'grid-cols-3' };

const OptionGroup: React.FC<{ id: string; label: string; columns: 1 | 2 | 3; children: React.ReactNode }> = ({
  id,
  label,
  columns,
  children,
}) => (
  <div role="group" aria-labelledby={id} className="flex flex-col gap-1">
    <span id={id} className={LEGEND}>{label}</span>
    <div className={`grid gap-1 ${COLUMNS[columns]}`}>{children}</div>
  </div>
);

export const StemsRunModal: React.FC<Props> = ({ open, entryLabel, onCancel, onConfirm }) => {
  const settings = useFeatureToggleStore((s) => s.settings.stems);
  const uid = useId();
  const ids = {
    heading: `${uid}-heading`,
    stems: `${uid}-stems`,
    device: `${uid}-device`,
    quality: `${uid}-quality`,
    persist: `${uid}-persist`,
  };
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const runRef = useRef<HTMLButtonElement | null>(null);
  // Local working copy so the user can try options without persisting
  // anything until they press Run.
  const [stems, setStems] = useState<StemModeValue>(() => (settings.default_count as StemModeValue) || 4);
  const [device, setDevice] = useState<'cuda' | 'cpu' | 'auto'>(() => (settings.device as 'cuda' | 'cpu' | 'auto') || 'cuda');
  const [quality, setQuality] = useState<QualityValue>(() => (settings.quality as QualityValue) || 'balanced');
  const [persist, setPersist] = useState(false);

  // Reload defaults whenever the dialog opens (settings may have changed
  // while it was closed).
  useEffect(() => {
    if (!open) return;
    setStems((settings.default_count as StemModeValue) || 4);
    setDevice((settings.device as 'cuda' | 'cpu' | 'auto') || 'cuda');
    setQuality((settings.quality as QualityValue) || 'balanced');
    setPersist(false);
  }, [open, settings.default_count, settings.device, settings.quality]);

  useEffect(() => {
    if (open) runRef.current?.focus();
  }, [open]);

  if (!open) return null;

  const confirm = () => onConfirm({ stems, device, quality, persistAsDefault: persist });
  const selectedQuality = QUALITY_TIERS.find((t) => t.value === quality) ?? QUALITY_TIERS[1];

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !(e.target instanceof HTMLButtonElement)) {
      // A focused button acts on its own Enter; anywhere else Enter runs.
      e.preventDefault();
      confirm();
      return;
    }
    if (e.key === 'Tab') {
      const box = dialogRef.current;
      const focusables = box ? Array.from(box.querySelectorAll<HTMLElement>('button, input')) : [];
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-auto">
      <div aria-hidden="true" className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onCancel} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ids.heading}
        onKeyDown={onKeyDown}
        className={`${FLYOUT_CARD} relative w-105 max-w-full flex flex-col`}
      >
        <div className="h-11 flex items-center gap-2 px-4 border-b border-white/10">
          <Scissors aria-hidden="true" className="w-4 h-4 shrink-0 et-ink-2" />
          <h2 id={ids.heading} className="flex-1 min-w-0 truncate font-display text-sm font-bold uppercase tracking-wider et-ink">
            Separate stems
          </h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            title="Cancel"
            className="h-8 w-8 flex items-center justify-center rounded-xs et-ink-2 hover:et-ink hover:bg-white/5"
          >
            <X aria-hidden="true" className="w-4 h-4" />
          </button>
        </div>

        <div className="px-4 py-3 flex flex-col gap-3">
          {entryLabel && (
            <p className="text-sm font-semibold et-ink truncate" title={entryLabel}>
              {entryLabel}
            </p>
          )}

          <OptionGroup id={ids.stems} label="Stems" columns={1}>
            {STEM_MODES.map((mode) => (
              <Option
                key={mode.value}
                selected={stems === mode.value}
                label={mode.label}
                hint={mode.hint}
                title={`${mode.partCount} files: ${mode.roles.join(', ')}`}
                onSelect={() => setStems(mode.value)}
              />
            ))}
          </OptionGroup>
          {STEM_MODES.filter((mode) => mode.notice).map((mode) => (
            <p key={mode.value} className="-mt-2 text-xs font-semibold et-ink-3">
              {mode.notice}
            </p>
          ))}

          <OptionGroup id={ids.device} label="Device" columns={3}>
            {DEVICE_OPTIONS.map((opt) => (
              <Option key={opt.value} selected={device === opt.value} label={opt.label} onSelect={() => setDevice(opt.value)} />
            ))}
          </OptionGroup>

          <OptionGroup id={ids.quality} label="Quality" columns={3}>
            {QUALITY_TIERS.map((tier) => (
              <Option
                key={tier.value}
                selected={quality === tier.value}
                label={tier.label}
                hint={tier.hint}
                title={qualityDetail(tier, stems)}
                onSelect={() => setQuality(tier.value)}
              />
            ))}
          </OptionGroup>
          <p className="-mt-2 text-xs font-semibold et-ink-3">
            {stems === 4
              ? `Quality picks the model and the passes: ${qualityDetail(selectedQuality, 4)}.`
              : `This mode's model is fixed, so quality changes passes and overlap only: ${qualityDetail(selectedQuality, stems)}.`}
          </p>

          <div className="flex items-center gap-2">
            <input
              id={ids.persist}
              name="stems-persist-default"
              type="checkbox"
              className="w-4 h-4 shrink-0 accent-[rgb(var(--et-accent))]"
              checked={persist}
              onChange={(e) => setPersist(e.target.checked)}
            />
            <label htmlFor={ids.persist} className="text-xs font-semibold et-ink cursor-pointer">
              Save these as the defaults for the next run
            </label>
          </div>
          <p className="text-xs font-semibold et-ink-3">The defaults live in Settings, Background features.</p>
        </div>

        <div className="px-4 py-3 border-t border-white/10 flex items-center justify-end gap-2">
          <button type="button" onClick={onCancel} className={BUTTON}>
            <span>Cancel</span>
          </button>
          <button ref={runRef} type="button" onClick={confirm} className={`${BUTTON} text-[rgb(var(--et-accent))]`}>
            <Scissors aria-hidden="true" className="w-3.5 h-3.5" />
            <span>Run separation</span>
          </button>
        </div>
      </div>
    </div>
  );
};
