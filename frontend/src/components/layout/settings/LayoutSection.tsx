/** Edit Layout (global surface prefs): text scale, gaps, snap, fill, guides. */
import React from 'react';
import { LayoutGrid } from 'lucide-react';
import { useLayoutPrefs, UI_SCALE_MIN, UI_SCALE_MAX } from '../../../state/layoutPrefsStore';
import { SlideTrack } from '../../audio/SlideTrack';
import { BTN_GHOST, CARD, FIELD_LABEL, SectionHeader, Segmented } from './shared';

export const LayoutSection: React.FC = () => {
  const fillMode = useLayoutPrefs((s) => s.fillMode);
  const gapPx = useLayoutPrefs((s) => s.gapPx);
  const snapPx = useLayoutPrefs((s) => s.snapPx);
  const showGuides = useLayoutPrefs((s) => s.showGuides);
  const matchSizes = useLayoutPrefs((s) => s.matchSizes);
  const setFillMode = useLayoutPrefs((s) => s.setFillMode);
  const setGapPx = useLayoutPrefs((s) => s.setGapPx);
  const setSnapPx = useLayoutPrefs((s) => s.setSnapPx);
  const setShowGuides = useLayoutPrefs((s) => s.setShowGuides);
  const setMatchSizes = useLayoutPrefs((s) => s.setMatchSizes);
  const uiScale = useLayoutPrefs((s) => s.uiScale);
  const setUiScale = useLayoutPrefs((s) => s.setUiScale);
  const scalePct = Math.round(uiScale * 100);
  return (
    <section aria-labelledby="settings-layout-title">
      <SectionHeader icon={<LayoutGrid className="w-3.5 h-3.5 text-purple-400" />} title="Layout"
        tip="Text scales every control app-wide. Scale grows controls to fill empty space; Compact keeps them natural. Gap sets spacing between panels. Snap sets the drag increment for margins. Per-panel padding, mirror, and placement are edited inside each workspace's Edit Layout mode."
        meta="every workspace" />
      <span id="settings-layout-title" className="sr-only">Layout</span>
      <div className={`${CARD} px-2 py-1.5 flex flex-col gap-1.5`}>
        <div className="flex items-center gap-2">
          <span id="settings-layout-text" className={`${FIELD_LABEL} w-9 shrink-0`}>Text</span>
          <SlideTrack
            min={Math.round(UI_SCALE_MIN * 100)}
            max={Math.round(UI_SCALE_MAX * 100)}
            step={5}
            value={scalePct}
            onChange={(v) => setUiScale(v / 100)}
            className="flex-1"
            ariaLabelledBy="settings-layout-text"
          />
          <span className="text-[11px] font-mono text-zinc-300 w-9 text-right tabular-nums">{scalePct}%</span>
          <button
            type="button"
            onClick={() => setUiScale(1)}
            disabled={scalePct === 100}
            className={BTN_GHOST}
            title="Reset text size to 100%"
          >
            Reset
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex items-center gap-2">
            <span id="settings-layout-gap" className={`${FIELD_LABEL} w-9 shrink-0`}>Gap</span>
            <SlideTrack min={0} max={24} step={1} value={gapPx} onChange={(v) => setGapPx(v)} className="flex-1" ariaLabelledBy="settings-layout-gap" />
            <span className="text-[11px] font-mono text-zinc-300 w-8 text-right tabular-nums">{gapPx}px</span>
          </div>
          <div className="flex items-center gap-2">
            <span id="settings-layout-snap" className={`${FIELD_LABEL} shrink-0`}>Snap</span>
            <SlideTrack min={0} max={24} step={1} value={snapPx} onChange={(v) => setSnapPx(v)} className="flex-1" ariaLabelledBy="settings-layout-snap" />
            <span className="text-[11px] font-mono text-zinc-300 w-8 text-right tabular-nums">{snapPx === 0 ? 'off' : `${snapPx}px`}</span>
          </div>
        </div>
        <div className="flex items-center gap-x-3 gap-y-1 flex-wrap">
          <div className="flex items-center gap-1.5">
            <span className={FIELD_LABEL}>Fill</span>
            <Segmented ariaLabel="Panel fill mode" value={fillMode} options={[['scale', 'Scale'], ['natural', 'Compact']]} onChange={(v) => setFillMode(v as 'scale' | 'natural')} />
          </div>
          <div className="flex items-center gap-1.5">
            <span className={FIELD_LABEL}>Guides</span>
            <Segmented ariaLabel="Layout guides" value={showGuides ? 'on' : 'off'} options={[['on', 'On'], ['off', 'Off']]} onChange={(v) => setShowGuides(v === 'on')} />
          </div>
          <div className="flex items-center gap-1.5">
            <span className={FIELD_LABEL}>Match</span>
            <Segmented ariaLabel="Match panel sizes" value={matchSizes ? 'on' : 'off'} options={[['on', 'On'], ['off', 'Off']]} onChange={(v) => setMatchSizes(v === 'on')} />
          </div>
        </div>
      </div>
    </section>
  );
};
