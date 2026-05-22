import type { LucideIcon } from 'lucide-react';
import { Activity, Clock, Download, Eraser, Layers } from 'lucide-react';

export interface AdvancedEffectCatalogItem {
  id: string;
  name: string;
  desc: string;
  params: number;
}

export interface AdvancedEffectCategoryMeta {
  id: keyof typeof ADVANCED_EFFECT_CATALOG;
  label: string;
  icon: LucideIcon;
  count: number;
}

export const ADVANCED_EFFECT_CATALOG = {
  stacks: [
    { id: 'mastering_chain', name: 'Mastering Chain', desc: 'EQ → Compression → Limiter → Loudness Normalization → 24-bit', params: 4 },
    { id: 'vocal_processing', name: 'Vocal Processing', desc: 'Highpass → EQ → Compression → Loudness Normalization', params: 3 },
    { id: 'lofi_vinyl', name: 'Lo-Fi / Vinyl', desc: 'Downsample → Highpass → Lowpass → Chorus for vintage character', params: 2 },
    { id: 'stereo_widener', name: 'Stereo Widener', desc: 'Haas effect — microscopic delay on right channel', params: 1 },
    { id: 'reverb_delay', name: 'Reverb + Delay', desc: 'Ping-pong delay cascade with long-decay ambient echo', params: 3 },
    { id: 'sub_exciter', name: 'Club EQ', desc: 'Sub bass boost + treble exciter for club-ready sound', params: 2 },
    { id: 'phase_isolation', name: 'Vocal Removal', desc: 'Phase cancellation to remove center-panned material', params: 1 },
  ],
  dynamics: [
    { id: 'compression', name: 'Compressor', desc: 'Dynamic range compression with adjustable attack and release', params: 2 },
    { id: 'loudnorm', name: 'Loudness Norm', desc: 'Normalize loudness to broadcast standards', params: 2 },
    { id: 'volume', name: 'Volume', desc: 'Simple volume gain control', params: 1 },
  ],
  tempo: [
    { id: 'tempo', name: 'Time Stretch', desc: 'Change tempo without affecting pitch', params: 1 },
    { id: 'pitch_shift', name: 'Pitch Shift', desc: 'Shift pitch up or down in cents', params: 1 },
  ],
  cleanup: [
    { id: 'denoise', name: 'Noise Reduction', desc: 'FFT denoise for cleaner audio', params: 1 },
    { id: 'declick', name: 'Click Removal', desc: 'Remove clicks and pops from recordings', params: 1 },
    { id: 'silence_remove', name: 'Silence Remove', desc: 'Trim leading silence below a threshold', params: 1 },
  ],
  export: [
    { id: 'export_flac', name: 'FLAC Encoder', desc: 'Export as lossless FLAC file', params: 1 },
    { id: 'export_mp3', name: 'MP3 Encoder', desc: 'Export as MP3 with selectable bitrate', params: 1 },
    { id: 'export_aac', name: 'AAC Encoder', desc: 'Export as AAC with selectable bitrate', params: 1 },
    { id: 'export_opus', name: 'Opus Encoder', desc: 'Export as Opus with selectable bitrate', params: 1 },
  ],
} as const satisfies Record<string, readonly AdvancedEffectCatalogItem[]>;

export const ADVANCED_EFFECT_CATEGORY_META: AdvancedEffectCategoryMeta[] = [
  { id: 'stacks', label: 'Stacks', icon: Layers, count: ADVANCED_EFFECT_CATALOG.stacks.length },
  { id: 'dynamics', label: 'Dynamics', icon: Activity, count: ADVANCED_EFFECT_CATALOG.dynamics.length },
  { id: 'tempo', label: 'Tempo', icon: Clock, count: ADVANCED_EFFECT_CATALOG.tempo.length },
  { id: 'cleanup', label: 'Cleanup', icon: Eraser, count: ADVANCED_EFFECT_CATALOG.cleanup.length },
  { id: 'export', label: 'Export', icon: Download, count: ADVANCED_EFFECT_CATALOG.export.length },
];

export function outputFormatForEffect(effect: string, fallback: string): string {
  return effect.startsWith('export_') ? effect.replace('export_', '') : fallback;
}
