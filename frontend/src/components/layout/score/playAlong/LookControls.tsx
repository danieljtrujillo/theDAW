import React from 'react';
import {
  HIGHLIGHT_INKS,
  NOW_LINE_POSITIONS,
  usePlayAlongStore,
  type HighlightInk,
  type NowLinePos,
} from '../../../../state/playAlongStore';

const NOW_LABELS: Record<NowLinePos, string> = {
  left: 'Left',
  center: 'Center',
};

/** The two look preferences every follow view shares: where the "now" sits
 *  across the pane (left third, or dead centre) and the ink the sounding
 *  note and the hairline are painted in. Both are stored in playAlongStore,
 *  so the PAGE, STRIP, TAB and CHORDS views all follow the same choice. */
export const LookControls: React.FC = () => {
  const nowLine = usePlayAlongStore((s) => s.nowLine);
  const ink = usePlayAlongStore((s) => s.ink);
  const setNowLine = usePlayAlongStore((s) => s.setNowLine);
  const setInk = usePlayAlongStore((s) => s.setInk);
  return (
    <span className="flex items-center gap-1">
      <label htmlFor="score-now-line" className="text-zinc-500 select-none" title="Where the music sounding now sits across the pane">
        NOW
      </label>
      <select
        id="score-now-line"
        name="score-now-line"
        className="form-select text-[10px] px-1 py-0.5"
        value={nowLine}
        onChange={(e) => setNowLine(e.target.value as NowLinePos)}
      >
        {NOW_LINE_POSITIONS.map((pos) => (
          <option key={pos} value={pos}>{NOW_LABELS[pos]}</option>
        ))}
      </select>
      <label htmlFor="score-ink" className="text-zinc-500 select-none" title="Colour of the sounding note and the now-line">
        INK
      </label>
      <select
        id="score-ink"
        name="score-ink"
        className="form-select text-[10px] px-1 py-0.5"
        value={ink}
        onChange={(e) => setInk(e.target.value as HighlightInk)}
        style={{ borderColor: HIGHLIGHT_INKS[ink].color }}
      >
        {(Object.keys(HIGHLIGHT_INKS) as HighlightInk[]).map((key) => (
          <option key={key} value={key}>{HIGHLIGHT_INKS[key].label}</option>
        ))}
      </select>
    </span>
  );
};

export default LookControls;
