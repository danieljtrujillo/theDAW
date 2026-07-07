/** DJ remote: drives the desktop's two-deck DJ engine over the control bus.
 *  Renders from the dj.* manifest entries (djControlSource on the desktop), so
 *  it stays in sync as DJ_TARGETS grows. Needs the desktop app open as host.
 *
 *  One-way for now (phone -> desktop): the desktop does not mirror DJ moves back,
 *  so faders seed to a cosmetic default and command absolute values on touch. */
import { Play, Headphones } from 'lucide-react';
import { RemoteGate } from '../ui/RemoteGate';
import { RangeControl } from '../ui/RangeControl';
import { useControlStore } from '../net/controlClient';
import type { ManifestEntry } from '../net/controlClient';

const DECKS = ['A', 'B'] as const;

function defaultFor(e: ManifestEntry): number {
  if (typeof e.value === 'number') return e.value;
  const min = e.min ?? 0;
  const max = e.max ?? 1;
  if (min < 0 && max > 0) return 0; // bipolar EQ / filter / crossfader
  return min + (max - min) * 0.5;
}

export function MobileDj() {
  const entries = useControlStore((s) => s.entries);
  const values = useControlStore((s) => s.values);
  const setControl = useControlStore((s) => s.setControl);

  const byId = new Map(entries.filter((e) => e.area === 'dj').map((e) => [e.id, e]));
  const hasDj = byId.size > 0;

  const range = (id: string, label: string) => {
    const e = byId.get(id);
    if (!e) return null;
    const v = typeof values[id] === 'number' ? (values[id] as number) : defaultFor(e);
    return (
      <RangeControl
        id={id}
        label={label}
        min={e.min ?? 0}
        max={e.max ?? 1}
        step={e.step ?? 0.01}
        value={v}
        unit={e.unit}
        compact
        onChange={(nv) => setControl(id, nv)}
      />
    );
  };

  const deck = (d: (typeof DECKS)[number]) => (
    <section className="m-deck" key={d} aria-label={`Deck ${d}`}>
      <span className="m-deck-head">Deck {d}</span>
      <div className="m-deck-btns">
        {byId.has(`dj.play.${d}`) && (
          <button type="button" className="m-deck-btn" onClick={() => setControl(`dj.play.${d}`, true)}>
            <Play size={14} /> Play
          </button>
        )}
        {byId.has(`dj.cue.${d}`) && (
          <button type="button" className="m-deck-btn" onClick={() => setControl(`dj.cue.${d}`, true)}>
            <Headphones size={14} /> Cue
          </button>
        )}
      </div>
      {range(`dj.vol.${d}`, 'Volume')}
      {range(`dj.eqHi.${d}`, 'EQ Hi')}
      {range(`dj.eqMid.${d}`, 'EQ Mid')}
      {range(`dj.eqLo.${d}`, 'EQ Lo')}
      {range(`dj.filter.${d}`, 'Filter')}
    </section>
  );

  return (
    <RemoteGate>
      {!hasDj ? (
        <div className="m-state">
          <h2>No DJ controls</h2>
          <p>Connected, but the desktop published no DJ controls yet.</p>
        </div>
      ) : (
        <div className="m-dj">
          <div className="m-decks">{DECKS.map(deck)}</div>
          <div className="m-dj-global">
            {range('dj.crossfade', 'Crossfade')}
            {byId.has('dj.limiter') && (
              <button
                type="button"
                className={`m-btn${values['dj.limiter'] === true ? ' is-on' : ''}`}
                aria-pressed={values['dj.limiter'] === true}
                onClick={() => setControl('dj.limiter', values['dj.limiter'] !== true)}
              >
                Master Limiter
              </button>
            )}
          </div>
        </div>
      )}
    </RemoteGate>
  );
}
