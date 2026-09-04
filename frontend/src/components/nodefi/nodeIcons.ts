/**
 * Per-kind glyphs for Nodefi nodes — rendered inside the canvas discs and
 * the rail tiles so kinds are tellable at a glance. Kept out of
 * lib/nodefiTypes so the data model stays free of React/lucide imports.
 */
import {
  Activity,
  ArrowLeftRight,
  Boxes,
  Cloud,
  Combine,
  Library,
  Repeat2,
  Save,
  SlidersHorizontal,
  Sparkles,
  Speaker,
  Timer,
  Layers,
  Volume2,
  Wand2,
  Waves,
  type LucideIcon,
} from 'lucide-react';
import type { NodeKind } from '../../lib/nodefiTypes';

export const NODE_ICONS: Record<NodeKind, LucideIcon> = {
  input: Library,
  stem: Layers,
  generate: Sparkles,
  magenta: Wand2,
  suno: Cloud,
  effect: SlidersHorizontal,
  merge: Combine,
  feedback: Repeat2,
  lfilter: Waves,
  lgain: Volume2,
  ldelay: Timer,
  xfade: ArrowLeftRight,
  lrack: Boxes,
  lfo: Activity,
  output: Save,
  lout: Speaker,
};
