/**
 * Autoprocesses as a compact matrix: one row per process (Analyze, MIDI,
 * Stem), one column per trigger (import, generate). A real <table> so the
 * row/column headers name every toggle; the toggles themselves are custom
 * controls with their own aria-label + aria-pressed. Stem options ride on
 * a single wrap row underneath.
 */
import React from 'react';
import { Activity, Music, Scissors } from 'lucide-react';
import { useFeatureToggleStore } from '../../../state/featureToggleStore';
import { InfoTip } from '../../ui/Tooltip';
import { CARD, FIELD_LABEL, IconToggle, SectionHeader } from './shared';

type Section = 'analysis' | 'midi' | 'stems';

const ROWS: Array<{ key: Section; title: string; desc: string; Icon: React.ComponentType<{ className?: string }> }> = [
  {
    key: 'analysis',
    title: 'Analyze',
    desc: 'Detect BPM, key, pitch, bars, codec, and embedded prompts. Local-only and CPU-friendly.',
    Icon: Activity,
  },
  {
    key: 'midi',
    title: 'MIDI',
    desc: 'Transcribe tracks (and stems, when present) to MIDI via basic-pitch / piano-transcription.',
    Icon: Music,
  },
  {
    key: 'stems',
    title: 'Stem',
    desc: 'Split tracks into stems via the Demucs sidecar. Needs the stems module (+ LARSNET weights for 12-stem). Count, device, and quality are the row below.',
    Icon: Scissors,
  },
];

export const AutoprocessSection: React.FC = () => {
  const settings = useFeatureToggleStore((s) => s.settings);
  const patch = useFeatureToggleStore((s) => s.patch);
  const error = useFeatureToggleStore((s) => s.error);

  const cell = 'border-y border-white/5 px-1 py-0.5 text-center';
  return (
    <section aria-labelledby="settings-autoprocess-title">
      <SectionHeader icon={<Activity className="w-3.5 h-3.5 text-purple-400" />} title="Autoprocesses"
        tip="Opt-in enrichment that runs on its own when the app is idle. Toggle per import and per generate; default OFF, persists across reloads. A toggle that fails to save flips back and says why."
        meta="while idle" />
      <span id="settings-autoprocess-title" className="sr-only">Autoprocesses</span>
      <div className={`${CARD} px-2 py-1`}>
        <table className="w-full border-separate border-spacing-y-0.5">
          <caption className="sr-only">Automatic processing per trigger</caption>
          <thead>
            <tr>
              <th scope="col" className="text-left">
                <span className="sr-only">Process</span>
              </th>
              <th scope="col" className={`${FIELD_LABEL} w-20 text-center font-normal`}>on import</th>
              <th scope="col" className={`${FIELD_LABEL} w-20 text-center font-normal`}>on generate</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map(({ key, title, desc, Icon }) => {
              const row = settings[key];
              return (
                <tr key={key}>
                  <th scope="row" className="rounded-l border-y border-l border-white/5 px-1.5 py-0.5 text-left font-normal">
                    <span className="flex items-center gap-1.5">
                      <Icon className="w-3 h-3 text-purple-400 shrink-0" />
                      <span className="text-xs font-bold text-zinc-100">{title}</span>
                      <InfoTip title={title} body={desc} />
                    </span>
                  </th>
                  <td className={cell}>
                    <IconToggle
                      enabled={row.auto_on_import}
                      onToggle={() => void patch({ [key]: { auto_on_import: !row.auto_on_import } })}
                      label={`${title} on import`}
                    />
                  </td>
                  <td className={`${cell} rounded-r border-r`}>
                    <IconToggle
                      enabled={row.auto_on_generate}
                      onToggle={() => void patch({ [key]: { auto_on_generate: !row.auto_on_generate } })}
                      label={`${title} on generate`}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <StemOptions />
        {error && (
          <p role="alert" className="mt-1 truncate text-[11px] text-rose-300" title={error}>
            {error}
          </p>
        )}
      </div>
    </section>
  );
};

/** The stems options (count / device / quality) on one wrap row. */
const StemOptions: React.FC = () => {
  const stems = useFeatureToggleStore((s) => s.settings.stems);
  const patch = useFeatureToggleStore((s) => s.patch);
  const Pill: React.FC<{ active: boolean; disabled?: boolean; title?: string; onClick: () => void; children: React.ReactNode }> = ({ active, disabled, title, onClick, children }) => (
    <button
      type="button"
      onClick={() => { if (!disabled) onClick(); }}
      disabled={disabled}
      aria-pressed={active}
      title={title}
      className={`text-[11px] font-mono uppercase tracking-widest px-1.5 py-px rounded border transition-colors ${
        active ? 'bg-purple-500/25 border-purple-400/60 text-purple-100'
        : disabled ? 'border-white/5 text-zinc-600 cursor-not-allowed line-through'
        : 'border-white/10 text-zinc-300 hover:text-white hover:bg-white/5'
      }`}
    >
      {children}
    </button>
  );
  const Group: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <div role="group" aria-label={`Stems ${label}`} className="flex items-center gap-1">
      <span className={`${FIELD_LABEL} text-zinc-400`}>{label}</span>
      {children}
    </div>
  );
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/5 pt-1">
      <span className={FIELD_LABEL}>Stems</span>
      <Group label="count">
        {[{ v: 2, h: 'vocals + accompaniment' }, { v: 4, h: 'vocals, drums, bass, other' }, { v: 6, h: '+ guitar, piano' }, { v: 12, h: '+ LARSNET drum sub-stems' }].map((o) => (
          <Pill key={o.v} active={stems.default_count === o.v} title={o.h} onClick={() => void patch({ stems: { default_count: o.v } })}>{o.v}</Pill>
        ))}
      </Group>
      <Group label="device">
        {[{ v: 'cuda', l: 'GPU', e: true }, { v: 'cpu', l: 'CPU', e: true }, { v: 'cloud-runpod', l: 'RunPod', e: false }, { v: 'cloud-cloudflare', l: 'Cloudflare', e: false }, { v: 'cloud-colab', l: 'Colab', e: false }].map((o) => (
          <Pill key={o.v} active={stems.device === o.v} disabled={!o.e} title={o.e ? o.l : `${o.l} — coming soon`} onClick={() => void patch({ stems: { device: o.v } })}>{o.l}</Pill>
        ))}
      </Group>
      <Group label="quality">
        {[{ v: 'fast', l: 'Fast', h: 'shifts=1, overlap=0.25 — ~30s/track' }, { v: 'balanced', l: 'Balanced', h: 'shifts=2, overlap=0.5 — ~1-2 min/track' }, { v: 'hq', l: 'HQ', h: 'shifts=10, overlap=0.9 — 5-15 min/track' }].map((o) => (
          <Pill key={o.v} active={stems.quality === o.v} title={o.h} onClick={() => void patch({ stems: { quality: o.v } })}>{o.l}</Pill>
        ))}
      </Group>
    </div>
  );
};
